import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeChannel } from '../src/channels/customerio-draft.js';
import { parseNewsletterArticle, renderNewsletterEmail } from '../src/lib/newsletter-email.js';

const ARTICLE = `---
title: HBM supply is the bottleneck
subject: Zen Trading Newsletter · Vol. 1 | HBM supply
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
      from: 'Zen Trading <newsletter@example.com>',
      companyAddress: '123 Market Street, San Francisco, CA',
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
  assert.match(html, /ZEN TRADING NEWSLETTER · VOL\. 1/);
  assert.match(html, /HBM supply is the bottleneck/);
  assert.match(html, /\{% unsubscribe_url %\}/);
  assert.doesNotMatch(html, /\{\{ unsubscribe_url \}\}/);
  assert.match(html, /Share feedback/);
  assert.match(html, /<strong>supply matters<\/strong>/);
  assert.match(html, /href="https:\/\/example\.com\/filing"/);
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
  assert.equal(result.title, 'Zen Trading Newsletter · Vol. 1');
  assert.equal(result.audienceStage, 'internal');
  assert.equal(result.audienceSegmentId, 17);
  assert.equal(result.audienceRecipientCount, 3);
  assert.equal(preflight.url, 'https://api.customer.test/v1/segments/17/customer_count');
  assert.equal(preflight.options.method, 'GET');
  assert.equal(request.url, 'https://api.customer.test/v1/newsletters');
  assert.equal(request.options.headers.Authorization, 'Bearer cio-key');
  assert.deepEqual(request.payload.recipients, {
    and: [{ or: [{ segment: { id: 17 } }] }],
  });
  assert.equal(request.payload.type, 'email');
  assert.equal(request.payload.subject, 'Zen Trading Newsletter · Vol. 1 | HBM supply');
  assert.ok(!('send_now' in request.payload));
  assert.ok(!('scheduled_at' in request.payload));
});

test('Customer.io channel:缺 segment 或公司地址时在网络请求前拦截', async () => {
  let calls = 0;
  const channel = makeChannel({ readArticle: async () => ARTICLE, fetchFn: async () => { calls++; } });
  await assert.rejects(
    channel.publish({ articlePath: '/tmp/article.md', config: config({
      newsletterSegmentId: undefined,
      audienceSegmentIds: { internal: undefined, pilot: 18, full: 6 },
    }) }),
    /CUSTOMERIO_INTERNAL_SEGMENT_ID/,
  );
  await assert.rejects(
    channel.publish({ articlePath: '/tmp/article.md', config: config({ companyAddress: '' }) }),
    /CUSTOMERIO_COMPANY_ADDRESS/,
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
