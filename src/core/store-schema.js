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

export const STORE_SCHEMA_VERSION = 2;
export function migrateStore(db) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  const version = exists ? Number(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version || 0) : 0;
  if (version > STORE_SCHEMA_VERSION) throw new Error(`数据库版本 ${version} 高于当前代码支持的 ${STORE_SCHEMA_VERSION}，拒绝降级写入`);
  db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    if (version < 1) {
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
      db.prepare('INSERT INTO schema_migrations VALUES (1, ?, ?)').run('legacy-baseline', Date.now());
    }
    if (version < 2) {
      db.exec(`CREATE TABLE IF NOT EXISTS publication_intents (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'prepared',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`);
      ensureColumn(db, 'remote_operations', 'payload_json', 'TEXT');
      db.prepare('INSERT INTO schema_migrations VALUES (2, ?, ?)').run('frozen-publication-intents', Date.now());
    }
    db.pragma(`user_version = ${STORE_SCHEMA_VERSION}`);
  })();
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
