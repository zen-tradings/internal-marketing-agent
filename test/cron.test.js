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

test('cron 使用统一通知频道和显式时区', () => {
  let callback;
  let options;
  const tasks = [];
  registerCron({
    workflows: { morning: { id: 'morning', triggers: ['cron:0 8 * * 1'] } },
    enqueue: (task) => tasks.push(task),
    notifyChannel: 'C-NOTIFY',
    timezone: 'America/Los_Angeles',
    scheduleFn: (_expr, fn, opts) => { callback = fn; options = opts; },
  });
  callback();
  assert.equal(options.timezone, 'America/Los_Angeles');
  assert.deepEqual(tasks[0].notify, { channel: 'C-NOTIFY' });
});
