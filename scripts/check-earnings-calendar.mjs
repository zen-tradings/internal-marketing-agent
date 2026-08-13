#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  remainingEarningsWindow,
  runOpeningDigestEarningsWorker,
} from '../src/lib/opening-digest-earnings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pythonPath = process.env.OPENING_DIGEST_EARNINGS_PYTHON_PATH
  || process.env.QDII_PYTHON_PATH
  || path.join(ROOT, '.venv', 'bin', 'python');
const earningsWorkerPath = process.env.OPENING_DIGEST_EARNINGS_WORKER_PATH
  || path.join(ROOT, 'python', 'opening_digest_worker.py');
const asOf = new Date();
const window = remainingEarningsWindow(asOf);
const result = await runOpeningDigestEarningsWorker(
  { action: 'query', ...window, limit: 100 },
  { config: { openingDigest: { earningsPythonPath: pythonPath, earningsWorkerPath, earningsWorkerTimeoutMs: 20000 } } },
);
if (result?.schemaVersion !== 1 || result?.provider !== 'yfinance-yahoo'
  || result?.startDate !== window.startDate || result?.endDate !== window.endDate
  || !Array.isArray(result?.candidates) || result.candidates.length > 100) {
  throw new Error('Yahoo/yfinance earnings calendar returned an invalid envelope');
}
console.log(JSON.stringify({
  ok: true,
  provider: result.provider,
  startDate: result.startDate,
  endDate: result.endDate,
  candidates: result.candidates.length,
  capturedAt: result.capturedAt,
}));
