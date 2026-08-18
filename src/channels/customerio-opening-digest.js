import fs from 'node:fs/promises';
import path from 'node:path';
import {
  NEWSLETTER_COMPANY_ADDRESS, parseNewsletterArticle, renderMarkdown, renderNewsletterEmail,
} from '../lib/newsletter-email.js';
import { assertRenderedTemplateMarker, FIXED_DRAFT_TEMPLATE_IDS } from '../lib/draft-template.js';
import { uploadCustomerIoAsset } from '../lib/customerio-assets.js';
import { renderOpeningDigestCover } from '../lib/opening-digest-cover.js';
import { captureTrendingOptionsTable, validateTrendingOptionsData } from '../lib/options-volume.js';
import { collectOpeningMetrics, normalizeOpeningMetrics, renderMetricsHtml } from '../lib/opening-digest-metrics.js';
import { easternDateKey } from '../lib/us-equity-calendar.js';
import { auditOpeningDigestArticle } from '../lib/opening-digest-content.js';
import { translateOpeningDigestPayload } from '../lib/opening-digest-translation.js';
import { makeWechatOpeningDigestChannel } from './wechat-opening-digest.js';
import { acquireRuntimeResource, runtimeFetch } from '../config/runtime.js';

const SENDER = 'support@zentradings.com';
const CUSTOMERIO_MIN_SCHEDULE_LEAD_MS = 5 * 60 * 1000;
export const CUSTOMERIO_OPENING_DIGEST_TEMPLATE_ID = FIXED_DRAFT_TEMPLATE_IDS['customerio-opening-digest'];
export const OPENING_DIGEST_NEWSLETTER_TITLE = 'Zen Opening Digest';

export function makeChannel({
  readArticle = (file) => fs.readFile(file, 'utf8'),
  fetchFn = (...args) => runtimeFetch(globalThis.fetch)(...args),
  now = () => new Date(), captureOptions = captureTrendingOptionsTable,
  renderCover = renderOpeningDigestCover, uploadAsset = uploadCustomerIoAsset,
  collectMetrics = collectOpeningMetrics,
  translatePayload = translateOpeningDigestPayload,
  wechatChannel = makeWechatOpeningDigestChannel(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  return {
    id: 'customerio-opening-digest',
    templateId: CUSTOMERIO_OPENING_DIGEST_TEMPLATE_ID,
    templateLocked: true,
    async publish({ articlePath, config, workflow, source = 'manual', existingRemoteId = '', existingDeliveries = [], onCreated, onDelivery, contentMode = 'editorial', acceptanceId = '' }) {
      const cio = config.customerio || {};
      const digest = config.openingDigest || {};
      assertDigestConfig(cio, digest);
      const current = now();
      const dateKey = easternDateKey(current);
      const diagnostics = [];
      const traceMetadata = {};
      const releaseCustomerio = await acquireRuntimeResource('customerio-write');
      try {
        const articleSource = await readArticle(articlePath);
        const articleAudit = auditOpeningDigestArticle({ article: articleSource, asOf: current });
        diagnostics.push(...articleAudit.warnings);
        const parsed = parseNewsletterArticle(articleSource, dateKey);
        if (parsed.title !== 'Zen Opening Digest' || parsed.edition !== dateKey) {
          throw publishError(`Opening Digest 标题或 edition 与当前美东日期不一致:${parsed.title} / ${parsed.edition}`);
        }
        const sanitized = sanitizeUnsubscribeTags(parsed.body);
        if (sanitized.removed) diagnostics.push(`Opening Digest 正文已移除 ${sanitized.removed} 个退订 Liquid 标签`);
        const article = { ...parsed, body: sanitized.body };

        const audience = await audiencePreflightFor({
          baseUrl: cio.baseUrl, appApiKey: cio.appApiKey, segmentId: digest.segmentId,
          fetchFn, timeoutMs: cio.timeoutMs, sleep,
        });
        diagnostics.push(...audience.diagnostics);
        if (audience.name && normalizedSegmentName(audience.name) !== 'test1') {
          throw publishError(`Opening Digest 测试版只能发送到 Customer.io segment test1，当前为 ${audience.name}`);
        }
        const acceptance = source === 'acceptance';
        if (acceptance && !/^[a-z0-9-]{8,80}$/i.test(acceptanceId)) {
          throw publishError('Opening Digest 验收邮件缺少安全的 acceptance ID');
        }
        const name = openingDigestNewsletterName(dateKey, { acceptance, acceptanceId });
        let newsletterId = Number(existingRemoteId) || 0;
        let remote;
        if (newsletterId) {
          const remoteData = await customerIoRequestWithRetry({
            baseUrl: cio.baseUrl, appApiKey: cio.appApiKey, path: `/v1/newsletters/${newsletterId}`,
            method: 'GET', fetchFn, timeoutMs: cio.timeoutMs, sleep,
          });
          remote = remoteData?.newsletter || remoteData;
          assertExistingNewsletter(remote, {
            newsletterId, name, segmentId: digest.segmentId, subscriptionTopicId: digest.subscriptionTopicId,
          });
        } else {
          remote = await findExistingNewsletter({ cio, digest, name, fetchFn, sleep, diagnostics });
          newsletterId = Number(remote?.id) || 0;
          if (newsletterId) await onCreated?.({ remoteId: String(newsletterId), title: name });
        }
        const emailAlreadySent = remote?.sent_at != null;

        let headerImageUrl = '';
        try {
          if (emailAlreadySent) throw new Error('skip-existing-email-cover');
          const coverKey = acceptance ? `${dateKey}-${acceptanceId}` : dateKey;
          const cover = await renderCover({
            dateLabel: displayDate(dateKey),
            executablePath: digest.browserExecutablePath,
            timeoutMs: digest.captureTimeoutMs,
          });
          const asset = await uploadAsset({
            baseUrl: cio.baseUrl,
            appApiKey: cio.appApiKey,
            fetchFn,
            timeoutMs: cio.timeoutMs,
            parentFolderId: digest.assetFolderId,
            buffer: cover,
            filename: `opening-digest-cover-${coverKey}.png`,
            name: `Zen Opening Digest cover ${coverKey}`,
          });
          const candidate = String(asset?.path || '').trim();
          if (/^https:\/\//i.test(candidate)) headerImageUrl = candidate;
          else diagnostics.push('Customer.io 未返回 Opening Digest 封面 HTTPS URL，已使用无封面版');
        } catch (error) {
          if (error.message === 'skip-existing-email-cover') {
            // A sent email does not need another Customer.io cover upload; WeChat still consumes this payload.
          } else {
          diagnostics.push(`Opening Digest 封面已省略:${error.message}`);
          }
        }

        const metricResult = await loadOrCollectMetrics({
          articlePath, dateKey, collectMetrics, fetchFn,
          timeoutMs: Math.min(cio.timeoutMs, 15000), diagnostics,
        });
        diagnostics.push(...metricResult.warnings);
        let options;
        try {
          options = await resolveOptions({ articlePath, digest, source, current, captureOptions });
        } catch (error) {
          diagnostics.push(`Opening Digest 期权区块已省略:${error.message}`);
        }
        if (contentMode === 'data-only' && metricResult.availableCount === 0 && !options) {
          throw publishError('Opening Digest 数据版无可用正文、行情或期权数据，拒绝发送空邮件');
        }

        const openingPayload = deepFreeze({
          schemaVersion: 1,
          dateKey,
          article: { title: article.title, preheader: article.preheader, body: article.body },
          metrics: metricResult.metrics,
          options: options || null,
          cover: { label: 'Opening Digest', dateLabel: displayDate(dateKey) },
        });
        const contentHtml = [
          renderMetricsHtml(metricResult.metrics),
          renderMarkdown(article.body),
          options ? renderOptionsHtml(options) : '',
        ].filter(Boolean).join('\n');
        const body = renderNewsletterEmail({ ...article, edition: dateKey }, {
          ...cio, headerImageUrl, contentHtml, includeUnsubscribe: false,
          templateId: CUSTOMERIO_OPENING_DIGEST_TEMPLATE_ID,
        });
        assertRenderedTemplateMarker(body, CUSTOMERIO_OPENING_DIGEST_TEMPLATE_ID);
        if (!body.includes(`Zen Trading · ${NEWSLETTER_COMPANY_ADDRESS}`)) {
          throw publishError(`Opening Digest 固定地址缺失:${NEWSLETTER_COMPANY_ADDRESS}`);
        }
        if (/\{%\s*unsubscribe_url\s*%\}/i.test(body)) {
          throw publishError('Opening Digest 本地渲染后仍含退订 Liquid 标签');
        }
        const payload = {
          name,
          type: 'email',
          recipients: { and: [{ or: [{ segment: { id: digest.segmentId } }] }] },
          subject: openingDigestNewsletterSubject(dateKey, { acceptance }),
          preheader_text: article.preheader,
          body,
          from: cio.from,
          subscription_topic_id: digest.subscriptionTopicId,
        };
        if (!newsletterId) {
          try {
            const newsletter = await customerIoRequestWithRetry({
              baseUrl: cio.baseUrl, appApiKey: cio.appApiKey, path: '/v1/newsletters',
              method: 'POST', body: payload, fetchFn, timeoutMs: cio.timeoutMs,
              sleep, retryCreateOn429: true,
            });
            newsletterId = Number(newsletter?.newsletter?.id) || 0;
          } catch (error) {
            if (!isAmbiguousCustomerIoFailure(error)) throw error;
            diagnostics.push(`Customer.io 创建结果不明，已进入远端恢复:${error.message}`);
          }
          if (!newsletterId) {
            const recovered = await recoverExistingNewsletter({ cio, digest, name, fetchFn, sleep, diagnostics });
            newsletterId = Number(recovered?.id) || 0;
          }
          if (!newsletterId) throw publishError('Customer.io 创建 Opening Digest 后无法恢复 newsletter.id');
          await onCreated?.({ remoteId: String(newsletterId), title: name });
        }

        if (!emailAlreadySent) {
          const target = openingSendTarget(current, digest.timezone || 'America/New_York');
          if (source === 'cron' && target.getTime() > current.getTime() + CUSTOMERIO_MIN_SCHEDULE_LEAD_MS) {
            await customerIoRequestWithRetry({
              baseUrl: cio.baseUrl, appApiKey: cio.appApiKey,
              path: `/v1/newsletters/${newsletterId}/schedule`, method: 'POST',
              body: { scheduled_at: Math.floor(target.getTime() / 1000), timezone: digest.timezone || 'America/New_York', tz_match_enabled: false },
              fetchFn, timeoutMs: cio.timeoutMs, sleep, idempotent: true,
            });
          } else {
            await sendNewsletterSafely({ cio, newsletterId, fetchFn, sleep, diagnostics });
          }
        }
        const deliveries = [{ destination: 'customerio', status: emailAlreadySent ? 'existing' : 'delivered', mediaId: `customerio-newsletter:${newsletterId}`, title: name }];
        await onDelivery?.(deliveries[0]);
        const deliveryWarnings = [];
        if (digest.wechatEnabled) {
          try {
            const translated = await translatePayload(openingPayload, {
              writer: config.writer, fetchFn, cacheDir: path.dirname(articlePath),
              timeoutMs: config.defaultTimeoutMs,
            });
            traceMetadata.translation = {
              model: translated.model, payloadHash: translated.payloadHash, blockCount: translated.blockCount,
              repairs: translated.repairs,
              invariants: { blockIdsAndOrder: true, numbersTickersTimesAndUrls: true },
            };
            const prior = existingDeliveries.find((item) => item.destination === 'wechat' && item.media_id);
            const wechat = prior
              ? { mediaId: prior.media_id, title: prior.title, status: prior.status || 'existing', errors: [], attempts: [] }
              : await wechatChannel.publish({ payload: openingPayload, translation: translated, config, acceptance });
            const delivery = { destination: 'wechat', status: wechat.status, mediaId: wechat.mediaId, title: wechat.title, details: { errors: wechat.errors, attempts: wechat.attempts } };
            deliveries.push(delivery);
            await onDelivery?.(delivery);
            traceMetadata.wechat = { ...wechat, html: undefined };
            if (wechat.status !== 'verified' && wechat.status !== 'existing') {
              deliveryWarnings.push(`Opening Digest 邮件已成功，但微信草稿${wechat.status === 'unverified' ? '未能回读验证' : '第三次回读仍不一致'}。Media ID:${wechat.mediaId}；${wechat.errors.join('；')}`);
            }
          } catch (error) {
            const delivery = { destination: 'wechat', status: 'failed', mediaId: '', title: '', error: error.message };
            deliveries.push(delivery);
            await onDelivery?.(delivery);
            traceMetadata.wechat = { status: 'failed', error: error.message };
            deliveryWarnings.push(`Opening Digest 邮件已成功，但中文微信草稿创建失败:${error.message}`);
          }
        }
        return publishResult({ newsletterId, name, digest, audience, deliveries, deliveryWarnings });
      } finally {
        try { await appendOpeningDiagnostics(articlePath, diagnostics, { contentMode, ...traceMetadata }); }
        finally { releaseCustomerio(); }
      }
    },
  };
}

export async function publishHistoricalOpeningDigestWechat({
  sourceDir, newsletterId, historicalSegmentId, historicalSegmentName,
  config, fetchFn = globalThis.fetch, now = () => new Date(),
  translatePayload = translateOpeningDigestPayload,
  wechatChannel = makeWechatOpeningDigestChannel(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const cio = config?.customerio || {};
  const digest = config?.openingDigest || {};
  assertDigestConfig(cio, digest);
  if (!digest.wechatEnabled) throw publishError('OPENING_DIGEST_WECHAT_ENABLED=true 才能执行历史同源迁移验收');
  if (!Number.isInteger(Number(newsletterId)) || Number(newsletterId) <= 0
    || !Number.isInteger(Number(historicalSegmentId)) || Number(historicalSegmentId) <= 0
    || !String(historicalSegmentName || '').trim()) {
    throw publishError('历史同源迁移验收必须显式提供邮件 ID、历史 segment ID 和名称');
  }
  if (Number(historicalSegmentId) === Number(digest.segmentId)) {
    throw publishError('历史 segment 与当前 test1 相同，不应进入迁移验收');
  }
  const resolvedDir = await fs.realpath(String(sourceDir || '')).catch(() => '');
  if (!resolvedDir || !/^zen-opening-acceptance-[A-Za-z0-9]+$/.test(path.basename(resolvedDir))) {
    throw publishError('历史同源目录必须是保留的 zen-opening-acceptance 隔离目录');
  }
  const articlePath = path.join(resolvedDir, 'article.md');
  const [articleSource, state, universe, trace] = await Promise.all([
    fs.readFile(articlePath, 'utf8'),
    readJson(path.join(resolvedDir, 'article.md.opening-digest-state.json'), '行情缓存'),
    readJson(path.join(resolvedDir, 'opening-digest-universe.json'), 'Opening Digest universe'),
    readJson(path.join(resolvedDir, 'research-trace.json'), '研究轨迹'),
  ]);
  const dateKey = easternDateKey(now());
  const article = parseNewsletterArticle(articleSource, dateKey);
  if (article.title !== 'Zen Opening Digest' || article.edition !== dateKey
    || state?.dateKey !== dateKey || universe?.dateKey !== dateKey) {
    throw publishError('历史同源目录与当前美东日期或 Opening Digest 标识不一致');
  }
  const remoteData = await customerIoRequestWithRetry({
    baseUrl: cio.baseUrl, appApiKey: cio.appApiKey, path: `/v1/newsletters/${Number(newsletterId)}`,
    method: 'GET', fetchFn, timeoutMs: cio.timeoutMs, sleep,
  });
  const remote = remoteData?.newsletter || remoteData;
  const segments = Array.isArray(remote?.recipient_segment_ids) ? remote.recipient_segment_ids.map(Number) : [];
  const expectedName = openingDigestNewsletterName(dateKey);
  if (Number(remote?.id) !== Number(newsletterId) || remote?.name !== expectedName || remote?.sent_at == null
    || segments.length !== 1 || segments[0] !== Number(historicalSegmentId)
    || Number(remote?.subscription_topic_id) !== Number(digest.subscriptionTopicId)) {
    throw publishError('已发送历史 Opening Digest 的日期、受众或订阅主题与迁移参数不一致');
  }
  const segmentData = await customerIoRequestWithRetry({
    baseUrl: cio.baseUrl, appApiKey: cio.appApiKey, path: `/v1/segments/${Number(historicalSegmentId)}`,
    method: 'GET', fetchFn, timeoutMs: cio.timeoutMs, sleep,
  });
  const segment = segmentData?.segment || segmentData;
  if (normalizedSegmentName(segment?.name) !== normalizedSegmentName(historicalSegmentName)) {
    throw publishError(`历史 segment 名称不一致:${segment?.name || '(empty)'}`);
  }
  const sourceStarted = Date.parse(trace?.startedAt || '');
  const sourceFinished = Math.max(...[
    Date.parse(trace?.finishedAt || ''),
    Date.parse(trace?.openingDigestDelivery?.updatedAt || ''),
  ].filter(Number.isFinite));
  const remoteCreated = Number(remote?.created) * 1000;
  if (![sourceStarted, sourceFinished, remoteCreated].every(Number.isFinite)
    || remoteCreated < sourceStarted || remoteCreated > sourceFinished) {
    throw publishError('历史邮件创建时间不在指定隔离 run 的生成/投递轨迹内');
  }
  const metrics = normalizeOpeningMetrics(state.metrics).metrics;
  const options = universe?.options?.data && universe?.options?.capturedAt ? {
    data: validateTrendingOptionsData(universe.options.data),
    capturedAt: universe.options.capturedAt,
    kind: 'Opening',
  } : null;
  const openingPayload = deepFreeze({
    schemaVersion: 1,
    dateKey,
    article: { title: article.title, preheader: article.preheader, body: sanitizeUnsubscribeTags(article.body).body },
    metrics,
    options,
    cover: { label: 'Opening Digest', dateLabel: displayDate(dateKey) },
  });
  let traceMetadata = { historicalMigration: { newsletterId: Number(newsletterId), segmentId: Number(historicalSegmentId), segmentName: segment.name, sourceDir: resolvedDir } };
  try {
    const translated = await translatePayload(openingPayload, {
      writer: config.writer, fetchFn, cacheDir: resolvedDir, timeoutMs: config.defaultTimeoutMs,
    });
    const wechat = await wechatChannel.publish({ payload: openingPayload, translation: translated, config, acceptance: false });
    traceMetadata = {
      ...traceMetadata,
      translation: {
        model: translated.model, payloadHash: translated.payloadHash, blockCount: translated.blockCount,
        repairs: translated.repairs, invariants: { blockIdsAndOrder: true, numbersTickersTimesAndUrls: true },
      },
      wechat: { ...wechat, html: undefined },
    };
    await appendOpeningDiagnostics(articlePath, ['Acceptance 仅用历史隔离 payload 补验已发送邮件的正式中文微信稿'], traceMetadata);
    return {
      mediaId: `customerio-newsletter:${Number(newsletterId)}`,
      title: expectedName,
      audienceStage: normalizedSegmentName(segment.name),
      audienceSegmentId: Number(historicalSegmentId),
      deliveries: [
        { destination: 'customerio', status: 'existing', mediaId: `customerio-newsletter:${Number(newsletterId)}`, title: expectedName },
        { destination: 'wechat', status: wechat.status, mediaId: wechat.mediaId, title: wechat.title, details: { errors: wechat.errors, attempts: wechat.attempts } },
      ],
      deliveryWarnings: [],
    };
  } catch (error) {
    await appendOpeningDiagnostics(articlePath, [], { ...traceMetadata, wechat: { status: 'failed', error: error.message } });
    throw error;
  }
}

async function readJson(filename, label) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) { throw publishError(`历史同源目录缺少或损坏${label}:${error.message}`); }
}

function openingDigestNewsletterName(dateKey, { acceptance = false, acceptanceId = '' } = {}) {
  const base = `${OPENING_DIGEST_NEWSLETTER_TITLE} · ${dateKey}`;
  return acceptance ? `[TEST] ${base} · ${acceptanceId}` : base;
}

function openingDigestNewsletterSubject(dateKey, { acceptance = false } = {}) {
  const base = `${OPENING_DIGEST_NEWSLETTER_TITLE} · ${displayDate(dateKey)}`;
  return acceptance ? `[TEST] ${base}` : base;
}

function assertExistingNewsletter(remote, { newsletterId, name, segmentId, subscriptionTopicId }) {
  const segments = Array.isArray(remote?.recipient_segment_ids) ? remote.recipient_segment_ids.map(Number) : [];
  if (Number(remote?.id) !== newsletterId || remote?.name !== name
    || segments.length !== 1 || segments[0] !== Number(segmentId)
    || Number(remote?.subscription_topic_id) !== Number(subscriptionTopicId)) {
    throw publishError('Customer.io 已有 Opening Digest 与当前日期、受众或订阅主题不一致，拒绝复用');
  }
}

async function loadOrCollectMetrics({ articlePath, dateKey, collectMetrics, fetchFn, timeoutMs, diagnostics }) {
  const statePath = `${articlePath}.opening-digest-state.json`;
  try {
    const prior = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (prior?.dateKey === dateKey && Array.isArray(prior.metrics)) return normalizeOpeningMetrics(prior.metrics);
  } catch (error) {
    if (error?.code !== 'ENOENT') diagnostics.push(`Opening Digest 行情缓存读取失败:${error.message}`);
  }
  let collected = [];
  try { collected = await collectMetrics({ fetchFn, timeoutMs }); }
  catch (error) { diagnostics.push(`Opening Digest 行情采集失败:${error.message}`); }
  const normalized = normalizeOpeningMetrics(collected);
  try {
    await fs.writeFile(statePath, JSON.stringify({ dateKey, metrics: normalized.metrics, capturedAt: new Date().toISOString() }), { mode: 0o600 });
  } catch (error) {
    diagnostics.push(`Opening Digest 行情缓存写入失败:${error.message}`);
  }
  return normalized;
}

async function resolveOptions({ articlePath, digest, source, current, captureOptions }) {
  const prepared = await readPreparedOptions(articlePath, current);
  if (prepared) {
    return {
      data: prepared.data,
      capturedAt: prepared.capturedAt,
      kind: source === 'cron' ? 'Opening' : 'Latest available',
    };
  }
  const screenshot = await captureOptions({
    url: digest.optionsUrl, storageStatePath: digest.storageStatePath,
    executablePath: digest.browserExecutablePath, timeoutMs: digest.captureTimeoutMs,
    automationAuthorized: digest.automationAuthorized,
  });
  const manual = source !== 'cron';
  return {
    data: validateTrendingOptionsData(screenshot.data),
    capturedAt: screenshot.capturedAt || current.toISOString(),
    kind: manual ? 'Latest available' : 'Opening',
  };
}

async function readPreparedOptions(articlePath, current) {
  const artifactPath = path.join(path.dirname(articlePath), 'opening-digest-universe.json');
  try {
    const artifact = JSON.parse(await fs.readFile(artifactPath, 'utf8'));
    if (![1, 2].includes(artifact?.schemaVersion) || artifact?.dateKey !== easternDateKey(current)
      || !artifact?.options?.data || !artifact?.options?.capturedAt) return null;
    return {
      data: validateTrendingOptionsData(artifact.options.data),
      capturedAt: artifact.options.capturedAt,
    };
  } catch { return null; }
}

export function renderOptionsHtml(options) {
  const heading = '<h2 style="margin:24px 0 10px;font-size:17px;line-height:1.35;font-weight:500;color:#08272b">Trending options volume</h2>';
  const data = validateTrendingOptionsData(options.data);
  const captured = formatCapturedAt(options.capturedAt);
  const rows = data.rows.map((cells, index) => renderOptionRows(cells, index)).join('');
  return `${heading}<p style="margin:0 0 10px;font-size:11px;line-height:150%;color:#66787a">${escapeHtml(data.asOf)}</p><table role="table" aria-label="OIC Trending Options Volume top twenty" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;border:1px solid #dcd8d5;background:#fffdf8;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif"><caption style="text-align:left;padding:0;font-size:0;line-height:0;height:0;overflow:hidden">OIC Trending Options Volume top twenty</caption>${rows}</table><p style="margin:8px 0 18px;font-size:11px;line-height:155%;color:#66787a">Source: OCC/OIC · ${escapeHtml(data.attribution)} · Data delayed 20 minutes · ${escapeHtml(options.kind || 'Opening')} capture: ${escapeHtml(captured)} · <a href="https://www.optionseducation.org/toolsoptionquotes/trending-options-volume" style="color:#0b6d75">View source</a></p>`;
}

function renderOptionRows(cells, index) {
  const [rank, ticker, name, callVolume, putVolume, totalVolume, ivx30, ivxChange] = cells;
  const background = index % 2 === 0 ? '#f7f4ec' : '#fffdf8';
  const change = Number(String(ivxChange).replace('%', ''));
  const changeColor = change < 0 ? '#b42318' : change > 0 ? '#167a45' : '#435c5f';
  const label = 'display:block;margin:0 0 2px;font-size:9px;line-height:120%;letter-spacing:.04em;font-weight:600;color:#66787a;text-transform:uppercase';
  const value = 'display:block;font-size:11px;line-height:135%;font-weight:500;color:#173f43;white-space:nowrap';
  return `<tbody><tr style="background:${background}"><th scope="rowgroup" rowspan="2" width="8%" valign="top" align="center" style="width:8%;padding:10px 4px;border-top:1px solid #dcd8d5;font-size:11px;line-height:135%;font-weight:600;color:#66787a">${escapeHtml(rank)}</th><th scope="row" colspan="2" width="46%" valign="top" align="left" style="width:46%;padding:10px 6px;border-top:1px solid #dcd8d5;font-size:12px;line-height:140%;font-weight:600;color:#08272b">${escapeHtml(ticker)}<span style="display:block;margin-top:2px;font-size:10px;line-height:135%;font-weight:300;color:#435c5f;word-break:break-word">${escapeHtml(name)}</span></th><td colspan="2" width="46%" valign="top" align="right" style="width:46%;padding:10px 6px;border-top:1px solid #dcd8d5"><span style="${label}">Total option volume</span><span style="${value};font-size:12px;color:#08272b">${escapeHtml(totalVolume)}</span></td></tr><tr style="background:${background}"><td width="23%" valign="top" align="left" style="width:23%;padding:7px 3px 10px;border-top:1px solid #e7e3df"><span style="${label}">Call</span><span style="${value}">${escapeHtml(callVolume)}</span></td><td width="23%" valign="top" align="left" style="width:23%;padding:7px 3px 10px;border-top:1px solid #e7e3df"><span style="${label}">Put</span><span style="${value}">${escapeHtml(putVolume)}</span></td><td width="23%" valign="top" align="left" style="width:23%;padding:7px 3px 10px;border-top:1px solid #e7e3df"><span style="${label}">IVX 30</span><span style="${value}">${escapeHtml(ivx30)}</span></td><td width="23%" valign="top" align="left" style="width:23%;padding:7px 3px 10px;border-top:1px solid #e7e3df"><span style="${label}">IVX change %</span><span style="${value};color:${changeColor}">${escapeHtml(ivxChange)}</span></td></tr></tbody>`;
}

function assertDigestConfig(cio, digest) {
  if (!digest.enabled) throw publishError('OPENING_DIGEST_ENABLED=true 才能发送');
  if (!cio.appApiKey || !cio.from) throw publishError('Opening Digest 缺少 Customer.io 发件配置');
  if (senderEmail(cio.from) !== SENDER) throw publishError(`Customer.io 发件邮箱必须统一为 ${SENDER}`);
  if (!digest.segmentId || !digest.subscriptionTopicId) throw publishError('缺少 Opening Digest segment 或 subscription topic ID');
}
async function audiencePreflightFor({ baseUrl, appApiKey, segmentId, fetchFn, timeoutMs, sleep }) {
  const diagnostics = [];
  const [segmentResult, countResult] = await Promise.allSettled([
    customerIoRequestWithRetry({ baseUrl, appApiKey, path: `/v1/segments/${segmentId}`, method: 'GET', fetchFn, timeoutMs, sleep }),
    customerIoRequestWithRetry({ baseUrl, appApiKey, path: `/v1/segments/${segmentId}/customer_count`, method: 'GET', fetchFn, timeoutMs, sleep }),
  ]);
  const segmentData = segmentResult.status === 'fulfilled' ? segmentResult.value : undefined;
  const countData = countResult.status === 'fulfilled' ? countResult.value : undefined;
  if (segmentResult.status === 'rejected') diagnostics.push(`Customer.io segment 名称预检失败:${segmentResult.reason?.message || segmentResult.reason}`);
  if (countResult.status === 'rejected') diagnostics.push(`Customer.io 受众人数预检失败:${countResult.reason?.message || countResult.reason}`);
  const segment = segmentData?.segment || segmentData;
  const name = segment?.name ? String(segment.name) : '';
  const count = Number.isInteger(countData?.count) ? countData.count : undefined;
  if (!name && segmentResult.status === 'fulfilled') diagnostics.push('Customer.io segment 预检未返回名称');
  if (count === undefined && countResult.status === 'fulfilled') diagnostics.push('Customer.io 受众预检返回无效人数');
  if (count === 0) diagnostics.push('Customer.io test1 受众预检人数为 0');
  return { name, count, diagnostics };
}

async function customerIoOnce({ baseUrl = 'https://api.customer.io', appApiKey, path: apiPath, method, body, fetchFn, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(timeoutMs) || 30000);
  try {
    let response;
    try {
      response = await fetchFn(`${String(baseUrl).replace(/\/+$/, '')}${apiPath}`, { method, headers: { Authorization: `Bearer ${appApiKey}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: controller.signal });
    } catch (cause) {
      throw customerIoError(`Customer.io ${method} ${apiPath} 网络失败:${cause.message || cause}`, { cause, method, apiPath });
    }
    const raw = await response.text();
    let data; try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
    if (!response.ok) throw customerIoError(`Customer.io 请求失败:${response.status} ${raw.slice(0, 500)}`, {
      status: response.status,
      retryAfter: response.headers?.get?.('retry-after') || '',
      method,
      apiPath,
    });
    return data;
  } finally { clearTimeout(timer); }
}

async function customerIoRequestWithRetry(args) {
  const attempts = 3;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await customerIoOnce(args); }
    catch (error) {
      lastError = error;
      const retryableStatus = !Number.isInteger(error.status)
        || [408, 425, 429, 500, 502, 503, 504].includes(error.status);
      const safe = args.method === 'GET' || args.idempotent === true
        || (args.retryCreateOn429 === true && error.status === 429);
      if (!safe || !retryableStatus || attempt === attempts - 1) break;
      await args.sleep(retryDelay(error, attempt));
    }
  }
  throw lastError;
}

async function findExistingNewsletter({ cio, digest, name, fetchFn, sleep, diagnostics }) {
  let start = '';
  const matches = [];
  for (let page = 0; page < 5; page++) {
    const query = new URLSearchParams({ limit: '100', sort: 'desc', ...(start ? { start } : {}) });
    const data = await customerIoRequestWithRetry({
      baseUrl: cio.baseUrl, appApiKey: cio.appApiKey,
      path: `/v1/newsletters?${query}`, method: 'GET', fetchFn, timeoutMs: cio.timeoutMs, sleep,
    });
    matches.push(...(Array.isArray(data?.newsletters) ? data.newsletters.filter((item) => item?.name === name) : []));
    if (matches.length > 1 || !data?.next) break;
    start = String(data.next);
  }
  if (matches.length > 1) throw publishError(`Customer.io 存在 ${matches.length} 个同名 Opening Digest，拒绝自动选择`);
  if (!matches.length) return undefined;
  const remote = matches[0];
  assertExistingNewsletter(remote, {
    newsletterId: Number(remote.id), name,
    segmentId: digest.segmentId, subscriptionTopicId: digest.subscriptionTopicId,
  });
  diagnostics.push(`Customer.io 已恢复当日 Opening Digest:${remote.id}`);
  return remote;
}

async function recoverExistingNewsletter(args) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await args.sleep([250, 750][attempt - 1]);
    const remote = await findExistingNewsletter(args);
    if (remote) return remote;
  }
  return undefined;
}

async function sendNewsletterSafely({ cio, newsletterId, fetchFn, sleep, diagnostics }) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await customerIoOnce({
        baseUrl: cio.baseUrl, appApiKey: cio.appApiKey,
        path: `/v1/newsletters/${newsletterId}/send`, method: 'POST', body: {},
        fetchFn, timeoutMs: cio.timeoutMs,
      });
      return;
    } catch (error) {
      lastError = error;
      if (error.status === 429) {
        await sleep(retryDelay(error, attempt));
        continue;
      }
      if (!isAmbiguousCustomerIoFailure(error) && error.status !== 400) throw error;
      const data = await customerIoRequestWithRetry({
        baseUrl: cio.baseUrl, appApiKey: cio.appApiKey,
        path: `/v1/newsletters/${newsletterId}`, method: 'GET', fetchFn, timeoutMs: cio.timeoutMs, sleep,
      });
      const remote = data?.newsletter || data;
      if (remote?.sent_at != null) {
        diagnostics.push(`Customer.io 发送结果已通过远端 sent_at 恢复:${newsletterId}`);
        return;
      }
      if (attempt < 2) await sleep([250, 750][attempt]);
    }
  }
  throw lastError || publishError('Customer.io 发送重试耗尽');
}

function sanitizeUnsubscribeTags(value) {
  let removed = 0;
  const body = String(value || '').replace(/\{%\s*unsubscribe_url\s*%\}/gi, () => { removed += 1; return ''; });
  return { body, removed };
}

async function appendOpeningDiagnostics(articlePath, diagnostics, metadata = {}) {
  if (!articlePath || (!diagnostics.length && !Object.keys(metadata).length)) return;
  const tracePath = `${articlePath.slice(0, articlePath.lastIndexOf('/') + 1)}research-trace.json`;
  try {
    let trace = {};
    try { trace = JSON.parse(await fs.readFile(tracePath, 'utf8')); } catch {}
    trace.openingDigestDelivery = {
      ...(trace.openingDigestDelivery || {}),
      ...metadata,
      diagnostics: [...new Set([...(trace.openingDigestDelivery?.diagnostics || []), ...diagnostics])],
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(tracePath, `${JSON.stringify(trace, null, 2)}\n`, { mode: 0o600 });
  } catch {}
}

function publishResult({ newsletterId, name, digest, audience, deliveries = [], deliveryWarnings = [] }) {
  return {
    mediaId: `customerio-newsletter:${newsletterId}`,
    title: name,
    audienceStage: 'test1',
    audienceSegmentId: digest.segmentId,
    audienceRecipientCount: audience.count,
    deliveries,
    deliveryWarnings,
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function isAmbiguousCustomerIoFailure(error) {
  return !Number.isInteger(error?.status) || error.status >= 500 || [408, 425].includes(error.status);
}

function retryDelay(error, attempt) {
  const seconds = Number(error?.retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30000);
  return [250, 750, 1500][Math.min(attempt, 2)];
}

function customerIoError(message, details = {}) {
  const error = publishError(message);
  Object.assign(error, details);
  return error;
}
function openingSendTarget(now, timezone) {
  const date = easternDateKey(now);
  const rough = new Date(`${date}T10:30:00Z`);
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'shortOffset' }).formatToParts(rough).find((part) => part.type === 'timeZoneName')?.value || 'GMT-5';
  const match = offset.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  const minutes = match ? (Number(match[2]) * 60 + Number(match[3] || 0)) * (match[1] === '+' ? 1 : -1) : -300;
  return new Date(rough.getTime() - minutes * 60_000);
}
function displayDate(dateKey) { return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${dateKey}T12:00:00Z`)); }
function formatCapturedAt(value) { try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); } catch { return String(value || ''); } }
function normalizedSegmentName(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function senderEmail(value) { const text = String(value || '').trim(); return String(text.match(/<([^<>]+)>\s*$/)?.[1] || text).trim().toLowerCase(); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function escapeAttr(value) { return escapeHtml(value); }
function publishError(message) { const error = new Error(message); error.stage = 'publish'; return error; }
