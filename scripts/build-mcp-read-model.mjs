import { buildReadModel, DEFAULT_RETENTION_DAYS } from '../src/mcp/read-model.js';

const options = parseArgs(process.argv.slice(2), process.env);
const result = buildReadModel(options);
console.log(JSON.stringify({
  ok: true,
  asOf: result.asOf,
  serverCount: result.servers.length,
  servers: result.servers.map((server) => ({ serverId: server.serverId, runsInWindow: server.runsInWindow })),
}));

export function parseArgs(args, env = {}) {
  const sources = [];
  let outputPath = env.MCP_READ_MODEL_PATH || '';
  let retentionDays = numberOrDefault(env.MCP_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--source') {
      const value = args[++index];
      const separator = value?.indexOf('=') ?? -1;
      if (separator < 1) throw new Error('--source must use server-id=/absolute/database/path');
      sources.push({ serverId: value.slice(0, separator), dbPath: value.slice(separator + 1) });
    } else if (arg === '--output') {
      outputPath = args[++index] || '';
    } else if (arg === '--retention-days') {
      retentionDays = Number(args[++index]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!sources.length && env.MCP_SERVER_ID && env.MCP_SOURCE_DB_PATH) {
    sources.push({ serverId: env.MCP_SERVER_ID, dbPath: env.MCP_SOURCE_DB_PATH });
  }
  return { sources, outputPath, retentionDays };
}

function numberOrDefault(value, fallback) {
  return value === undefined || value === '' ? fallback : Number(value);
}
