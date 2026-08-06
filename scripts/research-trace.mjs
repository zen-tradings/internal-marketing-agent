import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config({ override: true });

const workflowId = process.argv[2] || 'company';
const base = process.env.WORK_DIR || '/srv/zen/wechat';
const workDir = workflowId === 'wechat' ? base : path.join(base, workflowId);
const legacyTracePath = path.join(workDir, 'research-trace.json');
const runsDir = path.join(workDir, 'runs');
const runTracePaths = fs.existsSync(runsDir)
  ? fs.readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(runsDir, entry.name, 'research-trace.json'))
      .filter((candidate) => fs.existsSync(candidate))
  : [];
const tracePath = [legacyTracePath, ...runTracePaths]
  .filter((candidate) => fs.existsSync(candidate))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];

if (!tracePath) {
  console.log(`未找到调研轨迹: ${workDir}`);
  process.exit(0);
}

const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
console.log(`工作流: ${trace.workflowId}`);
if (trace.pipelineVersion) console.log(`分析链路: ${trace.pipelineVersion}`);
console.log(`任务: ${trace.input}`);
console.log(`开始: ${trace.startedAt}`);
if (trace.taskContract) {
  console.log('\n任务合同:');
  console.log(`- 修订: ${trace.taskContract.prompt_revision || 1}`);
  console.log(`- 类型: ${trace.taskContract.article_type || '-'}`);
  console.log(`- 实体: ${(trace.taskContract.exact_entities_and_versions || []).map((item) => item.literal).join(', ') || '-'}`);
  console.log(`- 用户链接: ${(trace.taskContract.user_urls || []).length}`);
  console.log(`- 时效: ${trace.taskContract.freshness_requirement || '-'}`);
}
if (trace.searchPlan?.length) {
  console.log('\n搜索计划:');
  for (const item of trace.searchPlan) {
    console.log(`- [${item.lane}] ${item.query}${item.recent ? ' (recent)' : ''}`);
  }
}
for (const request of trace.requests || []) {
  console.log(`\n[${request.status}] ${request.kind} ${request.searchType || ''} ${request.category || ''}`.trim());
  if (request.query) console.log(`查询: ${request.query}`);
  if (request.requestId) console.log(`Exa requestId: ${request.requestId}`);
  if (request.durationMs !== undefined) console.log(`耗时: ${request.durationMs}ms`);
  if (request.costDollars) console.log(`费用: ${JSON.stringify(request.costDollars)}`);
  if (request.error) console.log(`错误: ${request.error}`);
  for (const status of request.contentStatuses || []) {
    const detail = status.error
      ? ` (${status.error.tag || 'unknown'}${status.error.httpStatusCode ? ` HTTP ${status.error.httpStatusCode}` : ''})`
      : '';
    console.log(`URL 状态: ${status.status || 'unknown'}${detail}\n  ${status.id || '-'}`);
  }
  for (const result of request.results || []) console.log(`- ${result.title || '(无标题)'}\n  ${result.url}`);
}

if (trace.userSourceRecovery) {
  console.log('\n用户来源恢复:');
  console.log(`- 尝试: ${(trace.userSourceRecovery.attemptedUrls || []).length}`);
  console.log(`- 原链接恢复: ${(trace.userSourceRecovery.exactRecoveredUrls || []).length}`);
  console.log(`- 补充来源: ${(trace.userSourceRecovery.supplementalUrls || []).length}`);
  console.log(`- 搜索失败: ${trace.userSourceRecovery.failedSearches || 0}`);
}

if (trace.selectedSources?.length) {
  console.log('\n最终送入模型的来源:');
  for (const source of trace.selectedSources) console.log(`- [${source.kind}] ${source.title || '(无标题)'}\n  ${source.url}`);
}
if (trace.evidenceMatrix) {
  console.log('\n证据矩阵:');
  for (const entity of trace.evidenceMatrix.entities || []) {
    console.log(`- 实体 ${entity.literal}: ${entity.verified ? '已由一手来源确认' : '未确认'} (${(entity.source_ids || []).join(', ') || '-'})`);
  }
  for (const conflict of trace.evidenceMatrix.conflicts || []) {
    console.log(`- [${conflict.severity}] ${conflict.description || conflict.topic}`);
  }
}
if (trace.factReview) {
  console.log(`\n事实审计: ${trace.factReview.approved ? '通过' : '需处理'}`);
  for (const issue of trace.factReview.issues || []) {
    console.log(`- [${issue.severity || '-'} / ${issue.action || '-'}] ${issue.article_quote || issue}`);
  }
}
if (trace.needsInput) console.log(`\n等待确认: ${trace.needsInput.question || trace.error || '是'}`);
if (trace.error) console.log(`\n任务错误: ${trace.error}`);
