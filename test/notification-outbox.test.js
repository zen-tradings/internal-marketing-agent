import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/core/store.js';
import { deliverOrQueueNotification, flushNotificationOutbox } from '../src/core/notification-outbox.js';

test('Slack 离线时终态通知入库，恢复后只补发一次', async () => {
  const store = openStore(':memory:');
  store.createRun({ id: 'r1', workflowId: 'wechat', source: 'slack', input: 'x', notify: { channel: 'C1' } });
  store.setStatus('r1', 'done', { finishedAt: 1 });
  const queued = await deliverOrQueueNotification({
    store, notifier: undefined, runId: 'r1', method: 'success',
    notify: { channel: 'C1' }, payload: { title: 'T', mediaId: 'M' },
  });
  assert.equal(queued.delivered, false);
  const calls = [];
  const result = await flushNotificationOutbox({
    store,
    notifier: { async success(notify, payload) { calls.push({ notify, payload }); } },
  });
  assert.deepEqual(result, { delivered: 1, failed: 0 });
  assert.equal(calls.length, 1);
  assert.deepEqual(await flushNotificationOutbox({ store, notifier: { success: async () => calls.push('duplicate') } }), { delivered: 0, failed: 0 });
  assert.equal(calls.length, 1);
});

test('QDII respond 补发成功后写入 Slack response ts', async () => {
  const store = openStore(':memory:');
  store.createRun({ id: 'q1', workflowId: 'qdii', source: 'slack', input: 'x', notify: { channel: 'C1', ts: '1' } });
  store.setStatus('q1', 'done', { finishedAt: 1 });
  store.queueNotification({ runId: 'q1', method: 'respond', notify: { channel: 'C1', ts: '1' }, payload: { messages: ['ok'] } });
  await flushNotificationOutbox({ store, notifier: { respond: async () => ({ responseTs: '2.2' }) } });
  assert.equal(store.getRun('q1').slack_response_ts, '2.2');
});

test('过期的终态通知不会在任务状态已改变后误发', async () => {
  const store = openStore(':memory:');
  store.createRun({ id: 'r2', workflowId: 'wechat', source: 'slack', input: 'x', notify: { channel: 'C1' } });
  store.setStatus('r2', 'failed', { finishedAt: 1 });
  store.queueNotification({ runId: 'r2', method: 'failure', notify: { channel: 'C1' }, payload: { error: 'old' } });
  store.setStatus('r2', 'done', { finishedAt: 2 });
  let called = false;
  await flushNotificationOutbox({ store, notifier: { failure: async () => { called = true; } } });
  assert.equal(called, false);
  assert.equal(store.listPendingNotifications().length, 0);
});

test('任务尚未进入终态时暂缓通知，而不是把竞态窗口中的通知丢弃', async () => {
  const store = openStore(':memory:');
  store.createRun({ id: 'q2', workflowId: 'qdii', source: 'slack', input: 'x', notify: { channel: 'C1', ts: '1' } });
  store.setStatus('q2', 'running', { startedAt: 1 });
  store.queueNotification({ runId: 'q2', method: 'respond', notify: { channel: 'C1', ts: '1' }, payload: { messages: ['ok'] } });
  let calls = 0;
  const notifier = { respond: async () => { calls += 1; return { responseTs: '3.3' }; } };

  assert.deepEqual(await flushNotificationOutbox({ store, notifier }), { delivered: 0, failed: 0 });
  assert.equal(store.listPendingNotifications().length, 1);
  store.setStatus('q2', 'done', { finishedAt: 2 });
  assert.deepEqual(await flushNotificationOutbox({ store, notifier }), { delivered: 1, failed: 0 });
  assert.equal(calls, 1);
});

test('同一任务再次入队同类通知时可复用已发送记录', async () => {
  const store = openStore(':memory:');
  store.createRun({ id: 'r3', workflowId: 'wechat', source: 'slack', input: 'x', notify: { channel: 'C1' } });
  store.setStatus('r3', 'failed', { finishedAt: 1 });
  const notifier = { failure: async () => {} };

  store.queueNotification({ runId: 'r3', method: 'failure', notify: { channel: 'C1' }, payload: { error: 'first' } });
  assert.deepEqual(await flushNotificationOutbox({ store, notifier }), { delivered: 1, failed: 0 });
  assert.equal(store.queueNotification({ runId: 'r3', method: 'failure', notify: { channel: 'C1' }, payload: { error: 'second' } }), 1);
  assert.equal(store.listPendingNotifications().length, 1);
});

test('即时发送成功会确认同一任务遗留的待发通知', async () => {
  const store = openStore(':memory:');
  store.createRun({ id: 'r4', workflowId: 'wechat', source: 'slack', input: 'x', notify: { channel: 'C1' } });
  store.setStatus('r4', 'done', { finishedAt: 1 });
  store.queueNotification({ runId: 'r4', method: 'success', notify: { channel: 'C1' }, payload: { title: 'old' } });

  const result = await deliverOrQueueNotification({
    store, notifier: { success: async () => {} }, runId: 'r4', method: 'success',
    notify: { channel: 'C1' }, payload: { title: 'new' },
  });
  assert.equal(result.delivered, true);
  assert.equal(store.listPendingNotifications().length, 0);
});
