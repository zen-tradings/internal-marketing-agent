import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCronTriggers, registerCron } from '../src/triggers/cron.js';

test('解析 cron: 触发器', () => {
  assert.deepEqual(parseCronTriggers(['slack', 'cron:0 8 * * 1']), ['0 8 * * 1']);
});
test('为每个 cron 表达式注册一次', () => {
  const scheduled = [];
  const wf = { id: 'email', triggers: ['cron:0 8 * * 1', 'cron:0 8 * * 4'] };
  const n = registerCron({ workflows: { email: wf }, enqueue: () => {}, scheduleFn: (expr, fn) => { scheduled.push(expr); } });
  assert.equal(n, 2);
  assert.deepEqual(scheduled, ['0 8 * * 1', '0 8 * * 4']);
});
