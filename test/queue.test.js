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
