import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/core/store.js';
import { easternDateKey } from '../src/lib/us-equity-calendar.js';

dotenv.config();

export function requeueOpeningDigestAttribution({
  runId,
  dbPath = process.env.DB_PATH || `${process.env.HOME || '.'}/zen-content-hub/runs.db`,
  now = new Date(),
} = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{5,100}$/.test(String(runId || ''))) {
    throw new Error('Provide the failed Opening Digest database run ID');
  }
  if (!fs.existsSync(dbPath)) throw new Error(`任务数据库不存在:${dbPath}`);
  const store = openStore(dbPath);
  try {
    if (store.listByStatus('running').length || store.listByStatus('queued').length) {
      throw new Error('Queue must be idle before recovery');
    }
    const run = store.getRun(runId);
    const date = easternDateKey(now);
    if (!run || run.workflow_id !== 'opening-digest' || run.source !== 'cron'
      || run.status !== 'failed' || run.stage !== 'generate' || run.schedule_key !== date
      || !/^Opening Digest 归因快照冲突在发布前仍存在:/.test(run.error || '')) {
      throw new Error('Only a current-day formal attribution-gate failure can be recovered');
    }
    if (run.media_id || run.remote_id || store.getPublication(runId)
      || store.listDeliveries(runId).length) {
      throw new Error('Publication evidence exists; read-only reconciliation is required');
    }
    if (store.requeueFailedOpeningDigestAttribution(runId, date) !== 1) {
      throw new Error('Recovery conditions changed or another formal edition was sent');
    }
    return { runId, date, status: 'queued' };
  } finally {
    store.close();
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try { console.log(JSON.stringify(requeueOpeningDigestAttribution({ runId: process.argv[2] }))); }
  catch (error) { console.error(`Opening Digest recovery failed:${error.message}`); process.exitCode = 1; }
}
