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
  prompt_revision INTEGER NOT NULL DEFAULT 1,
  clarification_json TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_slack_threads_updated ON slack_threads(updated_at);

CREATE TABLE IF NOT EXISTS slack_events (
  event_key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_slack_events_created ON slack_events(created_at);
`;

export function openStore(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  ensureColumn(db, 'slack_threads', 'prompt_revision', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'slack_threads', 'clarification_json', 'TEXT');
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
      try { row.clarification = JSON.parse(row.clarification_json || 'null'); }
      catch { row.clarification = null; }
      return row;
    },
    upsertSlackThread({ threadKey, channelId, threadTs, workflowId, messages, lastRunId, promptRevision }) {
      const bounded = Array.isArray(messages) ? messages.slice(-12) : [];
      db.prepare(`
        INSERT INTO slack_threads
          (thread_key, channel_id, thread_ts, workflow_id, messages_json, last_run_id, prompt_revision, clarification_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(thread_key) DO UPDATE SET
          workflow_id = excluded.workflow_id,
          messages_json = excluded.messages_json,
          last_run_id = COALESCE(excluded.last_run_id, slack_threads.last_run_id),
          prompt_revision = excluded.prompt_revision,
          clarification_json = NULL,
          updated_at = excluded.updated_at
      `).run(
        threadKey,
        channelId,
        threadTs,
        workflowId,
        JSON.stringify(bounded),
        lastRunId ?? null,
        Number.isInteger(promptRevision) && promptRevision > 0 ? promptRevision : 1,
        Date.now(),
      );
    },
    setSlackClarification(threadKey, clarification) {
      if (!threadKey) return 0;
      return db.prepare(`
        UPDATE slack_threads
        SET clarification_json = ?, updated_at = ?
        WHERE thread_key = ?
      `).run(JSON.stringify(clarification || {}), Date.now(), threadKey).changes;
    },
    clearSlackClarification(threadKey) {
      if (!threadKey) return 0;
      return db.prepare(`
        UPDATE slack_threads
        SET clarification_json = NULL, updated_at = ?
        WHERE thread_key = ?
      `).run(Date.now(), threadKey).changes;
    },
    claimSlackEvent(eventKey) {
      if (!eventKey) return false;
      return db.prepare('INSERT OR IGNORE INTO slack_events (event_key, created_at) VALUES (?, ?)')
        .run(eventKey, Date.now()).changes === 1;
    },
    releaseSlackEvent(eventKey) {
      if (!eventKey) return 0;
      return db.prepare('DELETE FROM slack_events WHERE event_key = ?').run(eventKey).changes;
    },
    listPrunableRuns(before) {
      if (!Number.isFinite(before)) return [];
      return db.prepare(`
        SELECT id, workflow_id
        FROM runs
        WHERE status IN ('done', 'failed', 'interrupted', 'cancelled', 'needs_input')
          AND COALESCE(finished_at, created_at) < ?
        ORDER BY created_at
      `).all(before);
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
      // egress 只用于兼容旧版本已落库的失败记录；当前运行时不再产生出口门禁失败。
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
              OR error LIKE '结构化翻译校验失败:%'
              OR error LIKE '直译完整性门禁失败:%'
            ))
          )
      `).run(id).changes;
    },
    requeueRecoverableAnalysisGate(id) {
      return db.prepare(`
        UPDATE runs
        SET status = 'queued', stage = NULL, error = NULL, started_at = NULL, finished_at = NULL
        WHERE id = ?
          AND workflow_id IN ('wechat', 'sector', 'company', 'earnings')
          AND status = 'failed'
          AND media_id IS NULL
          AND (
            (stage = 'gate' AND (
              error LIKE '%正文包含代码围栏%'
              OR error LIKE '%四空格缩进块%'
            ))
            OR (stage = 'publish'
              AND error LIKE '发布失败:微信最终 HTML 完整性校验失败:%代码块含非语法高亮子节点%')
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
    prune({ runBefore, threadBefore, eventBefore } = {}) {
      const pruneTransaction = db.transaction(() => {
        const result = { runs: 0, threads: 0, events: 0 };
        if (Number.isFinite(runBefore)) {
          result.runs = db.prepare(`
            DELETE FROM runs
            WHERE status IN ('done', 'failed', 'interrupted', 'cancelled', 'needs_input')
              AND COALESCE(finished_at, created_at) < ?
          `).run(runBefore).changes;
        }
        if (Number.isFinite(threadBefore)) {
          result.threads = db.prepare('DELETE FROM slack_threads WHERE updated_at < ?').run(threadBefore).changes;
        }
        if (Number.isFinite(eventBefore)) {
          result.events = db.prepare('DELETE FROM slack_events WHERE created_at < ?').run(eventBefore).changes;
        }
        return result;
      });
      return pruneTransaction();
    },
    close() { db.close(); },
  };
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
