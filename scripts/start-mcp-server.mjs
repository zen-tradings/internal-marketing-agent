import { loadMcpServerConfig, startZenMcpHttpServer } from '../src/mcp/server.js';

const config = loadMcpServerConfig();
const runtime = await startZenMcpHttpServer(config);
console.error(`[mcp] ready on http://${config.host}:${config.port}/mcp`);

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.error(`[mcp] received ${signal}, stopping`);
  try { await runtime.close(); process.exitCode = 0; }
  catch (error) { console.error('[mcp] shutdown failed:', error?.code || 'internal_error'); process.exitCode = 1; }
}

process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
