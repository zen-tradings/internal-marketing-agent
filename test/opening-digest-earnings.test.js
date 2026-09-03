import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectOpeningDigestEarnings,
  decorateOpeningDigestWithEarnings,
  openingDigestEarningsResearchQuery,
  remainingEarningsWindow,
  selectEarningsHighlights,
} from '../src/lib/opening-digest-earnings.js';
import { validateOpeningDigestArticle } from '../src/lib/opening-digest-content.js';
import { translateOpeningDigestPayload } from '../src/lib/opening-digest-translation.js';

const BASE_ARTICLE = `---
title: Zen Opening Digest
subject: Zen Opening Digest
preheader: Market snapshot
edition: 2026-08-12
---
## Today's catalysts
- [Current source](https://example.com/current) supports a current and material market catalyst for the opening session.
- [Second source](https://example.com/second) supports another current and material market catalyst for the opening session.
- [Third source](https://example.com/third) supports a third current and material market catalyst for the opening session.

## Market read
The opening interpretation remains conditional on whether participation persists through the first hour of trading.`;

function workerResult(candidates, overrides = {}) {
  return {
    schemaVersion: 1,
    provider: 'yfinance-yahoo',
    capturedAt: '2026-08-12T17:00:00.000Z',
    startDate: '2026-08-12',
    endDate: '2026-08-14',
    candidates,
    ...overrides,
  };
}

function candidate(symbol, company, marketCap, eventStartDate, timing = 'AMC') {
  return {
    symbol, company, marketCap, eventName: 'Earnings Date', eventStartDate, timing,
    epsEstimate: 1, reportedEps: null, surprisePct: null,
  };
}

function listingResponse(symbol) {
  const exchange = symbol === 'OTCX' ? 'OTC Markets' : symbol === 'BAD' ? 'NasdaqGS' : 'NasdaqGS';
  const instrumentType = symbol === 'BAD' ? 'ETF' : 'EQUITY';
  return {
    ok: true,
    async json() { return { chart: { result: [{ meta: { fullExchangeName: exchange, instrumentType } }] } }; },
  };
}

test('earnings window runs from the current ET date through Friday', () => {
  assert.deepEqual(remainingEarningsWindow(new Date('2026-08-10T17:00:00Z')), {
    startDate: '2026-08-10', endDate: '2026-08-14',
  });
  assert.deepEqual(remainingEarningsWindow(new Date('2026-08-14T17:00:00Z')), {
    startDate: '2026-08-14', endDate: '2026-08-14',
  });
});

test('calendar collection retries once, excludes reported/OTC/non-equity rows and builds a balanced shortlist', async () => {
  let attempts = 0;
  const rows = [
    candidate('NVDA', 'NVIDIA Corporation', 4_000, '2026-08-13T20:00:00Z'),
    candidate('AMD', 'Advanced Micro Devices, Inc.', 3_000, '2026-08-14T12:30:00Z', 'BMO'),
    candidate('MSFT', 'Microsoft Corporation', 2_000, '2026-08-14T20:00:00Z'),
    candidate('WMT', 'Walmart Inc.', 5_000, '2026-08-13T12:30:00Z', 'BMO'),
    candidate('JPM', 'JPMorgan Chase & Co.', 4_500, '2026-08-14T12:30:00Z', 'BMO'),
    candidate('OTCX', 'OTC Example Inc.', 10_000, '2026-08-13T20:00:00Z'),
    candidate('BAD', 'Fund Example', 9_000, '2026-08-13T20:00:00Z'),
    { ...candidate('DONE', 'Already Reported', 8_000, '2026-08-13T20:00:00Z'), reportedEps: 2.5 },
  ];
  const calendar = await collectOpeningDigestEarnings({
    config: { openingDigest: { earningsPythonPath: '/python', earningsWorkerPath: '/worker.py' } },
    asOf: new Date('2026-08-12T17:00:00Z'),
    trackedTickers: ['NVDA', 'AMD', 'MSFT'],
    workerFn: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient Yahoo failure');
      return workerResult(rows);
    },
    fetchFn: async (url) => listingResponse(decodeURIComponent(new URL(url).pathname.split('/').at(-1))),
  });
  assert.equal(attempts, 2);
  assert.equal(calendar.status, 'ok');
  assert.deepEqual(calendar.candidates.map((item) => item.symbol).includes('DONE'), false);
  assert.deepEqual(calendar.shortlist.map((item) => item.symbol), ['NVDA', 'AMD', 'MSFT', 'WMT', 'JPM']);
  assert.equal(calendar.listingChecks.find((item) => item.symbol === 'OTCX').accepted, false);
  assert.equal(calendar.listingChecks.find((item) => item.symbol === 'BAD').accepted, false);
  assert.equal(calendar.sources.length, 1);
  assert.match(calendar.sources[0].text, /Yahoo timing is expected/);
});

test('dynamic verification query is limited to the normalized shortlist and accepts older official announcements', () => {
  const query = openingDigestEarningsResearchQuery({
    status: 'ok', startDate: '2026-08-12', endDate: '2026-08-14',
    shortlist: [
      { symbol: 'NVDA', company: 'NVIDIA Corporation' },
      { symbol: 'WMT', company: 'Walmart Inc.' },
    ],
  });
  assert.equal(query.openingDigestKind, 'earnings-verification');
  assert.equal(query.official, true);
  assert.equal(query.startPublishedDate, undefined);
  assert.match(query.query, /NVIDIA Corporation \(NVDA\).*Walmart Inc\. \(WMT\)/);
  assert.match(query.systemPrompt, /conference-call or webcast time/i);
});

test('official IR can confirm one exact call time; Yahoo-only rows stay expected and selection remains 3+3 balanced', () => {
  const sourceUrl = 'https://investors.alpha.example/news/earnings-release';
  const yahooUrl = 'https://finance.yahoo.com/calendar/earnings?from=2026-08-12&to=2026-08-14';
  const shortlist = [
    { ...candidate('AAA', 'Alpha Corporation', 10_000, '2026-08-13T20:00:00Z'), sourceUrl: yahooUrl, editorialGroup: 'broad-market' },
    { ...candidate('BBB', 'Beta Corporation', 9_000, '2026-08-13T12:30:00Z', 'BMO'), sourceUrl: yahooUrl, editorialGroup: 'broad-market' },
    { ...candidate('CCC', 'Gamma Corporation', 8_000, '2026-08-14T20:00:00Z'), sourceUrl: yahooUrl, editorialGroup: 'broad-market' },
    { ...candidate('DDD', 'Delta Corporation', 7_000, '2026-08-14T20:00:00Z'), sourceUrl: yahooUrl, editorialGroup: 'broad-market' },
    { ...candidate('NVDA', 'NVIDIA Corporation', 6_000, '2026-08-13T20:00:00Z'), sourceUrl: yahooUrl, editorialGroup: 'ai-tech' },
    { ...candidate('AMD', 'Advanced Micro Devices', 5_000, '2026-08-14T12:30:00Z', 'BMO'), sourceUrl: yahooUrl, editorialGroup: 'ai-tech' },
    { ...candidate('MSFT', 'Microsoft Corporation', 4_000, '2026-08-14T20:00:00Z'), sourceUrl: yahooUrl, editorialGroup: 'ai-tech' },
    { ...candidate('ORCL', 'Oracle Corporation', 3_000, '2026-08-14T20:00:00Z'), sourceUrl: yahooUrl, editorialGroup: 'ai-tech' },
  ];
  const research = [{
    title: 'Alpha schedules fiscal results', sourceUrl, url: sourceUrl, official: true,
    openingDigestKind: 'earnings-verification',
    text: 'Alpha Corporation (AAA) will report results after market close on August 13, 2026. The conference call will begin at 4:30 p.m. ET.',
  }];
  const calendar = { status: 'ok', startDate: '2026-08-12', endDate: '2026-08-14', shortlist };
  const selection = selectEarningsHighlights(calendar, research, new Date('2026-08-12T17:00:00Z'));
  assert.equal(selection.events.length, 6);
  assert.equal(selection.events.filter((item) => item.editorialGroup === 'ai-tech').length, 3);
  assert.equal(selection.events.filter((item) => item.editorialGroup === 'broad-market').length, 3);
  const decorated = decorateOpeningDigestWithEarnings(BASE_ARTICLE, {
    calendar, research, asOf: new Date('2026-08-12T17:00:00Z'),
  });
  assert.match(decorated, /^## Earnings ahead$/m);
  assert.ok(decorated.indexOf('## Earnings ahead') > decorated.indexOf('## Market read'));
  assert.match(decorated, new RegExp(`\\[AAA]\\(${sourceUrl.replaceAll('.', '\\.') }\\) after close; call 4:30 p\\.m\\. ET`));
  assert.match(decorated, /\[NVDA]\([^)]*finance\.yahoo[^)]*\) after close \(expected\)/);
  assert.equal((decorated.match(/^## Earnings ahead$/gm) || []).length, 1);
  const audit = validateOpeningDigestArticle({ article: decorated });
  assert.equal(audit.earningsCount, 6);
  assert.equal(audit.warnings.some((warning) => /Yahoo-only/.test(warning)), false);
});

test('an official announcement for the same month and day in another year cannot supply the call time', () => {
  const yahooUrl = 'https://finance.yahoo.com/calendar/earnings?from=2026-08-12&to=2026-08-14';
  const calendar = {
    status: 'ok',
    shortlist: [{
      ...candidate('AAA', 'Alpha Corporation', 10_000, '2026-08-13T20:00:00Z'),
      sourceUrl: yahooUrl,
      editorialGroup: 'broad-market',
    }],
  };
  const research = [{
    title: 'Alpha schedules prior-year results',
    url: 'https://investors.alpha.example/news/prior-year-results',
    official: true,
    openingDigestKind: 'earnings-verification',
    text: 'Alpha Corporation (AAA) reported after market close on August 13, 2025. The conference call began at 4:30 p.m. ET.',
  }];
  const [event] = selectEarningsHighlights(calendar, research, new Date('2026-08-12T17:00:00Z')).events;
  assert.equal(event.official, null);
  assert.equal(event.sourceUrl, yahooUrl);
});

test('same-day BMO without a future official call is excluded, while same-day AMC remains', () => {
  const url = 'https://finance.yahoo.com/calendar/earnings';
  const calendar = {
    status: 'ok', shortlist: [
      { ...candidate('EARLY', 'Early Inc.', 3, '2026-08-12T12:30:00Z', 'BMO'), sourceUrl: url, editorialGroup: 'broad-market' },
      { ...candidate('LATE', 'Late Inc.', 2, '2026-08-12T20:00:00Z', 'AMC'), sourceUrl: url, editorialGroup: 'broad-market' },
      { ...candidate('UNKNOWN', 'Unknown Inc.', 1, '2026-08-12T12:00:00Z', 'TNS'), sourceUrl: url, editorialGroup: 'broad-market' },
    ],
  };
  const selection = selectEarningsHighlights(calendar, [], new Date('2026-08-12T17:15:00Z'));
  assert.deepEqual(selection.events.map((item) => item.symbol), ['LATE']);
});

test('calendar failure removes a model-supplied earnings block; valid empty data renders the explicit no-highlights line', () => {
  const withModelBlock = BASE_ARTICLE.replace("## Today's catalysts", '## Earnings ahead\nUNTRUSTED MODEL DATE\n\n## Today\'s catalysts');
  const omitted = decorateOpeningDigestWithEarnings(withModelBlock, { calendar: { status: 'unavailable' } });
  assert.doesNotMatch(omitted, /Earnings ahead|UNTRUSTED MODEL DATE/);
  const empty = decorateOpeningDigestWithEarnings(BASE_ARTICLE, {
    calendar: { status: 'ok', shortlist: [] }, research: [], asOf: new Date('2026-08-12T17:00:00Z'),
  });
  assert.match(empty, /## Earnings ahead\nNo major U\.S\.-listed earnings events were selected for the remainder of this week\./);
});

test('controlled earnings copy translates deterministically without sending dates or links to the model', async () => {
  const source = {
    article: {
      preheader: 'Market snapshot',
      body: `## Earnings ahead
**Thu, Aug 13:** [AAA](https://investors.alpha.example/release) after close; call 4:30 p.m. ET; [NVDA](https://finance.yahoo.com/calendar/earnings) after close (expected)`,
    },
    metrics: [],
  };
  const result = await translateOpeningDigestPayload(source, {
    writer: { model: 'test' },
    complete: async () => { throw new Error('deterministic earnings copy must not call the model'); },
  });
  const heading = result.translations.find((item) => item.id === 'body-1');
  const paragraph = result.translations.find((item) => item.id === 'body-2');
  assert.equal(heading.text, '财报预告');
  assert.match(paragraph.text, /8月13日 周四/);
  assert.match(paragraph.text, /AAA.*盘后披露；电话会 4:30 p\.m\. ET/);
  assert.match(paragraph.text, /NVDA.*盘后（预计）/);
  assert.match(paragraph.text, /https:\/\/investors\.alpha\.example\/release/);
});
