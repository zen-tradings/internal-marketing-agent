import fs from 'node:fs';
import { runWorkDir } from '../lib/run-workdir.js';

// Bounded maintenance; callers share the single-instance runtime and do not yield
// between eligibility selection, artifact removal, and the guarded database delete.
export function pruneHistory({ store, workflows, config, now = Date.now() }) {
  const day = 86400000;
  const before = now - config.runRetentionDays * day;
  let runs = 0;
  for (const expired of store.listPrunableRuns(before, 100)) {
    try {
      const workflow = workflows[expired.workflow_id];
      if (workflow?.workDir) fs.rmSync(runWorkDir(workflow.workDir, expired.id), { recursive: true, force: true });
      runs += store.deletePrunableRun(expired.id, before);
    } catch (error) { console.error('[hub] 历史清理保留记录待重试:', error.message); }
  }
  const result = store.prune({ threadBefore: now - config.slackThreadRetentionDays * day, eventBefore: now - config.slackThreadRetentionDays * day });
  return { ...result, runs };
}
