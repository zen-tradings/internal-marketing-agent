import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUsEquitySession, easternDateKey } from '../src/lib/us-equity-calendar.js';
import { coverHtml, OPENING_COVER_HEIGHT, OPENING_COVER_WIDTH } from '../src/lib/opening-digest-cover.js';
import { makeChannel, renderOptionsHtml } from '../src/channels/customerio-opening-digest.js';
import { countTrendingRows } from '../src/lib/options-volume.js';

const ARTICLE = `---
title: Zen Opening Digest
subject: ignored by dedicated sender
preheader: Morning market signals.
edition: 2026-08-10
---
## Today's catalysts
- [A catalyst](https://example.com/a) matters.

## Market read
A falsifiable market read.`;

function response(data, { status = 200, headers = { 'content-type': 'application/json' } } = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (key) => headers[key.toLowerCase()] || '' }, async text() { return typeof data === 'string' ? data : JSON.stringify(data); } };
}

function config() {
  return {
    customerio: {
      appApiKey: 'cio-key', baseUrl: 'https://api.customer.test', timeoutMs: 30000,
      from: 'Zen Trading <support@zentradings.com>', companyAddress: '1 Market St',
      siteUrl: 'https://zentradings.com', contactEmail: 'support@zentradings.com', feedbackUrl: '',
    },
    openingDigest: {
      enabled: true, timezone: 'America/New_York', optionsUrl: 'https://options.example/table',
      storageStatePath: '/tmp/oic.json', browserExecutablePath: '/tmp/chrome', captureTimeoutMs: 45000,
      automationAuthorized: true, segmentId: 42, subscriptionTopicId: 19,
      assetFolderId: 8, eodCachePath: '/tmp/does-not-exist.json',
    },
  };
}

test('US equities calendar rejects weekends and recurring NYSE holidays', () => {
  assert.equal(isUsEquitySession(new Date('2026-07-04T16:00:00Z')), false);
  assert.equal(isUsEquitySession(new Date('2026-07-06T16:00:00Z')), true);
  assert.equal(easternDateKey(new Date('2026-08-10T14:00:00Z')), '2026-08-10');
});

test('iVolatility component text validates a complete native Top 20 without semantic table rows', () => {
  const text = ['As of today', 'Ticker Name Call Options Volume Put Options Volume Total Option Volume']
    .concat(Array.from({ length: 20 }, (_, index) => `${index + 1}\tT${index + 1}\tCompany ${index + 1}\t50 %\t50 %\t${1000 - index}`))
    .join('\n');
  assert.equal(countTrendingRows(text), 20);
  assert.equal(countTrendingRows(text.replace(/^20\t.*$/m, '')), 19);
});

test('opening cover keeps Zen title and uses date-specific digest line', () => {
  const html = coverHtml('August 10, 2026');
  assert.equal(OPENING_COVER_WIDTH, 1240);
  assert.equal(OPENING_COVER_HEIGHT, 620);
  assert.match(html, /Zen Research from Zen Trading/);
  assert.match(html, /OPENING DIGEST/);
  assert.match(html, /August 10, 2026/);
});

test('opening digest uploads cover/options, reuses Zen template and schedules the send', async () => {
  const requests = [];
  const uploads = [];
  const channel = makeChannel({
    readArticle: async () => ARTICLE,
    now: () => new Date('2026-08-10T13:00:00.000Z'),
    renderCover: async () => Buffer.from('cover'),
    captureOptions: async () => ({ buffer: Buffer.from('options'), capturedAt: '2026-08-10T14:15:00.000Z', rows: 20 }),
    uploadAsset: async (args) => { uploads.push(args.filename); return { id: uploads.length, path: `https://assets.example/${args.filename}` }; },
    collectMetrics: async () => [{ label: 'SPY', value: 640, prior: 630, changePct: 1.58 }],
    fetchFn: async (url, options = {}) => {
      requests.push({ url, options, body: options.body ? JSON.parse(options.body) : undefined });
      if (url.includes('/customer_count')) return response({ count: 4 });
      if (url.endsWith('/v1/segments/42')) return response({ segment: { id: 42, name: 'test 2' } });
      if (url.endsWith('/v1/newsletters')) return response({ newsletter: { id: 99 } });
      if (url.endsWith('/schedule')) return response({});
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  const result = await channel.publish({ articlePath: '/tmp/article.md', config: config(), workflow: {}, source: 'cron' });
  assert.equal(result.mediaId, 'customerio-newsletter:99');
  assert.deepEqual(uploads, ['opening-digest-cover-2026-08-10.png', 'opening-digest-options-2026-08-10-open.png']);
  const create = requests.find((item) => item.url.endsWith('/v1/newsletters'));
  assert.match(create.body.body, /data-zen-draft-template="zen-customerio\/zen-research@1"/);
  assert.match(create.body.body, /assets\.example\/opening-digest-options-2026-08-10-open\.png/);
  assert.equal(create.body.subscription_topic_id, 19);
  assert.ok(requests.some((item) => item.url.endsWith('/schedule')));
});

test('opening digest accepts any current audience size when the segment is test2', async () => {
  const requests = [];
  const channel = makeChannel({
    readArticle: async () => ARTICLE,
    renderCover: async () => Buffer.from('cover'),
    captureOptions: async () => ({ buffer: Buffer.from('options'), capturedAt: '2026-08-10T14:15:00.000Z', rows: 20 }),
    uploadAsset: async () => ({ id: 1, path: 'https://assets.example/image.png' }),
    collectMetrics: async () => [],
    fetchFn: async (url) => {
      requests.push(url);
      if (url.includes('/customer_count')) return response({ count: 37 });
      if (url.endsWith('/v1/segments/42')) return response({ segment: { id: 42, name: 'test2' } });
      if (url.endsWith('/v1/newsletters')) return response({ newsletter: { id: 100 } });
      if (url.endsWith('/send')) return response({});
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  const result = await channel.publish({ articlePath: '/tmp/article.md', config: config(), workflow: {}, source: 'manual' });
  assert.equal(result.audienceRecipientCount, 37);
  assert.ok(requests.some((url) => url.endsWith('/v1/newsletters/100/send')));
});

test('opening digest rejects a configured segment whose name is not test2', async () => {
  const channel = makeChannel({
    readArticle: async () => ARTICLE,
    fetchFn: async (url) => {
      if (url.includes('/customer_count')) return response({ count: 2 });
      if (url.endsWith('/v1/segments/42')) return response({ segment: { id: 42, name: 'customers' } });
      return response({});
    },
  });
  await assert.rejects(channel.publish({ articlePath: '/tmp/article.md', config: config(), workflow: {} }), /只能发送到 Customer\.io segment test2/);
});

test('opening digest reuses a persisted Customer.io newsletter id after a send retry', async () => {
  const requests = [];
  const channel = makeChannel({
    readArticle: async () => ARTICLE,
    now: () => new Date('2026-08-10T14:45:00.000Z'),
    renderCover: async () => Buffer.from('cover'),
    captureOptions: async () => ({ buffer: Buffer.from('options'), capturedAt: '2026-08-10T14:15:00.000Z', rows: 20 }),
    uploadAsset: async () => ({ id: 1, path: 'https://assets.example/image.png' }),
    collectMetrics: async () => [],
    fetchFn: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.includes('/customer_count')) return response({ count: 4 });
      if (url.endsWith('/v1/segments/42')) return response({ segment: { id: 42, name: 'test2' } });
      if (url.endsWith('/send')) return response({});
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  await channel.publish({ articlePath: '/tmp/article.md', config: config(), workflow: {}, source: 'manual', existingRemoteId: '99' });
  assert.equal(requests.some((item) => item.url.endsWith('/v1/newsletters')), false);
  assert.ok(requests.some((item) => item.url.endsWith('/v1/newsletters/99/send')));
});

test('options HTML contains the original-image link and the required short attribution only', () => {
  const html = renderOptionsHtml({ url: 'https://assets.example/options.png', capturedAt: '2026-08-10T14:15:00Z', kind: 'Opening' });
  assert.match(html, /assets\.example\/options\.png/);
  assert.match(html, /powered by iVolatility/);
  assert.doesNotMatch(html, /Catalyst for/);
});
