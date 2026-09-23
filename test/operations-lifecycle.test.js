import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { acquireInstanceLock } from '../src/core/instance-lock.js';
import { openStore } from '../src/core/store.js';
import { inspectRollbackSafety } from '../src/core/rollback-safety.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-ops-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'runs.db');
}

test('database lock covers symlink aliases and survives stale sidecars after SIGKILL', async t => {
  const dbPath = fixture(t), alias = path.join(path.dirname(dbPath), 'alias.db');
  const script = `import { acquireInstanceLock } from ${JSON.stringify(new URL('../src/core/instance-lock.js', import.meta.url).href)};
    globalThis.instanceLock = acquireInstanceLock(process.argv[1]); process.stdout.write('locked'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, dbPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  const [ready] = await once(child.stdout, 'data');
  assert.equal(String(ready), 'locked');
  fs.symlinkSync(dbPath, alias);
  assert.throws(() => acquireInstanceLock(alias), /独占运行权/);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const next = acquireInstanceLock(alias);
  assert.throws(() => acquireInstanceLock(dbPath), /独占运行权/);
  next.release(); next.release();
  acquireInstanceLock(dbPath).release();
  assert.ok(fs.existsSync(`${dbPath}.instance-lock`));
});

test('legacy database upgrades atomically, preserves rows and remains additive for old readers', t => {
  const dbPath = fixture(t);
  const old = new Database(dbPath);
  old.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, source TEXT NOT NULL, input TEXT NOT NULL,
    status TEXT NOT NULL, stage TEXT, title TEXT, media_id TEXT, error TEXT, notify_json TEXT, created_at INTEGER NOT NULL,
    started_at INTEGER, finished_at INTEGER);
    INSERT INTO runs (id,workflow_id,source,input,status,media_id,created_at) VALUES ('old','wechat','slack','original','done','remote-old',1);`);
  old.close();
  const store = openStore(dbPath); assert.equal(store.getRun('old').media_id, 'remote-old'); store.close();
  const reader = new Database(dbPath, { readonly: true });
  assert.deepEqual(reader.prepare('SELECT version FROM schema_migrations ORDER BY version').all(), [{ version: 1 }, { version: 2 }]);
  assert.equal(reader.prepare('SELECT input FROM runs WHERE id = ?').get('old').input, 'original');
  assert.equal(inspectRollbackSafety(reader).ok, true); reader.close();
  openStore(dbPath).close();
  const newer = new Database(dbPath); newer.prepare('INSERT INTO schema_migrations VALUES (99, ?, ?)').run('future', 1); newer.close();
  assert.throws(() => openStore(dbPath), /拒绝降级/);
});

test('rollback guard and health expose uncertain writes and retained outboxes without leaking content', t => {
  const dbPath = fixture(t), store = openStore(dbPath); t.after(() => store.close());
  store.createRun({ id: 'r', workflowId: 'wechat', source: 'slack', input: 'private prompt' });
  store.prepareRemoteOperation({ runId: 'r', operation: 'create', operationKey: 'key', payloadSha256: 'hash' });
  store.incrementRemoteOperationAttempt('r', 'create');
  store.setStatus('r', 'needs_review');
  store.queueNotification({ runId: 'r', method: 'needsReview', notify: {}, payload: 'private response' });
  store.queueDeliveryOutbox({ runId: 'r', destination: 'wechat', payloadJson: '{}', payloadSha256: 'hash' });
  const health = store.recoveryHealth(Date.now() + 1000);
  assert.equal(health.unresolvedOperations, 1); assert.equal(health.needsReviewRuns, 1);
  assert.equal(health.pendingNotifications, 1); assert.equal(health.unfinishedDeliveries, 1);
  assert.ok(health.oldestNotificationAgeMs >= 1000); assert.ok(!JSON.stringify(health).includes('private'));
  const reader = new Database(dbPath, { readonly: true });
  assert.equal(inspectRollbackSafety(reader).ok, false); reader.close();
});

test('startup preserves confirmed success and quarantines interrupted writes before translation recovery', t => {
  const dbPath = fixture(t), store = openStore(dbPath); t.after(() => store.close());
  for (const id of ['confirmed', 'uncertain', 'generation']) {
    store.createRun({ id, workflowId: 'translate', source: 'slack', input: 'fixture' });
    store.setStatus(id, 'running');
  }
  store.setMediaId('confirmed', 'remote-id', 'Confirmed draft');
  store.prepareRemoteOperation({ runId: 'uncertain', operation: 'create', operationKey: 'uncertain', payloadSha256: 'hash' });
  store.incrementRemoteOperationAttempt('uncertain', 'create');
  assert.deepEqual(store.recoverInterruptedPublications(), { confirmed: 1, needsReview: 1 });
  assert.equal(store.recoverRunningWorkflow('translate'), 1);
  assert.equal(store.getRun('confirmed').status, 'done');
  assert.equal(store.getRun('uncertain').status, 'needs_review');
  assert.equal(store.getRun('generation').status, 'queued');
  assert.deepEqual(store.listPendingNotifications().map(row => row.method).sort(), ['needsReview', 'success']);
});

test('isolated backup recovery preserves checkpoint and ambiguous operation records', async () => {
  const { rehearseBackupRestore } = await import('../scripts/check-backup-restore.mjs');
  assert.equal((await rehearseBackupRestore()).integrity, 'ok');
});

test('remote operation claim cannot authorize two creators even across database connections', t => {
  const dbPath = fixture(t), first = openStore(dbPath), second = openStore(dbPath);
  t.after(() => { first.close(); second.close(); });
  first.createRun({ id: 'r', workflowId: 'wechat', source: 'slack', input: 'fixture' });
  first.prepareRemoteOperation({ runId: 'r', operation: 'create', operationKey: 'key', payloadSha256: 'hash' });
  assert.equal(first.incrementRemoteOperationAttempt('r', 'create').attempt_count, 1);
  assert.equal(second.incrementRemoteOperationAttempt('r', 'create'), undefined);
  assert.equal(first.getRemoteOperation('r', 'create').attempt_count, 1);
});
