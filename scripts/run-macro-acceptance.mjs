import dotenv from 'dotenv';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { runWriter } from '../src/core/runner.js';
import { assertFixedDraftTemplate } from '../src/lib/draft-template.js';
import mockChannel from '../src/channels/mock.js';
import wechatDraft from '../src/channels/wechat-draft.js';
import macroWorkflow from '../src/workflows/macro.js';

dotenv.config({ override: true });

const options = parseArgs(process.argv.slice(2));
if (!options.dryRun && (!process.env.WECHAT_APP_ID || !process.env.WECHAT_APP_SECRET)) {
  throw new Error('真实 macro 验收缺少 WECHAT_APP_ID/WECHAT_APP_SECRET');
}
const config = loadConfig({
  ...process.env,
  NODE_ENV: 'acceptance-direct',
  SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN || 'xoxb-unused-by-direct-acceptance',
  SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN || 'xapp-unused-by-direct-acceptance',
  WECHAT_APP_ID: process.env.WECHAT_APP_ID || 'unused-by-dry-run',
  WECHAT_APP_SECRET: process.env.WECHAT_APP_SECRET || 'unused-by-dry-run',
});
if (!config.writer.exaApiKey) throw new Error('macro 验收缺少 EXA_API_KEY');
const runId = options.runId || `macro-acceptance-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const baseDir = path.resolve(process.env.MACRO_ACCEPTANCE_WORK_DIR
  || (options.dryRun
    ? path.join(os.tmpdir(), 'zen-content-hub')
    : process.env.WORK_DIR || '/var/lib/zen-content-hub/work'));
const acceptanceDir = path.join(baseDir, 'macro-acceptance', safeSegment(runId));
const workflow = Object.create(macroWorkflow);
Object.defineProperty(workflow, 'workDir', {
  value: acceptanceDir,
  enumerable: true,
});

const input = options.prompt || `截至 ${new Date().toISOString()}，从部署当天新发布或正在定价的央行政策、通胀与就业数据、利率与美元、关键商品或数字资产信息中，选择一个对中美和美元体系最重要、且至少有一个直接一手或原始来源支持的宏观主题，写一篇 800–1,500 字事件快评。结论先行，区分事实、已定价预期、增量信息与我们的判断，给出基准和反向情景、观察信号、反例及失效条件。若当天没有足够的一手材料，缩窄到最近七天内可确认的事实、待验证点和观察条件，不写交易指令。`;

console.log(JSON.stringify({
  stage: 'start',
  runId,
  dryRun: options.dryRun,
  workflowId: workflow.id,
  workDir: acceptanceDir,
  prompt: input,
}));

const generated = await runWriter({
  workflow,
  input,
  config,
  taskContext: { routeReason: 'production-direct-acceptance' },
});
if (!generated.ok) {
  console.error(JSON.stringify({
    stage: 'generate',
    ok: false,
    error: generated.stderr,
    researchTracePath: generated.researchTracePath,
  }));
  process.exit(1);
}

const trace = JSON.parse(fs.readFileSync(generated.researchTracePath, 'utf8'));
assertAcceptanceTrace(trace);
const channel = options.dryRun ? mockChannel : wechatDraft;
if (!options.dryRun) assertFixedDraftTemplate('wechat-draft', channel);
const published = await channel.publish({
  articlePath: generated.articlePath,
  config,
  workflow,
  runId,
  resumeFromCheckpoint: false,
  contentPolicy: generated.contentPolicy || {},
});
if (!published?.mediaId) throw new Error('macro 验收没有返回 media_id');

console.log(JSON.stringify({
  stage: 'complete',
  ok: true,
  dryRun: options.dryRun,
  runId,
  mediaId: published.mediaId,
  title: published.title,
  articlePath: generated.articlePath,
  researchTracePath: generated.researchTracePath,
  sourceCount: generated.sources?.length || 0,
  selectedReferenceCount: trace.evidenceMatrix?.selected_reference_ids?.length || 0,
  criticalClaimCount: trace.factReview?.criticalClaims?.length || 0,
  editorialSkills: trace.editorialSkills?.map((item) => item.id) || [],
  archetype: trace.macroBrief?.archetype,
  auditApproved: trace.factReview?.approved === true,
}));

function assertAcceptanceTrace(trace) {
  if (trace.pipelineVersion !== 'v2') throw new Error('macro 生产验收必须运行 Analysis V2');
  const skills = trace.editorialSkills?.map((item) => item.id) || [];
  for (const id of ['latepost-ai-writer', 'global-macro-strategy-writer']) {
    if (!skills.includes(id)) throw new Error(`macro trace 缺少 skill:${id}`);
  }
  if (!trace.macroBrief?.archetype) throw new Error('macro trace 缺少选定稿型');
  if (!trace.macroBrief?.evidenceBoundary) throw new Error('macro trace 缺少证据边界');
  if (!Array.isArray(trace.evidenceMatrix?.selected_reference_ids)
    || !trace.evidenceMatrix.selected_reference_ids.length) {
    throw new Error('macro trace 没有可复核的精选来源');
  }
  const primary = trace.evidenceMatrix?.source_assessments?.find((source) =>
    source.source_type === 'primary'
    && source.relevant !== false
    && Array.isArray(source.safe_statements)
    && source.safe_statements.length);
  if (!primary) throw new Error('macro 生产验收没有直接一手或原始来源支撑核心事实');
  if (trace.factReview?.approved !== true || trace.factReview?.skipped === true) {
    throw new Error('macro 事实审计未通过或被跳过');
  }
  const selected = new Set(trace.evidenceMatrix?.selected_reference_ids || []);
  for (const claim of trace.factReview?.criticalClaims || []) {
    if (!(claim.evidence_ids || []).some((id) => selected.has(id))) {
      throw new Error(`macro 关键主张的证据没有进入精选来源:${String(claim.article_quote || '').slice(0, 80)}`);
    }
  }
}

function parseArgs(args) {
  const parsed = { dryRun: false, prompt: '', runId: '' };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--prompt') parsed.prompt = String(args[++index] || '').trim();
    else if (arg === '--run-id') parsed.runId = String(args[++index] || '').trim();
    else throw new Error(`未知参数:${arg}`);
  }
  return parsed;
}

function safeSegment(value) {
  const clean = String(value || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 80);
  if (!clean) throw new Error('macro 验收 run-id 无效');
  return clean;
}
