import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { openStore } from '../src/core/store.js';
import { runWorkDir } from '../src/lib/run-workdir.js';

const hash = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
function tar(args) {
  const result = spawnSync('tar', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`备份归档检查失败: ${result.error?.message || result.stderr}`);
  return result.stdout;
}
export function restoreUnit(manifest, destination) {
  if (fs.existsSync(destination)) throw new Error('恢复目标必须是不存在的独立目录');
  const entries = fs.readFileSync(manifest, 'utf8').trim().split('\n').map(line => {
    const match = /^([a-f0-9]{64})\s+\*?([a-zA-Z0-9_.-]+)$/.exec(line);
    if (!match) throw new Error('备份 manifest 含不安全路径或无效哈希');
    const filename = path.join(path.dirname(manifest), match[2]);
    assert.equal(hash(filename), match[1], '备份校验和不一致');
    return filename;
  });
  const database = entries.find(name => /\/runs-[^/]+\.db$/.test(name));
  const archive = entries.find(name => /\/artifacts-[^/]+\.tar\.gz$/.test(name));
  if (entries.length !== 2 || !database || !archive) throw new Error('恢复单元必须同时包含数据库和资产归档');
  const names = tar(['-tzf', archive]).split('\n').filter(Boolean);
  if (names.some(name => path.isAbsolute(name) || name.split('/').includes('..'))) throw new Error('归档路径越界');
  if (tar(['-tvzf', archive]).split('\n').some(line => /^[lh]/.test(line))) throw new Error('隔离恢复不接受符号链接或硬链接资产');
  fs.mkdirSync(path.join(destination, 'work'), { recursive: true, mode: 0o700 });
  fs.copyFileSync(database, path.join(destination, 'runs.db'));
  tar(['-xzf', archive, '-C', path.join(destination, 'work'), '--no-same-owner']);
  const db = new Database(path.join(destination, 'runs.db'), { readonly: true });
  try {
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    return { integrity: 'ok', runCount: db.prepare('SELECT COUNT(*) AS count FROM runs').get().count,
      operationCount: db.prepare('SELECT COUNT(*) AS count FROM remote_operations').get().count };
  } finally { db.close(); }
}

export async function rehearseBackupRestore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-restore-drill-'));
  try {
    const database = path.join(root, 'source.db');
    const store = openStore(database);
    const work = path.join(root, 'work');
    const run = { id: 'restore-fixture', workflowId: 'translate' };
    const directory = runWorkDir(work, run.id);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'translation-checkpoint.json'), JSON.stringify({ key: 'fixture', translations: [{ id: 'b1', text: '恢复内容' }] }));
    try {
      store.createRun({ ...run, source: 'slack', input: 'isolated restore fixture' });
      store.setStatus(run.id, 'needs_review');
      store.prepareRemoteOperation({ runId: run.id, operation: 'create', operationKey: 'restore-key', payloadSha256: 'frozen-hash' });
      store.incrementRemoteOperationAttempt(run.id, 'create');
      store.queueNotification({ runId: run.id, method: 'needsReview', notify: {}, payload: 'preserve notification' });
      store.queueDeliveryOutbox({ runId: run.id, destination: 'wechat', payloadJson: '{}', payloadSha256: 'frozen-hash' });
      const reader = new Database(database, { readonly: true });
      try { await reader.backup(path.join(root, 'runs-fixture.db')); } finally { reader.close(); }
    } finally { store.close(); }
    tar(['-czf', path.join(root, 'artifacts-fixture.tar.gz'), '-C', work, '.']);
    const manifest = path.join(root, 'backup-fixture.sha256');
    fs.writeFileSync(manifest, ['runs-fixture.db', 'artifacts-fixture.tar.gz'].map(name => `${hash(path.join(root, name))}  ${name}`).join('\n'));
    const destination = path.join(root, 'restored');
    const result = restoreUnit(manifest, destination);
    const restored = openStore(path.join(destination, 'runs.db'));
    try {
      assert.equal(restored.getRun(run.id).status, 'needs_review');
      assert.equal(restored.getRemoteOperation(run.id, 'create').attempt_count, 1);
      assert.equal(restored.listPendingNotifications().length, 1);
      assert.equal(restored.deliveryOutboxStats().pending, 1);
      assert.equal(hash(path.join(destination, 'work', path.relative(work, directory), 'translation-checkpoint.json')), hash(path.join(directory, 'translation-checkpoint.json')));
    } finally { restored.close(); }
    // A tampered recovery unit is rejected before extraction.
    fs.appendFileSync(path.join(root, 'artifacts-fixture.tar.gz'), 'tamper');
    assert.throws(() => restoreUnit(manifest, path.join(root, 'tampered')), /校验和/);
    return { ...result, checkpoint: 'preserved', pendingOutboxes: 'preserved', ambiguousWrite: 'preserved', tampering: 'rejected', scope: 'isolated synthetic backup, no production data' };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('本命令只执行隔离的合成数据演练，不接受生产路径');
  console.log(JSON.stringify(await rehearseBackupRestore()));
}
