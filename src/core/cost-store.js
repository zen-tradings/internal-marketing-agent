import Database from 'better-sqlite3';
import { normalizeCostEvent } from '../lib/cost-telemetry.js';

// Separate, versioned ledger: no foreign key to runs, and no publication-schema
// migration. Old releases can roll back without dropping accumulated costs.
export function openCostStore(filename) {
  const db = new Database(filename);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 100');
    const version = db.pragma('user_version', { simple: true });
    if (version > 1) throw new Error('Unsupported cost ledger version');
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS cost_events (
          attempt_id TEXT PRIMARY KEY, usage_id TEXT UNIQUE,
          occurred_at INTEGER NOT NULL, vendor TEXT NOT NULL,
          workflow_id TEXT NOT NULL, run_id TEXT, stage TEXT NOT NULL,
          model TEXT, outcome TEXT NOT NULL, cost_usd REAL, event_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cost_imports (id TEXT PRIMARY KEY, completed_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_cost_events_date ON cost_events(occurred_at);`);
      db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES (1, ?, ?)').run('content-free-cost-ledger', Date.now());
      db.pragma('user_version = 1');
    })();
  } catch (error) { db.close(); throw error; }
  const insert = db.prepare(`INSERT INTO cost_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(attempt_id) DO UPDATE SET usage_id=excluded.usage_id,
      model=excluded.model, outcome=excluded.outcome, cost_usd=excluded.cost_usd,
      event_json=excluded.event_json`);
  const record = db.transaction(raw => {
    const event = normalizeCostEvent(raw);
    const previous = db.prepare('SELECT event_json FROM cost_events WHERE attempt_id=?').get(event.attemptId);
    if (previous) {
      const saved = JSON.parse(previous.event_json);
      for (const [key, value] of Object.entries(event)) { if (value === null) event[key] = saved[key] ?? null; }
      event.occurredAt = saved.occurredAt;
      if (['attempting', 'unknown'].includes(event.outcome) && ['completed', 'empty'].includes(saved.outcome)) event.outcome = saved.outcome;
    }
    const usageId = event.generationId ? `${event.vendor}:${event.generationId}` : null;
    const existing = usageId && db.prepare('SELECT attempt_id, event_json FROM cost_events WHERE usage_id=?').get(usageId);
    if (existing && existing.attempt_id !== event.attemptId) {
      // Polls/repeated receipts for one provider generation are one billable unit.
      db.prepare('DELETE FROM cost_events WHERE attempt_id=?').run(event.attemptId);
      const saved = JSON.parse(existing.event_json);
      for (const [key, value] of Object.entries(event)) {
        if (value === null) event[key] = saved[key] ?? null;
      }
      event.attemptId = existing.attempt_id;
      event.occurredAt = saved.occurredAt;
      if (event.outcome === 'unknown' && saved.outcome === 'completed') event.outcome = saved.outcome;
    }
    insert.run(event.attemptId, usageId, event.occurredAt, event.vendor,
      event.workflowId, event.runId, event.stage, event.model,
      event.outcome, event.costUsd, JSON.stringify(event));
  });
  return {
    record,
    importCompleted(id) { return Boolean(db.prepare('SELECT 1 FROM cost_imports WHERE id=?').get(id)); },
    markImportCompleted(id) { db.prepare('INSERT OR IGNORE INTO cost_imports VALUES (?, ?)').run(id, Date.now()); },
    prune(now = Date.now(), days = 90) {
      return db.prepare('DELETE FROM cost_events WHERE occurred_at < ?').run(now - days * 86400000).changes;
    },
    close() { db.close(); },
  };
}
