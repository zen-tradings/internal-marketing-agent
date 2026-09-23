import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createResourceGovernor } from '../src/core/resource-governor.js';
import { withTaskCancellation } from '../src/lib/task-cancellation.js';
import { safeFetchResource } from '../src/lib/safe-fetch.js';
import { fetchWithTimeout } from '../src/lib/http-timeout.js';
import { validateLocalImage } from '../src/lib/publication-assets.js';
import { loadConfig } from '../src/config/index.js';
import { flushDiscordDeliveryOutbox } from '../src/core/delivery-outbox.js';
import { flushOpeningDigestWechatOutbox } from '../src/core/opening-digest-wechat-outbox.js';

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

test('production governor + cancellation retain DNS pinning and cancellation', async () => {
  const governor = createResourceGovernor();
  const cancellation = new AbortController();
  let pinned = 0;
  const result = await safeFetchResource({
    url: 'https://example.com/test', dnsLookup: publicDns,
    fetchFn: withTaskCancellation(governor.fetch, cancellation.signal),
    pinnedFetchFactory(addresses) {
      assert.equal(addresses[0].address, '93.184.216.34');
      pinned++;
      return async () => new Response('fixture');
    },
  });
  assert.equal(pinned, 1);
  assert.equal(result.buffer.toString(), 'fixture');
});

test('body stalls obey the deadline after headers arrive', async () => {
  let cancelled = false;
  const response = await fetchWithTimeout(async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  })), 'https://example.com', {}, { timeoutMs: 15 });
  await assert.rejects(response.text(), /超时/);
  assert.equal(cancelled, true);
});

test('download body stalls obey safe-fetch deadline', async () => {
  await assert.rejects(safeFetchResource({
    url: 'https://example.com', dnsLookup: publicDns,
    limits: { maxRedirects: 0, fetchTimeoutMs: 15, maxSourceBytes: 100 },
    fetchFn: async () => new Response(new ReadableStream({})),
  }), /超时/);
});

test('OpenRouter permit covers body consumption, cancellation and errors', async () => {
  let calls = 0;
  const governor = createResourceGovernor({ openrouterConcurrency: 1, fetchFn: async () => {
    calls++;
    return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); } }));
  } });
  const first = await governor.fetch('https://openrouter.ai/api/v1/chat/completions');
  const second = governor.fetch('https://openrouter.ai/api/v1/chat/completions');
  await new Promise(r => setImmediate(r));
  assert.equal(calls, 1);
  assert.equal(governor.stats().openrouter.active, 1);
  await first.body.cancel();
  const response = await second;
  assert.equal(calls, 2);
  await response.body.cancel();
  assert.equal(governor.stats().openrouter.active, 0);
});

test('image paths reject traversal, encoding, symlink escapes and non-image files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-asset-boundary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = path.join(root, 'run'); await fs.mkdir(run);
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  await fs.writeFile(path.join(root, 'outside.png'), png);
  await fs.writeFile(path.join(run, 'ok.png'), png);
  await fs.writeFile(path.join(run, 'fake.png'), 'not an image');
  await fs.symlink(path.join(root, 'outside.png'), path.join(run, 'escape.png'));
  const options = { absoluteDirPath: run };
  for (const value of ['../outside.png', '%2e%2e/outside.png', 'escape.png', 'fake.png', 'asset:anything']) {
    assert.throws(() => validateLocalImage(value, options));
  }
  assert.equal(validateLocalImage('ok.png', options), await fs.realpath(path.join(run, 'ok.png')));
  const trusted = path.join(root, 'outside.png');
  assert.equal(validateLocalImage(trusted, { ...options, trustedAssetPaths: [trusted] }), await fs.realpath(trusted));
});

test('dry-run never reads or mutates real delivery outboxes', async () => {
  const store = new Proxy({}, { get() { throw new Error('real store touched'); } });
  const config = { dryRun: true, discord: { openingDigestEnabled: true }, openingDigest: { wechatEnabled: true } };
  await flushDiscordDeliveryOutbox({ store, config });
  await flushOpeningDigestWechatOutbox({ store, config });
});

test('dry-run selects isolated database and artifact directories', () => {
  const config = loadConfig({ HUB_DRY_RUN: '1', DB_PATH: '/state/runs.db', WORK_DIR: '/state/work', SLACK_BOT_TOKEN: 'x', SLACK_APP_TOKEN: 'x', OPENROUTER_API_KEY: 'x', EXA_API_KEY: 'x', WECHAT_APP_ID: 'x', WECHAT_APP_SECRET: 'x' });
  assert.equal(config.dryRun, true);
  assert.equal(config.dbPath, '/state/runs.db.dry-run.db');
  assert.equal(config.workDir, '/state/work/dry-run');
});

test('cancellation before headers rejects promptly and closes a late response', async () => {
  const controller = new AbortController();
  let resolveFetch, cancelled = false;
  const request = fetchWithTimeout(() => new Promise(resolve => { resolveFetch = resolve; }), 'https://example.com', { signal: controller.signal }, { timeoutMs: 5000 });
  await new Promise(resolve => setImmediate(resolve));
  const reason = new Error('cancelled by caller'); controller.abort(reason);
  await assert.rejects(request, error => error === reason);
  resolveFetch(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test('body errors release the production OpenRouter permit', async () => {
  const governor = createResourceGovernor({ openrouterConcurrency: 1, fetchFn: async () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error('stream failed')); } })) });
  const response = await fetchWithTimeout(governor.fetch, 'https://openrouter.ai/api/v1/chat/completions');
  await assert.rejects(response.text(), /stream failed/);
  assert.equal(governor.stats().openrouter.active, 0);
});
