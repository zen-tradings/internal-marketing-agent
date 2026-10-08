import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/index.js';
import { openStore } from '../src/core/store.js';
import { runWorkDir } from '../src/lib/run-workdir.js';
import { easternDateKey } from '../src/lib/us-equity-calendar.js';

export function requeueOpeningDigestCorrection({ originalId, config = loadConfig(process.env), now = new Date() } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{5,100}$/.test(String(originalId || ''))) {
    throw new Error('Provide the original Opening Digest database run ID');
  }
  if (config.dryRun) throw new Error('Correction queue requires the live database');
  const store = openStore(config.dbPath);
  try {
    if (store.listByStatus('running').length || store.listByStatus('queued').length) {
      throw new Error('Queue must be idle before queuing a correction');
    }
    const original = store.getRun(originalId);
    if (!original || original.workflow_id !== 'opening-digest' || original.source !== 'cron'
      || original.status !== 'done' || original.schedule_key !== easternDateKey(now)) {
      throw new Error('Correction requires a completed formal run from the current ET date');
    }
    const tracePath = path.join(runWorkDir(path.join(config.workDir, 'opening-digest'), originalId), 'research-trace.json');
    const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
    const reason = String(trace.fallbackReason || '');
    if (trace.contentMode !== 'data-only'
      || !(/归因快照冲突/.test(reason) || reason === 'OpenRouter 输出缺少 title frontmatter')) {
      throw new Error('Original run is not an eligible technical data-only publication');
    }
    const email = store.listDeliveries(originalId).find((item) => item.destination === 'customerio');
    const hold = store.getRemoteOperation(originalId, 'postpone-opening-email');
    const newsletterId = /^customerio-newsletter:(\d+)$/.exec(String(original.media_id || ''))?.[1];
    if (!newsletterId || email?.media_id !== original.media_id || email?.status !== 'delivered'
      || hold?.state !== 'confirmed' || hold.remote_id !== newsletterId
      || String(JSON.parse(hold.payload_json || '{}').newsletterId) !== newsletterId) {
      throw new Error('Original email identity or confirmed hold is missing');
    }
    const id = `opening-digest-correction-${original.schedule_key}`;
    if (store.getRun(id)) throw new Error(`Correction task already exists:${id}`);
    store.createRun({
      id, workflowId: 'opening-digest', source: 'cron', input: original.input,
      notify: JSON.parse(original.notify_json || '{}'),
      scheduleKey: `${original.schedule_key}:correction`, priority: 100,
    });
    return { queued: true, runId: id, originalId, date: original.schedule_key };
  } finally { store.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(requeueOpeningDigestCorrection({ originalId: process.argv[2] })));
}
