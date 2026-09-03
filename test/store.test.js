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

test('优先级和 Customer.io 远端操作跨重启所需状态均持久化', () => {
  const s = openStore(':memory:');
  s.createRun({ id: 'cio-1', workflowId: 'email', source: 'slack', input: 'x', notify: {}, priority: 7 });
  assert.equal(s.getRun('cio-1').priority, 7);
  let operation = s.prepareRemoteOperation({
    runId: 'cio-1',
    operation: 'create-newsletter',
    operationKey: 'cio:newsletter:create:v1:cio-1',
    payloadSha256: 'abc',
    beforeIds: ['10', '11'],
  });
  assert.equal(operation.attempt_count, 0);
  assert.deepEqual(JSON.parse(operation.before_ids_json), ['10', '11']);
  operation = s.incrementRemoteOperationAttempt('cio-1', 'create-newsletter');
  assert.equal(operation.attempt_count, 1);
  operation = s.updateRemoteOperation('cio-1', 'create-newsletter', { state: 'confirmed', remoteId: '42' });
  assert.equal(operation.remote_id, '42');
  assert.equal(s.getRemoteOperation('cio-1', 'create-newsletter').state, 'confirmed');
});

test('Opening Digest 双渠道结果按 run_id + destination 幂等记录', () => {
  const s = openStore(':memory:');
  s.createRun({ id: 'od-1', workflowId: 'opening-digest', source: 'cron', input: 'digest', notify: {} });
  s.upsertDelivery('od-1', { destination: 'customerio', status: 'delivered', mediaId: 'customerio-newsletter:1', title: 'English' });
  s.upsertDelivery('od-1', { destination: 'wechat', status: 'unverified', mediaId: 'wx-1', details: { errors: ['readback'] } });
  s.upsertDelivery('od-1', { destination: 'wechat', status: 'verified', mediaId: 'wx-1' });
  const rows = s.listDeliveries('od-1');
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.destination === 'wechat').status, 'verified');
  assert.equal(rows.find((row) => row.destination === 'wechat').media_id, 'wx-1');
  assert.equal(s.getRun('od-1').media_id, null, '子渠道记录不得覆盖主邮件 media_id');
});

test('Slack 核心回复单独记录 output kind/ts，绝不伪造 media_id', () => {
  const s = openStore(':memory:');
  s.createRun({ id: 'qdii-1', workflowId: 'qdii', source: 'slack', input: '513100', notify: {} });
  s.setOutputKind('qdii-1', 'slack-response');
  s.setSlackResponseTs('qdii-1', '1786332000.001');
  const row = s.getRun('qdii-1');
  assert.equal(row.output_kind, 'slack-response');
  assert.equal(row.slack_response_ts, '1786332000.001');
  assert.equal(row.media_id, null);
});

test('Slack 终态通知写入持久 outbox，失败退避后可确认发送', () => {
  const s = openStore(':memory:');
  s.createRun({ id: 'notify-1', workflowId: 'wechat', source: 'slack', input: 'x', notify: { channel: 'C1' } });
  assert.equal(s.queueNotification({ runId: 'notify-1', method: 'success', notify: { channel: 'C1' }, payload: { title: 'T' }, error: 'offline' }), 1);
  let pending = s.listPendingNotifications({ now: Date.now() });
  assert.equal(pending.length, 1);
  assert.equal(JSON.parse(pending[0].payload_json).title, 'T');
  s.markNotificationFailed(pending[0].id, { error: 'retry', nextAttemptAt: Date.now() + 60000 });
  assert.equal(s.listPendingNotifications({ now: Date.now() }).length, 0);
  pending = s.listPendingNotifications({ now: Date.now() + 61000 });
  assert.equal(pending[0].attempts, 1);
  s.markNotificationSent(pending[0].id, Date.now());
  assert.equal(s.listPendingNotifications({ now: Date.now() + 61000 }).length, 0);
});

test('cron schedule key 在数据库层阻止同工作流同业务日重复入队', () => {
  const s = openStore(':memory:');
  s.createRun({ id: 'cron-1', workflowId: 'opening-digest', source: 'cron', input: 'x', notify: {}, scheduleKey: '2026-08-14' });
  assert.throws(() => s.createRun({
    id: 'cron-2', workflowId: 'opening-digest', source: 'cron', input: 'x', notify: {}, scheduleKey: '2026-08-14',
  }), /UNIQUE constraint failed/);
  assert.equal(s.getRun('cron-1').schedule_key, '2026-08-14');
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

test('requeueRecoverableTranslation 可恢复中断、历史出口、发布、网络或结构响应失败的直译', () => {
  const s = openStore(':memory:');
  for (const id of ['egress', 'publish', 'generate', 'truncated', 'malformed', 'missing', 'validation', 'completeness', 'content']) {
    s.createRun({ id, workflowId: 'translate', source: 'slack', input: '直译', notify: {} });
    s.setStatus(id, 'failed', {
      stage: ['generate', 'truncated', 'malformed', 'missing', 'validation', 'completeness', 'content'].includes(id) ? 'generate' : id,
      error: id === 'generate'
        ? '网络请求失败:fetch failed (ECONNRESET)'
        : id === 'truncated'
          ? 'Unexpected end of JSON input'
          : id === 'malformed'
            ? 'OpenRouter returned malformed JSON response after retry'
            : id === 'missing'
              ? '结构化翻译缺块:38/51'
        : id === 'validation'
          ? '结构化翻译校验失败:b000067'
          : id === 'completeness'
            ? '直译完整性门禁失败:URL、占位符不一致:b000004'
          : id,
      finishedAt: 2,
    });
  }
  assert.equal(s.requeueRecoverableTranslation('egress'), 1);
  assert.equal(s.getRun('egress').status, 'queued');
  assert.equal(s.requeueRecoverableTranslation('publish'), 1);
  assert.equal(s.getRun('publish').status, 'queued');
  assert.equal(s.requeueRecoverableTranslation('generate'), 1);
  assert.equal(s.getRun('generate').status, 'queued');
  assert.equal(s.requeueRecoverableTranslation('truncated'), 1);
  assert.equal(s.requeueRecoverableTranslation('malformed'), 1);
  assert.equal(s.requeueRecoverableTranslation('missing'), 1);
  assert.equal(s.requeueRecoverableTranslation('validation'), 1);
  assert.equal(s.requeueRecoverableTranslation('completeness'), 1);
  assert.equal(s.getRun('validation').status, 'queued');
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
  assert.equal(thread.prompt_revision, 1);
  assert.equal(thread.clarification, null);
  assert.equal(s.setSlackClarification('D1:100.1', {
    runId: 'run-1',
    question: '请确认型号',
  }), 1);
  assert.equal(s.getSlackThread('D1:100.1').clarification.question, '请确认型号');
  s.upsertSlackThread({
    threadKey: 'D1:100.1', channelId: 'D1', threadTs: '100.1',
    workflowId: 'wechat', messages, lastRunId: 'run-2', promptRevision: 2,
  });
  assert.equal(s.getSlackThread('D1:100.1').prompt_revision, 2);
  assert.equal(s.getSlackThread('D1:100.1').clarification, null, '新修订入队后应清除旧澄清状态');
});

test('Slack 事件持久化 claim 防止跨进程重复消费,失败前可释放', () => {
  const s = openStore(':memory:');
  assert.equal(s.claimSlackEvent('Ev1'), true);
  assert.equal(s.claimSlackEvent('Ev1'), false);
  assert.equal(s.releaseSlackEvent('Ev1'), 1);
  assert.equal(s.claimSlackEvent('Ev1'), true);
});

test('Opening Digest OIC 历史同日幂等并只保留最近 60 个成功交易日', () => {
  const store = openStore(':memory:');
  const start = new Date('2026-01-01T12:00:00Z');
  for (let index = 0; index < 61; index++) {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    const sessionDate = date.toISOString().slice(0, 10);
    store.recordOpeningDigestOicCapture({
      sessionDate, capturedAt: date.toISOString(), status: 'success',
      rows: [{
        ticker: 'NVDA', rank: 1, ivx30: 55 + index, ivxChangePct: 2,
        ivxPointChange: 1, totalVolume: '1,000,000',
      }],
    });
  }
  const history = store.listOpeningDigestIvHistory();
  assert.equal(history.sessions.length, 60);
  assert.equal(history.rows.length, 60);
  assert.equal(history.sessions.includes('2026-01-01'), false);

  const latest = history.sessions[0];
  store.recordOpeningDigestOicCapture({
    sessionDate: latest, capturedAt: '2026-03-03T14:15:00Z', status: 'success',
    rows: [{
      ticker: 'META', rank: 2, ivx30: 61, ivxChangePct: 10,
      ivxPointChange: 5.55, totalVolume: '900,000',
    }],
  });
  const replaced = store.listOpeningDigestIvHistory();
  assert.equal(replaced.rows.some((row) => row.session_date === latest && row.ticker === 'NVDA'), false);
  assert.equal(replaced.rows.some((row) => row.session_date === latest && row.ticker === 'META'), true);

  store.recordOpeningDigestOicCapture({
    sessionDate: latest, capturedAt: '2026-03-03T15:00:00Z', status: 'failed', error: 'temporary', rows: [],
  });
  assert.equal(store.listOpeningDigestIvHistory().rows.some((row) => row.session_date === latest && row.ticker === 'META'), true);
});

test('Opening Digest 正式编辑判断同日幂等并只保留最近 20 个交易日', () => {
  const store = openStore(':memory:');
  for (let index = 0; index < 21; index++) {
    const sessionDate = `2026-08-${String(index + 1).padStart(2, '0')}`;
    assert.equal(store.recordOpeningDigestEditorialEdition({
      sessionDate, runId: `run-${index}`, headline: `Headline ${index}`,
      stance: index % 2 ? 'constructive' : 'neutral', confidence: 'medium',
      thesis: `Thesis ${index}.`, changeSummary: index ? 'Changed.' : 'Initial baseline.',
      signposts: ['VIX', '10Y UST'], publishedAt: index + 1,
    }), true);
  }
  const history = store.listOpeningDigestEditorialHistory({ limitSessions: 20 });
  assert.equal(history.length, 20);
  assert.equal(history[0].sessionDate, '2026-08-21');
  assert.equal(history.some((item) => item.sessionDate === '2026-08-01'), false);
  assert.deepEqual(history[0].signposts, ['VIX', '10Y UST']);
  assert.equal(store.recordOpeningDigestEditorialEdition({
    sessionDate: '2026-08-21', runId: 'other', headline: 'Do not overwrite',
    stance: 'defensive', confidence: 'low', thesis: 'Other thesis.',
  }), false);
  assert.equal(store.listOpeningDigestEditorialHistory()[0].headline, 'Headline 20');
});

test('过期任务只选择终态记录并和数据库清理保持一致', () => {
  const store = openStore(':memory:');
  store.createRun({ id: 'done-old', workflowId: 'wechat', source: 'test', input: 'x', notify: {} });
  store.createRun({ id: 'cancelled-old', workflowId: 'wechat', source: 'test', input: 'x', notify: {} });
  store.createRun({ id: 'queued-old', workflowId: 'wechat', source: 'test', input: 'x', notify: {} });
  store.createRun({ id: 'needs-input-old', workflowId: 'wechat', source: 'test', input: 'x', notify: {} });
  store.setStatus('done-old', 'done', { finishedAt: 1 });
  store.setStatus('cancelled-old', 'cancelled', { finishedAt: 1 });
  store.setStatus('needs-input-old', 'needs_input', { finishedAt: 1 });
  const expired = store.listPrunableRuns(2);
  assert.deepEqual(
    expired.map((row) => row.id).sort(),
    ['cancelled-old', 'done-old', 'needs-input-old'],
  );
  const result = store.prune({ runBefore: 2 });
  assert.equal(result.runs, 3);
  assert.equal(store.getRun('done-old'), undefined);
  assert.equal(store.getRun('cancelled-old'), undefined);
  assert.equal(store.getRun('needs-input-old'), undefined);
  assert.equal(store.getRun('queued-old').status, 'queued');
});
