import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/core/store.js';
import {
  flushOpeningDigestWechatOutbox,
  queueOpeningDigestWechatDelivery,
} from '../src/core/opening-digest-wechat-outbox.js';

function openingPayload() {
  return {
    schemaVersion: 2,
    dateKey: '2026-09-10',
    article: {
      title: 'Zen Opening Digest',
      headline: 'Rates test conviction',
      preheader: 'Signals diverge ([Reuters](https://example.com/preheader)).',
      body: 'SPY held 650.25【10†https://example.com/spy】 while [NVDA](https://example.com/nvda) rose 2.5%.',
    },
    metrics: [],
    options: null,
  };
}

function setup(dbPath = ':memory:') {
  const store = openStore(dbPath);
  if (!store.getRun('od-wechat-1')) {
    store.createRun({ id: 'od-wechat-1', workflowId: 'opening-digest', source: 'cron', input: 'opening', notify: {} });
  }
  return store;
}

function config(workDir) {
  return {
    workDir,
    defaultTimeoutMs: 30000,
    writer: { model: 'test' },
    openingDigest: { wechatEnabled: true },
    wechat: { appId: 'wx', appSecret: 'secret' },
  };
}

function translated(payload) {
  return {
    model: 'test', payloadHash: 'hash', blockCount: 3, repairs: [], fallbacks: [],
    translations: [
      { id: 'headline', kind: 'headline', source: payload.article.headline, text: '利率考验信心' },
      { id: 'preheader', kind: 'preheader', source: payload.article.preheader, text: '信号分化。' },
      { id: 'body-1', kind: 'paragraph', source: payload.article.body, text: 'SPY 守住 650.25，NVDA 上涨 2.5%。' },
    ],
  };
}

test('正式邮件成功前微信 outbox 不执行，成功后消费同一冻结 payload', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-wechat-outbox-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = setup();
  const original = openingPayload();
  const first = queueOpeningDigestWechatDelivery({ store, runId: 'od-wechat-1', title: '微信日报', payload: original });
  const duplicate = queueOpeningDigestWechatDelivery({ store, runId: 'od-wechat-1', title: '微信日报', payload: original });
  assert.equal(first.id, duplicate.id);
  assert.equal(first.payload_sha256, duplicate.payload_sha256);
  let publishes = 0;
  const beforeEmail = await flushOpeningDigestWechatOutbox({
    store, config: config(root),
    translatePayload: async () => { throw new Error('邮件前不应翻译'); },
    wechatChannel: { publish: async () => { publishes += 1; } },
  });
  assert.deepEqual(beforeEmail, { delivered: 0, retried: 0, failed: 0 });
  assert.equal(publishes, 0);

  store.upsertDelivery('od-wechat-1', { destination: 'customerio', status: 'delivered', mediaId: 'customerio-newsletter:1' });
  let translatedInput;
  const afterEmail = await flushOpeningDigestWechatOutbox({
    store, config: config(root),
    translatePayload: async (input) => { translatedInput = input; return translated(input); },
    wechatChannel: { publish: async ({ onCreated }) => {
      publishes += 1;
      await onCreated({ remoteId: 'wx-1', title: '利率考验信心（日报· 2026-09-10）' });
      return { mediaId: 'wx-1', title: '利率考验信心（日报· 2026-09-10）', status: 'verified', errors: [], attempts: [] };
    } },
  });
  assert.deepEqual(afterEmail, { delivered: 1, retried: 0, failed: 0 });
  assert.equal(publishes, 1);
  assert.doesNotMatch(JSON.stringify(translatedInput), /https?:\/\/|【|†/);
  assert.match(translatedInput.article.body, /NVDA/);
  assert.equal(store.listDeliveries('od-wechat-1').find((item) => item.destination === 'wechat').status, 'verified');
});

test('media_id 落库后重启续跑只回读同一稿，不再创建', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-wechat-restart-'));
  const dbPath = path.join(root, 'runs.db');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let store = setup(dbPath);
  store.upsertDelivery('od-wechat-1', { destination: 'customerio', status: 'delivered', mediaId: 'customerio-newsletter:1' });
  queueOpeningDigestWechatDelivery({ store, runId: 'od-wechat-1', title: '微信日报', payload: openingPayload() });
  let firstExisting;
  const first = await flushOpeningDigestWechatOutbox({
    store, config: config(root),
    translatePayload: async (input) => translated(input),
    wechatChannel: { publish: async ({ existingRemoteId, onCreated }) => {
      firstExisting = existingRemoteId;
      await onCreated({ remoteId: 'wx-persisted', title: '微信日报' });
      const error = new Error('微信回读暂时超时'); error.retryable = true; error.remoteId = 'wx-persisted'; throw error;
    } },
  });
  assert.deepEqual(first, { delivered: 0, retried: 1, failed: 0 });
  assert.equal(firstExisting, '');
  assert.equal(store.listDeliveries('od-wechat-1').find((item) => item.destination === 'wechat').media_id, 'wx-persisted');
  store.close();

  store = setup(dbPath);
  let resumedExisting;
  const second = await flushOpeningDigestWechatOutbox({
    store, config: config(root), now: Number.MAX_SAFE_INTEGER,
    translatePayload: async (input) => translated(input),
    wechatChannel: { publish: async ({ existingRemoteId }) => {
      resumedExisting = existingRemoteId;
      return { mediaId: existingRemoteId, title: '微信日报', status: 'verified', errors: [], attempts: [] };
    } },
  });
  assert.deepEqual(second, { delivered: 1, retried: 0, failed: 0 });
  assert.equal(resumedExisting, 'wx-persisted');
  store.close();
});

test('瞬时限流按 Retry-After 延后且保持 pending', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-wechat-retry-after-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = setup();
  store.upsertDelivery('od-wechat-1', { destination: 'customerio', status: 'delivered', mediaId: 'customerio-newsletter:1' });
  const queued = queueOpeningDigestWechatDelivery({ store, runId: 'od-wechat-1', title: '微信日报', payload: openingPayload() });
  const startedAt = Date.now();
  const result = await flushOpeningDigestWechatOutbox({
    store, config: config(root),
    translatePayload: async () => {
      const error = new Error('OpenRouter 429'); error.retryable = true; error.retryAfterMs = 120000; throw error;
    },
    wechatChannel: { publish: async () => { throw new Error('不应创建'); } },
  });
  assert.deepEqual(result, { delivered: 0, retried: 1, failed: 0 });
  const row = store.getDeliveryOutbox(queued.id);
  assert.equal(row.state, 'pending');
  assert.ok(row.next_attempt_at >= startedAt + 120000);
});

test('事实硬门禁终态失败只告警一次，Customer.io 状态保持成功', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-wechat-terminal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = setup();
  store.upsertDelivery('od-wechat-1', { destination: 'customerio', status: 'delivered', mediaId: 'customerio-newsletter:1' });
  queueOpeningDigestWechatDelivery({ store, runId: 'od-wechat-1', title: '微信日报', payload: openingPayload() });
  const warnings = [];
  const options = {
    store, config: config(root),
    translatePayload: async () => { const error = new Error('数字 650.25 被改变'); error.retryable = false; throw error; },
    wechatChannel: { publish: async () => { throw new Error('不应创建'); } },
    onTerminalFailure: async (entry) => warnings.push(entry),
  };
  assert.deepEqual(await flushOpeningDigestWechatOutbox(options), { delivered: 0, retried: 0, failed: 1 });
  assert.deepEqual(await flushOpeningDigestWechatOutbox(options), { delivered: 0, retried: 0, failed: 0 });
  assert.equal(warnings.length, 1);
  assert.equal(store.listDeliveries('od-wechat-1').find((item) => item.destination === 'customerio').status, 'delivered');
  assert.equal(store.listDeliveries('od-wechat-1').find((item) => item.destination === 'wechat').status, 'failed');
});
