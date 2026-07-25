import fs from 'node:fs/promises';
import {
  NEWSLETTER_TEMPLATE_ID,
  parseNewsletterArticle,
  renderNewsletterEmail,
} from '../lib/newsletter-email.js';
import { assertRenderedTemplateMarker } from '../lib/draft-template.js';

export const NEWSLETTER_SENDER_EMAIL = 'support@zentradings.com';

async function defaultReadArticle(articlePath) {
  return fs.readFile(articlePath, 'utf8');
}

export function makeChannel({ readArticle = defaultReadArticle, fetchFn = globalThis.fetch } = {}) {
  return {
    id: 'customerio-draft',
    templateId: NEWSLETTER_TEMPLATE_ID,
    templateLocked: true,
    async publish({ articlePath, config, workflow }) {
      const cio = config.customerio || {};
      if (!cio.appApiKey) throw publishError('缺少 CUSTOMERIO_APP_API_KEY');
      const audience = resolveAudience(cio);
      if (!cio.from) throw publishError('缺少 CUSTOMERIO_NEWSLETTER_FROM');
      if (senderEmail(cio.from) !== NEWSLETTER_SENDER_EMAIL) {
        throw publishError(`Customer.io 发件邮箱必须统一为 ${NEWSLETTER_SENDER_EMAIL}`);
      }
      if (!cio.companyAddress) throw publishError('缺少 CUSTOMERIO_COMPANY_ADDRESS');

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

      const article = parseNewsletterArticle(markdown, workflow?.edition || cio.edition || 'Vol. 1');
      const name = `Zen Research from Zen Trading · ${article.edition}`;
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

      let response;
      let data;
      let detail = '';
      try {
        ({ response, data, detail } = await withRequestTimeout(cio.timeoutMs, async (signal) => {
          const current = await fetchFn(`${baseUrl}/v1/newsletters`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${cio.appApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal,
          });
          if (!current.ok) return { response: current, detail: await safeText(current) };
          return { response: current, data: await current.json(), detail: '' };
        }));
      } catch (error) { throw publishError(`Customer.io 请求失败:${requestErrorMessage(error)}`); }

      if (!response.ok) {
        const domainError = unverifiedSendingDomainError(response.status, detail, cio.from);
        if (domainError) throw publishError(domainError);
        throw publishError(`Customer.io 创建草稿失败:${response.status} ${response.statusText || ''} ${detail}`.trim());
      }
      const newsletterId = data?.newsletter?.id;
      if (!newsletterId) throw publishError('Customer.io 返回成功但缺少 newsletter.id');
      return {
        mediaId: `customerio-newsletter:${newsletterId}`,
        title: name,
        audienceStage: audience.stage,
        audienceSegmentId: audience.segmentId,
        audienceRecipientCount: audienceCount,
      };
    },
  };
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
