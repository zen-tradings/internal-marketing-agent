import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/core/store.js';
import { requeueAnalysisGateRun } from '../scripts/requeue-analysis-gate.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'requeue-analysis-gate-'));
  return { dbPath: path.join(root, 'runs.db') };
}

const validNotify = { channel: 'C123456', ts: '1785538705.645', user: 'U123456' };

function createFailedRun(store, {
  id,
  workflowId = 'wechat',
  status = 'failed',
  stage = 'gate',
  error = '门禁拦截,不予发布:出口拦截:正文包含代码围栏,公众号固定版式不允许代码卡片',
  notify = validNotify,
  mediaId,
} = {}) {
  store.createRun({ id, workflowId, source: 'slack', input: '包含 ASCII 图和 Python 代码', notify });
  store.setStatus(id, status, { stage, error, mediaId, finishedAt: Date.now() });
}

test('受限分析重排只恢复四个 V2 工作流的旧代码门禁失败', () => {
  const { dbPath } = fixture();
  const store = openStore(dbPath);
  createFailedRun(store, { id: '1785538705645-6xoba', workflowId: 'wechat' });
  const result = requeueAnalysisGateRun({ runId: '1785538705645-6xoba', dbPath });
  assert.deepEqual(result, {
    runId: '1785538705645-6xoba',
    workflowId: 'wechat',
    status: 'queued',
  });
  assert.equal(store.getRun('1785538705645-6xoba').status, 'queued');
  assert.throws(
    () => requeueAnalysisGateRun({ runId: '1785538705645-6xoba', dbPath }),
    /只允许恢复旧代码块门禁失败/,
  );
  store.close();
});

test('受限分析重排拒绝其它工作流、失败类型、已发布任务和无效 Slack 通知', () => {
  const { dbPath } = fixture();
  const store = openStore(dbPath);
  createFailedRun(store, { id: 'translate-code-gate', workflowId: 'translate' });
  createFailedRun(store, { id: 'wechat-generate-fail', stage: 'generate', error: '模型失败' });
  createFailedRun(store, { id: 'wechat-already-published', mediaId: 'existing-media-id' });
  createFailedRun(store, { id: 'wechat-bad-notify', notify: { channel: 'C123456' } });

  assert.throws(
    () => requeueAnalysisGateRun({ runId: 'translate-code-gate', dbPath }),
    /只允许恢复 wechat\/sector\/company\/earnings/,
  );
  assert.throws(
    () => requeueAnalysisGateRun({ runId: 'wechat-generate-fail', dbPath }),
    /只允许恢复旧代码块门禁失败/,
  );
  assert.throws(
    () => requeueAnalysisGateRun({ runId: 'wechat-already-published', dbPath }),
    /已有 media_id/,
  );
  assert.throws(
    () => requeueAnalysisGateRun({ runId: 'wechat-bad-notify', dbPath }),
    /缺少有效 Slack/,
  );
  store.close();
});
