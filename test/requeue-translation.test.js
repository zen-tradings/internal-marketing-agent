import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/core/store.js';
import { runWorkDir } from '../src/lib/run-workdir.js';
import { requeueTranslationRun } from '../scripts/requeue-translation.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'requeue-translation-'));
  return {
    root,
    dbPath: path.join(root, 'runs.db'),
    workDir: path.join(root, 'work'),
  };
}

function writeCheckpoint(workDir, runId) {
  const runDir = runWorkDir(path.join(workDir, 'translate'), runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'translation-checkpoint.json'), JSON.stringify({
    version: 6,
    key: 'checkpoint-key',
    translations: [{ id: 'meta:title', text: '标题' }],
  }));
}

test('受限续跑命令只恢复有 checkpoint 的失败直译', () => {
  const { dbPath, workDir } = fixture();
  const runId = '1785296714576-5bm7p-dc67ddcb2cd7';
  const store = openStore(dbPath);
  store.createRun({ id: runId, workflowId: 'translate', source: 'slack', input: '直译', notify: {} });
  store.setStatus(runId, 'failed', {
    stage: 'generate',
    error: 'Unexpected end of JSON input',
    finishedAt: Date.now(),
  });
  writeCheckpoint(workDir, runId);
  const result = requeueTranslationRun({ runId, dbPath, workDir });
  assert.equal(result.restoredUnits, 1);
  assert.equal(store.getRun(runId).status, 'queued');
});

test('受限续跑命令拒绝无 checkpoint、其它工作流和已有 media_id 的任务', () => {
  const { dbPath, workDir } = fixture();
  const store = openStore(dbPath);
  store.createRun({ id: 'translate-no-checkpoint', workflowId: 'translate', source: 'slack', input: '直译', notify: {} });
  store.setStatus('translate-no-checkpoint', 'failed', {
    stage: 'generate',
    error: '结构化翻译校验失败:b1',
  });
  assert.throws(
    () => requeueTranslationRun({ runId: 'translate-no-checkpoint', dbPath, workDir }),
    /没有 translation checkpoint/,
  );

  store.createRun({ id: 'wechat-failed-run', workflowId: 'wechat', source: 'slack', input: '写作', notify: {} });
  store.setStatus('wechat-failed-run', 'failed', { stage: 'generate', error: '失败' });
  writeCheckpoint(workDir, 'wechat-failed-run');
  assert.throws(
    () => requeueTranslationRun({ runId: 'wechat-failed-run', dbPath, workDir }),
    /只允许恢复 translate/,
  );

  store.createRun({ id: 'translate-published', workflowId: 'translate', source: 'slack', input: '直译', notify: {} });
  store.setStatus('translate-published', 'failed', {
    stage: 'publish',
    error: '通知失败',
    mediaId: 'existing-media-id',
  });
  writeCheckpoint(workDir, 'translate-published');
  assert.throws(
    () => requeueTranslationRun({ runId: 'translate-published', dbPath, workDir }),
    /已有 media_id/,
  );
});

test('受限续跑命令允许恢复最终完整性门禁失败且仍要求 checkpoint', () => {
  const { dbPath, workDir } = fixture();
  const runId = '1785506911116-on5z3';
  const store = openStore(dbPath);
  store.createRun({ id: runId, workflowId: 'translate', source: 'slack', input: '直译', notify: {} });
  store.setStatus(runId, 'failed', {
    stage: 'generate',
    error: '直译完整性门禁失败:URL、占位符、Ticker 或型号标识不一致:b000004',
    finishedAt: Date.now(),
  });
  writeCheckpoint(workDir, runId);
  const result = requeueTranslationRun({ runId, dbPath, workDir });
  assert.equal(result.restoredUnits, 1);
  assert.equal(store.getRun(runId).status, 'queued');
});
