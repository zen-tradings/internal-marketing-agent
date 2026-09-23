import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const activeLocks = new Map();
function createFileIfAbsent(filename) {
  try { fs.closeSync(fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600)); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

/** A separate SQLite rollback-journal connection holds an OS lock for this
 * database's lifetime. Never unlink the sidecar: that would create a second
 * lock inode. OS process termination releases it, including SIGKILL. */
export function acquireInstanceLock(dbPath) {
  if (dbPath === ':memory:') return { release() {} };
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  createFileIfAbsent(dbPath);
  const canonical = fs.realpathSync(dbPath);
  if (fs.statSync(canonical).nlink !== 1) throw new Error('数据库存在硬链接，无法安全绑定唯一实例');
  // Beside the DB, not /tmp: systemd PrivateTmp must share this lock with manual starts.
  const lockPath = `${canonical}.instance-lock`;
  if (activeLocks.has(canonical)) throw new Error('无法取得数据库独占运行权，当前进程已持有实例锁');
  let lock;
  try {
    createFileIfAbsent(lockPath);
    if (!fs.lstatSync(lockPath).isFile()) throw new Error('实例锁必须是普通文件');
    lock = new Database(lockPath, { timeout: 0 });
    lock.pragma('journal_mode = DELETE');
    lock.exec('BEGIN EXCLUSIVE');
  } catch (cause) {
    try { lock?.close(); } catch {}
    throw new Error('无法取得数据库独占运行权，可能已有实例运行；不要删除 instance-lock 文件', { cause });
  }
  let released = false;
  const lease = { database: canonical, release() {
    if (released) return;
    released = true;
    activeLocks.delete(canonical);
    try { lock.exec('ROLLBACK'); } finally { lock.close(); }
  } };
  activeLocks.set(canonical, lease);
  return lease;
}
