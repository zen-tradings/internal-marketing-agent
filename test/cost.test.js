import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openCostStore } from '../src/core/cost-store.js';
import { withCostContext, COST_STAGE } from '../src/lib/cost-context.js';
import { createCostAwareFetch, knownNumber, normalizeCostEvent } from '../src/lib/cost-telemetry.js';
import { costPeriods } from '../src/lib/cost-report.js';
import { reuseTaskRequest } from '../src/lib/task-request-cache.js';
import { safeFetchResource } from '../src/lib/safe-fetch.js';
import { fetchUsesGlobalTransport, rebindFetchTransport } from '../src/lib/task-cancellation.js';
import { createResourceGovernor } from '../src/core/resource-governor.js';

test('missing usage remains unknown; whitelist excludes prompts, secrets and raw errors', () => {
  for (const value of [null, undefined, '', true, -1, 'bad']) assert.equal(knownNumber(value), null);
  assert.equal(knownNumber(0), 0);
  const event = normalizeCostEvent({ prompt: 'secret', error: 'private', costUsd: null });
  assert.equal(event.costUsd, null);
  assert.equal('prompt' in event, false);
  assert.equal('error' in event, false);
});

test('ledger accumulates retries, deduplicates generation IDs and outlives run pruning', () => {
  const store = openCostStore(':memory:');
  try {
    const base = { vendor: 'openrouter', workflowId: 'translate', runId: 'run', occurredAt: Date.now() };
    store.record({ ...base, attemptId: 'a', outcome: 'attempting' });
    store.record({ ...base, attemptId: 'a', generationId: 'g', costUsd: .02, outcome: 'empty' });
    store.record({ ...base, attemptId: 'b', generationId: 'g', costUsd: .02, outcome: 'empty' });
    store.record({ ...base, attemptId: 'c', generationId: 'h', costUsd: .03, outcome: 'completed' });
    assert.equal(store.prune(Date.now() + 89 * 86400000), 0);
    assert.equal(store.prune(Date.now() + 91 * 86400000), 2);
  } finally { store.close(); }
});

test('body observation retains unknown fees and records all attempts without cloning', async () => {
  const events = []; const requests = [];
  const fetch = createCostAwareFetch(async (url, options) => {
    requests.push(options);
    return new Response(JSON.stringify({ id: 'generation', choices: [{ message: { content: 'article' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 7 } } }));
  }, { record: event => events.push(normalizeCostEvent(event)) });
  await withCostContext({ runId: 'run', workflowId: 'wechat' }, async () => {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', [COST_STAGE]: 'cover', body: JSON.stringify({ model: 'z-ai/glm-5.3-flash', reasoning: { effort: 'none' } }),
    });
    await response.text();
  });
  assert.equal(JSON.parse(requests[0].body).reasoning.effort, 'low');
  assert.equal(requests[0][COST_STAGE], undefined);
  assert.equal(events.at(-1).stage, 'cover');
  assert.equal(events.at(-1).runId, 'run');
  assert.equal(events.at(-1).cachedTokens, 7);
  assert.equal(events.at(-1).costUsd, null);
});

test('Exa cost object and Datalab page usage do not invent USD costs', async () => {
  const events = [];
  const fetch = createCostAwareFetch(async url => new Response(JSON.stringify(String(url).includes('exa')
    ? { requestId: 'exa-id', costDollars: { total: .015 } }
    : { request_id: 'pdf-id', status: 'complete', page_count: 5, cost_breakdown: { credits: 80 } })),
  { record: event => events.push(normalizeCostEvent(event)) });
  await (await fetch('https://api.exa.ai/search')).json();
  assert.equal(events.at(-1).costUsd, .015);
  await (await fetch('https://www.datalab.to/api/v1/convert/pdf-id')).json();
  assert.equal(events.at(-1).pages, 5);
  assert.equal(events.at(-1).costUsd, null);
});

test('governor retries are individually recorded and usage survives streamed resource wrappers', async () => {
  const events = []; let calls = 0;
  const transport = createCostAwareFetch(async () => {
    calls++;
    return calls === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '0' } })
      : new Response(JSON.stringify({ id: 'ok-generation', choices: [{ message: { content: 'ok' } }], usage: { cost: .04 } }));
  }, { record: event => events.push(normalizeCostEvent(event)) });
  const governor = createResourceGovernor({ fetchFn: transport, sleep: async () => {} });
  const response = await governor.fetch('https://openrouter.ai/api/v1/chat/completions');
  await response.text();
  assert.equal(new Set(events.map(event => event.attemptId)).size, 2);
  assert.equal(events.at(-1).costUsd, .04);
  assert.equal(governor.stats().openrouter.active, 0);
});

test('recording failures never change body/transport behavior; DNS rebinding is preserved', async () => {
  const wrapped = createCostAwareFetch(globalThis.fetch, { record: () => { throw new Error('full disk'); } });
  assert.equal(fetchUsesGlobalTransport(wrapped), true);
  const rebound = rebindFetchTransport(wrapped, async () => new Response('{"ok":true}'));
  assert.deepEqual(await (await rebound('https://api.exa.ai/search')).json(), { ok: true });
});

test('identical concurrent requests share one attempt; failures can retry; tasks remain isolated', async () => {
  let calls = 0;
  const run = () => withCostContext({ runId: 'run-' + calls, requestCache: new Map() }, async () => {
    const load = async () => { calls++; return 'data'; };
    const results = await Promise.all([reuseTaskRequest('search', { q: 'q' }, load), reuseTaskRequest('search', { q: 'q' }, load)]);
    assert.equal(results[1].reused, true);
  });
  await run(); await run(); assert.equal(calls, 2);
  await withCostContext({ requestCache: new Map() }, async () => {
    await assert.rejects(reuseTaskRequest('search', {}, async () => { throw Error('fail'); }));
    assert.equal((await reuseTaskRequest('search', {}, async () => 'retry')).value, 'retry');
  });
});

test('safe-download reuse preserves bytes, size constraints, private-address protection and cancellation', async () => {
  let calls = 0;
  const options = { url: 'https://source.example/a', dnsLookup: async () => [{ address: '8.8.8.8', family: 4 }],
    fetchFn: async () => { calls++; return new Response('safe data'); },
    limits: { maxSourceBytes: 100, maxRedirects: 1, fetchTimeoutMs: 1000 } };
  await withCostContext({ requestCache: new Map() }, async () => {
    const first = await safeFetchResource(options); first.buffer.fill(0);
    assert.equal((await safeFetchResource(options)).buffer.toString(), 'safe data');
    assert.equal(calls, 1);
    await assert.rejects(safeFetchResource({ ...options, maxBytes: 2 }), /大小上限/);
    await assert.rejects(safeFetchResource({ ...options, url: 'http://127.0.0.1/a' }), /私网/);
  });
  const controller = new AbortController(); controller.abort();
  await withCostContext({ signal: controller.signal, requestCache: new Map() }, async () => {
    await assert.rejects(safeFetchResource(options), { name: 'AbortError' });
  });
});

test('calendar-month, rolling window and configuration totals are separate; reopening is read-only', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const events = [{ occurredAt: Date.parse('2026-10-01T01:00:00Z'), costUsd: 1, configurationId: 'old' },
    { occurredAt: now, costUsd: null, configurationId: 'current' }];
  const report = costPeriods(events, { month: '2026-09', now, configurationId: 'current' });
  assert.equal(report.calendarMonth.knownCostUsd, 1);
  assert.equal(report.rolling30Days.requests, 2);
  assert.equal(report.currentConfiguration.unknownCostRequests, 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-'));
  try {
    const filename = path.join(dir, 'costs.db'); const store = openCostStore(filename);
    store.record({ attemptId: 'one', costUsd: 0 }); store.close();
    const db = new Database(filename, { readonly: true });
    try { assert.equal(db.prepare('SELECT count(*) AS n FROM cost_events').get().n, 1); }
    finally { db.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('late unknown receipts cannot erase costs; legacy trace preservation is content-free and idempotent', async () => {
  const { legacyCostEvents, importLegacyCosts } = await import('../src/core/cost-import.js');
  const now = Date.now();
  const trace = { workflowId: 'translate', input: 'private article', translationInference: { requests: [
    { requestStartedAt: new Date(now).toISOString(), generationId: 'known', cost: .1, stage: 'translation', outcome: 'completed' },
    { requestStartedAt: new Date(now).toISOString(), cost: 0, error: 'private response' },
  ] }, requests: [{ startedAt: new Date(now).toISOString(), requestId: 'exa-known', costDollars: { total: .01 }, status: 'ok' }] };
  const events = legacyCostEvents(trace, 'directory', now);
  assert.equal(events.length, 3); assert.equal(events[1].costUsd, null);
  assert.equal(JSON.stringify(events).includes('private'), false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-cost-'));
  try {
    const filename = path.join(root, 'costs.db'); const store = openCostStore(filename);
    const directory = path.join(root, 'runs', 'task'); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'research-trace.json'), JSON.stringify(trace));
    try {
      const args = { costs: store, workflows: { translate: { id: 'translate', workDir: root } }, now };
      assert.equal(importLegacyCosts(args).events, 3);
      assert.equal(importLegacyCosts(args).skipped, true);
      store.record({ attemptId: 'late', vendor: 'openrouter', generationId: 'late-generation', costUsd: .2, outcome: 'completed' });
      store.record({ attemptId: 'late', vendor: 'openrouter', costUsd: null, outcome: 'unknown' });
    } finally { store.close(); }
    const reader = new Database(filename, { readonly: true });
    try {
      assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM cost_events').get().n, 4);
      assert.equal(reader.prepare('SELECT cost_usd FROM cost_events WHERE attempt_id=?').get('late').cost_usd, .2);
    } finally { reader.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('request reuse propagates cancellation while waiting and bounds cache bytes across nested stages', async () => {
  const controller = new AbortController(); let release;
  await withCostContext({ signal: controller.signal, requestCache: new Map() }, async () => {
    const load = () => new Promise(resolve => { release = resolve; });
    const first = reuseTaskRequest('download', {}, load);
    const second = reuseTaskRequest('download', {}, load);
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(); release('response');
    await assert.rejects(first, { name: 'AbortError' });
    await assert.rejects(second, { name: 'AbortError' });
  });
  let calls = 0;
  await withCostContext({ runId: 'cache-bounds', requestCache: new Map() }, async () => {
    const load = async () => { calls++; return 'data'; };
    await withCostContext({ stage: 'first' }, () => reuseTaskRequest('large', { q: 1 }, load, () => 5 * 1024 * 1024));
    await withCostContext({ stage: 'second' }, () => reuseTaskRequest('large', { q: 2 }, load, () => 5 * 1024 * 1024));
    await reuseTaskRequest('large', { q: 2 }, load, () => 5 * 1024 * 1024);
  });
  assert.equal(calls, 3);
});
