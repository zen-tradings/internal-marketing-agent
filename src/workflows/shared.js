// Shared writing-workflow primitives:
// - env getter behavior for channel, model, timeout, and work-directory base
// - Exa two-lane priority sources, fully overridable with EXA_PRIORITY_DOMAINS
// - common writing, research-material, and output-constraint blocks for prompt templates
//
// Getter-style exports read process.env at call time rather than import time, preserving the behavior where
// dotenv values injected after import still apply.

import path from 'node:path';
import { runtimeConfig } from '../config/runtime.js';

// Declarative priority sources for Exa's two research lanes. EXA_PRIORITY_DOMAINS fully overrides this comma-
// separated default list; includeDomains matches subdomains, so only root domains are needed.
const DEFAULT_PRIORITY_SOURCES = [
  'trendforce.com',        // Includes datatrack.trendforce.com for semiconductor, AI supply-chain, and HBM coverage.
  'semianalysis.com',
  'techinsights.com',
  'counterpointresearch.com',
  'omdia.tech.informa.com',
  'blocksandfiles.com',
  'eetimes.com',
  'digitimes.com',
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

// Use this separate domain set when the user explicitly requests official or primary sources; keeping it separate
// from industry-priority sources prevents analytical sites from being misclassified as official.
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

// Search-result news and commentary cannot come from government-funded, state-owned, or public-broadcast media.
// Regulators, exchanges, and primary government data are not media and remain valid through officialSources.
const DEFAULT_EXCLUDED_MEDIA_SOURCES = [
  'xinhuanet.com',
  'news.cn',
  'people.com.cn',
  'cctv.com',
  'cgtn.com',
  'chinadaily.com.cn',
  'globaltimes.cn',
  'cri.cn',
  'cnr.cn',
  'china.com.cn',
  'voanews.com',
  'rfa.org',
  'rferl.org',
  'usagm.gov',
  'alhurra.com',
  'bbc.com',
  'bbc.co.uk',
  'dw.com',
  'france24.com',
  'rfi.fr',
  'rt.com',
  'sputniknews.com',
  'tass.com',
  'trtworld.com',
  'aljazeera.com',
  'nhk.or.jp',
  'kbs.co.kr',
  'arirang.com',
  'abc.net.au',
  'sbs.com.au',
  'cbc.ca',
  'channelnewsasia.com',
  'pbs.org',
  'npr.org',
  'rnz.co.nz',
  'tvnz.co.nz',
  'swissinfo.ch',
  'rte.ie',
  'yle.fi',
  'svt.se',
  'nrk.no',
  'dr.dk',
  'ard.de',
  'zdf.de',
  'deutschlandradio.de',
];

// Prefer these independent third-party reporting and research organizations within a source tier. Other languages
// remain eligible when independent and directly supportive of task facts.
const DEFAULT_INDEPENDENT_REPORTING_SOURCES = [
  'reuters.com',
  'apnews.com',
  'ft.com',
  'wsj.com',
  'bloomberg.com',
  'economist.com',
  'nikkei.com',
  'caixinglobal.com',
  'caixin.com',
  'theinformation.com',
  'semafor.com',
  'techcrunch.com',
  'theregister.com',
  'trendforce.com',
  'semianalysis.com',
  'techinsights.com',
  'counterpointresearch.com',
  'omdia.tech.informa.com',
  'blocksandfiles.com',
  'eetimes.com',
  'digitimes.com',
  'lightcounting.com',
];

export function prioritySources() {
  const configured = runtimeConfig()?.workflowEnvironment;
  if (configured?.priorityDomainsOverride) return [...configured.priorityDomains];
  const raw = process.env.EXA_PRIORITY_DOMAINS;
  return raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : [...DEFAULT_PRIORITY_SOURCES];
}

export function officialSources() {
  const configured = runtimeConfig()?.workflowEnvironment;
  if (configured?.officialDomainsOverride) return [...configured.officialDomains];
  const raw = process.env.EXA_OFFICIAL_DOMAINS;
  return raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : [...DEFAULT_OFFICIAL_SOURCES];
}

export function excludedMediaSources() {
  const configured = runtimeConfig()?.workflowEnvironment;
  return uniqueDomains([
    ...DEFAULT_EXCLUDED_MEDIA_SOURCES,
    ...(configured ? configured.excludedMediaDomains : csvDomains(process.env.EXA_EXCLUDED_MEDIA_DOMAINS)),
  ]);
}

export function independentReportingSources() {
  const configured = runtimeConfig()?.workflowEnvironment;
  return uniqueDomains([
    ...DEFAULT_INDEPENDENT_REPORTING_SOURCES,
    ...(configured ? configured.independentMediaDomains : csvDomains(process.env.EXA_INDEPENDENT_MEDIA_DOMAINS)),
  ]);
}

// Returned directly by each workflow's get research().
export function sharedResearch() {
  return {
    prioritySources: prioritySources(),
    officialSources: officialSources(),
    excludedMediaSources: excludedMediaSources(),
    independentReportingSources: independentReportingSources(),
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

export function envChannel() { return runtimeConfig()?.workflowEnvironment?.channel || process.env.WECHAT_CHANNEL || 'wechat-draft'; }
export function envModel() { return runtimeConfig()?.writer?.model || process.env.OPENROUTER_MODEL; }
export function envTimeoutMs() { return runtimeConfig()?.defaultTimeoutMs || Number(process.env.DEFAULT_TIMEOUT_MS || 600000); }

// Keep WeChat's existing workDir without a subdirectory; new workflows use base-directory/workflow-id to prevent
// concurrent tasks from overwriting one article.md.
export function workDirFor(id) {
  const base = runtimeConfig()?.workDir || process.env.WORK_DIR || '/srv/zen/wechat';
  return path.join(base, id);
}

function csvDomains(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function uniqueDomains(domains) {
  return [...new Set(domains.map((domain) => String(domain || '').trim().toLowerCase())
    .filter(Boolean))];
}

// Common constraint block: style rules, research-material discipline, and output format. Workflow-specific
// methodology is assembled after task content and before this block.
export const COMMON_CONSTRAINTS_BLOCK = `【写作规范 — 严格执行】
- 风格:严谨专业,机构分析师口吻
- 不用破折号(——),改用逗号或冒号
- 括号内容极度克制,非必要不加
- 金额用中文单位(亿美元、百万美元),不出现美元符号
- 口径说明板块每个控制在 1-2 句
- 文章由「开头固定横幅图 + 正文 + 内容调研问卷图 + 社群封底图」构成,固定图由系统自动注入,你只需写正文,不要自己加结尾署名板块或落款

【调研素材 — 严格遵守】
- 调研由系统通过 Exa 完成,你只能使用系统提供的素材与任务内容
- 用户在 Slack 中提供的链接属于一级优先研究素材,必须与官方/一手来源和系统既定优先信源共同分析;它不是自动翻译对象,也不因用户提供就自动视为官方事实
- 不编造素材中没有的事实、数字、日期或来源
- 如果素材不足,明确说明信息不足,不要猜测
- 正文不放引用脚标、脚注或来源链接。文章末尾只生成一次“## 引用链接”,精选 1-5 个最相关、最具支持力的可点击链接;以相关性为准,不凑数,不要再生成“引用来源”或罗列全部检索结果
- “引用链接”必须是最后一个文字章节且左对齐;系统会在其后依次追加内容调研问卷图和社群封底图,二者是最终两个节点,不要自行追加任何内容
- 每个主要章节用 Markdown 粗体突出 1-2 个核心观点或关键词,高亮必须克制且不能改变原意
- 系统自行组织的正文分区标题写成 ## English｜中文,不要手写序号;用户点名的章节名必须原样保留;“引用链接”保持中文单行

【产出 — 必须执行】
把完成的文章写入当前工作目录下的 article.md,文件顶部用 YAML frontmatter 给出:
---
title: 文章标题
---
正文用 Markdown。不要自行发布,发布由外部系统完成。现在开始写作。`;

// Assemble complete promptTemplate text. Without methodology, general WeChat writing uses task content plus the
// common block; earnings, sector, and morning insert workflow-specific methodology after task content.
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
