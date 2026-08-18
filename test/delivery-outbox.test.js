import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/core/store.js';
import { flushDiscordDeliveryOutbox, queueDiscordDelivery } from '../src/core/delivery-outbox.js';

const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_1234567890';
const MESSAGE = { username: 'Zen Opening Digest', allowed_mentions: { parse: [] }, embeds: [{ title: 'Digest', description: 'Body' }] };

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => '' }, async text() { return JSON.stringify(data); } };
}

function setup(messageCount = 2) {
  const store = openStore(':memory:');
  store.createRun({ id: 'od-1', workflowId: 'opening-digest', source: 'cron', input: 'x', notify: { channel: 'C1' } });
  store.upsertDelivery('od-1', { destination: 'customerio', status: 'delivered', mediaId: 'customerio-newsletter:1' });
  queueDiscordDelivery({
    store,
    runId: 'od-1',
    title: 'Zen Opening Digest · 2026-08-10',
    payload: { schemaVersion: 1, messages: Array.from({ length: messageCount }, (_, index) => ({ ...MESSAGE, embeds: [{ ...MESSAGE.embeds[0], description: `Body ${index}` }] })) },
  });
  return store;
}

function config(maxAttempts = 8) {
  return { discord: { openingDigestEnabled: true, webhookUrl: WEBHOOK, expectedChannelId: '', timeoutMs: 30000, maxAttempts } };
}

test('Discord delivery outbox 逐条持久化 message id 并只投递一次', async () => {
  const store = setup(2);
  const posted = [];
  const fetchFn = async (_url, init) => {
    if (init.method === 'GET') return response({ id: 'webhook', channel_id: 'C-discord' });
    posted.push(JSON.parse(init.body).embeds[0].description);
    return response({ id: String(100 + posted.length), channel_id: 'C-discord' });
  };
  assert.deepEqual(await flushDiscordDeliveryOutbox({ store, config: config(), fetchFn }), {
    delivered: 1, retried: 0, failed: 0, messages: 2,
  });
  assert.deepEqual(posted, ['Body 0', 'Body 1']);
  const delivery = store.listDeliveries('od-1').find((item) => item.destination === 'discord');
  assert.equal(delivery.status, 'delivered');
  assert.equal(delivery.media_id, 'discord-message:101');
  assert.deepEqual(JSON.parse(delivery.details_json).messageIds, ['101', '102']);
  assert.deepEqual(await flushDiscordDeliveryOutbox({ store, config: config(), fetchFn }), {
    delivered: 0, retried: 0, failed: 0, messages: 0,
  });
  assert.equal(posted.length, 2);
});

test('Discord delivery outbox 从已成功的消息之后续传，不重发前帖', async () => {
  const store = setup(2);
  let firstRoundPosts = 0;
  const first = await flushDiscordDeliveryOutbox({
    store,
    config: config(),
    fetchFn: async (_url, init) => {
      if (init.method === 'GET') return response({ id: 'webhook', channel_id: 'C-discord' });
      firstRoundPosts += 1;
      if (firstRoundPosts === 2) throw new Error('temporary network outage');
      return response({ id: '201', channel_id: 'C-discord' });
    },
  });
  assert.deepEqual(first, { delivered: 0, retried: 1, failed: 0, messages: 1 });
  const pending = store.listDeliveries('od-1').find((item) => item.destination === 'discord');
  assert.equal(JSON.parse(pending.details_json).nextMessageIndex, 1);

  const secondRoundPosts = [];
  const second = await flushDiscordDeliveryOutbox({
    store,
    config: config(),
    now: Number.MAX_SAFE_INTEGER,
    fetchFn: async (_url, init) => {
      if (init.method === 'GET') return response({ id: 'webhook', channel_id: 'C-discord' });
      secondRoundPosts.push(JSON.parse(init.body).embeds[0].description);
      return response({ id: '202', channel_id: 'C-discord' });
    },
  });
  assert.deepEqual(second, { delivered: 1, retried: 0, failed: 0, messages: 1 });
  assert.deepEqual(secondRoundPosts, ['Body 1']);
});

test('Discord 不可重试失败会终结 outbox 并只触发一次精确告警', async () => {
  const store = setup(1);
  const warnings = [];
  const result = await flushDiscordDeliveryOutbox({
    store,
    config: config(),
    fetchFn: async () => response({ message: 'Unknown Webhook' }, 404),
    onTerminalFailure: async (entry) => warnings.push(entry),
  });
  assert.deepEqual(result, { delivered: 0, retried: 0, failed: 1, messages: 0 });
  assert.equal(warnings.length, 1);
  assert.equal(store.listDeliveries('od-1').find((item) => item.destination === 'discord').status, 'failed');
  await flushDiscordDeliveryOutbox({ store, config: config(), fetchFn: async () => { throw new Error('must not run'); }, onTerminalFailure: async () => warnings.push('duplicate') });
  assert.equal(warnings.length, 1);
});

test('Discord outbox 拒绝为同一 run 混入不同 payload', () => {
  const store = setup(1);
  assert.throws(() => queueDiscordDelivery({
    store, runId: 'od-1', title: 'changed', payload: { schemaVersion: 1, messages: [{ ...MESSAGE, embeds: [{ title: 'Other', description: 'changed' }] }] },
  }), /不同 payload/);
});
