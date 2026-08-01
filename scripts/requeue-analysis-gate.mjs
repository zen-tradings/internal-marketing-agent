import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/core/store.js';

dotenv.config();

const ANALYSIS_WORKFLOWS = new Set(['wechat', 'sector', 'company', 'earnings']);
const LEGACY_CODE_GATE_RE = /正文包含代码围栏|四空格缩进块/;

export function requeueAnalysisGateRun({
  runId,
  dbPath = process.env.DB_PATH || `${process.env.HOME || '.'}/zen-content-hub/runs.db`,
} = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{5,100}$/.test(String(runId || ''))) {
    throw new Error('run-id 格式无效');
  }
  if (!fs.existsSync(dbPath)) throw new Error(`任务数据库不存在:${dbPath}`);
  const store = openStore(dbPath);
  try {
    const run = store.getRun(runId);
    if (!run) throw new Error(`任务不存在:${runId}`);
    if (!ANALYSIS_WORKFLOWS.has(run.workflow_id)) {
      throw new Error('只允许恢复 wechat/sector/company/earnings 分析工作流');
    }
    if (run.media_id) throw new Error('任务已有 media_id，拒绝重复创建草稿');
    if (run.status !== 'failed' || run.stage !== 'gate' || !LEGACY_CODE_GATE_RE.test(run.error || '')) {
      throw new Error(`只允许恢复旧代码块门禁失败:${run.status || 'unknown'}/${run.stage || 'unknown'}`);
    }
    let notify;
    try { notify = JSON.parse(run.notify_json || '{}'); }
    catch { throw new Error('任务 Slack notify_json 无效'); }
    if (!notify?.channel || !notify?.ts || !notify?.user) {
      throw new Error('任务缺少有效 Slack channel/ts/user，拒绝恢复');
    }
    if (store.requeueRecoverableAnalysisGate(runId) !== 1) {
      throw new Error('任务状态已变化，未重新入队');
    }
    return { runId, workflowId: run.workflow_id, status: 'queued' };
  } finally {
    store.close();
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const result = requeueAnalysisGateRun({ runId: process.argv[2] });
    console.log(`分析代码门禁失败任务已重新入队:${result.runId}（${result.workflowId}）`);
  } catch (error) {
    console.error(`续跑失败:${error.message}`);
    process.exitCode = 1;
  }
}
