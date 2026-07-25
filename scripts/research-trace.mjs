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
console.log(`任务: ${trace.input}`);
console.log(`开始: ${trace.startedAt}`);
for (const request of trace.requests || []) {
  console.log(`\n[${request.status}] ${request.kind} ${request.searchType || ''} ${request.category || ''}`.trim());
  if (request.query) console.log(`查询: ${request.query}`);
  if (request.requestId) console.log(`Exa requestId: ${request.requestId}`);
  if (request.durationMs !== undefined) console.log(`耗时: ${request.durationMs}ms`);
  if (request.costDollars) console.log(`费用: ${JSON.stringify(request.costDollars)}`);
  if (request.error) console.log(`错误: ${request.error}`);
  for (const result of request.results || []) console.log(`- ${result.title || '(无标题)'}\n  ${result.url}`);
}

if (trace.selectedSources?.length) {
  console.log('\n最终送入模型的来源:');
  for (const source of trace.selectedSources) console.log(`- [${source.kind}] ${source.title || '(无标题)'}\n  ${source.url}`);
}
if (trace.error) console.log(`\n任务错误: ${trace.error}`);
