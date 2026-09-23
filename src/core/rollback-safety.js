import { STORE_SCHEMA_VERSION } from './store-schema.js';

/** Read-only compatibility assessment. Additive columns remain readable by old
 * releases, but old retry/retention code must never see unresolved new state. */
export function inspectRollbackSafety(db) {
  const exists = table => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  const count = (table, predicate) => exists(table) ? db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`).get().count : 0;
  const schemaVersion = exists('schema_migrations') ? Number(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version || 0) : 0;
  const blockers = {
    activeOrReviewRuns: count('runs', "status IN ('queued', 'running', 'needs_review')"),
    unresolvedOperations: count('remote_operations', "state NOT IN ('confirmed', 'rejected')"),
    unconfirmedPublications: count('publication_intents', "state != 'confirmed'"),
    unfinishedDeliveries: count('delivery_outbox', "state IN ('pending', 'needs_review')"),
    pendingNotifications: count('notification_outbox', 'sent_at IS NULL'),
  };
  return { ok: schemaVersion <= STORE_SCHEMA_VERSION && Object.values(blockers).every(value => value === 0), schemaVersion, blockers };
}
