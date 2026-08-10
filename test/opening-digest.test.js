import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { isUsEquitySession, easternDateKey } from '../src/lib/us-equity-calendar.js';
import {
  coverHtml,
  loadOpeningCoverBackground,
  OPENING_COVER_BACKGROUND_HEIGHT,
  OPENING_COVER_BACKGROUND_SHA256,
  OPENING_COVER_BACKGROUND_WIDTH,
  OPENING_COVER_HEIGHT,
  OPENING_COVER_WIDTH,
} from '../src/lib/opening-digest-cover.js';
import { cacheEodOptions, makeChannel, renderOptionsHtml } from '../src/channels/customerio-opening-digest.js';
import { countTrendingRows, validateTrendingOptionsData } from '../src/lib/options-volume.js';
import { collectOpeningMetrics, validateOpeningMetrics } from '../src/lib/opening-digest-metrics.js';
import {
  openingDigestResearchQueries,
  openingDigestSearchInput,
  previousRegularClose,
  validateOpeningDigestArticle,
} from '../src/lib/opening-digest-content.js';

const ARTICLE = `---
title: Zen Opening Digest
subject: ignored by dedicated sender
preheader: Morning market signals.
edition: 2026-08-10
---
## Today's catalysts
- [A catalyst](https://example.com/a) has a concrete and material implication for today's US equity opening session.
- [Another catalyst](https://example.com/b) has a concrete and material implication for today's US equity opening session.
- [Third catalyst](https://example.com/c) has a distinct and sufficiently detailed implication for today's US equity opening session.

## Market read
A restrained and falsifiable market read that clearly states the condition that would invalidate the opening interpretation during today's session.`;

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

function openingMetrics() {
  return ['SPY', 'QQQ', 'IWM', 'VIX', '2Y UST', '10Y UST', 'DXY', 'WTI', 'Gold']
    .map((label, index) => ({ label, symbol: label, value: 100 + index, prior: 99 + index, changePct: 1 }));
}

function response(data, { status = 200, headers = { 'content-type': 'application/json' } } = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (key) => headers[key.toLowerCase()] || '' }, async text() { return typeof data === 'string' ? data : JSON.stringify(data); } };
}

function customerIoContents() {
  return { contents: [{ id: 1, type: 'email', body: '<html>digest</html>', layout: '{{ content }}\n<a href="{% unsubscribe_url %}">Unsubscribe</a>' }] };
}

function config() {
  return {
    customerio: {
      appApiKey: 'cio-key', baseUrl: 'https://api.customer.test', timeoutMs: 30000,
      from: 'Zen Trading <support@zentradings.com>',
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

test('opening digest research uses a market-specific query and the prior regular close window', () => {
  const now = new Date('2026-08-10T14:15:00.000Z');
  assert.equal(previousRegularClose(now).toISOString(), '2026-08-07T20:00:00.000Z');
  assert.equal(previousRegularClose(new Date('2026-07-06T14:15:00.000Z')).toISOString(), '2026-07-02T20:00:00.000Z');
  assert.equal(previousRegularClose(new Date('2026-01-05T15:15:00.000Z')).toISOString(), '2026-01-02T21:00:00.000Z');
  assert.match(openingDigestSearchInput(now), /US equity opening digest for 2026-08-10/);
  assert.doesNotMatch(openingDigestSearchInput(now), /today's Zen/i);
  const queries = openingDigestResearchQueries(now);
  assert.equal(queries.length, 3);
  assert.ok(queries.every((query) => query.startPublishedDate === '2026-08-07T20:00:00.000Z'));
  assert.ok(queries.every((query) => query.endPublishedDate === now.toISOString()));
});

test('opening digest content gate requires 3-5 unique current-window catalysts', () => {
  const now = new Date('2026-08-10T14:15:00.000Z');
  const research = ['a', 'b', 'c'].map((id, index) => ({
    url: `https://example.com/${id}`,
    publishedDate: new Date(now.getTime() - (index + 1) * 60_000).toISOString(),
  }));
  assert.equal(validateOpeningDigestArticle({
    article: ARTICLE, research, asOf: now, requireFreshSources: true,
  }).catalystCount, 3);
  assert.throws(() => validateOpeningDigestArticle({
    article: ARTICLE.replace(research[0].url, 'https://example.com/unmatched'),
    research, asOf: now, requireFreshSources: true,
  }), /未匹配到本次检索来源/);
  const stale = ARTICLE.replace('has a concrete and material implication for today\'s US equity opening session.', 'is background rather than a current-window catalyst.');
  assert.throws(() => validateOpeningDigestArticle({ article: stale, asOf: now }), /旧闻或背景/);
});

test('opening metrics uses the Treasury daily 2Y series and requires at least eight valid cards', async () => {
  const metrics = await collectOpeningMetrics({
    now: () => new Date('2026-08-10T14:15:00.000Z'),
    fetchFn: async (url) => {
      if (String(url).includes('home.treasury.gov')) return {
        ok: true,
        async text() { return 'Date,"2 Yr"\n08/07/2026,4.19\n08/06/2026,4.14\n'; },
      };
      return {
        ok: true,
        async json() {
          return { chart: { result: [{
            regularMarketTime: 1786371300,
            timestamp: [1786284900, 1786371300],
            indicators: { quote: [{ close: [100, 101] }] },
          }] } };
        },
      };
    },
  });
  assert.equal(metrics.find((metric) => metric.label === '2Y UST').value, 4.19);
  assert.match(metrics.find((metric) => metric.label === '2Y UST').sourceNote, /Treasury daily par yield/);
  assert.equal(validateOpeningMetrics(metrics), metrics);
  assert.throws(() => validateOpeningMetrics(metrics.map((metric, index) => index < 2 ? { ...metric, unavailable: true } : metric)), /可用数据不足/);
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

test('opening cover locks the supplied brand artwork and overlays only digest name and date', async () => {
  const background = await loadOpeningCoverBackground();
  assert.ok(background.length > 1_000_000);
  assert.equal(OPENING_COVER_BACKGROUND_WIDTH, 1774);
  assert.equal(OPENING_COVER_BACKGROUND_HEIGHT, 887);
  assert.equal(OPENING_COVER_BACKGROUND_SHA256, '44436cfdf3e7b9dc17aba36fe61c5c8a891cf08885c8887722a907225866e300');
  const html = coverHtml('August 10, 2026', { backgroundDataUrl: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.equal(OPENING_COVER_WIDTH, 1240);
  assert.equal(OPENING_COVER_HEIGHT, 620);
  assert.match(html, /data-cover-background/);
  assert.match(html, /Opening Digest/);
  assert.match(html, /August 10, 2026/);
  assert.doesNotMatch(html, /radial-gradient|class="brand"|class="title"|SUPPLY CHAINS/);
  assert.throws(() => coverHtml(''), /日期无效/);
  assert.throws(() => coverHtml('August 10, 2026', { backgroundDataUrl: 'https://example.com/cover.png' }), /内联 PNG/);
  await assert.rejects(
    loadOpeningCoverBackground({ readFile: async () => Buffer.from('not a png') }),
    /签名无效/,
  );
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
    collectMetrics: async () => openingMetrics(),
    fetchFn: async (url, options = {}) => {
      requests.push({ url, options, body: options.body ? JSON.parse(options.body) : undefined });
      if (url.includes('/customer_count')) return response({ count: 4 });
      if (url.endsWith('/v1/segments/42')) return response({ segment: { id: 42, name: 'test 2' } });
      if (url.endsWith('/v1/newsletters')) return response({ newsletter: { id: 99 } });
      if (url.endsWith('/v1/newsletters/99/contents')) return response(customerIoContents());
      if (url.endsWith('/schedule')) return response({});
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  const result = await channel.publish({ articlePath: '/tmp/article.md', config: config(), workflow: {}, source: 'cron' });
  assert.equal(result.mediaId, 'customerio-newsletter:99');
  assert.deepEqual(uploads, ['opening-digest-cover-2026-08-10.png']);
  const create = requests.find((item) => item.url.endsWith('/v1/newsletters'));
  assert.match(create.body.body, /data-zen-draft-template="zen-customerio\/zen-research@3"/);
  assert.match(create.body.body, /Zen Trading · 700 Leahy St/);
  assert.match(create.body.body, /<table role="table" aria-label="OIC Trending Options Volume top twenty"/);
  assert.match(create.body.body, /Company 20/);
  assert.doesNotMatch(create.body.body, /opening-digest-options-.*\.png/);
  assert.doesNotMatch(create.body.body, /unsubscribe_url/);
  assert.equal(create.body.subscription_topic_id, 19);
  const schedule = requests.find((item) => item.url.endsWith('/schedule'));
  assert.equal(schedule.body.scheduled_at, Date.parse('2026-08-10T14:30:00.000Z') / 1000);
  assert.equal(schedule.body.timezone, 'America/New_York');
  assert.equal(schedule.body.tz_match_enabled, false);
});

test('opening digest fails closed before newsletter creation when the locked cover cannot render or upload', async () => {
  for (const setup of [
    { renderCover: async () => { throw new Error('background checksum mismatch'); } },
    {
      renderCover: async () => Buffer.from('cover'),
      uploadAsset: async () => ({ id: 1, path: '' }),
    },
  ]) {
    const requests = [];
    const channel = makeChannel({
      readArticle: async () => ARTICLE,
      now: () => new Date('2026-08-10T14:15:00.000Z'),
      collectMetrics: async () => openingMetrics(),
      captureOptions: async () => capturedOptions(),
      uploadAsset: async () => ({ id: 1, path: 'https://assets.example/cover.png' }),
      ...setup,
      fetchFn: async (url) => {
        requests.push(url);
        if (url.includes('/customer_count')) return response({ count: 2 });
        if (url.endsWith('/v1/segments/42')) return response({ segment: { id: 42, name: 'test2' } });
        throw new Error(`Unexpected URL ${url}`);
      },
    });
    await assert.rejects(
      channel.publish({ articlePath: '/tmp/article.md', config: config(), workflow: {} }),
      /background checksum mismatch|未返回 Opening Digest 封面 HTTPS URL/,
    );
    assert.equal(requests.some((url) => url.endsWith('/v1/newsletters')), false);
  }
});

test('opening digest accepts any nonempty test2 audience and a late cron run sends immediately', async () => {
  const requests = [];
  const channel = makeChannel({
    readArticle: async () => ARTICLE,
    now: () => new Date('2026-08-10T14:45:00.000Z'),
    renderCover: async () => Buffer.from('cover'),
    captureOptions: async () => capturedOptions(),
    uploadAsset: async () => ({ id: 1, path: 'https://assets.example/image.png' }),
    collectMetrics: async () => openingMetrics(),
    fetchFn: async (url) => {
      requests.push(url);
      if (url.includes('/customer_count')) return response({ count: 37 });
      if (url.endsWith('/v1/segments/42')) return response({ segment: { id: 42, name: 'test2' } });
      if (url.endsWith('/v1/newsletters')) return response({ newsletter: { id: 100 } });
      if (url.endsWith('/v1/newsletters/100/contents')) return response(customerIoContents());
      if (url.endsWith('/send')) return response({});
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  const result = await channel.publish({ articlePath: '/tmp/article.md', config: config(), workflow: {}, source: 'cron' });
  assert.equal(result.audienceRecipientCount, 37);
  assert.ok(requests.some((url) => url.endsWith('/v1/newsletters/100/send')));
});

test('manual Slack digest always captures the live page and labels off-session data latest available', async () => {
  const requests = [];
  const uploads = [];
  let captures = 0;
  const channel = makeChannel({
    readArticle: async () => ARTICLE.replaceAll('2026-08-10', '2026-08-08'),
    now: () => new Date('2026-08-08T15:30:00.000Z'),
    renderCover: async () => Buffer.from('cover'),
    captureOptions: async () => { captures += 1; return capturedOptions({ capturedAt: '2026-08-08T15:29:00.000Z' }); },
    uploadAsset: async (args) => { uploads.push(args.filename); return { id: uploads.length, path: `https://assets.example/${args.filename}` }; },
    collectMetrics: async () => openingMetrics(),
    fetchFn: async (url, options = {}) => {
      requests.push({ url, body: options.body ? JSON.parse(options.body) : undefined });
      if (url.includes('/customer_count')) return response({ count: 2 });
      if (url.endsWith('/v1/segments/42')) return response({ segment: { id: 42, name: 'test2' } });
      if (url.endsWith('/v1/newsletters')) return response({ newsletter: { id: 101 } });
      if (url.endsWith('/v1/newsletters/101/contents')) return response(customerIoContents());
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
    now: () => new Date('2026-08-10T14:45:00.000Z'),
    fetchFn: async (url) => {
      if (url.includes('/customer_count')) return response({ count: 2 });
      if (url.endsWith('/v1/segments/42')) return response({ segment: { id: 42, name: 'customers' } });
      return response({});
    },
  });
  await assert.rejects(channel.publish({ articlePath: '/tmp/article.md', config: config(), workflow: {} }), /只能发送到 Customer\.io segment test2/);
});

test('opening digest rejects an empty test2 audience before creating assets or a newsletter', async () => {
  let coverCalls = 0;
  const channel = makeChannel({
    readArticle: async () => ARTICLE,
    now: () => new Date('2026-08-10T14:45:00.000Z'),
    renderCover: async () => { coverCalls += 1; return Buffer.from('cover'); },
    fetchFn: async (url) => {
      if (url.includes('/customer_count')) return response({ count: 0 });
      if (url.endsWith('/v1/segments/42')) return response({ segment: { id: 42, name: 'test2' } });
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  await assert.rejects(channel.publish({ articlePath: '/tmp/article.md', config: config(), workflow: {} }), /test2 受众为空/);
  assert.equal(coverCalls, 0);
});

test('opening digest requires exactly one Customer.io layout unsubscribe and none in the body', async () => {
  const requests = [];
  const channel = makeChannel({
    readArticle: async () => ARTICLE,
    now: () => new Date('2026-08-10T14:45:00.000Z'),
    renderCover: async () => Buffer.from('cover'),
    captureOptions: async () => capturedOptions(),
    uploadAsset: async () => ({ id: 1, path: 'https://assets.example/image.png' }),
    collectMetrics: async () => openingMetrics(),
    fetchFn: async (url) => {
      requests.push(url);
      if (url.includes('/customer_count')) return response({ count: 2 });
      if (url.endsWith('/v1/segments/42')) return response({ segment: { id: 42, name: 'test2' } });
      if (url.endsWith('/v1/newsletters')) return response({ newsletter: { id: 102 } });
      if (url.endsWith('/v1/newsletters/102/contents')) return response({
        contents: [{ body: '<a href="{% unsubscribe_url %}">Unsubscribe</a>', layout: '<a href="{% unsubscribe_url %}">Unsubscribe</a>' }],
      });
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  await assert.rejects(channel.publish({ articlePath: '/tmp/article.md', config: config(), workflow: {} }), /退订链接归属异常/);
  assert.equal(requests.some((url) => url.endsWith('/send') || url.endsWith('/schedule')), false);
});

test('opening digest reuses a persisted Customer.io newsletter id after a send retry', async () => {
  const requests = [];
  const channel = makeChannel({
    readArticle: async () => ARTICLE,
    now: () => new Date('2026-08-10T14:45:00.000Z'),
    renderCover: async () => Buffer.from('cover'),
    captureOptions: async () => capturedOptions(),
    uploadAsset: async () => ({ id: 1, path: 'https://assets.example/image.png' }),
    collectMetrics: async () => openingMetrics(),
    fetchFn: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.includes('/customer_count')) return response({ count: 4 });
      if (url.endsWith('/v1/segments/42')) return response({ segment: { id: 42, name: 'test2' } });
      if (url.endsWith('/v1/newsletters/99')) return response({ newsletter: {
        id: 99, name: 'Zen Opening Digest · 2026-08-10', sent_at: null,
        recipient_segment_ids: [42], subscription_topic_id: 19,
      } });
      if (url.endsWith('/v1/newsletters/99/contents')) return response(customerIoContents());
      if (url.endsWith('/send')) return response({});
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  await channel.publish({ articlePath: '/tmp/article.md', config: config(), workflow: {}, source: 'manual', existingRemoteId: '99' });
  assert.equal(requests.some((item) => item.url.endsWith('/v1/newsletters')), false);
  assert.ok(requests.some((item) => item.url.endsWith('/v1/newsletters/99/send')));
});

test('opening digest treats an already-sent matching remote newsletter as authoritative', async () => {
  const requests = [];
  const channel = makeChannel({
    readArticle: async () => ARTICLE,
    now: () => new Date('2026-08-10T14:45:00.000Z'),
    fetchFn: async (url) => {
      requests.push(url);
      if (url.includes('/customer_count')) return response({ count: 2 });
      if (url.endsWith('/v1/segments/42')) return response({ segment: { id: 42, name: 'test2' } });
      if (url.endsWith('/v1/newsletters/99')) return response({ newsletter: {
        id: 99, name: 'Zen Opening Digest · 2026-08-10', sent_at: 1786372201,
        recipient_segment_ids: [42], subscription_topic_id: 19,
      } });
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  const result = await channel.publish({
    articlePath: '/tmp/article.md', config: config(), workflow: {}, source: 'cron', existingRemoteId: '99',
  });
  assert.equal(result.mediaId, 'customerio-newsletter:99');
  assert.equal(requests.some((url) => url.endsWith('/send') || url.endsWith('/schedule') || url.endsWith('/contents')), false);
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
    now: () => new Date('2026-08-10T14:45:00.000Z'),
    renderCover: async () => Buffer.from('cover'),
    captureOptions: async () => capturedOptions({ data: bad }),
    uploadAsset: async () => ({ id: 1, path: 'https://assets.example/cover.png' }),
    collectMetrics: async () => openingMetrics(),
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
