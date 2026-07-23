import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/core/store.js';

test('createRun / getRun / setStatus 流转', () => {
  const s = openStore(':memory:');
  s.createRun({ id: 'r1', workflowId: 'wechat', source: 'slack', input: '写英伟达', notify: { channel: 'C1', ts: '1.1' } });
  let r = s.getRun('r1');
  assert.equal(r.status, 'queued');
  assert.equal(JSON.parse(r.notify_json).channel, 'C1');

  s.setStatus('r1', 'running', { startedAt: 111 });
  s.setStatus('r1', 'done', { title: 'T', mediaId: 'M', finishedAt: 222 });
  r = s.getRun('r1');
  assert.equal(r.status, 'done');
  assert.equal(r.media_id, 'M');
  assert.equal(r.title, 'T');
});

test('setMediaId 只写 media_id/title,不改变 status(支撑发布幂等判断)', () => {
  const s = openStore(':memory:');
  s.createRun({ id: 'r2', workflowId: 'wechat', source: 'slack', input: '写茅台', notify: { channel: 'C1', ts: '2.2' } });
  s.setStatus('r2', 'running', { startedAt: 111 });
  s.setMediaId('r2', 'M2', 'T2');
  const r = s.getRun('r2');
  assert.equal(r.media_id, 'M2');
  assert.equal(r.title, 'T2');
  assert.equal(r.status, 'running', 'setMediaId 不应改变 status(早写落库,收尾状态由 setStatus 负责)');
});

test('markInterrupted 把 running 置 interrupted', () => {
  const s = openStore(':memory:');
  s.createRun({ id: 'a', workflowId: 'w', source: 'slack', input: 'x', notify: {} });
  s.setStatus('a', 'running', {});
  assert.equal(s.markInterrupted(), 1);
  assert.equal(s.getRun('a').status, 'interrupted');
});

test('requeueInterrupted 只恢复指定中断任务并清理旧执行状态', () => {
  const s = openStore(':memory:');
  s.createRun({ id: 'a', workflowId: 'translate', source: 'slack', input: '直译', notify: {} });
  s.setStatus('a', 'running', { stage: 'generate', startedAt: 111 });
  s.markInterrupted();
  assert.equal(s.requeueInterrupted('a'), 1);
  const row = s.getRun('a');
  assert.equal(row.status, 'queued');
  assert.equal(row.stage, null);
  assert.equal(row.error, null);
  assert.equal(row.started_at, null);
  assert.equal(row.finished_at, null);
  assert.equal(s.requeueInterrupted('a'), 0, '已排队任务不得重复恢复');
});

test('recoverRunningWorkflow 只自动恢复指定工作流的运行中任务', () => {
  const s = openStore(':memory:');
  s.createRun({ id: 'translate', workflowId: 'translate', source: 'slack', input: '直译', notify: {} });
  s.createRun({ id: 'wechat', workflowId: 'wechat', source: 'slack', input: '分析', notify: {} });
  s.setStatus('translate', 'running', { startedAt: 1 });
  s.setStatus('wechat', 'running', { startedAt: 1 });
  assert.equal(s.recoverRunningWorkflow('translate'), 1);
  assert.equal(s.getRun('translate').status, 'queued');
  assert.equal(s.getRun('wechat').status, 'running');
  assert.equal(s.markInterrupted(), 1);
  assert.equal(s.getRun('wechat').status, 'interrupted');
});

test('requeueRecoverableTranslation 可恢复中断、历史出口、发布或网络生成失败的直译', () => {
  const s = openStore(':memory:');
  for (const id of ['egress', 'publish', 'generate', 'content']) {
    s.createRun({ id, workflowId: 'translate', source: 'slack', input: '直译', notify: {} });
    s.setStatus(id, 'failed', {
      stage: ['generate', 'content'].includes(id) ? 'generate' : id,
      error: id === 'generate' ? '网络请求失败:fetch failed (ECONNRESET)' : id,
      finishedAt: 2,
    });
  }
  assert.equal(s.requeueRecoverableTranslation('egress'), 1);
  assert.equal(s.getRun('egress').status, 'queued');
  assert.equal(s.requeueRecoverableTranslation('publish'), 1);
  assert.equal(s.getRun('publish').status, 'queued');
  assert.equal(s.requeueRecoverableTranslation('generate'), 1);
  assert.equal(s.getRun('generate').status, 'queued');
  assert.equal(s.requeueRecoverableTranslation('content'), 0);
  assert.equal(s.getRun('content').status, 'failed');
});

test('openStore 自动创建数据库父目录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  const dbPath = path.join(root, 'missing', 'nested', 'runs.db');
  const s = openStore(dbPath);
  s.createRun({ id: 'r3', workflowId: 'wechat', source: 'slack', input: 'x', notify: {} });
  assert.equal(s.getRun('r3').status, 'queued');
  assert.equal(fs.existsSync(path.dirname(dbPath)), true);
});

test('Slack 线程上下文按 channel + thread_ts 保存并限制最近 12 条', () => {
  const s = openStore(':memory:');
  const messages = Array.from({ length: 15 }, (_, i) => ({ text: `第${i + 1}条`, ts: String(i + 1) }));
  s.upsertSlackThread({
    threadKey: 'D1:100.1', channelId: 'D1', threadTs: '100.1',
    workflowId: 'translate', messages, lastRunId: 'run-1',
  });
  const thread = s.getSlackThread('D1:100.1');
  assert.equal(thread.workflow_id, 'translate');
  assert.equal(thread.messages.length, 12);
  assert.equal(thread.messages[0].text, '第4条');
  assert.equal(thread.last_run_id, 'run-1');
});

test('Slack 事件持久化 claim 防止跨进程重复消费,失败前可释放', () => {
  const s = openStore(':memory:');
  assert.equal(s.claimSlackEvent('Ev1'), true);
  assert.equal(s.claimSlackEvent('Ev1'), false);
  assert.equal(s.releaseSlackEvent('Ev1'), 1);
  assert.equal(s.claimSlackEvent('Ev1'), true);
});

test('过期任务只选择终态记录并和数据库清理保持一致', () => {
  const store = openStore(':memory:');
  store.createRun({ id: 'done-old', workflowId: 'wechat', source: 'test', input: 'x', notify: {} });
  store.createRun({ id: 'queued-old', workflowId: 'wechat', source: 'test', input: 'x', notify: {} });
  store.setStatus('done-old', 'done', { finishedAt: 1 });
  const expired = store.listPrunableRuns(2);
  assert.deepEqual(expired, [{ id: 'done-old', workflow_id: 'wechat' }]);
  const result = store.prune({ runBefore: 2 });
  assert.equal(result.runs, 1);
  assert.equal(store.getRun('done-old'), undefined);
  assert.equal(store.getRun('queued-old').status, 'queued');
});
