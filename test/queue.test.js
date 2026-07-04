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
