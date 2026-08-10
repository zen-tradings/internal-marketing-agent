import fs from 'node:fs/promises';
import path from 'node:path';
import {
  NEWSLETTER_TEMPLATE_ID, parseNewsletterArticle, renderMarkdown, renderNewsletterEmail,
} from '../lib/newsletter-email.js';
import { assertRenderedTemplateMarker } from '../lib/draft-template.js';
import { uploadCustomerIoAsset } from '../lib/customerio-assets.js';
import { renderOpeningDigestCover } from '../lib/opening-digest-cover.js';
import { captureTrendingOptionsTable, validateTrendingOptionsData } from '../lib/options-volume.js';
import { collectOpeningMetrics, renderMetricsHtml, validateOpeningMetrics } from '../lib/opening-digest-metrics.js';
import { easternDateKey } from '../lib/us-equity-calendar.js';
import { validateOpeningDigestArticle } from '../lib/opening-digest-content.js';

const SENDER = 'support@zentradings.com';
const CUSTOMERIO_MIN_SCHEDULE_LEAD_MS = 5 * 60 * 1000;

export function makeChannel({
  readArticle = (file) => fs.readFile(file, 'utf8'), fetchFn = globalThis.fetch,
  now = () => new Date(), captureOptions = captureTrendingOptionsTable,
  renderCover = renderOpeningDigestCover, uploadAsset = uploadCustomerIoAsset,
  collectMetrics = collectOpeningMetrics,
} = {}) {
  return {
    id: 'customerio-opening-digest',
    templateId: NEWSLETTER_TEMPLATE_ID,
    templateLocked: true,
    async publish({ articlePath, config, workflow, source = 'manual', existingRemoteId = '', onCreated }) {
      const cio = config.customerio || {};
      const digest = config.openingDigest || {};
      assertDigestConfig(cio, digest);
      const current = now();
      const dateKey = easternDateKey(current);
      const articleSource = await readArticle(articlePath);
      validateOpeningDigestArticle({ article: articleSource, asOf: current });
      const article = parseNewsletterArticle(articleSource, dateKey);
      if (article.title !== 'Zen Opening Digest' || article.edition !== dateKey) {
        throw publishError(`Opening Digest 标题或 edition 与当前美东日期不一致:${article.title} / ${article.edition}`);
      }
      const { count: audienceCount, name: audienceName } = await audiencePreflightFor({
        baseUrl: cio.baseUrl, appApiKey: cio.appApiKey, segmentId: digest.segmentId,
        fetchFn, timeoutMs: cio.timeoutMs,
      });
      if (normalizedSegmentName(audienceName) !== 'test2') {
        throw publishError(`Opening Digest 测试版只能发送到 Customer.io segment test2，当前为 ${audienceName || '(unnamed)'}`);
      }
      if (audienceCount < 1) throw publishError('Opening Digest test2 受众为空，拒绝创建或发送 Newsletter');
      const name = `Zen Opening Digest · ${dateKey}`;
      let newsletterId = Number(existingRemoteId) || 0;
      if (newsletterId) {
        const remoteData = await customerIoJson({
          baseUrl: cio.baseUrl, appApiKey: cio.appApiKey, path: `/v1/newsletters/${newsletterId}`,
          method: 'GET', fetchFn, timeoutMs: cio.timeoutMs,
        });
        const remote = remoteData?.newsletter || remoteData;
        assertExistingNewsletter(remote, {
          newsletterId, name, segmentId: digest.segmentId, subscriptionTopicId: digest.subscriptionTopicId,
        });
        // A crash can happen after Customer.io starts the send but before the
        // local media_id write. Treat the remote sent_at as authoritative and
        // do not attempt a second send that Customer.io will reject.
        if (remote.sent_at != null) {
          return {
            mediaId: `customerio-newsletter:${newsletterId}`, title: name, audienceStage: 'test2',
            audienceSegmentId: digest.segmentId, audienceRecipientCount: audienceCount,
          };
        }
      }

      const common = { baseUrl: cio.baseUrl, appApiKey: cio.appApiKey, fetchFn, timeoutMs: cio.timeoutMs, parentFolderId: digest.assetFolderId };
      const cover = await renderCover({
        dateLabel: displayDate(dateKey),
        executablePath: digest.browserExecutablePath,
        timeoutMs: digest.captureTimeoutMs,
      });
      const asset = await uploadAsset({
        ...common,
        buffer: cover,
        filename: `opening-digest-cover-${dateKey}.png`,
        name: `Zen Opening Digest cover ${dateKey}`,
      });
      const headerImageUrl = String(asset?.path || '').trim();
      if (!/^https:\/\//i.test(headerImageUrl)) {
        throw publishError('Customer.io 未返回 Opening Digest 封面 HTTPS URL，拒绝发送无封面邮件');
      }

      // An OIC-login retry must keep the original opening snapshot. Persist this
      // before the OIC call because that call is the only deliberate hold point.
      const metrics = validateOpeningMetrics(await loadOrCollectMetrics({
        articlePath, dateKey, collectMetrics, fetchFn, timeoutMs: Math.min(cio.timeoutMs, 15000),
      }));
      const options = await resolveOptions({ digest, source, current, captureOptions });
      const contentHtml = [renderMetricsHtml(metrics), renderMarkdown(article.body), renderOptionsHtml(options)].join('\n');
      // Customer.io wraps API-created emails in the workspace layout. Opening
      // Digest verifies that layout below and leaves the legal unsubscribe link
      // to that single wrapper so the delivered HTML cannot contain duplicates.
      const body = renderNewsletterEmail({ ...article, edition: dateKey }, {
        ...cio, headerImageUrl, contentHtml, includeUnsubscribe: false,
      });
      assertRenderedTemplateMarker(body, NEWSLETTER_TEMPLATE_ID);
      const payload = {
        name,
        type: 'email',
        recipients: { and: [{ or: [{ segment: { id: digest.segmentId } }] }] },
        subject: `Zen Opening Digest · ${displayDate(dateKey)}`,
        preheader_text: article.preheader,
        body,
        from: cio.from,
        subscription_topic_id: digest.subscriptionTopicId,
      };
      if (!newsletterId) {
        const newsletter = await customerIoJson({ baseUrl: cio.baseUrl, appApiKey: cio.appApiKey, path: '/v1/newsletters', method: 'POST', body: payload, fetchFn, timeoutMs: cio.timeoutMs });
        newsletterId = newsletter?.newsletter?.id;
        if (!newsletterId) throw publishError('Customer.io 创建 Opening Digest 后未返回 newsletter.id');
        await onCreated?.({ remoteId: String(newsletterId), title: name });
      }
      await assertCustomerIoUnsubscribeLayout({
        baseUrl: cio.baseUrl, appApiKey: cio.appApiKey, newsletterId, fetchFn, timeoutMs: cio.timeoutMs,
      });
      const target = openingSendTarget(current, digest.timezone || 'America/New_York');
      // Customer.io requires a scheduled newsletter to be at least five
      // minutes ahead. If editorial/research work finishes later, send now
      // rather than creating a schedule request guaranteed to be rejected.
      if (source === 'cron' && target.getTime() > current.getTime() + CUSTOMERIO_MIN_SCHEDULE_LEAD_MS) {
        await customerIoJson({ baseUrl: cio.baseUrl, appApiKey: cio.appApiKey, path: `/v1/newsletters/${newsletterId}/schedule`, method: 'POST', body: { scheduled_at: Math.floor(target.getTime() / 1000), timezone: digest.timezone || 'America/New_York', tz_match_enabled: false }, fetchFn, timeoutMs: cio.timeoutMs });
      } else {
        await customerIoJson({ baseUrl: cio.baseUrl, appApiKey: cio.appApiKey, path: `/v1/newsletters/${newsletterId}/send`, method: 'POST', body: {}, fetchFn, timeoutMs: cio.timeoutMs });
      }
      return { mediaId: `customerio-newsletter:${newsletterId}`, title: name, audienceStage: 'test2', audienceSegmentId: digest.segmentId, audienceRecipientCount: audienceCount };
    },
  };
}

function assertExistingNewsletter(remote, { newsletterId, name, segmentId, subscriptionTopicId }) {
  const segments = Array.isArray(remote?.recipient_segment_ids) ? remote.recipient_segment_ids.map(Number) : [];
  if (Number(remote?.id) !== newsletterId || remote?.name !== name
    || segments.length !== 1 || segments[0] !== Number(segmentId)
    || Number(remote?.subscription_topic_id) !== Number(subscriptionTopicId)) {
    throw publishError('Customer.io 已有 Opening Digest 与当前日期、受众或订阅主题不一致，拒绝复用');
  }
}

async function assertCustomerIoUnsubscribeLayout({ baseUrl, appApiKey, newsletterId, fetchFn, timeoutMs }) {
  const data = await customerIoJson({
    baseUrl, appApiKey, path: `/v1/newsletters/${newsletterId}/contents`, method: 'GET', fetchFn, timeoutMs,
  });
  const contents = Array.isArray(data?.contents) ? data.contents : [];
  if (!contents.length) throw publishError('Customer.io 未返回 Opening Digest 邮件内容，拒绝发送');
  for (const content of contents) {
    const layoutCount = (String(content?.layout || '').match(/\{%\s*unsubscribe_url\s*%\}/g) || []).length;
    const bodyCount = (String(content?.body || '').match(/\{%\s*unsubscribe_url\s*%\}/g) || []).length;
    if (layoutCount !== 1 || bodyCount !== 0) {
      throw publishError(`Customer.io Opening Digest 退订链接归属异常:layout=${layoutCount},body=${bodyCount}`);
    }
  }
}

async function loadOrCollectMetrics({ articlePath, dateKey, collectMetrics, fetchFn, timeoutMs }) {
  const statePath = `${articlePath}.opening-digest-state.json`;
  try {
    const prior = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (prior?.dateKey === dateKey && Array.isArray(prior.metrics)) return validateOpeningMetrics(prior.metrics);
  } catch {}
  const metrics = validateOpeningMetrics(await collectMetrics({ fetchFn, timeoutMs }));
  await fs.writeFile(statePath, JSON.stringify({ dateKey, metrics, capturedAt: new Date().toISOString() }), { mode: 0o600 });
  return metrics;
}

async function resolveOptions({ digest, source, current, captureOptions }) {
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

export async function cacheEodOptions({ articlePath, config }) {
  const digest = config.openingDigest || {};
  const cio = config.customerio || {};
  assertDigestConfig(cio, digest);
  const payload = JSON.parse(await fs.readFile(articlePath, 'utf8'));
  const data = validateTrendingOptionsData(payload.data);
  await fs.mkdir(path.dirname(digest.eodCachePath), { recursive: true });
  await fs.writeFile(digest.eodCachePath, JSON.stringify({ data, dateKey: payload.dateKey, capturedAt: payload.capturedAt, kind: 'EOD' }), { mode: 0o600 });
  return { mediaId: `opening-digest-eod:${payload.dateKey}`, title: `Opening Digest EOD options cache · ${payload.dateKey}` };
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
async function audiencePreflightFor({ baseUrl, appApiKey, segmentId, fetchFn, timeoutMs }) {
  const [segmentData, countData] = await Promise.all([
    customerIoJson({ baseUrl, appApiKey, path: `/v1/segments/${segmentId}`, method: 'GET', fetchFn, timeoutMs }),
    customerIoJson({ baseUrl, appApiKey, path: `/v1/segments/${segmentId}/customer_count`, method: 'GET', fetchFn, timeoutMs }),
  ]);
  const segment = segmentData?.segment || segmentData;
  if (!segment?.name) throw publishError('Customer.io segment 预检没有返回名称');
  if (!Number.isInteger(countData?.count)) throw publishError('Customer.io 受众预检返回无效人数');
  return { name: String(segment.name), count: countData.count };
}
async function customerIoJson({ baseUrl = 'https://api.customer.io', appApiKey, path: apiPath, method, body, fetchFn, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(`${String(baseUrl).replace(/\/+$/, '')}${apiPath}`, { method, headers: { Authorization: `Bearer ${appApiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal });
    const raw = await response.text();
    let data; try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
    if (!response.ok) throw publishError(`Customer.io 请求失败:${response.status} ${raw.slice(0, 500)}`);
    return data;
  } finally { clearTimeout(timer); }
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
