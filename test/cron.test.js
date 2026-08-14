import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCronTriggers, reconcileCronWorkflows, registerCron, validateCronConfiguration } from '../src/triggers/cron.js';

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

test('cron 在创建任何定时器前统一拒绝无效表达式和时区', () => {
  assert.throws(() => validateCronConfiguration({
    workflows: { morning: { id: 'morning', triggers: ['cron:not valid'] } },
  }), /无效 cron 表达式/);
  assert.throws(() => validateCronConfiguration({
    workflows: { morning: { id: 'morning', cronTimezone: 'Mars\/Olympus', triggers: ['cron:0 8 * * 1'] } },
  }), /无效 cron 时区/);
});

test('cron 补跑只发生在允许窗口并携带稳定 schedule key', async () => {
  const tasks = [];
  const workflow = {
    id: 'opening-digest',
    triggers: ['cron:15 10 * * 1-5'],
    cronTimezone: 'America/New_York',
    cronCatchUpWindowMinutes: 120,
    cronRunKey: () => '2026-08-14',
    shouldRun: async () => true,
    cronInput: 'digest',
  };
  assert.equal(await reconcileCronWorkflows({
    workflows: { opening: workflow }, enqueue: (task) => tasks.push(task),
    now: new Date('2026-08-14T14:30:00Z'),
  }), 1);
  assert.equal(tasks[0].scheduleKey, '2026-08-14');
  assert.equal(await reconcileCronWorkflows({
    workflows: { opening: workflow }, enqueue: (task) => tasks.push(task),
    now: new Date('2026-08-14T17:00:00Z'),
  }), 0);
});
