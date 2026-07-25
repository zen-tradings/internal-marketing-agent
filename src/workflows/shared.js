// 各写作工作流共享的公共项:
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

// 用户明确要求“官方/一手信源”时单独跑这一组域名。它与上面的行业优先源分开,
// 防止分析站点命中后被误算作官方来源。
const DEFAULT_OFFICIAL_SOURCES = [
  'sec.gov',
  'nasdaq.com',
  'csrc.gov.cn',
  'sse.com.cn',
  'szse.cn',
  'cninfo.com.cn',
  'krx.co.kr',
  'fsc.go.kr',
  'fss.or.kr',
  'kofia.or.kr',
  'skhynix.com',
  'samsung.com',
  'micron.com',
  'nvidia.com',
  'cxmt.com',
];

export function prioritySources() {
  const raw = process.env.EXA_PRIORITY_DOMAINS;
  return raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : [...DEFAULT_PRIORITY_SOURCES];
}

export function officialSources() {
  const raw = process.env.EXA_OFFICIAL_DOMAINS;
  return raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : [...DEFAULT_OFFICIAL_SOURCES];
}

// 供各工作流 `get research()` 直接返回。
export function sharedResearch() {
  return {
    prioritySources: prioritySources(),
    officialSources: officialSources(),
    minOfficialSources: 2,
  };
}

export function officialFirstPolicy() {
  return {
    officialFirst: true,
    requireCitations: true,
    minOfficialSources: 2,
    failClosed: true,
  };
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

// 各工作流共用的通用约束块:风格规范 + 调研素材纪律 + 产出格式。
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
- 用户在 Slack 中提供的链接属于一级优先研究素材,必须与官方/一手来源和系统既定优先信源共同分析;它不是自动翻译对象,也不因用户提供就自动视为官方事实
- 不编造素材中没有的事实、数字、日期或来源
- 如果素材不足,明确说明信息不足,不要猜测
- 正文不放引用脚标、脚注或来源链接。文章末尾只生成一次“## 引用链接”,精选 1-5 个最相关、最具支持力的可点击链接;以相关性为准,不凑数,不要再生成“引用来源”或罗列全部检索结果
- “引用链接”必须是最后一个文字章节且左对齐;系统会在其后追加固定二维码尾图,不要在尾图后追加任何内容
- 每个主要章节用 Markdown 粗体突出 1-2 个核心观点或关键词,高亮必须克制且不能改变原意

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
