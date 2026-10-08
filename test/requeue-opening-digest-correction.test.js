import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/core/store.js';
import { runWorkDir } from '../src/lib/run-workdir.js';
import { requeueOpeningDigestCorrection } from '../scripts/requeue-opening-digest-correction.mjs';

const NOW = new Date('2026-10-08T14:20:00Z');
function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-opening-correction-'));
  const config = { dryRun: false, dbPath: path.join(dir, 'runs.db'), workDir: path.join(dir, 'work') };
  const store = openStore(config.dbPath);
  const originalId = 'opening-original-2026-10-08';
  store.createRun({ id: originalId, workflowId: 'opening-digest', source: 'cron', input: 'opening', notify: {}, scheduleKey: '2026-10-08' });
  store.setStatus(originalId, 'done', { mediaId: 'customerio-newsletter:95' });
  store.upsertDelivery(originalId, { destination: 'customerio', status: 'delivered', mediaId: 'customerio-newsletter:95' });
  const tracePath = path.join(runWorkDir(path.join(config.workDir, 'opening-digest'), originalId), 'research-trace.json');
  fs.mkdirSync(path.dirname(tracePath), { recursive: true });
  const trace = (reason = 'OpenRouter 输出缺少 title frontmatter', mode = 'data-only') => fs.writeFileSync(tracePath, JSON.stringify({ contentMode: mode, fallbackReason: reason }));
  trace();
  const hold = (newsletterId = 95) => {
    store.prepareRemoteOperation({ runId: originalId, operation: 'postpone-opening-email', operationKey: 'hold:'+originalId, payloadSha256: 'hash', payload: { newsletterId } });
    store.updateRemoteOperation(originalId, 'postpone-opening-email', { state: 'confirmed', remoteId: String(newsletterId) });
  };
  try { fn({ config, store, originalId, trace, hold, queue: () => requeueOpeningDigestCorrection({ originalId, config, now: NOW }) }); }
  finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('a held current-day malformed-title edition queues one formal correction with a distinct identity', () => fixture(({ store, originalId, hold, queue }) => {
  hold();
  const result = queue();
  assert.equal(result.runId, 'opening-digest-correction-2026-10-08');
  const corrected = store.getRun(result.runId);
  assert.equal(corrected.source, 'cron');
  assert.equal(corrected.schedule_key, '2026-10-08:correction');
  assert.equal(corrected.status, 'queued');
  assert.equal(store.getRun(originalId).media_id, 'customerio-newsletter:95');
  assert.throws(queue, /Queue must be idle/);
}));

test('correction refuses missing or wrong-identity holds, unrelated fallbacks, editorial drafts and stale originals', () => fixture(({ config, store, originalId, trace, hold, queue }) => {
  assert.throws(queue, /confirmed hold is missing/);
  hold(96);
  assert.throws(queue, /confirmed hold is missing/);
  store.updateRemoteOperation(originalId, 'postpone-opening-email', { remoteId: '95' });
  assert.throws(queue, /confirmed hold is missing/);
  hold(95);
  trace('Exa network failure');
  assert.throws(queue, /eligible technical/);
  trace('OpenRouter 输出缺少 title frontmatter', 'editorial');
  assert.throws(queue, /eligible technical/);
  trace();
  assert.throws(() => requeueOpeningDigestCorrection({ originalId, config, now: new Date('2026-10-09T14:20:00Z') }), /current ET date/);
  assert.equal(store.listByStatus('queued').length, 0);
}));

test('the attribution-conflict correction remains supported', () => fixture(({ trace, hold, queue }) => {
  trace('Opening Digest 归因快照冲突在发布前仍存在:2 条');
  hold();
  assert.equal(queue().queued, true);
}));
