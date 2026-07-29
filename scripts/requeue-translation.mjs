import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/core/store.js';
import { runWorkDir } from '../src/lib/run-workdir.js';

dotenv.config();

export function requeueTranslationRun({
  runId,
  dbPath = process.env.DB_PATH || `${process.env.HOME || '.'}/zen-content-hub/runs.db`,
  workDir = process.env.WORK_DIR || '/srv/zen/wechat',
} = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{5,100}$/.test(String(runId || ''))) {
    throw new Error('run-id 格式无效');
  }
  if (!fs.existsSync(dbPath)) throw new Error(`任务数据库不存在:${dbPath}`);
  const store = openStore(dbPath);
  const run = store.getRun(runId);
  if (!run) throw new Error(`任务不存在:${runId}`);
  if (run.workflow_id !== 'translate') throw new Error('只允许恢复 translate 工作流');
  if (run.media_id) throw new Error('任务已有 media_id，拒绝重复创建草稿');
  if (!['failed', 'interrupted'].includes(run.status)) {
    throw new Error(`任务状态不可恢复:${run.status}`);
  }
  const checkpointPath = path.join(
    runWorkDir(path.join(path.resolve(workDir), 'translate'), runId),
    'translation-checkpoint.json',
  );
  if (!fs.existsSync(checkpointPath)) throw new Error('任务没有 translation checkpoint，拒绝续跑');
  const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  if (!checkpoint?.key || !Array.isArray(checkpoint.translations) || !checkpoint.translations.length) {
    throw new Error('translation checkpoint 无效或没有已完成单元');
  }
  if (store.requeueRecoverableTranslation(runId) !== 1) {
    throw new Error(`该失败类型不在允许恢复范围内:${run.stage || 'unknown'}`);
  }
  return {
    runId,
    restoredUnits: checkpoint.translations.length,
    status: 'queued',
  };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const result = requeueTranslationRun({ runId: process.argv[2] });
    console.log(`直译任务已重新入队:${result.runId}（checkpoint ${result.restoredUnits} 个单元）`);
  } catch (error) {
    console.error(`续跑失败:${error.message}`);
    process.exitCode = 1;
  }
}
