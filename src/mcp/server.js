import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import { z } from 'zod';
import {
  inspectReadModel,
  queryBusinessOverview,
  queryDeliveryPerformance,
  queryFailureSummary,
  queryServerInventory,
  queryWorkflowTrends,
} from './read-model.js';

const TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});
const WORKFLOW_IDS = [
  'wechat', 'sector', 'company', 'earnings', 'macro', 'morning', 'email',
  'translate', 'qdii', 'opening-digest',
];
const DESTINATIONS = [
  'wechat', 'wechat-opening-digest', 'customerio', 'customerio-draft',
  'customerio-opening-digest', 'discord', 'discord-opening-digest', 'mock',
];

export function loadMcpServerConfig(env = process.env) {
  const host = env.MCP_HOST || '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('MCP_HOST must be a loopback address');
  const port = boundedInteger(env.MCP_PORT, 8790, 1024, 65535, 'MCP_PORT');
  const readModelPath = absolutePath(env.MCP_READ_MODEL_PATH, 'MCP_READ_MODEL_PATH');
  const auditLogPath = absolutePath(env.MCP_AUDIT_LOG_PATH, 'MCP_AUDIT_LOG_PATH');
  if (readModelPath === auditLogPath) throw new Error('MCP audit log must be separate from the read model');
  return {
    host,
    port,
    readModelPath,
    auditLogPath,
    maxStalenessMs: boundedInteger(env.MCP_MAX_STALENESS_SECONDS, 900, 60, 86400, 'MCP_MAX_STALENESS_SECONDS') * 1000,
    rateLimitPerMinute: boundedInteger(env.MCP_RATE_LIMIT_PER_MINUTE, 20, 1, 120, 'MCP_RATE_LIMIT_PER_MINUTE'),
    maxConcurrent: boundedInteger(env.MCP_MAX_CONCURRENT, 1, 1, 4, 'MCP_MAX_CONCURRENT'),
    maxResultBytes: boundedInteger(env.MCP_MAX_RESULT_BYTES, 65536, 4096, 262144, 'MCP_MAX_RESULT_BYTES'),
    maxRequestBytes: boundedInteger(env.MCP_MAX_REQUEST_BYTES, 131072, 4096, 1048576, 'MCP_MAX_REQUEST_BYTES'),
  };
}

export function createZenMcpServer({ config, accessController = createAccessController(config), audit = createAuditWriter(config.auditLogPath) }) {
  const common = { config, accessController, audit };
  const server = new McpServer(
    { name: 'zen-content-hub-production-readonly', version: '1.0.0' },
    {
      instructions: [
        'This server exposes delayed, aggregate-only production business metrics from a sanitized read model.',
        'All tools are read-only. Never claim the data is live: cite each result\'s asOf and lagSeconds.',
        'No arbitrary SQL, prompts, message bodies, task identifiers, raw errors, credentials, or customer data are available.',
        'Use list_production_servers first when the user asks about a specific server.',
      ].join(' '),
    },
  );

  server.registerTool('list_production_servers', {
    title: 'List production servers and data freshness',
    description: 'Lists explicitly configured production server labels and the timestamp of the sanitized read model.',
    inputSchema: z.object({}),
    annotations: TOOL_ANNOTATIONS,
  }, async () => guardedTool(common, 'list_production_servers', {}, () => queryServerInventory(config.readModelPath, queryOptions(config))));

  server.registerTool('get_business_overview', {
    title: 'Get production business overview',
    description: 'Returns aggregate run volume, completion rate, workflow totals, and current queue counts. It never returns task-level records.',
    inputSchema: z.object({
      days: z.number().int().min(1).max(90).default(7).describe('Inclusive UTC day window, from 1 to 90'),
      serverId: serverIdSchema(),
    }),
    annotations: TOOL_ANNOTATIONS,
  }, async (args) => guardedTool(common, 'get_business_overview', args, () => queryBusinessOverview(config.readModelPath, { ...args, ...queryOptions(config) })));

  server.registerTool('get_workflow_trends', {
    title: 'Get workflow trends',
    description: 'Returns daily aggregate production volume, completion/failure counts, and average duration by workflow.',
    inputSchema: z.object({
      days: z.number().int().min(1).max(90).default(30),
      serverId: serverIdSchema(),
      workflowId: z.enum(WORKFLOW_IDS).optional(),
    }),
    annotations: TOOL_ANNOTATIONS,
  }, async (args) => guardedTool(common, 'get_workflow_trends', args, () => queryWorkflowTrends(config.readModelPath, { ...args, ...queryOptions(config) })));

  server.registerTool('get_delivery_performance', {
    title: 'Get delivery performance',
    description: 'Returns aggregate delivery outcomes by server and destination without remote IDs, recipient data, content, or payloads.',
    inputSchema: z.object({
      days: z.number().int().min(1).max(90).default(30),
      serverId: serverIdSchema(),
      destination: z.enum(DESTINATIONS).optional(),
    }),
    annotations: TOOL_ANNOTATIONS,
  }, async (args) => guardedTool(common, 'get_delivery_performance', args, () => queryDeliveryPerformance(config.readModelPath, { ...args, ...queryOptions(config) })));

  server.registerTool('get_failure_summary', {
    title: 'Get sanitized failure summary',
    description: 'Returns counts grouped into fixed error categories. Raw errors, task IDs, prompts, and stack traces are never included.',
    inputSchema: z.object({
      days: z.number().int().min(1).max(90).default(30),
      serverId: serverIdSchema(),
      workflowId: z.enum(WORKFLOW_IDS).optional(),
    }),
    annotations: TOOL_ANNOTATIONS,
  }, async (args) => guardedTool(common, 'get_failure_summary', args, () => queryFailureSummary(config.readModelPath, { ...args, ...queryOptions(config) })));

  return server;
}

export function createZenMcpHttpServer(config) {
  const accessController = createAccessController(config);
  const audit = createAuditWriter(config.auditLogPath);
  const handler = createMcpHandler(
    () => createZenMcpServer({ config, accessController, audit }),
    { legacy: 'stateless', onerror: (error) => console.error('[mcp] protocol error:', safeErrorCode(error)) },
  );
  const handleMcp = toNodeHandler(handler, {
    onerror: (error) => console.error('[mcp] transport error:', safeErrorCode(error)),
  });
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const server = http.createServer(async (req, res) => {
    setSecurityHeaders(res);
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    const pathname = safePathname(req.url);
    if (req.method === 'GET' && ['/healthz', '/readyz'].includes(pathname)) {
      try {
        const model = inspectReadModel(config.readModelPath, queryOptions(config));
        writeJson(res, 200, { ok: true, asOf: model.asOf, lagSeconds: model.lagSeconds, serverCount: model.servers.length });
      } catch (error) {
        writeJson(res, 503, { ok: false, error: safeErrorCode(error) });
      }
      return;
    }
    if (pathname !== '/mcp') {
      writeJson(res, 404, { error: 'not_found' });
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      writeJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    if (req.headers['content-length'] === undefined) {
      writeJson(res, 411, { error: 'content_length_required' });
      return;
    }
    const contentLength = Number(req.headers['content-length']);
    if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > config.maxRequestBytes) {
      writeJson(res, 413, { error: 'request_too_large' });
      return;
    }
    await handleMcp(req, res);
  });
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  return { server, handler, audit };
}

export async function startZenMcpHttpServer(config) {
  await ensureAuditWritable(config.auditLogPath);
  inspectReadModel(config.readModelPath, queryOptions(config));
  const runtime = createZenMcpHttpServer(config);
  await runtime.audit({ event: 'server_start', at: new Date().toISOString(), version: '1.0.0' });
  await new Promise((resolve, reject) => {
    runtime.server.once('error', reject);
    runtime.server.listen(config.port, config.host, resolve);
  });
  return {
    ...runtime,
    close: async () => {
      await runtime.handler.close();
      await new Promise((resolve, reject) => runtime.server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export function createAccessController({ rateLimitPerMinute, maxConcurrent }) {
  let windowStartedAt = Date.now();
  let calls = 0;
  let active = 0;
  return {
    async run(callback) {
      const now = Date.now();
      if (now - windowStartedAt >= 60_000) {
        windowStartedAt = now;
        calls = 0;
      }
      if (calls >= rateLimitPerMinute) throw codedError('rate_limited', 'Read-only query rate limit exceeded');
      if (active >= maxConcurrent) throw codedError('busy', 'Read-only query service is busy');
      calls += 1;
      active += 1;
      try { return await callback(); }
      finally { active -= 1; }
    },
  };
}

export function createAuditWriter(auditLogPath) {
  return async (entry) => {
    const allowed = {
      event: entry.event,
      requestId: entry.requestId,
      at: entry.at,
      tool: entry.tool,
      args: entry.args,
      outcome: entry.outcome,
      errorCode: entry.errorCode,
      durationMs: entry.durationMs,
      resultBytes: entry.resultBytes,
      version: entry.version,
    };
    await fs.appendFile(auditLogPath, `${JSON.stringify(removeUndefined(allowed))}\n`, { encoding: 'utf8', mode: 0o600 });
  };
}

async function guardedTool({ config, accessController, audit }, tool, args, query) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const safeArgs = sanitizeAuditArgs(args);
  try {
    await audit({ event: 'tool_start', requestId, at: new Date(startedAt).toISOString(), tool, args: safeArgs });
  } catch {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({
        error: 'audit_unavailable',
        message: publicMessage('audit_unavailable'),
      }) }],
    };
  }
  try {
    const result = await accessController.run(query);
    const text = JSON.stringify(result);
    const bytes = Buffer.byteLength(text);
    if (bytes > config.maxResultBytes) throw codedError('result_too_large', 'Result exceeded the configured response limit');
    await audit({
      event: 'tool_finish', requestId, at: new Date().toISOString(), tool, args: safeArgs,
      outcome: 'success', durationMs: Date.now() - startedAt, resultBytes: bytes,
    });
    return { content: [{ type: 'text', text }], structuredContent: result };
  } catch (error) {
    const errorCode = safeErrorCode(error);
    try {
      await audit({
        event: 'tool_finish', requestId, at: new Date().toISOString(), tool, args: safeArgs,
        outcome: 'error', errorCode, durationMs: Date.now() - startedAt,
      });
    } catch {
      throw codedError('audit_unavailable', 'Audit logging is unavailable; production data was not returned');
    }
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: errorCode, message: publicMessage(errorCode) }) }],
    };
  }
}

function queryOptions(config) {
  return { maxStalenessMs: config.maxStalenessMs };
}

function serverIdSchema() {
  return z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/).optional();
}

function sanitizeAuditArgs(args) {
  const allowed = ['days', 'serverId', 'workflowId', 'destination'];
  return Object.fromEntries(Object.entries(args || {}).filter(([key]) => allowed.includes(key)));
}

function setSecurityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function writeJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function safePathname(value) {
  try { return new URL(value || '/', 'http://localhost').pathname; }
  catch { return '/invalid'; }
}

function safeErrorCode(error) {
  const code = String(error?.code || 'internal_error');
  return /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'internal_error';
}

function publicMessage(code) {
  const messages = {
    rate_limited: 'Read-only query rate limit exceeded',
    busy: 'Read-only query service is busy',
    read_model_stale: 'Read model is stale; production data was not returned',
    read_model_unavailable: 'Read model is unavailable',
    read_model_invalid: 'Read model metadata is invalid',
    read_model_version_mismatch: 'Read model schema is not supported',
    invalid_filter: 'The requested filter is not available',
    invalid_range: 'The requested time range is not available',
    result_too_broad: 'Result is too broad; add a server or workflow filter',
    result_too_large: 'Result exceeded the configured response limit',
    audit_unavailable: 'Audit logging is unavailable; production data was not returned',
  };
  return messages[code] || 'The read-only query could not be completed';
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function absolutePath(value, name) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return path.resolve(value);
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

async function ensureAuditWritable(filename) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await fs.appendFile(filename, '', { mode: 0o600 });
  await fs.chmod(filename, 0o600);
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
