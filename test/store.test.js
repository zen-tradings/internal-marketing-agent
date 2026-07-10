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

test('openStore 自动创建数据库父目录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  const dbPath = path.join(root, 'missing', 'nested', 'runs.db');
  const s = openStore(dbPath);
  s.createRun({ id: 'r3', workflowId: 'wechat', source: 'slack', input: 'x', notify: {} });
  assert.equal(s.getRun('r3').status, 'queued');
  assert.equal(fs.existsSync(path.dirname(dbPath)), true);
});
