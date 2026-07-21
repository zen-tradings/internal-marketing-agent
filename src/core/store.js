import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  source TEXT NOT NULL,
  input TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT,
  title TEXT,
  media_id TEXT,
  error TEXT,
  notify_json TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at);

CREATE TABLE IF NOT EXISTS slack_threads (
  thread_key TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  messages_json TEXT NOT NULL,
  last_run_id TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_slack_threads_updated ON slack_threads(updated_at);
`;

export function openStore(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return {
    createRun({ id, workflowId, source, input, notify }) {
      db.prepare(
        `INSERT INTO runs (id, workflow_id, source, input, status, notify_json, created_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?)`
      ).run(id, workflowId, source, input, JSON.stringify(notify ?? {}), Date.now());
    },
    setStatus(id, status, patch = {}) {
      const cols = { status, stage: patch.stage, title: patch.title,
        media_id: patch.mediaId, error: patch.error,
        started_at: patch.startedAt, finished_at: patch.finishedAt };
      const sets = [], vals = [];
      for (const [k, v] of Object.entries(cols)) {
        if (v !== undefined) { sets.push(`${k} = ?`); vals.push(v); }
      }
      vals.push(id);
      db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    },
    getRun(id) { return db.prepare('SELECT * FROM runs WHERE id = ?').get(id); },
    setMediaId(id, mediaId, title) {
      // 早写:发布成功后立刻落库 media_id(不等整条 run 收尾),供重试/重启幂等判断
      db.prepare(`UPDATE runs SET media_id = ?, title = COALESCE(?, title) WHERE id = ?`)
        .run(mediaId, title ?? null, id);
    },
    listByStatus(status) { return db.prepare('SELECT * FROM runs WHERE status = ? ORDER BY created_at').all(status); },
    getSlackThread(threadKey) {
      const row = db.prepare('SELECT * FROM slack_threads WHERE thread_key = ?').get(threadKey);
      if (!row) return undefined;
      try { row.messages = JSON.parse(row.messages_json || '[]'); }
      catch { row.messages = []; }
      return row;
    },
    upsertSlackThread({ threadKey, channelId, threadTs, workflowId, messages, lastRunId }) {
      const bounded = Array.isArray(messages) ? messages.slice(-12) : [];
      db.prepare(`
        INSERT INTO slack_threads
          (thread_key, channel_id, thread_ts, workflow_id, messages_json, last_run_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_key) DO UPDATE SET
          workflow_id = excluded.workflow_id,
          messages_json = excluded.messages_json,
          last_run_id = COALESCE(excluded.last_run_id, slack_threads.last_run_id),
          updated_at = excluded.updated_at
      `).run(threadKey, channelId, threadTs, workflowId, JSON.stringify(bounded), lastRunId ?? null, Date.now());
    },
    markInterrupted() {
      return db.prepare(`UPDATE runs SET status = 'interrupted' WHERE status = 'running'`).run().changes;
    },
    requeueInterrupted(id) {
      return db.prepare(`
        UPDATE runs
        SET status = 'queued', stage = NULL, error = NULL, started_at = NULL, finished_at = NULL
        WHERE id = ? AND status = 'interrupted'
      `).run(id).changes;
    },
    requeueRecoverableTranslation(id) {
      return db.prepare(`
        UPDATE runs
        SET status = 'queued', stage = NULL, error = NULL, started_at = NULL, finished_at = NULL
        WHERE id = ? AND workflow_id = 'translate'
          AND (
            status = 'interrupted'
            OR (status = 'failed' AND stage IN ('egress', 'publish'))
            OR (status = 'failed' AND stage = 'generate' AND (
              error LIKE '%fetch failed%'
              OR error LIKE '网络请求失败%'
              OR error LIKE '%ECONNRESET%'
            ))
          )
      `).run(id).changes;
    },
    recoverRunningWorkflow(workflowId) {
      return db.prepare(`
        UPDATE runs
        SET status = 'queued', stage = NULL, error = NULL, started_at = NULL, finished_at = NULL
        WHERE workflow_id = ? AND status = 'running'
      `).run(workflowId).changes;
    },
  };
}
