import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeChannel } from '../src/channels/customerio-draft.js';
import {
  NEWSLETTER_COMPANY_ADDRESS,
  NEWSLETTER_COMPANY_LINKEDIN_URL,
  NEWSLETTER_TEMPLATE_ID,
  parseNewsletterArticle,
  renderNewsletterEmail,
} from '../src/lib/newsletter-email.js';

const ARTICLE = `---
title: HBM supply is the bottleneck
subject: Zen Research from Zen Trading · Vol. 1 | HBM supply
preheader: Three signals we are watching this week.
edition: vol.1
---
## The takeaway
Demand remains strong and **supply matters**.

## What we're watching
- Lead times
- [Company filings](https://example.com/filing)`;

function config(overrides = {}) {
  return {
    customerio: {
      appApiKey: 'cio-key',
      baseUrl: 'https://api.customer.test',
      audienceStage: 'internal',
      audienceSegmentIds: { internal: 17, pilot: 18, full: 6 },
      audienceMaxRecipients: { internal: 10, pilot: 50 },
      allowFullAudience: false,
      newsletterSegmentId: 17,
      from: 'Zen Trading <support@zentradings.com>',
      siteUrl: 'https://zentradings.com',
      feedbackUrl: 'https://example.com/feedback',
      ...overrides,
    },
  };
}

test('newsletter article:规范化 Vol. 版号并渲染品牌/退订/反馈结构', () => {
  const parsed = parseNewsletterArticle(ARTICLE);
  assert.equal(parsed.edition, 'Vol. 1');
  const html = renderNewsletterEmail(parsed, config().customerio);
  assert.match(html, new RegExp(`data-zen-draft-template="${NEWSLETTER_TEMPLATE_ID}"`));
  assert.match(html, /ZEN RESEARCH FROM ZEN TRADING/);
  assert.equal(NEWSLETTER_COMPANY_ADDRESS, '700 Leahy St, Redwood City, CA 94061');
  assert.equal(NEWSLETTER_COMPANY_LINKEDIN_URL, 'https://www.linkedin.com/company/110921483');
  assert.match(html, /Zen Trading · 700 Leahy St, Redwood City, CA 94061/);
  assert.match(html, /href="https:\/\/www\.linkedin\.com\/company\/110921483"[^>]*>LinkedIn<\/a>/);
  assert.doesNotMatch(renderNewsletterEmail(parsed, { companyAddress: 'Old address' }), /Old address/);
  assert.doesNotMatch(renderNewsletterEmail(parsed, { linkedInUrl: 'https://example.com/override' }), /example\.com\/override/);
  assert.match(html, /HBM supply is the bottleneck/);
  assert.match(html, /\{% unsubscribe_url %\}/);
  assert.doesNotMatch(html, /\{\{ unsubscribe_url \}\}/);
  assert.match(html, /Satisfied/);
  assert.match(html, /Not satisfied/);
  assert.match(html, /rating=positive/);
  assert.match(html, /rating=negative/);
  assert.match(html, /edition=Vol\.\+1/);
  assert.match(html, /<strong>supply matters<\/strong>/);
  assert.match(html, /href="https:\/\/example\.com\/filing"/);
  assert.match(html, /@media screen and \(max-width:640px\)/);
  assert.match(html, /\.zen-email-shell \{ padding:8px 4px !important; \}/);
  assert.match(html, /\.zen-email-content \{ padding:20px 8px !important; \}/);
  assert.match(html, /class="zen-email-content" style="padding:24px 16px"/);
});

test('newsletter feedback:未配置反馈页时退化为可追踪 mailto 按钮', () => {
  const parsed = parseNewsletterArticle(ARTICLE);
  const html = renderNewsletterEmail(parsed, config({
    feedbackUrl: '',
    contactEmail: 'research@example.com',
  }).customerio);
  assert.match(html, /mailto:research@example\.com\?subject=/);
  assert.match(html, /Zen%20Research%20feedback%3A%20satisfied/);
  assert.match(html, /Zen%20Research%20feedback%3A%20not%20satisfied/);
});

test('Customer.io channel:只创建内部 segment 草稿,绝不夹带发送或排期字段', async () => {
  const requests = [];
  const channel = makeChannel({
    readArticle: async () => ARTICLE,
    fetchFn: async (url, options) => {
      requests.push({ url, options, payload: options.body ? JSON.parse(options.body) : undefined });
      if (options.method === 'GET') {
        return { ok: true, status: 200, async json() { return { segment_id: 17, count: 3 }; } };
      }
      return { ok: true, status: 200, statusText: 'OK', async json() { return { newsletter: { id: 41 } }; } };
    },
  });
  const result = await channel.publish({ articlePath: '/tmp/article.md', config: config(), workflow: { edition: 'Vol. 1' } });
  const [preflight, request] = requests;

  assert.equal(result.mediaId, 'customerio-newsletter:41');
  assert.equal(result.title, 'Zen Research from Zen Trading · Vol. 1');
  assert.equal(result.audienceStage, 'internal');
  assert.equal(result.audienceSegmentId, 17);
  assert.equal(result.audienceRecipientCount, 3);
  assert.equal(channel.templateId, NEWSLETTER_TEMPLATE_ID);
  assert.equal(channel.templateLocked, true);
  assert.match(request.payload.body, new RegExp(`data-zen-draft-template="${NEWSLETTER_TEMPLATE_ID}"`));
  assert.equal(preflight.url, 'https://api.customer.test/v1/segments/17/customer_count');
  assert.equal(preflight.options.method, 'GET');
  assert.equal(request.url, 'https://api.customer.test/v1/newsletters');
  assert.equal(request.options.headers.Authorization, 'Bearer cio-key');
  assert.deepEqual(request.payload.recipients, {
    and: [{ or: [{ segment: { id: 17 } }] }],
  });
  assert.equal(request.payload.type, 'email');
  assert.equal(request.payload.subject, 'Zen Research from Zen Trading · Vol. 1 | HBM supply');
  assert.equal(request.payload.from, 'Zen Trading <support@zentradings.com>');
  assert.ok(!('send_now' in request.payload));
  assert.ok(!('scheduled_at' in request.payload));
});

test('Customer.io channel:创建后立即持久化 remote id，恢复任务不重复 POST', async () => {
  const created = [];
  let posts = 0;
  const channel = makeChannel({
    readArticle: async () => ARTICLE,
    fetchFn: async (url, options) => {
      if (url.endsWith('/customer_count')) return { ok: true, status: 200, async json() { return { count: 3 }; } };
      if (options.method === 'POST') {
        posts += 1;
        return { ok: true, status: 200, async json() { return { newsletter: { id: 41 } }; } };
      }
      return { ok: true, status: 200, async json() { return { newsletter: { id: 41, name: 'Zen Research from Zen Trading · Vol. 1', sent_at: null } }; } };
    },
  });
  await channel.publish({ articlePath: '/tmp/article.md', config: config(), workflow: { edition: 'Vol. 1' }, onCreated: (value) => created.push(value) });
  const recovered = await channel.publish({
    articlePath: '/tmp/article.md', config: config(), workflow: { edition: 'Vol. 1' },
    existingRemoteId: '41', onCreated: (value) => created.push(value), resumeFromCheckpoint: true,
  });
  assert.equal(posts, 1);
  assert.equal(recovered.mediaId, 'customerio-newsletter:41');
  assert.equal(created.length, 2);
});

test('Customer.io channel:正文含真实密钥或本地路径时在上传前拦截', async () => {
  let postCalled = false;
  const channel = makeChannel({
    readArticle: async () => `${ARTICLE}\n/tmp/private\ncio-super-secret`,
    fetchFn: async (_url, options) => {
      if (options.method === 'POST') postCalled = true;
      return { ok: true, status: 200, async json() { return { count: 3 }; } };
    },
  });
  await assert.rejects(() => channel.publish({
    articlePath: '/tmp/article.md', config: config({ appApiKey: 'cio-super-secret' }), workflow: { edition: 'Vol. 1' },
  }), /出口门禁拦截.*真实凭据.*本地路径/);
  assert.equal(postCalled, false);
});

test('Customer.io channel:发件邮箱不是 support@zentradings.com 时在网络请求前拦截', async () => {
  let calls = 0;
  const channel = makeChannel({ readArticle: async () => ARTICLE, fetchFn: async () => { calls++; } });
  await assert.rejects(
    channel.publish({ articlePath: '/tmp/article.md', config: config({ from: 'Other <other@example.com>' }) }),
    /发件邮箱必须统一为 support@zentradings\.com/,
  );
  assert.equal(calls, 0);
});

test('Customer.io channel:未验证发件域名时返回可操作提示且不切换发件人', async () => {
  const requests = [];
  const channel = makeChannel({
    readArticle: async () => ARTICLE,
    fetchFn: async (url, options) => {
      requests.push({ url, options, payload: options.body ? JSON.parse(options.body) : undefined });
      if (options.method === 'GET') {
        return { ok: true, status: 200, async json() { return { segment_id: 17, count: 3 }; } };
      }
      return {
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        async text() {
          return JSON.stringify({
            errors: [{ detail: 'domain "zentradings.com" has not been verified in this workspace' }],
          });
        },
      };
    },
  });

  await assert.rejects(
    channel.publish({ articlePath: '/tmp/article.md', config: config(), workflow: { edition: 'Vol. 1' } }),
    (error) => {
      assert.equal(error.stage, 'publish');
      assert.match(error.message, /发件域名 zentradings\.com 尚未在当前 workspace 完成验证/);
      assert.match(error.message, /保留 support@zentradings\.com/);
      assert.match(error.message, /Settings → Workspace Settings → Email/);
      assert.doesNotMatch(error.message, /unknown|"errors"/);
      return true;
    },
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[1].payload.from, 'Zen Trading <support@zentradings.com>');
});

test('Customer.io channel:缺 segment 时在网络请求前拦截', async () => {
  let calls = 0;
  const channel = makeChannel({ readArticle: async () => ARTICLE, fetchFn: async () => { calls++; } });
  await assert.rejects(
    channel.publish({ articlePath: '/tmp/article.md', config: config({
      newsletterSegmentId: undefined,
      audienceSegmentIds: { internal: undefined, pilot: 18, full: 6 },
    }) }),
    /CUSTOMERIO_INTERNAL_SEGMENT_ID/,
  );
  assert.equal(calls, 0);
});

test('Customer.io channel:Pilot 为空或超过上限时只做预检,不创建草稿', async () => {
  for (const [count, message] of [[0, /受众为空/], [51, /超过配置上限 50 人/]]) {
    const calls = [];
    const channel = makeChannel({
      readArticle: async () => ARTICLE,
      fetchFn: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: 200, async json() { return { segment_id: 18, count }; } };
      },
    });
    await assert.rejects(
      channel.publish({ articlePath: '/tmp/article.md', config: config({
        audienceStage: 'pilot',
        newsletterSegmentId: 18,
      }) }),
      message,
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /segments\/18\/customer_count$/);
  }
});

test('Customer.io channel:全量阶段没有显式解锁时在网络请求前拦截', async () => {
  let calls = 0;
  const channel = makeChannel({ readArticle: async () => ARTICLE, fetchFn: async () => { calls++; } });
  await assert.rejects(
    channel.publish({ articlePath: '/tmp/article.md', config: config({
      audienceStage: 'full',
      newsletterSegmentId: 6,
      allowFullAudience: false,
    }) }),
    /CUSTOMERIO_ALLOW_FULL_AUDIENCE=true/,
  );
  assert.equal(calls, 0);
});

test('Customer.io channel:Pilot/full 不能回退到旧的单一 segment ID', async () => {
  let calls = 0;
  const channel = makeChannel({ readArticle: async () => ARTICLE, fetchFn: async () => { calls++; } });
  await assert.rejects(
    channel.publish({ articlePath: '/tmp/article.md', config: config({
      audienceStage: 'pilot',
      audienceSegmentIds: { internal: 17 },
      newsletterSegmentId: 17,
    }) }),
    /CUSTOMERIO_PILOT_SEGMENT_ID/,
  );
  assert.equal(calls, 0);
});

test('Newsletter 查询参数链接不会被双重转义', () => {
  const article = parseNewsletterArticle('---\ntitle: T\n---\n[Link](https://example.com/a?x=1&y=2)');
  const html = renderNewsletterEmail(article);
  assert.match(html, /href="https:\/\/example\.com\/a\?x=1&amp;y=2"/);
  assert.doesNotMatch(html, /amp;amp/);
});
