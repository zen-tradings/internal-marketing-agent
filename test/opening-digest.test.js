import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { isUsEquitySession, easternDateKey } from '../src/lib/us-equity-calendar.js';
import { coverHtml, OPENING_COVER_HEIGHT, OPENING_COVER_WIDTH } from '../src/lib/opening-digest-cover.js';
import { cacheEodOptions, makeChannel, renderOptionsHtml } from '../src/channels/customerio-opening-digest.js';
import { countTrendingRows, validateTrendingOptionsData } from '../src/lib/options-volume.js';

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

const OPTIONS_DATA = {
  asOf: 'As of 10 Aug 2026, 10:15:00 EDT',
  headers: ['', 'Ticker', 'Name', 'Call Options Volume (%)', 'Put Options Volume (%)', 'Total Option Volume', 'IVX 30', 'IVX Change %'],
  rows: Array.from({ length: 20 }, (_, index) => [
    String(index + 1), `T${index + 1}`, `Company ${index + 1}`,
    '50.00 %', '50.00 %', (1_000_000 - index * 10_000).toLocaleString('en-US'),
    (20 + index / 10).toFixed(2), index % 3 === 0 ? '-0.10' : index % 3 === 1 ? '0' : '0.10',
  ]),
  attribution: 'Data provided by IVolatility',
};

function capturedOptions(overrides = {}) {
  return {
    buffer: Buffer.from('discarded screenshot'), capturedAt: '2026-08-10T14:15:00.000Z',
    rows: 20, data: OPTIONS_DATA, ...overrides,
  };
}

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

test('structured options data requires exact headers, twenty ordered rows, and coherent values', () => {
  assert.deepEqual(validateTrendingOptionsData(OPTIONS_DATA), OPTIONS_DATA);
  const badRank = structuredClone(OPTIONS_DATA);
  badRank.rows[4][0] = '6';
  assert.throws(() => validateTrendingOptionsData(badRank), /排名必须连续/);
  const badPercent = structuredClone(OPTIONS_DATA);
  badPercent.rows[0][3] = '49.00 %';
  assert.throws(() => validateTrendingOptionsData(badPercent), /call\/put 百分比无效/);
  const badVolumeOrder = structuredClone(OPTIONS_DATA);
  badVolumeOrder.rows[1][5] = '2,000,000';
  assert.throws(() => validateTrendingOptionsData(badVolumeOrder), /总成交量排序或数值无效/);
});

test('opening cover keeps Zen title and uses date-specific digest line', () => {
  const html = coverHtml('August 10, 2026');
  assert.equal(OPENING_COVER_WIDTH, 1240);
  assert.equal(OPENING_COVER_HEIGHT, 620);
  assert.match(html, /Zen Research from Zen Trading/);
  assert.match(html, /OPENING DIGEST/);
  assert.match(html, /August 10, 2026/);
});

test('opening digest uploads only its cover, renders options as text, reuses Zen template and schedules the send', async () => {
  const requests = [];
  const uploads = [];
  const channel = makeChannel({
    readArticle: async () => ARTICLE,
    now: () => new Date('2026-08-10T13:00:00.000Z'),
    renderCover: async () => Buffer.from('cover'),
    captureOptions: async () => capturedOptions(),
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
  assert.deepEqual(uploads, ['opening-digest-cover-2026-08-10.png']);
  const create = requests.find((item) => item.url.endsWith('/v1/newsletters'));
  assert.match(create.body.body, /data-zen-draft-template="zen-customerio\/zen-research@1"/);
  assert.match(create.body.body, /<table role="table" aria-label="OIC Trending Options Volume top twenty"/);
  assert.match(create.body.body, /Company 20/);
  assert.doesNotMatch(create.body.body, /opening-digest-options-.*\.png/);
  assert.equal(create.body.subscription_topic_id, 19);
  assert.ok(requests.some((item) => item.url.endsWith('/schedule')));
});

test('opening digest accepts any current audience size when the segment is test2', async () => {
  const requests = [];
  const channel = makeChannel({
    readArticle: async () => ARTICLE,
    renderCover: async () => Buffer.from('cover'),
    captureOptions: async () => capturedOptions(),
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

test('manual Slack digest always captures the live page and labels off-session data latest available', async () => {
  const requests = [];
  const uploads = [];
  let captures = 0;
  const channel = makeChannel({
    readArticle: async () => ARTICLE,
    now: () => new Date('2026-08-08T15:30:00.000Z'),
    renderCover: async () => Buffer.from('cover'),
    captureOptions: async () => { captures += 1; return capturedOptions({ capturedAt: '2026-08-08T15:29:00.000Z' }); },
    uploadAsset: async (args) => { uploads.push(args.filename); return { id: uploads.length, path: `https://assets.example/${args.filename}` }; },
    collectMetrics: async () => [],
    fetchFn: async (url, options = {}) => {
      requests.push({ url, body: options.body ? JSON.parse(options.body) : undefined });
      if (url.includes('/customer_count')) return response({ count: 2 });
      if (url.endsWith('/v1/segments/42')) return response({ segment: { id: 42, name: 'test2' } });
      if (url.endsWith('/v1/newsletters')) return response({ newsletter: { id: 101 } });
      if (url.endsWith('/send')) return response({});
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  await channel.publish({ articlePath: '/tmp/article.md', config: config(), workflow: {}, source: 'manual' });
  assert.equal(captures, 1);
  assert.deepEqual(uploads, ['opening-digest-cover-2026-08-08.png']);
  const create = requests.find((item) => item.url.endsWith('/v1/newsletters'));
  assert.match(create.body.body, /Latest available capture/);
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
    captureOptions: async () => capturedOptions(),
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

test('options HTML reproduces all source values as text without an image or media-query dependency', () => {
  const html = renderOptionsHtml({ data: OPTIONS_DATA, capturedAt: '2026-08-10T14:15:00Z', kind: 'Opening' });
  const document = new JSDOM(html).window.document;
  const groups = [...document.querySelectorAll('tbody')];
  assert.match(html, /As of 10 Aug 2026, 10:15:00 EDT/);
  assert.match(html, /Data provided by IVolatility/);
  assert.match(html, /Company 20/);
  assert.match(html, /IVX change %/);
  assert.equal(groups.length, 20);
  for (let index = 0; index < OPTIONS_DATA.rows.length; index++) {
    const rendered = groups[index].textContent.replace(/\s+/g, ' ').trim();
    for (const sourceValue of OPTIONS_DATA.rows[index]) assert.ok(rendered.includes(sourceValue), `${sourceValue} missing from row ${index + 1}`);
  }
  assert.doesNotMatch(html, /<img\b/i);
  assert.doesNotMatch(html, /@media/i);
  assert.ok(Buffer.byteLength(html) < 70 * 1024);
});

test('options HTML escapes provider text and applies change colors from validated numeric values', () => {
  const data = structuredClone(OPTIONS_DATA);
  data.rows[0][2] = '<img src=x onerror=alert(1)>';
  const html = renderOptionsHtml({ data, capturedAt: '2026-08-10T14:15:00Z', kind: 'Opening' });
  assert.doesNotMatch(html, /<img\b/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /color:#b42318/);
  assert.match(html, /color:#167a45/);
});

test('opening digest fails closed before creating a newsletter when options validation fails', async () => {
  const requests = [];
  const bad = structuredClone(OPTIONS_DATA);
  bad.rows.pop();
  const channel = makeChannel({
    readArticle: async () => ARTICLE,
    renderCover: async () => Buffer.from('cover'),
    captureOptions: async () => capturedOptions({ data: bad }),
    uploadAsset: async () => ({ id: 1, path: 'https://assets.example/cover.png' }),
    collectMetrics: async () => [],
    fetchFn: async (url) => {
      requests.push(url);
      if (url.includes('/customer_count')) return response({ count: 2 });
      if (url.endsWith('/v1/segments/42')) return response({ segment: { id: 42, name: 'test2' } });
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  await assert.rejects(channel.publish({ articlePath: '/tmp/article.md', config: config(), workflow: {} }), /必须恰好包含20行/);
  assert.equal(requests.some((url) => url.endsWith('/v1/newsletters')), false);
});

test('EOD cache retains validated table data but never the discarded screenshot', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-options-eod-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const articlePath = path.join(directory, 'article.json');
  const cachePath = path.join(directory, 'cache.json');
  await fs.writeFile(articlePath, JSON.stringify({
    dateKey: '2026-08-10', capturedAt: '2026-08-10T20:20:00Z',
    data: OPTIONS_DATA, png: 'must-not-be-retained',
  }));
  const currentConfig = config();
  currentConfig.openingDigest.eodCachePath = cachePath;
  const result = await cacheEodOptions({ articlePath, config: currentConfig });
  const saved = JSON.parse(await fs.readFile(cachePath, 'utf8'));
  assert.equal(result.mediaId, 'opening-digest-eod:2026-08-10');
  assert.deepEqual(saved.data, OPTIONS_DATA);
  assert.equal(saved.png, undefined);
  assert.equal(saved.url, undefined);
});
