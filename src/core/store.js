import Database from 'better-sqlite3';

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
`;

export function openStore(dbPath) {
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
    listByStatus(status) { return db.prepare('SELECT * FROM runs WHERE status = ? ORDER BY created_at').all(status); },
    markInterrupted() {
      return db.prepare(`UPDATE runs SET status = 'interrupted' WHERE status = 'running'`).run().changes;
    },
  };
}
