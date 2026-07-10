// 四个工作流(wechat/earnings/sector/morning)共享的公共项:
// - env getter 语义(channel/model/timeoutMs/workDir 基准目录)
// - Exa 双路调研优先信源清单(可用 EXA_PRIORITY_DOMAINS 整体覆盖)
// - 通用写作规范/调研素材/产出约束文案,供各工作流的 promptTemplate 拼装复用
//
// 注意:所有 getter 风格的导出都是"调用时才读 process.env"(函数),不是在 import
// 时求值一次的常量,这样才能保持与原 wechat.js 一致的"dotenv 在 import 之后才注入也生效"语义。

import path from 'node:path';

// Exa 双路调研的优先信源(声明式)。EXA_PRIORITY_DOMAINS(逗号分隔)整体覆盖默认列表;
// Exa includeDomains 会匹配子域名,这里只需写主域。
const DEFAULT_PRIORITY_SOURCES = [
  'trendforce.com',        // 含 datatrack.trendforce.com,半导体/AI 供应链/HBM
  'semianalysis.com',
  'alphaxiv.org',
  'x.com', 'twitter.com',
  'skhynix.com',           // SK Hynix IR
  'marvell.com',           // investor.marvell.com
  'broadcom.com',          // investors.broadcom.com
  'vertiv.com',
  'cerebras.ai',
  'aehr.com',
  'asml.com',
  'optioncharts.io',
  'barchart.com',
  'oxford-man.ox.ac.uk',   // quant finance research newsletter
  'parallel.ai',
  'lightcounting.com',
];

export function prioritySources() {
  const raw = process.env.EXA_PRIORITY_DOMAINS;
  return raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : [...DEFAULT_PRIORITY_SOURCES];
}

// 供各工作流 `get research()` 直接返回。
export function sharedResearch() {
  return { prioritySources: prioritySources() };
}

export function envChannel() { return process.env.WECHAT_CHANNEL || 'wechat-draft'; }
export function envModel() { return process.env.OPENROUTER_MODEL; }
export function envTimeoutMs() { return Number(process.env.DEFAULT_TIMEOUT_MS || 600000); }

// wechat 自身的 workDir 保持现状(不带子目录);新工作流用「基准目录/工作流 id」,
// 避免并发任务写同一个 article.md 互相覆盖。
export function workDirFor(id) {
  const base = process.env.WORK_DIR || '/srv/zen/wechat';
  return path.join(base, id);
}

// 四个工作流共用的通用约束块:风格规范 + 调研素材纪律 + 产出格式。
// 专属方法论内容(各工作流自己的分析框架)拼在【任务内容】之后、本块之前。
export const COMMON_CONSTRAINTS_BLOCK = `【写作规范 — 严格执行】
- 风格:严谨专业,机构分析师口吻
- 不用破折号(——),改用逗号或冒号
- 括号内容极度克制,非必要不加
- 金额用中文单位(亿美元、百万美元),不出现美元符号
- 口径说明板块每个控制在 1-2 句
- 文章由「开头固定横幅图 + 正文 + 结尾固定二维码图」构成,首尾图由系统自动注入,你只需写正文,不要自己加结尾署名板块或落款

【调研素材 — 严格遵守】
- 调研由系统通过 Exa 完成,你只能使用系统提供的素材与任务内容
- 不编造素材中没有的事实、数字、日期或来源
- 如果素材不足,明确说明信息不足,不要猜测

【产出 — 必须执行】
把完成的文章写入当前工作目录下的 article.md,文件顶部用 YAML frontmatter 给出:
---
title: 文章标题
---
正文用 Markdown。不要自行发布,发布由外部系统完成。现在开始写作。`;

// 拼装完整 promptTemplate 文本。methodologyBlock 为空时(wechat 的通用写作任务)只有
// 任务内容 + 通用约束块;非空时(earnings/sector/morning)在任务内容之后插入专属方法论。
export function buildPromptTemplate({ persona, task, methodologyBlock }) {
  const parts = [
    `你是 ${persona}。完成以下写作任务。`,
    '',
    '【任务内容】',
    task,
  ];
  if (methodologyBlock) parts.push('', methodologyBlock);
  parts.push('', COMMON_CONSTRAINTS_BLOCK);
  return parts.join('\n');
}
