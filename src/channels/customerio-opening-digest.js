import fs from 'node:fs/promises';
import path from 'node:path';
import {
  NEWSLETTER_TEMPLATE_ID, parseNewsletterArticle, renderMarkdown, renderNewsletterEmail,
} from '../lib/newsletter-email.js';
import { assertRenderedTemplateMarker } from '../lib/draft-template.js';
import { uploadCustomerIoAsset } from '../lib/customerio-assets.js';
import { renderOpeningDigestCover } from '../lib/opening-digest-cover.js';
import { captureTrendingOptionsTable } from '../lib/options-volume.js';
import { collectOpeningMetrics, renderMetricsHtml } from '../lib/opening-digest-metrics.js';
import { easternDateKey, isUsEquitySession } from '../lib/us-equity-calendar.js';

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
    async publish({ articlePath, config, workflow, notifier, notify, source = 'manual', existingRemoteId = '', onCreated }) {
      const cio = config.customerio || {};
      const digest = config.openingDigest || {};
      assertDigestConfig(cio, digest);
      const current = now();
      const dateKey = easternDateKey(current);
      const article = parseNewsletterArticle(await readArticle(articlePath), dateKey);
      const { count: audienceCount, name: audienceName } = await audiencePreflightFor({
        baseUrl: cio.baseUrl, appApiKey: cio.appApiKey, segmentId: digest.segmentId,
        fetchFn, timeoutMs: cio.timeoutMs,
      });
      if (normalizedSegmentName(audienceName) !== 'test2') {
        throw publishError(`Opening Digest 测试版只能发送到 Customer.io segment test2，当前为 ${audienceName || '(unnamed)'}`);
      }

      const common = { baseUrl: cio.baseUrl, appApiKey: cio.appApiKey, fetchFn, timeoutMs: cio.timeoutMs, parentFolderId: digest.assetFolderId };
      let headerImageUrl = '';
      try {
        const cover = await renderCover({ dateLabel: displayDate(dateKey), executablePath: digest.browserExecutablePath, timeoutMs: digest.captureTimeoutMs });
        const asset = await uploadAsset({ ...common, buffer: cover, filename: `opening-digest-cover-${dateKey}.png`, name: `Zen Opening Digest cover ${dateKey}` });
        headerImageUrl = asset.path;
      } catch (error) {
        await notifier?.warn?.(notify, `Opening Digest 封面不可用，按规则无封面继续发送: ${error.message}`);
      }

      // An OIC-login retry must keep the original opening snapshot. Persist this
      // before the OIC call because that call is the only deliberate hold point.
      const metrics = await loadOrCollectMetrics({ articlePath, dateKey, collectMetrics, fetchFn, timeoutMs: Math.min(cio.timeoutMs, 15000) });
      const options = await resolveOptions({ digest, common, source, dateKey, current, captureOptions, uploadAsset });
      const contentHtml = [renderMetricsHtml(metrics), renderMarkdown(article.body), renderOptionsHtml(options)].join('\n');
      const body = renderNewsletterEmail({ ...article, edition: dateKey }, { ...cio, headerImageUrl, contentHtml });
      assertRenderedTemplateMarker(body, NEWSLETTER_TEMPLATE_ID);
      const name = `Zen Opening Digest · ${dateKey}`;
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
      let newsletterId = Number(existingRemoteId) || 0;
      if (!newsletterId) {
        const newsletter = await customerIoJson({ baseUrl: cio.baseUrl, appApiKey: cio.appApiKey, path: '/v1/newsletters', method: 'POST', body: payload, fetchFn, timeoutMs: cio.timeoutMs });
        newsletterId = newsletter?.newsletter?.id;
        if (!newsletterId) throw publishError('Customer.io 创建 Opening Digest 后未返回 newsletter.id');
        await onCreated?.({ remoteId: String(newsletterId), title: name });
      }
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

async function loadOrCollectMetrics({ articlePath, dateKey, collectMetrics, fetchFn, timeoutMs }) {
  const statePath = `${articlePath}.opening-digest-state.json`;
  try {
    const prior = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (prior?.dateKey === dateKey && Array.isArray(prior.metrics)) return prior.metrics;
  } catch {}
  const metrics = await collectMetrics({ fetchFn, timeoutMs });
  await fs.writeFile(statePath, JSON.stringify({ dateKey, metrics, capturedAt: new Date().toISOString() }), { mode: 0o600 });
  return metrics;
}

async function resolveOptions({ digest, common, source, dateKey, current, captureOptions, uploadAsset }) {
  if (source !== 'cron' && !isUsEquitySession(current)) {
    try {
      const cached = JSON.parse(await fs.readFile(digest.eodCachePath, 'utf8'));
      if (cached?.url && cached?.dateKey) return { url: cached.url, dateKey: cached.dateKey, capturedAt: cached.capturedAt, kind: 'EOD' };
    } catch {}
    return { unavailable: true, reason: 'No verified EOD options snapshot is available.' };
  }
  try {
    const screenshot = await captureOptions({
      url: digest.optionsUrl, storageStatePath: digest.storageStatePath,
      executablePath: digest.browserExecutablePath, timeoutMs: digest.captureTimeoutMs,
      automationAuthorized: digest.automationAuthorized,
    });
    const asset = await uploadAsset({
      ...common, buffer: screenshot.buffer, filename: `opening-digest-options-${dateKey}-open.png`,
      name: `OIC Trending Options Volume ${dateKey}`,
    });
    return { url: asset.path, dateKey, capturedAt: screenshot.capturedAt, kind: 'Opening' };
  } catch (error) {
    if (error?.code === 'OIC_AUTH_EXPIRED') throw error;
    return { unavailable: true, reason: 'The options table could not be captured for this edition.' };
  }
}

export async function cacheEodOptions({ articlePath, config, fetchFn = globalThis.fetch }) {
  const digest = config.openingDigest || {};
  const cio = config.customerio || {};
  assertDigestConfig(cio, digest);
  const payload = JSON.parse(await fs.readFile(articlePath, 'utf8'));
  const asset = await uploadCustomerIoAsset({
    baseUrl: cio.baseUrl, appApiKey: cio.appApiKey, buffer: Buffer.from(payload.png, 'base64'),
    filename: `opening-digest-options-${payload.dateKey}-close.png`, name: `OIC Trending Options Volume EOD ${payload.dateKey}`,
    parentFolderId: digest.assetFolderId, fetchFn, timeoutMs: cio.timeoutMs,
  });
  await fs.mkdir(path.dirname(digest.eodCachePath), { recursive: true });
  await fs.writeFile(digest.eodCachePath, JSON.stringify({ url: asset.path, dateKey: payload.dateKey, capturedAt: payload.capturedAt, kind: 'EOD' }), { mode: 0o600 });
  return { mediaId: `customerio-asset:${asset.id}`, title: `Opening Digest EOD options cache · ${payload.dateKey}` };
}

export function renderOptionsHtml(options) {
  const heading = '<h2 style="margin:24px 0 10px;font-size:17px;line-height:1.35;font-weight:500;color:#08272b">Trending options volume</h2>';
  if (options.unavailable) return `${heading}<p style="margin:0 0 18px;color:#66787a">Options table unavailable. ${escapeHtml(options.reason || '')}</p>`;
  const captured = formatCapturedAt(options.capturedAt);
  return `${heading}<a href="https://www.optionseducation.org/toolsoptionquotes/trending-options-volume" style="display:block"><img src="${escapeAttr(options.url)}" alt="OIC Trending Options Volume top twenty table" width="620" style="display:block;width:100%;max-width:620px;height:auto;border:0"></a><p style="margin:8px 0 18px;font-size:11px;line-height:1.55;color:#66787a">Source: OCC/OIC, powered by iVolatility · Data delayed 20 minutes · ${escapeHtml(options.kind || 'Opening')} capture: ${escapeHtml(captured)} · <a href="https://www.optionseducation.org/toolsoptionquotes/trending-options-volume" style="color:#0b6d75">View source</a></p>`;
}

function assertDigestConfig(cio, digest) {
  if (!digest.enabled) throw publishError('OPENING_DIGEST_ENABLED=true 才能发送');
  if (!cio.appApiKey || !cio.companyAddress || !cio.from) throw publishError('Opening Digest 缺少 Customer.io 发件配置');
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
