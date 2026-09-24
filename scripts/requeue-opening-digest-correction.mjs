import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { openStore } from '../src/core/store.js';
import { runWorkDir } from '../src/lib/run-workdir.js';
import { easternDateKey } from '../src/lib/us-equity-calendar.js';

const originalId = process.argv[2];
if (!/^[A-Za-z0-9][A-Za-z0-9-]{5,100}$/.test(String(originalId || ''))) {
  throw new Error('Provide the original Opening Digest database run ID');
}
const config = loadConfig(process.env);
if (config.dryRun) throw new Error('Correction queue requires the live database');
const store = openStore(config.dbPath);
if (store.listByStatus('running').length || store.listByStatus('queued').length) {
  throw new Error('Queue must be idle before queuing a correction');
}
const original = store.getRun(originalId);
if (!original || original.workflow_id !== 'opening-digest' || original.source !== 'cron'
  || original.status !== 'done' || original.schedule_key !== easternDateKey(new Date())) {
  throw new Error('Correction requires a completed formal run from the current ET date');
}
const tracePath = path.join(runWorkDir(path.join(config.workDir, 'opening-digest'), originalId), 'research-trace.json');
const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
if (trace.contentMode !== 'data-only' || !/归因快照冲突/.test(String(trace.fallbackReason || ''))) {
  throw new Error('Original run is not the attribution-conflict data-only publication');
}
const email = store.listDeliveries(originalId).find((item) => item.destination === 'customerio');
const hold = store.getRemoteOperation(originalId, 'postpone-opening-email');
if (email?.media_id !== original.media_id || email?.status !== 'delivered'
  || hold?.state !== 'confirmed') {
  throw new Error('Original email identity or confirmed hold is missing');
}
const id = `opening-digest-correction-${original.schedule_key}`;
if (store.getRun(id)) throw new Error(`Correction task already exists:${id}`);
store.createRun({
  id, workflowId: 'opening-digest', source: 'cron', input: original.input,
  notify: JSON.parse(original.notify_json || '{}'),
  scheduleKey: `${original.schedule_key}:correction`, priority: 100,
});
console.log(JSON.stringify({ queued: true, runId: id, originalId, date: original.schedule_key }));
