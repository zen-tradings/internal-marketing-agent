import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  buildReadModel,
  queryBusinessOverview,
  queryDeliveryPerformance,
  queryFailureSummary,
  queryServerInventory,
  queryWorkflowTrends,
} from '../src/mcp/read-model.js';
import {
  createAuditWriter,
  loadMcpServerConfig,
  startZenMcpHttpServer,
} from '../src/mcp/server.js';

const NOW = Date.parse('2026-09-20T18:00:00.000Z');

test('MCP read model exports only fixed aggregate fields and never copies sensitive production values', () => {
  const fixture = createFixture();
  const readModelPath = path.join(fixture.root, 'read-model.db');
  const result = buildReadModel({
    sources: [{ serverId: 'prod-sfo3', dbPath: fixture.dbPath }],
    outputPath: readModelPath,
    now: NOW,
  });
  assert.equal(result.servers[0].serverId, 'prod-sfo3');
  assert.equal(result.servers[0].runsInWindow, 3);

  const bytes = fs.readFileSync(readModelPath);
  for (const secret of fixture.secrets) assert.equal(bytes.includes(Buffer.from(secret)), false, secret);

  const model = new Database(readModelPath, { readonly: true });
  const tables = model.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
  assert.deepEqual(tables, [
    'delivery_metrics', 'failure_metrics', 'metadata', 'outbox_metrics',
    'queue_metrics', 'run_metrics', 'servers',
  ]);
  model.close();

  const overview = queryBusinessOverview(readModelPath, { days: 7, now: NOW });
  assert.equal(overview.totals.runs, 3);
  assert.equal(overview.totals.done, 1);
  assert.equal(overview.totals.failed, 1);
  assert.equal(overview.totals.successRate, 0.5);
  assert.equal(overview.currentQueue.running, 1);

  const trends = queryWorkflowTrends(readModelPath, { days: 7, now: NOW, workflowId: 'opening-digest' });
  assert.equal(trends.rows.length, 2);
  assert.equal(trends.rows.reduce((sum, row) => sum + row.total, 0), 2);
  const deliveries = queryDeliveryPerformance(readModelPath, { days: 7, now: NOW });
  assert.deepEqual(deliveries.rows.map((row) => [row.destination, row.status, row.count]), [
    ['customerio-opening-digest', 'sent', 1],
    ['discord-opening-digest', 'failed', 1],
  ]);
  const failures = queryFailureSummary(readModelPath, { days: 7, now: NOW });
  assert.equal(failures.rows[0].errorCategory, 'access_or_auth');
  assert.equal(failures.rows[0].count, 1);
});

test('MCP read model combines explicit server sources and fails closed when stale', () => {
  const first = createFixture('first');
  const second = createFixture('second');
  const readModelPath = path.join(first.root, 'combined.db');
  buildReadModel({
    sources: [
      { serverId: 'prod-a', dbPath: first.dbPath },
      { serverId: 'prod-b', dbPath: second.dbPath },
    ],
    outputPath: readModelPath,
    now: NOW,
  });
  const inventory = queryServerInventory(readModelPath, { now: NOW });
  assert.deepEqual(inventory.servers.map((item) => item.serverId), ['prod-a', 'prod-b']);
  assert.throws(
    () => queryBusinessOverview(readModelPath, { now: NOW + 16 * 60 * 1000, maxStalenessMs: 15 * 60 * 1000 }),
    (error) => error.code === 'read_model_stale' && !error.message.includes(first.dbPath),
  );
});

test('MCP runtime only accepts loopback and absolute isolated paths', () => {
  const base = {
    MCP_READ_MODEL_PATH: '/var/lib/zen-content-hub-mcp/read-model.db',
    MCP_AUDIT_LOG_PATH: '/var/log/zen-content-hub-mcp/audit.jsonl',
  };
  assert.equal(loadMcpServerConfig(base).host, '127.0.0.1');
  assert.throws(() => loadMcpServerConfig({ ...base, MCP_HOST: '0.0.0.0' }), /loopback/);
  assert.throws(() => loadMcpServerConfig({ ...base, MCP_READ_MODEL_PATH: 'runs.db' }), /absolute/);
  assert.throws(() => loadMcpServerConfig({ ...base, MCP_MAX_CONCURRENT: '5' }), /1 to 4/);
});

test('MCP audit writer stores metadata but drops results and unapproved fields', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-mcp-audit-'));
  const filename = path.join(root, 'audit.jsonl');
  const writeAudit = createAuditWriter(filename);
  await writeAudit({
    event: 'tool_finish', requestId: 'request-1', at: new Date(NOW).toISOString(),
    tool: 'get_business_overview', args: { days: 7 }, outcome: 'success',
    resultBytes: 120, result: 'must-not-be-logged', secret: 'must-not-be-logged',
  });
  const text = fs.readFileSync(filename, 'utf8');
  assert.match(text, /get_business_overview/);
  assert.doesNotMatch(text, /must-not-be-logged/);
});

test('MCP HTTP surface exposes only loopback MCP and freshness health endpoints', async (t) => {
  const fixture = createFixture();
  const readModelPath = path.join(fixture.root, 'read-model.db');
  const auditLogPath = path.join(fixture.root, 'audit.jsonl');
  buildReadModel({ sources: [{ serverId: 'prod', dbPath: fixture.dbPath }], outputPath: readModelPath, now: Date.now() });
  const config = {
    ...loadMcpServerConfig({
      MCP_READ_MODEL_PATH: readModelPath,
      MCP_AUDIT_LOG_PATH: auditLogPath,
      MCP_PORT: '8790',
    }),
    port: 0,
  };
  const runtime = await startZenMcpHttpServer(config);
  t.after(() => runtime.close());
  const address = runtime.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${baseUrl}/readyz`);
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(await health.json()).sort(), ['asOf', 'lagSeconds', 'ok', 'serverCount']);
  const missing = await fetch(`${baseUrl}/private`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), 'no-store');

  const initialize = await mcpRequest(baseUrl, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
  });
  assert.equal(initialize.result.serverInfo.name, 'zen-content-hub-production-readonly');
  const tools = await mcpRequest(baseUrl, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.deepEqual(tools.result.tools.map((tool) => tool.name), [
    'list_production_servers', 'get_business_overview', 'get_workflow_trends',
    'get_delivery_performance', 'get_failure_summary',
  ]);
  for (const tool of tools.result.tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.openWorldHint, false);
  }
  const overview = await mcpRequest(baseUrl, {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'get_business_overview', arguments: { days: 7 } },
  });
  assert.equal(overview.result.isError, undefined);
  const payload = JSON.parse(overview.result.content[0].text);
  assert.equal(payload.serverId, 'all');
  assert.equal(payload.privacyPolicy, 'aggregate-only:no-prompts:no-identifiers:no-raw-errors:no-secrets');
  for (const secret of fixture.secrets) assert.doesNotMatch(overview.result.content[0].text, new RegExp(secret));
  const audit = fs.readFileSync(auditLogPath, 'utf8');
  assert.match(audit, /get_business_overview/);
  for (const secret of fixture.secrets) assert.doesNotMatch(audit, new RegExp(secret));
});

async function mcpRequest(baseUrl, body) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) assert.fail(`Unexpected MCP status ${response.status}: ${await response.text()}`);
  const text = await response.text();
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return JSON.parse(text);
  const data = text.split('\n').find((line) => line.startsWith('data: '));
  assert.ok(data, text);
  return JSON.parse(data.slice('data: '.length));
}

function createFixture(label = 'fixture') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `zen-mcp-${label}-`));
  const dbPath = path.join(root, 'runs.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, source TEXT NOT NULL, input TEXT NOT NULL,
      status TEXT NOT NULL, stage TEXT, title TEXT, error TEXT, notify_json TEXT,
      created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
    );
    CREATE INDEX idx_runs_created ON runs(created_at);
    CREATE TABLE run_deliveries (
      run_id TEXT NOT NULL, destination TEXT NOT NULL, status TEXT NOT NULL,
      media_id TEXT, title TEXT, error TEXT, details_json TEXT
    );
    CREATE TABLE notification_outbox (sent_at INTEGER, payload_json TEXT, notify_json TEXT);
    CREATE TABLE delivery_outbox (state TEXT NOT NULL, payload_json TEXT);
  `);
  const secrets = [
    `prompt-secret-${label}`, `customer-secret-${label}`, `token-secret-${label}`,
    `remote-id-secret-${label}`, `payload-secret-${label}`,
  ];
  const insertRun = db.prepare(`
    INSERT INTO runs (id, workflow_id, source, input, status, stage, title, error, notify_json, created_at, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertRun.run('run-1', 'opening-digest', 'cron', secrets[0], 'done', 'publish', secrets[1], null, secrets[2], NOW - 2 * 86400000, NOW - 2 * 86400000, NOW - 2 * 86400000 + 60000);
  insertRun.run('run-2', 'opening-digest', 'cron', 'safe', 'failed', 'publish', null, `403 ${secrets[2]}`, '{}', NOW - 86400000, NOW - 86400000, NOW - 86400000 + 120000);
  insertRun.run('run-3', 'translate', 'slack', 'safe', 'running', 'generate', null, null, '{}', NOW, NOW, null);
  db.prepare('INSERT INTO run_deliveries VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('run-1', 'customerio-opening-digest', 'sent', secrets[3], secrets[1], null, secrets[4]);
  db.prepare('INSERT INTO run_deliveries VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('run-2', 'discord-opening-digest', 'failed', null, null, secrets[2], secrets[4]);
  db.prepare('INSERT INTO notification_outbox VALUES (?, ?, ?)').run(null, secrets[4], secrets[2]);
  db.prepare('INSERT INTO delivery_outbox VALUES (?, ?)').run('pending', secrets[4]);
  db.close();
  return { root, dbPath, secrets };
}
