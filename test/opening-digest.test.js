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
import { makeChannel, renderOptionsHtml } from '../src/channels/customerio-opening-digest.js';
import { countTrendingRows, validateTrendingOptionsData } from '../src/lib/options-volume.js';
import { collectOpeningMetrics, normalizeOpeningMetrics, validateOpeningMetrics } from '../src/lib/opening-digest-metrics.js';
import {
  analyzeUniverseOptions,
  collectOpeningDigestUniverseContext,
  collectUniverseQuotes,
  OPENING_DIGEST_UNIVERSE,
  OPENING_DIGEST_UNIVERSE_GROUPS,
} from '../src/lib/opening-digest-universe.js';
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

const DATA_ONLY_ARTICLE = `---
title: Zen Opening Digest
subject: Zen Opening Digest · 2026-08-10
preheader: Market signals and available opening data.
edition: 2026-08-10
---
Editorial update unavailable for this edition.`;

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

function response(data, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key) => headers[String(key).toLowerCase()] || '' },
    async text() { return typeof data === 'string' ? data : JSON.stringify(data); },
  };
}

function config() {
  return {
    customerio: {
      appApiKey: 'cio-key', baseUrl: 'https://api.customer.test', timeoutMs: 30000,
      from: 'Zen Trading <support@zentradings.com>', siteUrl: 'https://zentradings.com',
      contactEmail: 'support@zentradings.com', feedbackUrl: '',
    },
    openingDigest: {
      enabled: true, timezone: 'America/New_York', optionsUrl: 'https://options.example/table',
      storageStatePath: '/tmp/oic.json', browserExecutablePath: '/tmp/chrome', captureTimeoutMs: 45000,
      automationAuthorized: true, segmentId: 42, subscriptionTopicId: 19, assetFolderId: 8,
    },
  };
}

function makeCioFetch({ requests, audienceName = 'test2', audienceCount = 4, newsletterId = 99, list = [], send } = {}) {
  return async (url, options = {}) => {
    const parsed = new URL(url);
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    requests?.push({ url, path: parsed.pathname, search: parsed.search, method: options.method || 'GET', body });
    if (parsed.pathname.endsWith('/customer_count')) return response({ count: audienceCount });
    if (parsed.pathname === '/v1/segments/42') return response({ segment: { id: 42, name: audienceName } });
    if (parsed.pathname === '/v1/newsletters' && (options.method || 'GET') === 'GET') return response({ newsletters: list });
    if (parsed.pathname === '/v1/newsletters' && options.method === 'POST') return response({ newsletter: { id: newsletterId } });
    if (parsed.pathname === `/v1/newsletters/${newsletterId}`) return response({ newsletter: list.find((item) => Number(item.id) === newsletterId) || {
      id: newsletterId, name: 'Zen Opening Digest · 2026-08-10', sent_at: null,
      recipient_segment_ids: [42], subscription_topic_id: 19,
    } });
    if (parsed.pathname.endsWith('/send')) return send ? send(url, options) : response({});
    if (parsed.pathname.endsWith('/schedule')) return response({});
    throw new Error(`Unexpected URL ${url}`);
  };
}

function standardChannel(overrides = {}) {
  const requests = overrides.requests || [];
  return {
    requests,
    channel: makeChannel({
      readArticle: async () => ARTICLE,
      now: () => new Date('2026-08-10T14:45:00.000Z'),
      renderCover: async () => Buffer.from('cover'),
      captureOptions: async () => capturedOptions(),
      uploadAsset: async () => ({ id: 1, path: 'https://assets.example/cover.png' }),
      collectMetrics: async () => openingMetrics(),
      sleep: async () => {},
      fetchFn: makeCioFetch({ requests, ...overrides.cio }),
      ...overrides.channel,
    }),
  };
}

test('US equities calendar rejects weekends and recurring NYSE holidays', () => {
  assert.equal(isUsEquitySession(new Date('2026-07-04T16:00:00Z')), false);
  assert.equal(isUsEquitySession(new Date('2026-07-06T16:00:00Z')), true);
  assert.equal(easternDateKey(new Date('2026-08-10T14:00:00Z')), '2026-08-10');
});

test('opening digest research uses the prior regular close window', () => {
  const now = new Date('2026-08-10T14:15:00.000Z');
  assert.equal(previousRegularClose(now).toISOString(), '2026-08-07T20:00:00.000Z');
  assert.equal(previousRegularClose(new Date('2026-07-06T14:15:00.000Z')).toISOString(), '2026-07-02T20:00:00.000Z');
  assert.match(openingDigestSearchInput(now), /US equity opening digest for 2026-08-10/);
  const queries = openingDigestResearchQueries(now);
  assert.equal(queries.length, 10);
  assert.equal(queries.filter((query) => query.openingDigestKind === 'universe-news').length, 7);
  assert.equal(queries.filter((query) => query.openingDigestKind === 'earnings-schedule').length, 1);
  assert.ok(queries.slice(0, -1).every((query) => query.startPublishedDate === '2026-08-07T20:00:00.000Z'));
  assert.equal(queries.at(-1).startPublishedDate, undefined);
  assert.match(queries.at(-1).query, /2026-08-10 through 2026-08-14/);
  assert.ok(queries.every((query) => query.endPublishedDate === now.toISOString()));
});

test('opening universe locks 72 unique tickers in seven groups and keeps Alphabet quote classes distinct', () => {
  assert.equal(OPENING_DIGEST_UNIVERSE.length, 72);
  assert.equal(OPENING_DIGEST_UNIVERSE_GROUPS.length, 7);
  assert.equal(new Set(OPENING_DIGEST_UNIVERSE.map((item) => item.ticker)).size, 72);
  assert.equal(OPENING_DIGEST_UNIVERSE.find((item) => item.ticker === 'GOOG').issuerKey, 'alphabet');
  assert.equal(OPENING_DIGEST_UNIVERSE.find((item) => item.ticker === 'GOOGL').issuerKey, 'alphabet');
  assert.equal(OPENING_DIGEST_UNIVERSE.some((item) => item.ticker === 'SKHY' && /SK hynix/.test(item.company)), true);
});

test('universe quotes detect 5% moves, dedupe share classes and degrade individual failures', async () => {
  const attempts = new Map();
  const asOf = new Date('2026-08-10T14:15:00.000Z');
  const result = await collectUniverseQuotes({
    asOf,
    concurrency: 6,
    fetchFn: async (url) => {
      const ticker = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
      attempts.set(ticker, (attempts.get(ticker) || 0) + 1);
      if (ticker === 'BABA') return { ok: false, status: 404 };
      if (ticker === 'NVDA' && attempts.get(ticker) === 1) return { ok: false, status: 429 };
      const prices = ticker === 'GOOG' ? [100, 106]
        : ticker === 'GOOGL' ? [100, 105]
          : ticker === 'NVDA' ? [100, 95]
            : [100, 101];
      return {
        ok: true,
        async json() { return { chart: { result: [{ meta: {
          chartPreviousClose: prices[0], regularMarketPrice: prices[1], regularMarketTime: asOf.getTime() / 1000,
        } }] } }; },
      };
    },
  });
  assert.equal(result.coverage.requested, 72);
  assert.equal(result.coverage.available, 71);
  assert.equal(result.coverage.failed, 1);
  assert.deepEqual(result.movers.map((item) => item.ticker), ['GOOG', 'NVDA']);
  assert.equal(attempts.get('NVDA'), 2);
});

test('universe OIC analysis applies absolute and derived point thresholds with sparse history', () => {
  const data = structuredClone(OPTIONS_DATA);
  data.rows[0].splice(1, 7, 'NVDA', 'NVIDIA', '60.00 %', '40.00 %', '1,000,000', '65.00', '1.00');
  data.rows[1].splice(1, 7, 'IREN', 'IREN', '55.00 %', '45.00 %', '990,000', '55.00', '12.00');
  data.rows[2].splice(1, 7, 'META', 'Meta', '50.00 %', '50.00 %', '980,000', '40.00', '2.00');
  const analyzed = analyzeUniverseOptions(data, {
    sessions: ['2026-08-10', '2026-08-07'],
    rows: [
      { session_date: '2026-08-10', ticker: 'NVDA' },
      { session_date: '2026-08-07', ticker: 'NVDA' },
      { session_date: '2026-08-10', ticker: 'IREN' },
    ],
  });
  assert.deepEqual(analyzed.matches.map((item) => item.ticker), ['NVDA', 'IREN', 'META']);
  assert.deepEqual(analyzed.triggers.map((item) => item.ticker), ['NVDA', 'IREN']);
  assert.ok(analyzed.triggers.find((item) => item.ticker === 'IREN').ivxPointChange >= 5);
  assert.equal(analyzed.history.NVDA.consecutiveAppearances, 2);
  assert.equal(analyzed.history.IREN.firstAppearanceInWindow, true);
});

test('universe context emits prompt sources and a reusable OIC artifact without making IV coverage claims', async () => {
  const asOf = new Date('2026-08-10T14:15:00.000Z');
  const data = structuredClone(OPTIONS_DATA);
  data.rows[0].splice(1, 7, 'NVDA', 'NVIDIA', '60.00 %', '40.00 %', '1,000,000', '65.00', '1.00');
  const recorded = [];
  const context = await collectOpeningDigestUniverseContext({
    config: config(), asOf, quoteConcurrency: 12,
    fetchFn: async (url) => {
      const ticker = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
      const moved = ticker === 'META';
      return { ok: true, async json() { return { chart: { result: [{ meta: {
        chartPreviousClose: 100, regularMarketPrice: moved ? 106 : 101,
        regularMarketTime: asOf.getTime() / 1000,
      } }] } }; } };
    },
    captureOptions: async () => capturedOptions({ data }),
    history: {
      recordCapture: (entry) => recorded.push(entry),
      listHistory: () => ({ sessions: ['2026-08-10'], rows: [{ session_date: '2026-08-10', ticker: 'NVDA' }] }),
    },
  });
  assert.equal(context.artifact.schemaVersion, 1);
  assert.equal(context.artifact.quotes.coverage.available, 72);
  assert.equal(context.artifact.options.data.rows.length, 20);
  assert.deepEqual(context.sources.map((source) => source.openingDigestKind), ['universe-price', 'universe-iv']);
  assert.equal(context.sources[0].text, 'META (Meta Platforms) was +6.00% at 2026-08-10T14:15:00.000Z, versus the prior regular close.');
  assert.doesNotMatch(context.sources[0].text, /cause|reason|asserted/i);
  assert.match(context.promptText, /not a full-universe IV scan/);
  assert.equal(recorded[0].status, 'success');
});

test('opening content rules are diagnostics rather than hard gates', () => {
  const now = new Date('2026-08-10T14:15:00.000Z');
  const research = ['a', 'b', 'c'].map((id, index) => ({
    url: `https://example.com/${id}`,
    publishedDate: new Date(now.getTime() - (index + 1) * 60_000).toISOString(),
  }));
  const valid = validateOpeningDigestArticle({ article: ARTICLE, research, asOf: now, requireFreshSources: true });
  assert.equal(valid.catalystCount, 3);
  assert.deepEqual(valid.warnings, []);
  const invalid = validateOpeningDigestArticle({
    article: ARTICLE
      .replace('https://example.com/a', 'https://example.com/unmatched')
      .replace('has a concrete and material implication for today\'s US equity opening session.', 'is background rather than a current-window catalyst.'),
    research,
    asOf: now,
    requireFreshSources: true,
  });
  assert.ok(invalid.warnings.some((warning) => /未匹配到本次检索来源/.test(warning)));
  assert.ok(invalid.warnings.some((warning) => /旧闻或背景/.test(warning)));
  const malformed = validateOpeningDigestArticle({ article: 'No standard headings or links.' });
  assert.ok(malformed.warnings.length >= 3);

  const scheduled = validateOpeningDigestArticle({
    article: ARTICLE.replace('https://example.com/a', 'https://example.com/earnings'),
    research: [
      { url: 'https://example.com/earnings', publishedDate: '2026-07-20T12:00:00Z', openingDigestKind: 'earnings-schedule' },
      ...research.slice(1),
    ],
    asOf: now,
    requireFreshSources: true,
  });
  assert.equal(scheduled.warnings.some((warning) => /时间窗口/.test(warning)), false);
});

test('opening metrics keeps nine fixed slots and replaces invalid or missing data with placeholders', async () => {
  const metrics = await collectOpeningMetrics({
    now: () => new Date('2026-08-10T14:15:00.000Z'),
    fetchFn: async (url) => String(url).includes('home.treasury.gov')
      ? { ok: true, async text() { return 'Date,"2 Yr"\n08/07/2026,4.19\n08/06/2026,4.14\n'; } }
      : { ok: true, async json() { return { chart: { result: [{ regularMarketTime: 1786371300, timestamp: [1786284900, 1786371300], indicators: { quote: [{ close: [100, 101] }] } }] } }; } },
  });
  assert.equal(metrics.find((metric) => metric.label === '2Y UST').value, 4.19);
  const mixed = normalizeOpeningMetrics([metrics[2], { ...metrics[0], value: NaN }, metrics[2], { label: 'UNKNOWN', value: 10 }]);
  assert.equal(mixed.metrics.length, 9);
  assert.deepEqual(mixed.metrics.map((metric) => metric.label), ['SPY', 'QQQ', 'IWM', 'VIX', '2Y UST', '10Y UST', 'DXY', 'WTI', 'Gold']);
  assert.equal(mixed.availableCount, 1);
  assert.ok(mixed.warnings.length > 0);
  assert.equal(validateOpeningMetrics([]).length, 9);
});

test('structured options validation remains strict inside the optional section', () => {
  assert.deepEqual(validateTrendingOptionsData(OPTIONS_DATA), OPTIONS_DATA);
  const badRank = structuredClone(OPTIONS_DATA);
  badRank.rows[4][0] = '6';
  assert.throws(() => validateTrendingOptionsData(badRank), /排名必须连续/);
  const text = ['As of today', 'Ticker Name Call Options Volume Put Options Volume Total Option Volume']
    .concat(Array.from({ length: 20 }, (_, index) => `${index + 1}\tT${index + 1}\tCompany ${index + 1}\t50 %\t50 %\t${1000 - index}`)).join('\n');
  assert.equal(countTrendingRows(text), 20);
});

test('opening cover locks the supplied artwork and overlays only digest name and date', async () => {
  const background = await loadOpeningCoverBackground();
  assert.ok(background.length > 1_000_000);
  assert.equal(OPENING_COVER_BACKGROUND_WIDTH, 1774);
  assert.equal(OPENING_COVER_BACKGROUND_HEIGHT, 887);
  assert.equal(OPENING_COVER_BACKGROUND_SHA256, '44436cfdf3e7b9dc17aba36fe61c5c8a891cf08885c8887722a907225866e300');
  assert.equal(OPENING_COVER_WIDTH, 1240);
  assert.equal(OPENING_COVER_HEIGHT, 620);
  const html = coverHtml('August 10, 2026', { backgroundDataUrl: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.match(html, /Opening Digest/);
  assert.match(html, /August 10, 2026/);
  assert.doesNotMatch(html, /radial-gradient|class="brand"|SUPPLY CHAINS/);
});

test('complete digest renders template, address, options and schedules without contents readback', async () => {
  const requests = [];
  const uploads = [];
  const { channel } = standardChannel({
    requests,
    channel: {
      now: () => new Date('2026-08-10T13:00:00.000Z'),
      uploadAsset: async (args) => { uploads.push(args.filename); return { path: `https://assets.example/${args.filename}` }; },
    },
  });
  const result = await channel.publish({ articlePath: '/tmp/article.md', config: config(), source: 'cron' });
  assert.equal(result.mediaId, 'customerio-newsletter:99');
  assert.deepEqual(uploads, ['opening-digest-cover-2026-08-10.png']);
  const create = requests.find((item) => item.path === '/v1/newsletters' && item.method === 'POST');
  assert.match(create.body.body, /data-zen-draft-template="zen-customerio\/zen-research@4"/);
  assert.match(create.body.body, /\.zen-email-content \{ padding:20px 8px !important; \}/);
  assert.match(create.body.body, /Zen Trading · 700 Leahy St, Redwood City, CA 94061/);
  assert.match(create.body.body, /OIC Trending Options Volume top twenty/);
  assert.doesNotMatch(create.body.body, /unsubscribe_url/);
  assert.equal(requests.some((item) => item.path.endsWith('/contents')), false);
  const schedule = requests.find((item) => item.path.endsWith('/schedule'));
  assert.equal(schedule.body.scheduled_at, Date.parse('2026-08-10T14:30:00.000Z') / 1000);
});

test('prepared universe artifact is reused for acceptance and formal rendering without another OIC capture', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-opening-universe-artifact-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const articlePath = path.join(directory, 'article.md');
  await fs.writeFile(path.join(directory, 'opening-digest-universe.json'), JSON.stringify({
    schemaVersion: 1,
    dateKey: '2026-08-10',
    options: { data: OPTIONS_DATA, capturedAt: '2026-08-10T14:15:00.000Z' },
  }));
  let captures = 0;
  const requests = [];
  const { channel } = standardChannel({
    requests,
    channel: { captureOptions: async () => { captures += 1; return capturedOptions(); } },
  });
  await channel.publish({
    articlePath, config: config(), source: 'acceptance', acceptanceId: 'artifact-1015et',
  });
  await channel.publish({ articlePath, config: config(), source: 'cron' });
  assert.equal(captures, 0);
  const creates = requests.filter((item) => item.path === '/v1/newsletters' && item.method === 'POST');
  assert.equal(creates.length, 2);
  assert.ok(creates.every((item) => /OIC Trending Options Volume top twenty/.test(item.body.body)));
});

test('cover and OIC failures degrade silently and persist diagnostics to trace', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-opening-soft-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const articlePath = path.join(directory, 'article.md');
  await fs.writeFile(path.join(directory, 'research-trace.json'), JSON.stringify({ workflowId: 'opening-digest' }));
  const requests = [];
  const { channel } = standardChannel({
    requests,
    channel: {
      renderCover: async () => { throw new Error('cover checksum mismatch'); },
      captureOptions: async () => { throw new Error('OIC login expired'); },
    },
  });
  await channel.publish({ articlePath, config: config(), source: 'manual' });
  const create = requests.find((item) => item.path === '/v1/newsletters' && item.method === 'POST');
  assert.doesNotMatch(create.body.body, /<img src=/);
  assert.doesNotMatch(create.body.body, /Trending options volume/);
  const trace = JSON.parse(await fs.readFile(path.join(directory, 'research-trace.json'), 'utf8'));
  assert.ok(trace.openingDigestDelivery.diagnostics.some((item) => /封面已省略/.test(item)));
  assert.ok(trace.openingDigestDelivery.diagnostics.some((item) => /期权区块已省略/.test(item)));
});

test('中文翻译失败不影响已成功的 Customer.io 邮件且绝不创建英文微信稿', async () => {
  let wechatCreates = 0;
  const { channel } = standardChannel({
    channel: {
      translatePayload: async () => { throw new Error('missing translated block body-2'); },
      wechatChannel: { publish: async () => { wechatCreates += 1; throw new Error('must not run'); } },
    },
  });
  const enabled = config();
  enabled.openingDigest.wechatEnabled = true;
  const result = await channel.publish({ articlePath: '/tmp/article.md', config: enabled, source: 'manual' });
  assert.equal(result.mediaId, 'customerio-newsletter:99');
  assert.equal(wechatCreates, 0);
  assert.equal(result.deliveries.find((item) => item.destination === 'wechat').status, 'failed');
  assert.match(result.deliveryWarnings[0], /邮件已成功.*中文微信草稿创建失败/);
});

test('双渠道严格先完成 Customer.io，再用同一冻结 payload 创建中文微信草稿', async () => {
  const events = []; let translatedPayload; let wechatPayload;
  const { channel } = standardChannel({
    cio: { send: async () => { events.push('email'); return response({}); } },
    channel: {
      translatePayload: async (input) => {
        events.push('translate'); translatedPayload = input;
        return { model: 'test', payloadHash: 'hash', blockCount: 1, repairs: [], translations: [{ id: 'preheader', text: '早盘信号' }] };
      },
      wechatChannel: {
        async publish({ payload: input }) {
          events.push('wechat'); wechatPayload = input;
          return { mediaId: 'wx-media-1', title: 'Zen 开市日报 · 2026-08-10', status: 'verified', errors: [], attempts: [{ status: 'verified' }] };
        },
      },
    },
  });
  const enabled = config(); enabled.openingDigest.wechatEnabled = true;
  const result = await channel.publish({ articlePath: '/tmp/article.md', config: enabled, source: 'manual' });
  assert.deepEqual(events, ['email', 'translate', 'wechat']);
  assert.equal(translatedPayload, wechatPayload);
  assert.equal(Object.isFrozen(translatedPayload), true);
  assert.equal(result.deliveries.find((item) => item.destination === 'wechat').mediaId, 'wx-media-1');
});

test('zero audience and failed audience preflight do not block configured test2 delivery', async () => {
  for (const fetchMode of ['zero', 'failed']) {
    const requests = [];
    const fallback = makeCioFetch({ requests, audienceCount: 0 });
    const channel = makeChannel({
      readArticle: async () => ARTICLE,
      now: () => new Date('2026-08-10T14:45:00.000Z'),
      renderCover: async () => Buffer.from('cover'),
      captureOptions: async () => capturedOptions(),
      uploadAsset: async () => ({ path: 'https://assets.example/cover.png' }),
      collectMetrics: async () => openingMetrics(),
      sleep: async () => {},
      fetchFn: async (url, options) => {
        const pathname = new URL(url).pathname;
        if (fetchMode === 'failed' && pathname.startsWith('/v1/segments/')) throw new Error('preflight offline');
        return fallback(url, options);
      },
    });
    const result = await channel.publish({ articlePath: '/tmp/article.md', config: config(), source: 'manual' });
    assert.equal(result.mediaId, 'customerio-newsletter:99');
  }
});

test('a known non-test2 segment name remains a hard gate', async () => {
  const { channel } = standardChannel({ cio: { audienceName: 'customers' } });
  await assert.rejects(channel.publish({ articlePath: '/tmp/article.md', config: config() }), /只能发送到 Customer\.io segment test2/);
});

test('data-only digest requires at least one valid metric or a valid options section', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-opening-empty-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const articlePath = path.join(directory, 'article.md');
  const requests = [];
  const { channel } = standardChannel({
    requests,
    channel: {
      readArticle: async () => DATA_ONLY_ARTICLE,
      collectMetrics: async () => [],
      captureOptions: async () => { throw new Error('unavailable'); },
    },
  });
  await assert.rejects(
    channel.publish({ articlePath, config: config(), source: 'manual', contentMode: 'data-only' }),
    /拒绝发送空邮件/,
  );
  assert.equal(requests.some((item) => item.path === '/v1/newsletters' && item.method === 'POST'), false);
});

test('body unsubscribe tags are removed locally and Customer.io contents is never read', async () => {
  const requests = [];
  const { channel } = standardChannel({
    requests,
    channel: { readArticle: async () => ARTICLE.replace('## Market read', '{% unsubscribe_url %}\n\n## Market read') },
  });
  await channel.publish({ articlePath: '/tmp/article.md', config: config(), source: 'manual' });
  const create = requests.find((item) => item.path === '/v1/newsletters' && item.method === 'POST');
  assert.doesNotMatch(create.body.body, /unsubscribe_url/);
  assert.equal(requests.some((item) => item.path.endsWith('/contents')), false);
});

test('remote discovery reuses one matching sent newsletter and rejects duplicate candidates', async () => {
  const sent = {
    id: 77, name: 'Zen Opening Digest · 2026-08-10', sent_at: 1786372201,
    recipient_segment_ids: [42], subscription_topic_id: 19,
  };
  const requests = [];
  const first = standardChannel({ requests, cio: { list: [sent], newsletterId: 77 } });
  const result = await first.channel.publish({ articlePath: '/tmp/article.md', config: config(), source: 'cron' });
  assert.equal(result.mediaId, 'customerio-newsletter:77');
  assert.equal(requests.some((item) => item.method === 'POST'), false);

  const duplicate = standardChannel({ cio: { list: [sent, { ...sent, id: 78 }] } });
  await assert.rejects(duplicate.channel.publish({ articlePath: '/tmp/article.md', config: config() }), /2 个同名/);
});

test('ambiguous create response recovers the exact remote newsletter without a second create', async () => {
  const requests = [];
  let listCalls = 0;
  let createCalls = 0;
  const recovered = {
    id: 105, name: 'Zen Opening Digest · 2026-08-10', sent_at: null,
    recipient_segment_ids: [42], subscription_topic_id: 19,
  };
  const fallback = makeCioFetch({ requests, newsletterId: 105, list: [recovered] });
  const { channel } = standardChannel({
    requests,
    channel: {
      fetchFn: async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/v1/newsletters' && (options.method || 'GET') === 'GET') {
          listCalls += 1;
          return response({ newsletters: listCalls === 1 ? [] : [recovered] });
        }
        if (parsed.pathname === '/v1/newsletters' && options.method === 'POST') {
          createCalls += 1;
          throw new Error('socket reset after write');
        }
        return fallback(url, options);
      },
    },
  });
  const result = await channel.publish({ articlePath: '/tmp/article.md', config: config(), source: 'manual' });
  assert.equal(result.mediaId, 'customerio-newsletter:105');
  assert.equal(createCalls, 1);
});

test('ambiguous send response is recovered from remote sent_at', async () => {
  const requests = [];
  let sent = false;
  const fallback = makeCioFetch({ requests, newsletterId: 109 });
  const { channel } = standardChannel({
    requests,
    channel: {
      fetchFn: async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/v1/newsletters/109/send') {
          sent = true;
          throw new Error('response lost');
        }
        if (parsed.pathname === '/v1/newsletters/109') return response({ newsletter: {
          id: 109, name: 'Zen Opening Digest · 2026-08-10', sent_at: sent ? 1786372201 : null,
          recipient_segment_ids: [42], subscription_topic_id: 19,
        } });
        return fallback(url, options);
      },
    },
    cio: { newsletterId: 109 },
  });
  const result = await channel.publish({ articlePath: '/tmp/article.md', config: config(), source: 'manual' });
  assert.equal(result.mediaId, 'customerio-newsletter:109');
});

test('manual digest is allowed off-session and labels live options latest available', async () => {
  const requests = [];
  const { channel } = standardChannel({
    requests,
    channel: {
      readArticle: async () => ARTICLE.replaceAll('2026-08-10', '2026-08-08'),
      now: () => new Date('2026-08-08T15:30:00.000Z'),
    },
  });
  await channel.publish({ articlePath: '/tmp/article.md', config: config(), source: 'manual' });
  const create = requests.find((item) => item.path === '/v1/newsletters' && item.method === 'POST');
  assert.match(create.body.body, /Latest available capture/);
});

test('production acceptance uses an explicit TEST identity and sends immediately to test2', async () => {
  const requests = [];
  const uploads = [];
  const { channel } = standardChannel({
    requests,
    channel: {
      uploadAsset: async (args) => {
        uploads.push({ filename: args.filename, name: args.name });
        return { path: `https://assets.example/${args.filename}` };
      },
    },
  });
  await channel.publish({
    articlePath: '/tmp/article.md',
    config: config(),
    source: 'acceptance',
    acceptanceId: 'cc3fc06bb76a-1045et',
  });
  const create = requests.find((item) => item.path === '/v1/newsletters' && item.method === 'POST');
  assert.equal(create.body.name, '[TEST] Zen Opening Digest · 2026-08-10 · cc3fc06bb76a-1045et');
  assert.match(create.body.subject, /^\[TEST\] Zen Opening Digest/);
  assert.deepEqual(uploads, [{
    filename: 'opening-digest-cover-2026-08-10-cc3fc06bb76a-1045et.png',
    name: 'Zen Opening Digest cover 2026-08-10-cc3fc06bb76a-1045et',
  }]);
  assert.ok(requests.some((item) => item.path.endsWith('/send')));
  assert.equal(requests.some((item) => item.path.endsWith('/schedule')), false);
});

test('options HTML reproduces all source values safely as text', () => {
  const data = structuredClone(OPTIONS_DATA);
  data.rows[0][2] = '<img src=x onerror=alert(1)>';
  const html = renderOptionsHtml({ data, capturedAt: '2026-08-10T14:15:00Z', kind: 'Opening' });
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelectorAll('tbody').length, 20);
  assert.doesNotMatch(html, /<img\b/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /color:#b42318/);
  assert.match(html, /color:#167a45/);
  assert.ok(Buffer.byteLength(html) < 70 * 1024);
});
