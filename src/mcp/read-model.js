import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const READ_MODEL_SCHEMA_VERSION = '1';
export const DEFAULT_RETENTION_DAYS = 90;

const WORKFLOWS = new Set([
  'wechat', 'sector', 'company', 'earnings', 'macro', 'morning', 'email',
  'translate', 'qdii', 'opening-digest',
]);
const RUN_SOURCES = new Set(['slack', 'cron', 'manual', 'recovery', 'test']);
const RUN_STATUSES = new Set([
  'queued', 'running', 'needs_input', 'done', 'failed', 'cancelled', 'interrupted',
]);
const DESTINATIONS = new Set([
  'wechat', 'wechat-opening-digest', 'customerio', 'customerio-draft',
  'customerio-opening-digest', 'discord', 'discord-opening-digest', 'mock',
]);
const DELIVERY_STATUSES = new Set([
  'pending', 'prepared', 'attempting', 'created', 'scheduled', 'sent', 'delivered',
  'done', 'failed', 'skipped', 'cancelled', 'existing', 'verified', 'unverified', 'queued',
]);

const READ_MODEL_SCHEMA = `
CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE servers (
  server_id TEXT PRIMARY KEY,
  exported_at INTEGER NOT NULL,
  newest_run_at INTEGER,
  oldest_run_at INTEGER,
  runs_in_window INTEGER NOT NULL
);
CREATE TABLE run_metrics (
  server_id TEXT NOT NULL,
  day TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  run_count INTEGER NOT NULL,
  duration_sum_ms INTEGER NOT NULL,
  duration_count INTEGER NOT NULL,
  PRIMARY KEY (server_id, day, workflow_id, source, status)
);
CREATE INDEX idx_run_metrics_day ON run_metrics(day, server_id, workflow_id);
CREATE TABLE delivery_metrics (
  server_id TEXT NOT NULL,
  day TEXT NOT NULL,
  destination TEXT NOT NULL,
  status TEXT NOT NULL,
  delivery_count INTEGER NOT NULL,
  PRIMARY KEY (server_id, day, destination, status)
);
CREATE INDEX idx_delivery_metrics_day ON delivery_metrics(day, server_id, destination);
CREATE TABLE failure_metrics (
  server_id TEXT NOT NULL,
  day TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  error_category TEXT NOT NULL,
  failure_count INTEGER NOT NULL,
  PRIMARY KEY (server_id, day, workflow_id, error_category)
);
CREATE INDEX idx_failure_metrics_day ON failure_metrics(day, server_id, workflow_id);
CREATE TABLE queue_metrics (
  server_id TEXT NOT NULL,
  status TEXT NOT NULL,
  run_count INTEGER NOT NULL,
  PRIMARY KEY (server_id, status)
);
CREATE TABLE outbox_metrics (
  server_id TEXT NOT NULL,
  outbox_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  PRIMARY KEY (server_id, outbox_kind, status)
);
`;

export function buildReadModel({
  sources,
  outputPath,
  retentionDays = DEFAULT_RETENTION_DAYS,
  now = Date.now(),
  busyTimeoutMs = 100,
} = {}) {
  const normalizedSources = validateSources(sources);
  if (!path.isAbsolute(String(outputPath || ''))) throw new Error('Read-model output path must be absolute');
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 366) {
    throw new Error('Read-model retentionDays must be an integer from 1 to 366');
  }
  if (!Number.isFinite(now)) throw new Error('Read-model timestamp is invalid');
  const resolvedOutput = path.resolve(outputPath);
  if (normalizedSources.some((source) => source.dbPath === resolvedOutput)) {
    throw new Error('Read-model output must not replace a source database');
  }

  const outputDirectory = path.dirname(resolvedOutput);
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o750 });
  const temporary = path.join(outputDirectory, `.${path.basename(resolvedOutput)}.${process.pid}.tmp`);
  removeOwnedTemporary(temporary);
  const cutoffDate = new Date(now);
  cutoffDate.setUTCHours(0, 0, 0, 0);
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - retentionDays + 1);
  const cutoff = cutoffDate.getTime();
  let output;
  try {
    output = new Database(temporary);
    output.pragma('journal_mode = DELETE');
    output.pragma('synchronous = FULL');
    output.exec(READ_MODEL_SCHEMA);
    const insertMetadata = output.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)');
    insertMetadata.run('schema_version', READ_MODEL_SCHEMA_VERSION);
    insertMetadata.run('generated_at', String(Math.trunc(now)));
    insertMetadata.run('retention_days', String(retentionDays));
    insertMetadata.run('source_count', String(normalizedSources.length));
    insertMetadata.run('privacy_policy', 'aggregate-only:no-prompts:no-identifiers:no-raw-errors:no-secrets');

    const importAll = output.transaction(() => {
      for (const source of normalizedSources) importSource(output, source, { cutoff, now, busyTimeoutMs });
    });
    importAll();
    output.pragma('optimize');
    output.close();
    output = undefined;
    fs.chmodSync(temporary, 0o640);
    fs.renameSync(temporary, resolvedOutput);
    return inspectReadModel(resolvedOutput, { maxStalenessMs: Infinity, now });
  } catch (error) {
    output?.close();
    removeOwnedTemporary(temporary);
    throw error;
  }
}

export function inspectReadModel(readModelPath, { maxStalenessMs = 15 * 60 * 1000, now = Date.now() } = {}) {
  return withReadModel(readModelPath, { maxStalenessMs, now }, (db, metadata) => {
    const servers = db.prepare(`
      SELECT server_id, exported_at, newest_run_at, oldest_run_at, runs_in_window
      FROM servers ORDER BY server_id
    `).all().map(camelizeServerRow);
    return { ...metadata, servers };
  });
}

export function queryBusinessOverview(readModelPath, {
  days = 7,
  serverId,
  maxStalenessMs,
  now = Date.now(),
} = {}) {
  const range = queryRange(days, now);
  return withReadModel(readModelPath, { maxStalenessMs, now }, (db, metadata) => {
    assertKnownServer(db, serverId);
    const params = [range.startDay];
    const serverClause = optionalServerClause(serverId, params);
    const totals = db.prepare(`
      SELECT status, SUM(run_count) AS count
      FROM run_metrics
      WHERE day >= ?${serverClause}
      GROUP BY status ORDER BY status
    `).all(...params);
    const workflows = db.prepare(`
      SELECT workflow_id, SUM(run_count) AS total,
        SUM(CASE WHEN status = 'done' THEN run_count ELSE 0 END) AS done,
        SUM(CASE WHEN status = 'failed' THEN run_count ELSE 0 END) AS failed,
        CAST(ROUND(CASE WHEN SUM(duration_count) > 0
          THEN 1.0 * SUM(duration_sum_ms) / SUM(duration_count) END) AS INTEGER) AS avg_duration_ms
      FROM run_metrics
      WHERE day >= ?${serverClause}
      GROUP BY workflow_id ORDER BY total DESC, workflow_id
    `).all(...params).map(normalizeCountRow);
    const queueParams = [];
    const queueServerClause = optionalServerClause(serverId, queueParams);
    const queue = db.prepare(`
      SELECT status, SUM(run_count) AS count
      FROM queue_metrics WHERE 1 = 1${queueServerClause}
      GROUP BY status ORDER BY status
    `).all(...queueParams).map(normalizeCountRow);
    const outbox = db.prepare(`
      SELECT outbox_kind, status, SUM(item_count) AS count
      FROM outbox_metrics WHERE 1 = 1${queueServerClause}
      GROUP BY outbox_kind, status ORDER BY outbox_kind, status
    `).all(...queueParams).map(normalizeCountRow);
    const total = totals.reduce((sum, row) => sum + Number(row.count), 0);
    const done = countFor(totals, 'done');
    const failed = countFor(totals, 'failed');
    return attachMetadata(metadata, range, {
      serverId: serverId || 'all',
      totals: {
        runs: total,
        done,
        failed,
        successRate: done + failed ? round(done / (done + failed), 4) : null,
        byStatus: Object.fromEntries(totals.map((row) => [row.status, Number(row.count)])),
      },
      currentQueue: Object.fromEntries(queue.map((row) => [row.status, Number(row.count)])),
      currentOutboxes: outbox,
      workflows,
    });
  });
}

export function queryWorkflowTrends(readModelPath, {
  days = 30,
  serverId,
  workflowId,
  maxStalenessMs,
  now = Date.now(),
  maxRows = 300,
} = {}) {
  const range = queryRange(days, now);
  return withReadModel(readModelPath, { maxStalenessMs, now }, (db, metadata) => {
    assertKnownServer(db, serverId);
    const params = [range.startDay];
    let filters = optionalServerClause(serverId, params);
    if (workflowId) {
      if (!WORKFLOWS.has(workflowId)) throw publicError('invalid_filter', 'Unknown workflow filter');
      filters += ' AND workflow_id = ?';
      params.push(workflowId);
    }
    params.push(maxRows + 1);
    const rows = db.prepare(`
      SELECT server_id, day, workflow_id,
        SUM(run_count) AS total,
        SUM(CASE WHEN status = 'done' THEN run_count ELSE 0 END) AS done,
        SUM(CASE WHEN status = 'failed' THEN run_count ELSE 0 END) AS failed,
        CAST(ROUND(CASE WHEN SUM(duration_count) > 0
          THEN 1.0 * SUM(duration_sum_ms) / SUM(duration_count) END) AS INTEGER) AS avg_duration_ms
      FROM run_metrics
      WHERE day >= ?${filters}
      GROUP BY server_id, day, workflow_id
      ORDER BY day DESC, server_id, workflow_id
      LIMIT ?
    `).all(...params).map(normalizeCountRow);
    if (rows.length > maxRows) throw publicError('result_too_broad', 'Result is too broad; filter by server or workflow');
    return attachMetadata(metadata, range, { serverId: serverId || 'all', workflowId: workflowId || 'all', rows });
  });
}

export function queryDeliveryPerformance(readModelPath, {
  days = 30,
  serverId,
  destination,
  maxStalenessMs,
  now = Date.now(),
} = {}) {
  const range = queryRange(days, now);
  return withReadModel(readModelPath, { maxStalenessMs, now }, (db, metadata) => {
    assertKnownServer(db, serverId);
    const params = [range.startDay];
    let filters = optionalServerClause(serverId, params);
    if (destination) {
      if (!DESTINATIONS.has(destination)) throw publicError('invalid_filter', 'Unknown destination filter');
      filters += ' AND destination = ?';
      params.push(destination);
    }
    const rows = db.prepare(`
      SELECT server_id, destination, status, SUM(delivery_count) AS count
      FROM delivery_metrics
      WHERE day >= ?${filters}
      GROUP BY server_id, destination, status
      ORDER BY server_id, destination, status
    `).all(...params).map(normalizeCountRow);
    return attachMetadata(metadata, range, { serverId: serverId || 'all', destination: destination || 'all', rows });
  });
}

export function queryFailureSummary(readModelPath, {
  days = 30,
  serverId,
  workflowId,
  maxStalenessMs,
  now = Date.now(),
} = {}) {
  const range = queryRange(days, now);
  return withReadModel(readModelPath, { maxStalenessMs, now }, (db, metadata) => {
    assertKnownServer(db, serverId);
    const params = [range.startDay];
    let filters = optionalServerClause(serverId, params);
    if (workflowId) {
      if (!WORKFLOWS.has(workflowId)) throw publicError('invalid_filter', 'Unknown workflow filter');
      filters += ' AND workflow_id = ?';
      params.push(workflowId);
    }
    const rows = db.prepare(`
      SELECT server_id, workflow_id, error_category, SUM(failure_count) AS count
      FROM failure_metrics
      WHERE day >= ?${filters}
      GROUP BY server_id, workflow_id, error_category
      ORDER BY count DESC, server_id, workflow_id, error_category
    `).all(...params).map(normalizeCountRow);
    return attachMetadata(metadata, range, { serverId: serverId || 'all', workflowId: workflowId || 'all', rows });
  });
}

export function queryServerInventory(readModelPath, { maxStalenessMs, now = Date.now() } = {}) {
  return inspectReadModel(readModelPath, { maxStalenessMs, now });
}

function importSource(output, source, { cutoff, now, busyTimeoutMs }) {
  const input = new Database(source.dbPath, { readonly: true, fileMustExist: true, timeout: busyTimeoutMs });
  try {
    input.pragma('query_only = ON');
    input.pragma(`busy_timeout = ${Math.max(1, Math.min(1000, Number(busyTimeoutMs) || 100))}`);
    requireSourceTables(input);
    const window = input.prepare(`
      SELECT COUNT(*) AS count, MIN(created_at) AS oldest, MAX(created_at) AS newest
      FROM runs WHERE created_at >= ?
    `).get(cutoff);
    output.prepare(`
      INSERT INTO servers (server_id, exported_at, newest_run_at, oldest_run_at, runs_in_window)
      VALUES (?, ?, ?, ?, ?)
    `).run(source.serverId, now, nullableNumber(window.newest), nullableNumber(window.oldest), Number(window.count));

    const insertRun = output.prepare(`
      INSERT INTO run_metrics
        (server_id, day, workflow_id, source, status, run_count, duration_sum_ms, duration_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id, day, workflow_id, source, status) DO UPDATE SET
        run_count = run_count + excluded.run_count,
        duration_sum_ms = duration_sum_ms + excluded.duration_sum_ms,
        duration_count = duration_count + excluded.duration_count
    `);
    const runRows = input.prepare(`
      SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
        workflow_id, source, status, COUNT(*) AS count,
        CAST(SUM(CASE
          WHEN finished_at IS NOT NULL AND COALESCE(started_at, created_at) <= finished_at
          THEN finished_at - COALESCE(started_at, created_at) ELSE 0
        END) AS INTEGER) AS duration_sum_ms,
        COUNT(CASE
          WHEN finished_at IS NOT NULL AND COALESCE(started_at, created_at) <= finished_at
          THEN 1 END) AS duration_count
      FROM runs
      WHERE created_at >= ?
      GROUP BY day, workflow_id, source, status
    `).all(cutoff);
    for (const row of runRows) {
      insertRun.run(
        source.serverId, row.day, safeDimension(row.workflow_id, WORKFLOWS),
        safeDimension(row.source, RUN_SOURCES), safeDimension(row.status, RUN_STATUSES),
        Number(row.count), Number(row.duration_sum_ms), Number(row.duration_count),
      );
    }

    const insertDelivery = output.prepare(`
      INSERT INTO delivery_metrics (server_id, day, destination, status, delivery_count)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(server_id, day, destination, status) DO UPDATE SET
        delivery_count = delivery_count + excluded.delivery_count
    `);
    const deliveryRows = input.prepare(`
      SELECT strftime('%Y-%m-%d', r.created_at / 1000, 'unixepoch') AS day,
        d.destination, d.status, COUNT(*) AS count
      FROM runs r
      JOIN run_deliveries d ON d.run_id = r.id
      WHERE r.created_at >= ?
      GROUP BY day, d.destination, d.status
    `).all(cutoff);
    for (const row of deliveryRows) {
      insertDelivery.run(
        source.serverId, row.day, safeDimension(row.destination, DESTINATIONS),
        safeDimension(row.status, DELIVERY_STATUSES), Number(row.count),
      );
    }

    const failures = new Map();
    for (const row of input.prepare(`
      SELECT created_at, workflow_id, error
      FROM runs WHERE status = 'failed' AND created_at >= ?
    `).all(cutoff)) {
      const day = new Date(row.created_at).toISOString().slice(0, 10);
      const workflowId = safeDimension(row.workflow_id, WORKFLOWS);
      const category = classifyError(row.error);
      const key = JSON.stringify([day, workflowId, category]);
      failures.set(key, (failures.get(key) || 0) + 1);
    }
    const insertFailure = output.prepare(`
      INSERT INTO failure_metrics (server_id, day, workflow_id, error_category, failure_count)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const [key, count] of failures) {
      const [day, workflowId, category] = JSON.parse(key);
      insertFailure.run(source.serverId, day, workflowId, category, count);
    }

    const insertQueue = output.prepare(`
      INSERT INTO queue_metrics (server_id, status, run_count) VALUES (?, ?, ?)
    `);
    for (const row of input.prepare(`
      SELECT status, COUNT(*) AS count FROM runs
      WHERE status IN ('queued', 'running', 'needs_input', 'interrupted')
      GROUP BY status
    `).all()) {
      insertQueue.run(source.serverId, safeDimension(row.status, RUN_STATUSES), Number(row.count));
    }
    importOutboxMetrics(input, output, source.serverId);
  } finally {
    input.close();
  }
}

function importOutboxMetrics(input, output, serverId) {
  const insert = output.prepare(`
    INSERT INTO outbox_metrics (server_id, outbox_kind, status, item_count) VALUES (?, ?, ?, ?)
  `);
  const pendingNotifications = input.prepare(`
    SELECT COUNT(*) AS count FROM notification_outbox WHERE sent_at IS NULL
  `).get();
  insert.run(serverId, 'notification', 'pending', Number(pendingNotifications.count));
  const pendingDeliveries = input.prepare(`
    SELECT COUNT(*) AS count FROM delivery_outbox WHERE state = 'pending'
  `).get();
  insert.run(serverId, 'delivery', 'pending', Number(pendingDeliveries.count));
}

function withReadModel(readModelPath, { maxStalenessMs = 15 * 60 * 1000, now = Date.now() } = {}, callback) {
  if (!path.isAbsolute(String(readModelPath || ''))) throw publicError('read_model_unavailable', 'Read model is unavailable');
  let db;
  try {
    db = new Database(readModelPath, { readonly: true, fileMustExist: true, timeout: 50 });
    db.pragma('query_only = ON');
    db.pragma('busy_timeout = 50');
    const metadataRows = db.prepare('SELECT key, value FROM metadata').all();
    const values = Object.fromEntries(metadataRows.map((row) => [row.key, row.value]));
    if (values.schema_version !== READ_MODEL_SCHEMA_VERSION) {
      throw publicError('read_model_version_mismatch', 'Read model schema is not supported');
    }
    const generatedAtMs = Number(values.generated_at);
    if (!Number.isFinite(generatedAtMs)) throw publicError('read_model_invalid', 'Read model metadata is invalid');
    if (generatedAtMs > now + 60_000) throw publicError('read_model_invalid', 'Read model timestamp is in the future');
    const lagMs = Math.max(0, now - generatedAtMs);
    if (Number.isFinite(maxStalenessMs) && lagMs > maxStalenessMs) {
      throw publicError('read_model_stale', 'Read model is stale; production data was not returned');
    }
    return callback(db, {
      asOf: new Date(generatedAtMs).toISOString(),
      lagSeconds: Math.round(lagMs / 1000),
      privacyPolicy: values.privacy_policy,
    });
  } catch (error) {
    if (error?.code && String(error.code).startsWith('read_model_')) throw error;
    throw publicError('read_model_unavailable', 'Read model is unavailable');
  } finally {
    db?.close();
  }
}

function requireSourceTables(db) {
  const required = ['runs', 'run_deliveries', 'notification_outbox', 'delivery_outbox'];
  const present = new Set(db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${required.map(() => '?').join(',')})
  `).all(...required).map((row) => row.name));
  const missing = required.filter((table) => !present.has(table));
  if (missing.length) throw new Error(`Source database is missing required tables: ${missing.join(', ')}`);
}

function validateSources(sources) {
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 32) {
    throw new Error('Read-model sources must contain 1 to 32 databases');
  }
  const ids = new Set();
  return sources.map((source) => {
    const serverId = String(source?.serverId || '');
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(serverId)) throw new Error('Invalid read-model server id');
    if (ids.has(serverId)) throw new Error(`Duplicate read-model server id: ${serverId}`);
    ids.add(serverId);
    const dbPath = path.resolve(String(source?.dbPath || ''));
    if (!path.isAbsolute(String(source?.dbPath || '')) || !fs.statSync(dbPath).isFile()) {
      throw new Error(`Invalid source database for ${serverId}`);
    }
    return { serverId, dbPath };
  });
}

function classifyError(value) {
  const error = String(value || '').toLowerCase();
  if (/rate.?limit|too many requests|\b429\b/.test(error)) return 'rate_limit';
  if (/timeout|timed out|etimedout/.test(error)) return 'timeout';
  if (/401|403|unauthori[sz]ed|forbidden|credential|token|scope/.test(error)) return 'access_or_auth';
  if (/econn|enotfound|fetch failed|network|socket|dns|tls|certificate/.test(error)) return 'network';
  if (/gate|校验|完整性|equivalence|unsupported|invalid|malformed|缺块|重复|未翻译/.test(error)) return 'content_gate';
  if (/publish|draft|wechat|customer\.io|discord|投递|草稿|发送/.test(error)) return 'delivery';
  if (/notion|linear|google docs|document|pdf|文档/.test(error)) return 'document_access';
  if (/cancel/.test(error)) return 'cancelled';
  return 'other';
}

function queryRange(days, now) {
  const normalized = Number(days);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 90) {
    throw publicError('invalid_range', 'days must be an integer from 1 to 90');
  }
  const today = new Date(now).toISOString().slice(0, 10);
  const start = new Date(`${today}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - normalized + 1);
  return { days: normalized, startDay: start.toISOString().slice(0, 10), endDay: today };
}

function optionalServerClause(serverId, params) {
  if (!serverId) return '';
  params.push(serverId);
  return ' AND server_id = ?';
}

function assertKnownServer(db, serverId) {
  if (!serverId) return;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(serverId)) throw publicError('invalid_filter', 'Unknown server filter');
  const row = db.prepare('SELECT 1 FROM servers WHERE server_id = ?').get(serverId);
  if (!row) throw publicError('invalid_filter', 'Unknown server filter');
}

function attachMetadata(metadata, range, payload) {
  return { ...metadata, range: { days: range.days, from: range.startDay, through: range.endDay }, ...payload };
}

function safeDimension(value, allowed) {
  const normalized = String(value || '');
  return allowed.has(normalized) ? normalized : 'other';
}

function normalizeCountRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (['count', 'total', 'done', 'failed', 'avg_duration_ms'].includes(key)) return [camelCase(key), nullableNumber(value)];
    return [camelCase(key), value];
  }));
}

function camelizeServerRow(row) {
  return {
    serverId: row.server_id,
    exportedAt: new Date(row.exported_at).toISOString(),
    newestRunAt: row.newest_run_at ? new Date(row.newest_run_at).toISOString() : null,
    oldestRunAt: row.oldest_run_at ? new Date(row.oldest_run_at).toISOString() : null,
    runsInWindow: Number(row.runs_in_window),
  };
}

function countFor(rows, status) {
  return Number(rows.find((row) => row.status === status)?.count || 0);
}

function round(value, digits) {
  return Number(value.toFixed(digits));
}

function nullableNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

function camelCase(value) {
  return value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function removeOwnedTemporary(filename) {
  try { fs.unlinkSync(filename); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

function publicError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
