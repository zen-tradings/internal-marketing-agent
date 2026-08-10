import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { runQdiiQuery } from '../src/core/qdii.js';

dotenv.config({ override: true });
const code = String(process.argv[2] || '513100');
if (!/^\d{6}$/.test(code)) throw new Error('Usage: npm run check:qdii -- <six-digit-fund-code>');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = {
  qdii: {
    enabled: true,
    pythonPath: process.env.QDII_PYTHON_PATH || path.join(root, '.venv', 'bin', 'python'),
    workerPath: process.env.QDII_WORKER_PATH || path.join(root, 'python', 'qdii_worker.py'),
    workerTimeoutMs: positiveInteger(process.env.QDII_WORKER_TIMEOUT_MS, 120000),
    maxFundsSlack: positiveInteger(process.env.QDII_MAX_FUNDS_SLACK, 20),
    maxFundsDraft: positiveInteger(process.env.QDII_MAX_FUNDS_DRAFT, 8),
    staleMaxDays: positiveInteger(process.env.QDII_STALE_MAX_DAYS, 366),
    maxReportBytes: positiveInteger(process.env.QDII_MAX_REPORT_BYTES, 30 * 1024 * 1024),
    maxTaskDownloadBytes: positiveInteger(process.env.QDII_MAX_TASK_DOWNLOAD_BYTES, 150 * 1024 * 1024),
    maxReportCandidates: positiveInteger(process.env.QDII_MAX_REPORT_CANDIDATES, 3),
  },
  translation: {},
  writer: {},
};
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-qdii-check-'));
try {
  const result = await runQdiiQuery({
    input: `QDII: Show the latest disclosed equity holdings for fund ${code}.`,
    config,
    workDir,
  });
  if (!result.results.length) throw new Error(result.failures.map((item) => `${item.code}: ${item.error}`).join('; ') || 'No holdings returned');
  console.log(JSON.stringify({
    ok: true,
    code,
    reportPeriod: result.results[0].reportPeriod.key,
    scope: result.results[0].disclosureScope,
    rows: result.results[0].holdings.length,
    provider: result.results[0].source.provider,
  }, null, 2));
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}

function positiveInteger(value, fallback) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid positive integer: ${value}`);
  return parsed;
}
