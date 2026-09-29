import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/core/store.js';
import { requeueOpeningDigestAttribution } from '../scripts/requeue-opening-digest-attribution.mjs';

const NOW = new Date('2026-09-29T14:15:00Z');
const ERROR = 'Opening Digest 归因快照冲突在发布前仍存在:2 条';

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-opening-requeue-'));
  const dbPath = path.join(dir, 'runs.db');
  const store = openStore(dbPath);
  try { fn({ store, dbPath }); }
  finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('current formal attribution failure is queued once, with no publication', () => withStore(({ store, dbPath }) => {
  const runId = 'opening-digest-2026-09-29';
  store.createRun({ id: runId, workflowId: 'opening-digest', source: 'cron',
    input: 'opening digest', notify: {}, scheduleKey: '2026-09-29' });
  store.setStatus(runId, 'failed', { stage: 'generate', error: ERROR });
  assert.deepEqual(requeueOpeningDigestAttribution({ runId, dbPath, now: NOW }),
    { runId, date: '2026-09-29', status: 'queued' });
  assert.equal(store.getRun(runId).status, 'queued');
  assert.throws(() => requeueOpeningDigestAttribution({ runId, dbPath, now: NOW }), /Queue must be idle/);
}));

test('recovery rejects any publication record and non-attribution failures', () => withStore(({ store, dbPath }) => {
  const runId = 'opening-digest-2026-09-29';
  store.createRun({ id: runId, workflowId: 'opening-digest', source: 'cron',
    input: 'opening digest', notify: {}, scheduleKey: '2026-09-29' });
  store.setStatus(runId, 'failed', { stage: 'generate', error: 'other error' });
  assert.throws(() => requeueOpeningDigestAttribution({ runId, dbPath, now: NOW }), /Only a current-day/);
  store.setStatus(runId, 'failed', { stage: 'generate', error: ERROR });
  store.preparePublication(runId, { title: 'already frozen' });
  assert.throws(() => requeueOpeningDigestAttribution({ runId, dbPath, now: NOW }), /Publication evidence exists/);
}));
