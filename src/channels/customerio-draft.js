import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {
  NEWSLETTER_TEMPLATE_ID,
  parseNewsletterArticle,
  renderNewsletterEmail,
} from '../lib/newsletter-email.js';
import { assertRenderedTemplateMarker } from '../lib/draft-template.js';
import { checkOutboundLeaks, configuredSecretValues } from '../lib/gate.js';
import { withRuntimeResource } from '../config/runtime.js';
import { cancellationErrorFromSignal, throwIfTaskCancelled } from '../lib/task-cancellation.js';

export const NEWSLETTER_SENDER_EMAIL = 'support@zentradings.com';

async function defaultReadArticle(articlePath) {
  return fs.readFile(articlePath, 'utf8');
}

export function makeChannel({
  readArticle = defaultReadArticle,
  fetchFn = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  return {
    id: 'customerio-draft',
    templateId: NEWSLETTER_TEMPLATE_ID,
    templateLocked: true,
    async publish({
      articlePath,
      config,
      workflow,
      existingRemoteId,
      onCreated,
      resumeFromCheckpoint = false,
      runId,
      createdAt,
      remoteOperations,
      signal,
    }) {
      const cio = config.customerio || {};
      if (!cio.appApiKey) throw publishError('缺少 CUSTOMERIO_APP_API_KEY');
      const audience = resolveAudience(cio);
      if (!cio.from) throw publishError('缺少 CUSTOMERIO_NEWSLETTER_FROM');
      if (senderEmail(cio.from) !== NEWSLETTER_SENDER_EMAIL) {
        throw publishError(`Customer.io 发件邮箱必须统一为 ${NEWSLETTER_SENDER_EMAIL}`);
      }
      const baseUrl = String(cio.baseUrl || 'https://api.customer.io').replace(/\/+$/, '');
      const audienceCount = await fetchAudienceCount({
        baseUrl,
        appApiKey: cio.appApiKey,
        segmentId: audience.segmentId,
        fetchFn,
        timeoutMs: cio.timeoutMs,
      });
      validateAudienceCount(audience, audienceCount);

      let markdown;
      try { markdown = await readArticle(articlePath); }
      catch (error) { const wrapped = new Error(`读取 newsletter 失败:${error.message}`); wrapped.stage = 'render'; throw wrapped; }
      const leakGate = checkOutboundLeaks(markdown, { secretValues: configuredSecretValues(config) });
      if (leakGate.errors.length) {
        const error = new Error(`Newsletter 出口门禁拦截:${leakGate.errors.join('; ')}`);
        error.stage = 'gate';
        throw error;
      }

      const article = parseNewsletterArticle(markdown, workflow?.edition || cio.edition || 'Vol. 1');
      const name = newsletterDraftName(createdAt);
      const body = renderNewsletterEmail(article, cio);
      assertRenderedTemplateMarker(body, NEWSLETTER_TEMPLATE_ID);
      const payload = {
        name,
        type: 'email',
        // Customer.io's newsletter endpoint currently rejects a bare
        // { segment: ... } filter. Wrap the segment in the same AND/OR shape
        // used by its documented complex-filter example.
        recipients: {
          and: [{ or: [{ segment: { id: audience.segmentId } }] }],
        },
        subject: article.subject,
        preheader_text: article.preheader,
        body,
        from: cio.from,
        ...(cio.subscriptionTopicId ? { subscription_topic_id: cio.subscriptionTopicId } : {}),
      };

      let recovered;
      if (existingRemoteId) {
        recovered = await fetchNewsletterById({ baseUrl, appApiKey: cio.appApiKey, id: existingRemoteId, fetchFn, timeoutMs: cio.timeoutMs });
        assertRecoverableNewsletter(recovered, name);
      } else if (resumeFromCheckpoint && (!runId || !remoteOperations)) {
        recovered = await findNewsletterByName({ baseUrl, appApiKey: cio.appApiKey, name, fetchFn, timeoutMs: cio.timeoutMs });
      }
      if (recovered) {
        const recoveredId = Number(recovered.id);
        assertRecoverableNewsletter(recovered, name);
        await onCreated?.({ remoteId: String(recoveredId), title: name });
        return newsletterResult({ newsletterId: recoveredId, name, audience, audienceCount });
      }

      return withRuntimeResource('customerio-write', () => createNewsletterDraft({
        baseUrl,
        cio,
        payload,
        name,
        audience,
        audienceCount,
        fetchFn,
        sleep,
        signal,
        runId,
        remoteOperations,
        onCreated,
      }), signal);
    },
  };
}

export function newsletterDraftName(createdAt = Date.now()) {
  const date = new Date(Number(createdAt));
  if (Number.isNaN(date.getTime())) throw publishError('Newsletter 任务创建时间无效');
  return `Zen Research日报 · ${date.toISOString().slice(0, 10)}`;
}

async function createNewsletterDraft({
  baseUrl, cio, payload, name, audience, audienceCount, fetchFn, sleep, signal,
  runId, remoteOperations, onCreated,
}) {
  if (!runId || !remoteOperations) {
    const newsletterId = await postNewsletter({ baseUrl, cio, payload, fetchFn });
    await onCreated?.({ remoteId: String(newsletterId), title: name });
    return newsletterResult({ newsletterId, name, audience, audienceCount });
  }

  const operation = 'create-newsletter';
  const operationKey = `cio:newsletter:create:v1:${runId}`;
  const payloadSha256 = crypto.createHash('sha256').update(stableJson(payload)).digest('hex');
  let record = remoteOperations.get(operation);
  if (!record) {
    const before = await listMatchingNewsletters({ baseUrl, cio, name, fetchFn });
    record = remoteOperations.prepare({
      operation,
      operationKey,
      payloadSha256,
      beforeIds: before.map((item) => String(item.id)),
    });
  }
  if (record.payload_sha256 !== payloadSha256) {
    throw publishError('Customer.io 后台操作请求哈希与当前草稿不一致，拒绝复用旧操作');
  }
  if (record.remote_id) {
    const newsletter = await fetchNewsletterById({
      baseUrl, appApiKey: cio.appApiKey, id: record.remote_id, fetchFn, timeoutMs: cio.timeoutMs,
    });
    assertRecoverableNewsletter(newsletter, name);
    await onCreated?.({ remoteId: String(record.remote_id), title: name });
    return newsletterResult({ newsletterId: record.remote_id, name, audience, audienceCount });
  }

  const beforeIds = new Set(parseIdSnapshot(record.before_ids_json));
  if (Number(record.attempt_count || 0) > 0) {
    const recovered = await recoverCreatedNewsletter({
      baseUrl, cio, name, audience, beforeIds, fetchFn, sleep, signal,
    });
    if (recovered) return confirmRecovered({
      recovered, record, remoteOperations, onCreated, name, audience, audienceCount, runId,
    });
  }
  while (Number(record.attempt_count || 0) < 2) {
    throwIfTaskCancelled(signal);
    record = remoteOperations.increment(operation);
    if (!record || Number(record.attempt_count || 0) > 2) break;
    try {
      const newsletterId = await postNewsletter({ baseUrl, cio, payload, fetchFn });
      remoteOperations.update(operation, { state: 'confirmed', remoteId: String(newsletterId), lastError: '' });
      await onCreated?.({ remoteId: String(newsletterId), title: name });
      return newsletterResult({
        newsletterId, name, audience, audienceCount,
        deliveryWarnings: Number(record.attempt_count) > 1
          ? [`Customer.io 自动重试已成功，但第一次请求结果不明，可能存在同名重复草稿。任务:${runId}`]
          : [],
      });
    } catch (error) {
      if (!isAmbiguousCreateError(error)) throw error;
      record = remoteOperations.update(operation, {
        state: 'ambiguous',
        lastError: requestErrorMessage(error),
      });
      const recovered = await recoverCreatedNewsletter({
        baseUrl, cio, name, audience, beforeIds, fetchFn, sleep, signal,
      });
      if (recovered) return confirmRecovered({
        recovered, record, remoteOperations, onCreated, name, audience, audienceCount, runId,
      });
    }
  }

  remoteOperations.update(operation, {
    state: 'needs_review',
    lastError: '两次创建请求后仍无法唯一确认 newsletter.id',
  });
  const error = publishError(`Customer.io 两次创建请求后仍无法唯一确认草稿，已停止继续创建；请人工检查同名草稿。任务:${runId}`);
  error.stage = 'needs_review';
  throw error;
}

async function postNewsletter({ baseUrl, cio, payload, fetchFn }) {
  let response;
  let data;
  let detail = '';
  try {
    ({ response, data, detail } = await withRequestTimeout(cio.timeoutMs, async (requestSignal) => {
      const current = await fetchFn(`${baseUrl}/v1/newsletters`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cio.appApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: requestSignal,
      });
      if (!current.ok) return { response: current, detail: await safeText(current) };
      return { response: current, data: await current.json(), detail: '' };
    }));
  } catch (error) {
    const wrapped = publishError(`Customer.io 请求失败:${requestErrorMessage(error)}`);
    wrapped.ambiguousCreate = true;
    throw wrapped;
  }
  if (!response.ok) {
    const domainError = unverifiedSendingDomainError(response.status, detail, cio.from);
    if (domainError) throw publishError(domainError);
    const error = publishError(`Customer.io 创建草稿失败:${response.status} ${response.statusText || ''} ${detail}`.trim());
    if (Number(response.status) >= 500) error.ambiguousCreate = true;
    throw error;
  }
  const newsletterId = Number(data?.newsletter?.id);
  if (!Number.isInteger(newsletterId) || newsletterId <= 0) {
    const error = publishError('Customer.io 返回成功但缺少 newsletter.id');
    error.ambiguousCreate = true;
    throw error;
  }
  return newsletterId;
}

async function recoverCreatedNewsletter({ baseUrl, cio, name, audience, beforeIds, fetchFn, sleep, signal }) {
  for (const delay of [2000, 5000, 10000]) {
    await cancellableSleep(delay, signal, sleep);
    let matches;
    try { matches = await listMatchingNewsletters({ baseUrl, cio, name, fetchFn }); }
    catch { continue; }
    const candidates = matches.filter((item) => !beforeIds.has(String(item.id))
      && item.sent_at == null
      && recipientMatches(item, audience.segmentId)
      && topicMatches(item, cio.subscriptionTopicId));
    if (candidates.length === 1) return candidates[0];
  }
  return undefined;
}

async function listMatchingNewsletters({ baseUrl, cio, name, fetchFn }) {
  const data = await customerIoGet({
    baseUrl,
    appApiKey: cio.appApiKey,
    path: '/v1/newsletters?limit=100&sort=desc',
    fetchFn,
    timeoutMs: cio.timeoutMs,
  });
  return (data?.newsletters || []).filter((item) => item?.name === name && Number(item?.id) > 0);
}

async function confirmRecovered({ recovered, record, remoteOperations, onCreated, name, audience, audienceCount, runId }) {
  const remoteId = String(recovered.id);
  remoteOperations.update('create-newsletter', { state: 'confirmed', remoteId, lastError: '' });
  await onCreated?.({ remoteId, title: name });
  return newsletterResult({
    newsletterId: remoteId,
    name,
    audience,
    audienceCount,
    deliveryWarnings: Number(record?.attempt_count || 0) > 1
      ? [`Customer.io 第二次创建请求经回读恢复，但第一次请求结果不明，可能存在同名重复草稿。任务:${runId}`]
      : [],
  });
}

function recipientMatches(newsletter, segmentId) {
  const ids = newsletter?.recipient_segment_ids;
  return Array.isArray(ids) && ids.map(Number).includes(Number(segmentId));
}

function topicMatches(newsletter, topicId) {
  return !topicId || Number(newsletter?.subscription_topic_id) === Number(topicId);
}

function parseIdSnapshot(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isAmbiguousCreateError(error) {
  return error?.ambiguousCreate === true;
}

async function cancellableSleep(ms, signal, sleep) {
  throwIfTaskCancelled(signal);
  if (!signal) return sleep(ms);
  let onAbort;
  try {
    await Promise.race([
      sleep(ms),
      new Promise((_, reject) => {
        onAbort = () => reject(cancellationErrorFromSignal(signal));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function newsletterResult({ newsletterId, name, audience, audienceCount, deliveryWarnings = [] }) {
  return {
    mediaId: `customerio-newsletter:${newsletterId}`,
    title: name,
    audienceStage: audience.stage,
    audienceSegmentId: audience.segmentId,
    audienceRecipientCount: audienceCount,
    deliveryWarnings,
  };
}

async function fetchNewsletterById({ baseUrl, appApiKey, id, fetchFn, timeoutMs }) {
  const numericId = Number(String(id).replace(/^customerio-newsletter:/, ''));
  if (!Number.isInteger(numericId) || numericId <= 0) throw publishError('Customer.io 已记录的 remote_id 无效');
  return customerIoGet({ baseUrl, appApiKey, path: `/v1/newsletters/${numericId}`, fetchFn, timeoutMs });
}

async function findNewsletterByName({ baseUrl, appApiKey, name, fetchFn, timeoutMs }) {
  const data = await customerIoGet({ baseUrl, appApiKey, path: '/v1/newsletters?limit=100&sort=desc', fetchFn, timeoutMs });
  const matches = (data?.newsletters || []).filter((item) => item?.name === name);
  if (matches.length > 1) throw publishError(`Customer.io 存在 ${matches.length} 个同名草稿，拒绝自动选择`);
  return matches[0];
}

async function customerIoGet({ baseUrl, appApiKey, path, fetchFn, timeoutMs }) {
  let response;
  let data;
  let detail = '';
  try {
    ({ response, data, detail } = await withRequestTimeout(timeoutMs, async (signal) => {
      const current = await fetchFn(`${baseUrl}${path}`, {
        method: 'GET', headers: { Authorization: `Bearer ${appApiKey}` }, signal,
      });
      if (!current.ok) return { response: current, detail: await safeText(current) };
      return { response: current, data: await current.json(), detail: '' };
    }));
  } catch (error) { throw publishError(`Customer.io 恢复查询失败:${requestErrorMessage(error)}`); }
  if (!response.ok) throw publishError(`Customer.io 恢复查询失败:${response.status} ${detail}`.trim());
  return data?.newsletter || data;
}

function assertRecoverableNewsletter(newsletter, name) {
  if (!newsletter || Number(newsletter.id) <= 0) throw publishError('Customer.io 恢复结果缺少 newsletter.id');
  if (newsletter.name !== name) throw publishError(`Customer.io 已有草稿名称不匹配:${newsletter.name || '无名称'}`);
  if (newsletter.sent_at != null) throw publishError('Customer.io 同名 Newsletter 已发送，拒绝把已发送内容当作草稿恢复');
}

function senderEmail(value) {
  const text = String(value || '').trim();
  const bracketed = text.match(/<([^<>]+)>\s*$/)?.[1];
  return String(bracketed || text).trim().toLowerCase();
}

function senderDomain(value) {
  const email = senderEmail(value);
  return email.includes('@') ? email.split('@').pop() : '';
}

export function unverifiedSendingDomainError(status, detail, from) {
  if (Number(status) !== 422) return '';

  let messages = String(detail || '');
  try {
    const parsed = JSON.parse(messages);
    messages = Array.isArray(parsed?.errors)
      ? parsed.errors.map((item) => item?.detail || '').join(' ')
      : messages;
  } catch {
    // Customer.io occasionally returns plain text; inspect it below as-is.
  }

  if (!/domain\s+.+has not been verified|unverified.+domain|verify.+domain/i.test(messages)) return '';
  const domain = senderDomain(from) || '发件域名';
  return [
    `Customer.io 发件域名 ${domain} 尚未在当前 workspace 完成验证。`,
    '已保留 support@zentradings.com，未自动改用其他发件人。',
    '请在 Customer.io 的 Settings → Workspace Settings → Email 中添加并验证 Sending Domain，DNS 生效后重试原任务。',
  ].join('\n');
}

export function resolveAudience(cio = {}) {
  const stage = String(cio.audienceStage || 'internal').trim().toLowerCase();
  if (!['internal', 'pilot', 'full'].includes(stage)) {
    throw publishError('NEWSLETTER_AUDIENCE_STAGE 必须是 internal、pilot 或 full');
  }
  if (stage === 'full' && cio.allowFullAudience !== true) {
    throw publishError('全量阶段需要显式设置 CUSTOMERIO_ALLOW_FULL_AUDIENCE=true');
  }
  const segmentId = cio.audienceSegmentIds?.[stage]
    || (stage === 'internal' ? cio.newsletterSegmentId : undefined);
  if (!Number.isInteger(segmentId) || segmentId <= 0) {
    const variable = {
      internal: 'CUSTOMERIO_INTERNAL_SEGMENT_ID',
      pilot: 'CUSTOMERIO_PILOT_SEGMENT_ID',
      full: 'CUSTOMERIO_FULL_SEGMENT_ID',
    }[stage];
    throw publishError(`缺少有效的 ${variable}`);
  }
  const maxRecipients = cio.audienceMaxRecipients?.[stage];
  return { stage, segmentId, maxRecipients };
}

async function fetchAudienceCount({ baseUrl, appApiKey, segmentId, fetchFn, timeoutMs }) {
  let response;
  let data;
  let detail = '';
  try {
    ({ response, data, detail } = await withRequestTimeout(timeoutMs, async (signal) => {
      const current = await fetchFn(`${baseUrl}/v1/segments/${segmentId}/customer_count`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${appApiKey}` },
        signal,
      });
      if (!current.ok) return { response: current, detail: await safeText(current) };
      return { response: current, data: await current.json(), detail: '' };
    }));
  } catch (error) {
    throw publishError(`Customer.io 受众预检失败:${requestErrorMessage(error)}`);
  }
  if (!response.ok) {
    throw publishError(`Customer.io 受众预检失败:${response.status} ${response.statusText || ''} ${detail}`.trim());
  }
  if (!Number.isInteger(data?.count) || data.count < 0) {
    throw publishError('Customer.io 受众预检返回无效人数');
  }
  return data.count;
}

function validateAudienceCount(audience, count) {
  if (count === 0) throw publishError(`Customer.io ${audience.stage} 受众为空，拒绝创建草稿`);
  if (Number.isInteger(audience.maxRecipients) && count > audience.maxRecipients) {
    throw publishError(
      `Customer.io ${audience.stage} 受众为 ${count} 人，超过配置上限 ${audience.maxRecipients} 人`,
    );
  }
}

function publishError(message) {
  const error = new Error(message);
  error.stage = 'publish';
  return error;
}

async function safeText(response) {
  try { return (await response.text()).slice(0, 1000); }
  catch { return ''; }
}

async function withRequestTimeout(timeoutMs = 30000, operation) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error('请求超时');
      error.name = 'AbortError';
      reject(error);
    }, timeoutMs);
  });
  try { return await Promise.race([operation(controller.signal), timeout]); }
  finally { clearTimeout(timer); }
}

function requestErrorMessage(error) {
  return error?.name === 'AbortError' ? '请求超时' : (error?.message || String(error));
}

export default makeChannel();
