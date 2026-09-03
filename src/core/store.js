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
  remote_id TEXT,
  output_kind TEXT,
  slack_response_ts TEXT,
  schedule_key TEXT,
  error TEXT,
  notify_json TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  next_retry_at INTEGER,
  last_reminded_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at);

CREATE TABLE IF NOT EXISTS remote_operations (
  run_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  payload_sha256 TEXT NOT NULL,
  before_ids_json TEXT NOT NULL DEFAULT '[]',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  remote_id TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, operation),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_remote_operations_state ON remote_operations(state, updated_at);

CREATE TABLE IF NOT EXISTS run_deliveries (
  run_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  status TEXT NOT NULL,
  media_id TEXT,
  title TEXT,
  error TEXT,
  details_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, destination),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_run_deliveries_run ON run_deliveries(run_id);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  method TEXT NOT NULL,
  notify_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  UNIQUE(run_id, method),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_notification_outbox_pending
  ON notification_outbox(sent_at, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS delivery_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  title TEXT,
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  next_message_index INTEGER NOT NULL DEFAULT 0,
  message_ids_json TEXT NOT NULL DEFAULT '[]',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE(run_id, destination),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_delivery_outbox_pending
  ON delivery_outbox(destination, state, next_attempt_at, created_at);

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

CREATE TABLE IF NOT EXISTS opening_digest_oic_captures (
  session_date TEXT PRIMARY KEY,
  captured_at TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS opening_digest_iv_history (
  session_date TEXT NOT NULL,
  ticker TEXT NOT NULL,
  rank INTEGER NOT NULL,
  ivx30 REAL NOT NULL,
  ivx_change_pct REAL NOT NULL,
  ivx_point_change REAL,
  total_option_volume INTEGER NOT NULL,
  PRIMARY KEY (session_date, ticker),
  FOREIGN KEY (session_date) REFERENCES opening_digest_oic_captures(session_date) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_opening_digest_iv_ticker_date
  ON opening_digest_iv_history(ticker, session_date DESC);

CREATE TABLE IF NOT EXISTS opening_digest_editorial_history (
  session_date TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  headline TEXT NOT NULL,
  stance TEXT NOT NULL,
  confidence TEXT NOT NULL,
  thesis TEXT NOT NULL,
  change_summary TEXT NOT NULL,
  signposts_json TEXT NOT NULL DEFAULT '[]',
  published_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opening_digest_editorial_published
  ON opening_digest_editorial_history(session_date DESC);
`;

export function openStore(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  ensureColumn(db, 'slack_threads', 'prompt_revision', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'slack_threads', 'clarification_json', 'TEXT');
  ensureColumn(db, 'runs', 'next_retry_at', 'INTEGER');
  ensureColumn(db, 'runs', 'last_reminded_at', 'INTEGER');
  ensureColumn(db, 'runs', 'remote_id', 'TEXT');
  ensureColumn(db, 'runs', 'output_kind', 'TEXT');
  ensureColumn(db, 'runs', 'slack_response_ts', 'TEXT');
  ensureColumn(db, 'runs', 'schedule_key', 'TEXT');
  ensureColumn(db, 'runs', 'priority', 'INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_queue_order ON runs(status, priority DESC, created_at ASC)');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_workflow_schedule
    ON runs(workflow_id, schedule_key) WHERE schedule_key IS NOT NULL`);
  return {
    createRun({ id, workflowId, source, input, notify, scheduleKey, priority = 0 }) {
      return db.prepare(
        `INSERT INTO runs (id, workflow_id, source, input, status, notify_json, schedule_key, priority, created_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`
      ).run(id, workflowId, source, input, JSON.stringify(notify ?? {}), scheduleKey || null, priority, Date.now()).changes;
    },
    setStatus(id, status, patch = {}) {
      const cols = { status, stage: patch.stage, title: patch.title,
        media_id: patch.mediaId, error: patch.error,
        started_at: patch.startedAt, finished_at: patch.finishedAt,
        next_retry_at: patch.nextRetryAt, last_reminded_at: patch.lastRemindedAt };
      const sets = [], vals = [];
      for (const [k, v] of Object.entries(cols)) {
        if (v !== undefined) { sets.push(`${k} = ?`); vals.push(v); }
      }
      vals.push(id);
      db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    },
    getRun(id) { return db.prepare('SELECT * FROM runs WHERE id = ?').get(id); },
    setMediaId(id, mediaId, title) {
      // Persist media_id immediately after publication, before run completion, for retry/restart idempotency.
      db.prepare(`UPDATE runs SET media_id = ?, title = COALESCE(?, title) WHERE id = ?`)
        .run(mediaId, title ?? null, id);
    },
    setRemoteId(id, remoteId) {
      db.prepare('UPDATE runs SET remote_id = ? WHERE id = ?').run(remoteId, id);
    },
    upsertDelivery(runId, delivery) {
      const now = Date.now();
      db.prepare(`
        INSERT INTO run_deliveries
          (run_id, destination, status, media_id, title, error, details_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, destination) DO UPDATE SET
          status = excluded.status,
          media_id = COALESCE(excluded.media_id, run_deliveries.media_id),
          title = COALESCE(excluded.title, run_deliveries.title),
          error = excluded.error,
          details_json = excluded.details_json,
          updated_at = excluded.updated_at
      `).run(
        runId, delivery.destination, delivery.status, delivery.mediaId || null,
        delivery.title || null, delivery.error || null,
        delivery.details ? JSON.stringify(delivery.details) : null, now, now,
      );
    },
    listDeliveries(runId) {
      return db.prepare('SELECT * FROM run_deliveries WHERE run_id = ? ORDER BY destination').all(runId);
    },
    setOutputKind(id, outputKind) {
      db.prepare('UPDATE runs SET output_kind = ? WHERE id = ?').run(outputKind || null, id);
    },
    setSlackResponseTs(id, responseTs) {
      db.prepare('UPDATE runs SET slack_response_ts = ? WHERE id = ?').run(responseTs || null, id);
    },
    queueNotification({ runId, method, notify, payload, error }) {
      const now = Date.now();
      return db.prepare(`
        INSERT INTO notification_outbox
          (run_id, method, notify_json, payload_json, attempts, next_attempt_at, last_error, created_at)
        VALUES (?, ?, ?, ?, 0, 0, ?, ?)
        ON CONFLICT(run_id, method) DO UPDATE SET
          notify_json = excluded.notify_json,
          payload_json = excluded.payload_json,
          attempts = 0,
          last_error = excluded.last_error,
          next_attempt_at = 0,
          created_at = excluded.created_at,
          sent_at = NULL
      `).run(
        runId, method, JSON.stringify(notify || {}), JSON.stringify(payload || {}),
        error ? String(error).slice(0, 1000) : null, now,
      ).changes;
    },
    listPendingNotifications({ now = Date.now(), limit = 50 } = {}) {
      return db.prepare(`
        SELECT * FROM notification_outbox
        WHERE sent_at IS NULL AND next_attempt_at <= ?
        ORDER BY created_at, id
        LIMIT ?
      `).all(now, Math.max(1, Math.min(500, Number(limit) || 50)));
    },
    markNotificationSent(id, sentAt = Date.now()) {
      return db.prepare(`
        UPDATE notification_outbox
        SET sent_at = ?, last_error = NULL
        WHERE id = ? AND sent_at IS NULL
      `).run(sentAt, id).changes;
    },
    markNotificationSentByRun(runId, method, sentAt = Date.now()) {
      return db.prepare(`
        UPDATE notification_outbox
        SET sent_at = ?, last_error = NULL
        WHERE run_id = ? AND method = ? AND sent_at IS NULL
      `).run(sentAt, runId, method).changes;
    },
    markNotificationFailed(id, { error, nextAttemptAt }) {
      return db.prepare(`
        UPDATE notification_outbox
        SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?
        WHERE id = ? AND sent_at IS NULL
      `).run(String(error || '').slice(0, 1000), Number(nextAttemptAt) || Date.now(), id).changes;
    },
    queueDeliveryOutbox({ runId, destination, title, payloadJson, payloadSha256 }) {
      const now = Date.now();
      return db.transaction(() => {
        db.prepare(`
          INSERT OR IGNORE INTO delivery_outbox
            (run_id, destination, title, payload_json, payload_sha256, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(runId, destination, title || null, payloadJson, payloadSha256, now, now);
        const row = db.prepare('SELECT * FROM delivery_outbox WHERE run_id = ? AND destination = ?')
          .get(runId, destination);
        if (!row) throw new Error(`无法持久化 ${destination} delivery outbox`);
        if (row.payload_sha256 !== payloadSha256) {
          throw new Error(`${destination} delivery outbox 已存在不同 payload，拒绝混合投递`);
        }
        return row;
      })();
    },
    listPendingDeliveryOutbox({ destination, now = Date.now(), limit = 10 } = {}) {
      return db.prepare(`
        SELECT * FROM delivery_outbox
        WHERE destination = ? AND state = 'pending' AND next_attempt_at <= ?
        ORDER BY created_at, id
        LIMIT ?
      `).all(destination, now, Math.max(1, Math.min(100, Number(limit) || 10)));
    },
    getDeliveryOutbox(id) {
      return db.prepare('SELECT * FROM delivery_outbox WHERE id = ?').get(id);
    },
    advanceDeliveryOutbox(id, { messageId }) {
      return db.transaction(() => {
        const row = db.prepare("SELECT * FROM delivery_outbox WHERE id = ? AND state = 'pending'").get(id);
        if (!row) throw new Error('delivery outbox 不存在或已终结');
        let messageIds;
        try { messageIds = JSON.parse(row.message_ids_json || '[]'); } catch { messageIds = []; }
        if (!Array.isArray(messageIds)) messageIds = [];
        messageIds.push(String(messageId));
        db.prepare(`
          UPDATE delivery_outbox
          SET next_message_index = next_message_index + 1,
              message_ids_json = ?, attempts = 0, next_attempt_at = 0,
              last_error = NULL, updated_at = ?
          WHERE id = ? AND state = 'pending'
        `).run(JSON.stringify(messageIds), Date.now(), id);
        return db.prepare('SELECT * FROM delivery_outbox WHERE id = ?').get(id);
      })();
    },
    retryDeliveryOutbox(id, { error, nextAttemptAt }) {
      db.prepare(`
        UPDATE delivery_outbox
        SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?, updated_at = ?
        WHERE id = ? AND state = 'pending'
      `).run(String(error || '').slice(0, 1000), Number(nextAttemptAt) || Date.now(), Date.now(), id);
      return db.prepare('SELECT * FROM delivery_outbox WHERE id = ?').get(id);
    },
    completeDeliveryOutbox(id) {
      const now = Date.now();
      db.prepare(`
        UPDATE delivery_outbox
        SET state = 'delivered', last_error = NULL, next_attempt_at = 0,
            updated_at = ?, finished_at = ?
        WHERE id = ? AND state = 'pending'
      `).run(now, now, id);
      return db.prepare('SELECT * FROM delivery_outbox WHERE id = ?').get(id);
    },
    failDeliveryOutbox(id, { error }) {
      const now = Date.now();
      db.prepare(`
        UPDATE delivery_outbox
        SET state = 'failed', attempts = attempts + 1, last_error = ?,
            next_attempt_at = 0, updated_at = ?, finished_at = ?
        WHERE id = ? AND state = 'pending'
      `).run(String(error || '').slice(0, 1000), now, now, id);
      return db.prepare('SELECT * FROM delivery_outbox WHERE id = ?').get(id);
    },
    deliveryOutboxStats() {
      const rows = db.prepare('SELECT state, COUNT(*) AS count FROM delivery_outbox GROUP BY state').all();
      const counts = Object.fromEntries(rows.map((row) => [row.state, Number(row.count)]));
      return { pending: counts.pending || 0, delivered: counts.delivered || 0, failed: counts.failed || 0 };
    },
    listByStatus(status) { return db.prepare('SELECT * FROM runs WHERE status = ? ORDER BY priority DESC, created_at').all(status); },
    getRemoteOperation(runId, operation) {
      return db.prepare('SELECT * FROM remote_operations WHERE run_id = ? AND operation = ?').get(runId, operation);
    },
    prepareRemoteOperation({ runId, operation, operationKey, payloadSha256, beforeIds = [] }) {
      const now = Date.now();
      db.prepare(`
        INSERT INTO remote_operations
          (run_id, operation, operation_key, payload_sha256, before_ids_json, attempt_count, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, 'prepared', ?, ?)
        ON CONFLICT(run_id, operation) DO UPDATE SET
          updated_at = excluded.updated_at
      `).run(runId, operation, operationKey, payloadSha256, JSON.stringify(beforeIds), now, now);
      return db.prepare('SELECT * FROM remote_operations WHERE run_id = ? AND operation = ?').get(runId, operation);
    },
    incrementRemoteOperationAttempt(runId, operation) {
      db.prepare(`
        UPDATE remote_operations
        SET attempt_count = attempt_count + 1, state = 'attempting', updated_at = ?
        WHERE run_id = ? AND operation = ? AND attempt_count < 2 AND remote_id IS NULL
      `).run(Date.now(), runId, operation);
      return db.prepare('SELECT * FROM remote_operations WHERE run_id = ? AND operation = ?').get(runId, operation);
    },
    updateRemoteOperation(runId, operation, patch = {}) {
      const columns = {
        state: patch.state,
        remote_id: patch.remoteId,
        last_error: patch.lastError === undefined ? undefined : String(patch.lastError || '').slice(0, 1000),
        updated_at: Date.now(),
      };
      const sets = [], values = [];
      for (const [column, value] of Object.entries(columns)) {
        if (value !== undefined) { sets.push(`${column} = ?`); values.push(value); }
      }
      values.push(runId, operation);
      db.prepare(`UPDATE remote_operations SET ${sets.join(', ')} WHERE run_id = ? AND operation = ?`).run(...values);
      return db.prepare('SELECT * FROM remote_operations WHERE run_id = ? AND operation = ?').get(runId, operation);
    },
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
    recordOpeningDigestOicCapture({ sessionDate, capturedAt, status, error, rows = [] }) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(sessionDate || ''))) throw new Error('Opening Digest OIC session date 无效');
      if (!['success', 'failed'].includes(status)) throw new Error('Opening Digest OIC capture status 无效');
      const record = db.transaction(() => {
        db.prepare(`
          INSERT INTO opening_digest_oic_captures (session_date, captured_at, status, error)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(session_date) DO UPDATE SET
            captured_at = excluded.captured_at,
            status = CASE WHEN opening_digest_oic_captures.status = 'success' THEN 'success' ELSE excluded.status END,
            error = CASE WHEN opening_digest_oic_captures.status = 'success' THEN NULL ELSE excluded.error END
        `).run(sessionDate, String(capturedAt || new Date().toISOString()), status, error ? String(error).slice(0, 600) : null);
        if (status === 'success') {
          db.prepare('DELETE FROM opening_digest_iv_history WHERE session_date = ?').run(sessionDate);
          const insert = db.prepare(`
            INSERT INTO opening_digest_iv_history
              (session_date, ticker, rank, ivx30, ivx_change_pct, ivx_point_change, total_option_volume)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `);
          for (const row of rows) {
            const volume = Number(String(row.totalVolume || '').replaceAll(',', ''));
            if (!/^[A-Z0-9.-]{1,20}$/.test(String(row.ticker || ''))
              || !Number.isInteger(row.rank) || !Number.isFinite(row.ivx30)
              || !Number.isFinite(row.ivxChangePct) || !Number.isSafeInteger(volume)) continue;
            insert.run(
              sessionDate, row.ticker, row.rank, row.ivx30, row.ivxChangePct,
              Number.isFinite(row.ivxPointChange) ? row.ivxPointChange : null,
              volume,
            );
          }
        }
        const cutoff = db.prepare(`
          SELECT session_date
          FROM opening_digest_oic_captures
          WHERE status = 'success'
          ORDER BY session_date DESC
          LIMIT 1 OFFSET 59
        `).get()?.session_date;
        if (cutoff) {
          db.prepare('DELETE FROM opening_digest_iv_history WHERE session_date < ?').run(cutoff);
          db.prepare('DELETE FROM opening_digest_oic_captures WHERE session_date < ?').run(cutoff);
        }
      });
      record();
    },
    listOpeningDigestIvHistory({ limitSessions = 60 } = {}) {
      const limit = Math.max(1, Math.min(60, Math.floor(Number(limitSessions) || 60)));
      const sessions = db.prepare(`
        SELECT session_date
        FROM opening_digest_oic_captures
        WHERE status = 'success'
        ORDER BY session_date DESC
        LIMIT ?
      `).all(limit).map((row) => row.session_date);
      if (!sessions.length) return { sessions: [], rows: [] };
      const placeholders = sessions.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT session_date, ticker, rank, ivx30, ivx_change_pct, ivx_point_change, total_option_volume
        FROM opening_digest_iv_history
        WHERE session_date IN (${placeholders})
        ORDER BY session_date DESC, rank ASC
      `).all(...sessions);
      return { sessions, rows };
    },
    recordOpeningDigestEditorialEdition({ sessionDate, runId, headline, stance, confidence, thesis, changeSummary = '', signposts = [], publishedAt = Date.now() }) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(sessionDate || ''))) throw new Error('Opening Digest editorial session date 无效');
      if (!String(runId || '').trim() || !String(headline || '').trim() || !['constructive', 'neutral', 'defensive'].includes(stance)
        || !['high', 'medium', 'low'].includes(confidence) || !String(thesis || '').trim()) {
        throw new Error('Opening Digest editorial history 字段无效');
      }
      const transaction = db.transaction(() => {
        const inserted = db.prepare(`
          INSERT OR IGNORE INTO opening_digest_editorial_history
            (session_date, run_id, headline, stance, confidence, thesis, change_summary, signposts_json, published_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          sessionDate, String(runId), String(headline).slice(0, 200), stance, confidence,
          String(thesis).slice(0, 2000), String(changeSummary).slice(0, 600),
          JSON.stringify((Array.isArray(signposts) ? signposts : []).map(String).slice(0, 5)), Number(publishedAt) || Date.now(),
        );
        db.prepare(`
          DELETE FROM opening_digest_editorial_history
          WHERE session_date NOT IN (
            SELECT session_date FROM opening_digest_editorial_history ORDER BY session_date DESC LIMIT 20
          )
        `).run();
        return inserted.changes === 1;
      });
      return transaction();
    },
    listOpeningDigestEditorialHistory({ limitSessions = 20 } = {}) {
      const limit = Math.max(1, Math.min(20, Math.floor(Number(limitSessions) || 20)));
      return db.prepare(`
        SELECT session_date, run_id, headline, stance, confidence, thesis, change_summary, signposts_json, published_at
        FROM opening_digest_editorial_history
        ORDER BY session_date DESC
        LIMIT ?
      `).all(limit).map((row) => ({
        sessionDate: row.session_date,
        runId: row.run_id,
        headline: row.headline,
        stance: row.stance,
        confidence: row.confidence,
        thesis: row.thesis,
        changeSummary: row.change_summary,
        signposts: safeJsonArray(row.signposts_json),
        publishedAt: row.published_at,
      }));
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
    deletePrunableRun(id, before) {
      if (!Number.isFinite(before)) return 0;
      return db.prepare(`
        DELETE FROM runs
        WHERE id = ?
          AND status IN ('done', 'failed', 'interrupted', 'cancelled', 'needs_input')
          AND COALESCE(finished_at, created_at) < ?
      `).run(id, before).changes;
    },
    markInterrupted() {
      return db.prepare(`UPDATE runs SET status = 'interrupted' WHERE status = 'running'`).run().changes;
    },
    requeueInterrupted(id) {
      return requeueAndClearNotifications(db, `
          UPDATE runs
          SET status = 'queued', stage = NULL, error = NULL, started_at = NULL, finished_at = NULL
          WHERE id = ? AND status = 'interrupted'
        `, id);
    },
    requeueRecoverableTranslation(id) {
      // egress exists only for historical persisted failures; current runtime no longer creates egress-gate failures.
      return requeueAndClearNotifications(db, `
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
              OR error = 'Unexpected end of JSON input'
              OR error LIKE 'OpenRouter returned malformed JSON response%'
              OR error LIKE '结构化翻译校验失败:%'
              OR error LIKE '结构化翻译缺块:%'
              OR error LIKE '直译完整性门禁失败:%'
            ))
          )
      `, id);
    },
    requeueRecoverableAnalysisGate(id) {
      return requeueAndClearNotifications(db, `
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
      `, id);
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

function safeJsonArray(value) {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function requeueAndClearNotifications(db, sql, id) {
  return db.transaction(() => {
    const changes = db.prepare(sql).run(id).changes;
    if (changes) db.prepare('DELETE FROM notification_outbox WHERE run_id = ? AND sent_at IS NULL').run(id);
    return changes;
  })();
}
