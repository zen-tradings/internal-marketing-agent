import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/core/store.js';
import { createQueue } from '../src/core/queue.js';

test('并发受限 + 全部处理', async () => {
  const store = openStore(':memory:');
  let active = 0, maxSeen = 0;
  const order = [];
  const handler = async (run) => {
    active++; maxSeen = Math.max(maxSeen, active);
    await new Promise(r => setTimeout(r, 10));
    order.push(run.id); active--;
  };
  const q = createQueue({ store, maxConcurrency: 2, handler });
  for (const id of ['a', 'b', 'c', 'd']) q.enqueue({ id, workflowId: 'w', source: 'slack', input: id, notify: {} });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(order.length, 4);
  assert.ok(maxSeen <= 2, `并发应 ≤2,实际 ${maxSeen}`);
});

test('handler 抛错不卡死队列', async () => {
  const store = openStore(':memory:');
  const done = [];
  const q = createQueue({ store, maxConcurrency: 1, handler: async (run) => {
    if (run.id === 'bad') throw new Error('boom');
    done.push(run.id);
  }});
  q.enqueue({ id: 'bad', workflowId: 'w', source: 's', input: 'x', notify: {} });
  q.enqueue({ id: 'ok', workflowId: 'w', source: 's', input: 'y', notify: {} });
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(done, ['ok']);
});

test('restore 恢复持久化任务但不重复 INSERT', async () => {
  const store = openStore(':memory:');
  store.createRun({ id: 'saved', workflowId: 'translate', source: 'slack', input: '直译', notify: {} });
  const done = [];
  const q = createQueue({ store, maxConcurrency: 1, handler: async (run) => done.push(run.id) });
  q.restore({ id: 'saved', workflowId: 'translate', source: 'slack', input: '直译', notify: {} });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(done, ['saved']);
  assert.equal(store.getRun('saved').status, 'queued');
});

test('有界队列满时拒绝新任务且停止后不再接单', async () => {
  const store = openStore(':memory:');
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const q = createQueue({
    store,
    maxConcurrency: 1,
    maxQueueSize: 1,
    handler: async () => blocker,
  });
  q.enqueue({ id: 'active', workflowId: 'w', source: 'slack', input: 'a', notify: {} });
  q.enqueue({ id: 'pending', workflowId: 'w', source: 'slack', input: 'b', notify: {} });
  assert.throws(
    () => q.enqueue({ id: 'overflow', workflowId: 'w', source: 'slack', input: 'c', notify: {} }),
    /队列已满/,
  );
  assert.equal(store.getRun('overflow'), undefined);
  q.stop();
  assert.throws(
    () => q.enqueue({ id: 'stopped', workflowId: 'w', source: 'slack', input: 'd', notify: {} }),
    /正在关闭/,
  );
  release();
  await q.whenIdle();
});

test('活动任务可按 Slack 频道取消并触发 AbortSignal', async () => {
  const store = openStore(':memory:');
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const q = createQueue({
    store,
    maxConcurrency: 1,
    handler: async (_run, { signal, setPhase }) => {
      setPhase('generate');
      started();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  });
  q.enqueue({
    id: 'active-cancel',
    workflowId: 'w',
    source: 'slack',
    input: 'x',
    notify: { channel: 'C1', user: 'U1' },
  });
  await entered;
  const result = q.cancel({ channel: 'C1', user: 'U1' });
  assert.equal(result.kind, 'active');
  assert.equal(result.run.id, 'active-cancel');
  await result.done;
  assert.deepEqual(q.stats(), { active: 0, pending: 0, stopped: false });
});

test('排队任务取消后从队列移除并标记 cancelled', async () => {
  const store = openStore(':memory:');
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const q = createQueue({
    store,
    maxConcurrency: 1,
    handler: async () => blocker,
  });
  q.enqueue({ id: 'busy', workflowId: 'w', source: 'slack', input: 'a', notify: { channel: 'C1' } });
  q.enqueue({ id: 'queued-cancel', workflowId: 'w', source: 'slack', input: 'b', notify: { channel: 'C1' } });
  const result = q.cancel({ runId: 'queued-cancel', reason: 'cancel test' });
  assert.equal(result.kind, 'pending');
  assert.equal(q.stats().pending, 0);
  assert.equal(store.getRun('queued-cancel').status, 'cancelled');
  assert.equal(store.getRun('queued-cancel').stage, 'cancelled');
  release();
  await q.whenIdle();
});

test('进入外部草稿创建阶段后拒绝强制中断', async () => {
  const store = openStore(':memory:');
  let started;
  let release;
  const entered = new Promise((resolve) => { started = resolve; });
  const blocker = new Promise((resolve) => { release = resolve; });
  const q = createQueue({
    store,
    maxConcurrency: 1,
    handler: async (_run, { setPhase }) => {
      setPhase('publish');
      started();
      await blocker;
    },
  });
  q.enqueue({ id: 'publishing', workflowId: 'w', source: 'slack', input: 'x', notify: { channel: 'C1' } });
  await entered;
  const result = q.cancel({ channel: 'C1' });
  assert.equal(result.kind, 'too-late');
  assert.equal(result.phase, 'publish');
  release();
  await q.whenIdle();
});

test('重启恢复任务也能从数据库通知配置识别所属 Slack 频道', async () => {
  const store = openStore(':memory:');
  store.createRun({
    id: 'restored-cancel',
    workflowId: 'translate',
    source: 'slack',
    input: 'translate',
    notify: { channel: 'C2', user: 'U2' },
  });
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const q = createQueue({
    store,
    maxConcurrency: 1,
    handler: async (_run, { signal, setPhase }) => {
      setPhase('generate');
      started();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  });
  q.restore({
    id: 'restored-cancel',
    workflowId: 'translate',
    source: 'slack',
    input: 'translate',
    notify: {},
    restored: true,
  });
  await entered;
  const result = q.cancel({ channel: 'C2', user: 'U2' });
  assert.equal(result.kind, 'active');
  await result.done;
});
