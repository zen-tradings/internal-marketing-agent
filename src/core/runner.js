import fs from 'node:fs';
import path from 'node:path';
import { renderQuarterlyCharts } from '../lib/quarterly-chart.js';

const DEFAULT_SYSTEM_PROMPT = `你是 Zen Trading 公众号分析师。你会基于系统提供的调研素材写中文金融分析文章。

严格要求:
- 只使用用户任务与调研素材中可支持的信息,不编造数字、新闻或来源
- 风格严谨专业,机构分析师口吻
- 不用破折号,改用逗号或冒号
- 括号内容极度克制,非必要不加
- 金额用中文单位,例如亿美元、百万美元,不出现美元符号
- 口径说明板块每个控制在 1-2 句

输出必须是完整 Markdown,且文件开头必须是 YAML frontmatter:
---
title: 文章标题
---
正文从 frontmatter 后开始。不要输出解释、代码围栏或发布指令。`;

export async function runWriter({ workflow, input, config, fetchFn = globalThis.fetch }) {
  const articlePath = path.join(workflow.workDir, 'article.md');
  const researchTracePath = path.join(workflow.workDir, 'research-trace.json');
  const trace = {
    workflowId: workflow.id || 'unknown',
    input,
    startedAt: new Date().toISOString(),
    tracePath: researchTracePath,
    live: fetchFn === globalThis.fetch,
    requests: [],
  };
  try { fs.rmSync(articlePath, { force: true }); } catch {}

  try {
    fs.mkdirSync(workflow.workDir, { recursive: true });
    const writer = config.writer || {};
    const model = workflow.model || writer.model;
    if (!writer.openrouterApiKey) throw new Error('缺少 OpenRouter API key');
    if (!writer.exaApiKey) throw new Error('缺少 Exa API key');
    if (!model) throw new Error('缺少 OpenRouter model');

    const sourcePolicy = sourcePolicyFor({ input, workflow });
    const research = await searchExa({ input, writer, workflow, fetchFn, trace, sourcePolicy });
    trace.finishedAt = new Date().toISOString();
    trace.selectedSources = research.map(sourceForTrace);
    writeResearchTrace(researchTracePath, trace);
    const prompt = buildUserPrompt({ workflow, input, research, writer, sourcePolicy, asOf: new Date() });
    const content = await completeArticle({
      prompt,
      model,
      writer,
      fetchFn,
      timeoutMs: workflow.timeoutMs,
      systemPrompt: workflow.systemPrompt,
    });
    const article = renderQuarterlyCharts(normalizeArticle(content));
    if (!hasTitleFrontmatter(article)) {
      throw new Error('OpenRouter 输出缺少 title frontmatter');
    }
    validateArticleSourceContract(article, research, sourcePolicy);

    fs.writeFileSync(articlePath, article);
    return { ok: true, articlePath, model, researchTracePath, sources: research.map((r) => r.url).filter(Boolean) };
  } catch (e) {
    trace.finishedAt = new Date().toISOString();
    trace.error = describeFetchError(e).slice(0, 600);
    writeResearchTrace(researchTracePath, trace);
    try { fs.rmSync(articlePath, { force: true }); } catch {}
    return { ok: false, articlePath, researchTracePath, exitCode: 1, stderr: describeFetchError(e).slice(0, 600) };
  }
}

// 调研入口:
// 1) 从任务文本里摘出用户手工贴的 URL(最多 5 个),直接调 Exa /contents 抓正文,作为最高优先素材;
// 2) 剩余文本(去掉 URL)作为 query,并行跑「优先信源」+「开放」两路 /search;
// 3) 三路结果按 用户指定 > 优先信源 > 开放搜索 顺序合并,按 URL 去重。
async function searchExa({ input, writer, workflow, fetchFn, trace, sourcePolicy }) {
  // 普通任务维持 5 个全文 URL 上限；明确要求官方/一手信源的严格任务允许 8 个，
  // 以容纳交易所、监管、公司 IR 等相互独立的证据链。仍保留上限，避免 prompt 无界增长。
  const maxUserUrls = sourcePolicy.requireOfficial ? 8 : 5;
  const { urls, remainder } = extractUrls(input, maxUserUrls);

  const contentsPromise = urls.length
    ? fetchExaContents({ urls, writer, fetchFn, trace }).then(
        (results) => results.map((r) => ({ ...r, userSpecified: true })),
        () => [], // 抓取失败只降级,不影响其它素材
      )
    : Promise.resolve([]);

  const prioritySources = workflow?.research?.prioritySources;
  const hasPriority = Array.isArray(prioritySources) && prioritySources.length > 0;
  const officialSources = workflow?.research?.officialSources;
  const hasOfficial = sourcePolicy.requireOfficial && Array.isArray(officialSources) && officialSources.length > 0;

  let searchResults = [];
  if (remainder) {
    const extraQueries = typeof workflow?.research?.extraQueries === 'function'
      ? workflow.research.extraQueries(remainder).filter(Boolean).slice(0, 3)
      : [];
    const [openSettled, prioritySettled, officialSettled, ...extraSettled] = await Promise.allSettled([
      searchExaOpen({ query: remainder, writer, fetchFn, trace }),
      hasPriority ? searchExaPriority({ query: remainder, writer, prioritySources, fetchFn, trace }) : Promise.resolve([]),
      hasOfficial ? searchExaPriority({
        query: `${remainder} official filing investor relations exchange data`,
        writer,
        prioritySources: officialSources,
        fetchFn,
        trace,
        kind: 'official-search',
        official: true,
      }) : Promise.resolve([]),
      ...extraQueries.map((spec) => searchExaOpen({
        query: typeof spec === 'string' ? spec : spec.query,
        options: typeof spec === 'string' ? {} : spec,
        writer,
        fetchFn,
        trace,
      })),
    ]);
    const openFailed = openSettled.status === 'rejected';
    const priorityFailed = hasPriority && prioritySettled.status === 'rejected';
    if (openFailed && (!hasPriority || priorityFailed)) {
      throw openFailed ? openSettled.reason : prioritySettled.reason;
    }
    const priorityResults = hasPriority && prioritySettled.status === 'fulfilled' ? prioritySettled.value : [];
    const officialResults = hasOfficial && officialSettled.status === 'fulfilled' ? officialSettled.value : [];
    const openResults = openSettled.status === 'fulfilled' ? openSettled.value : [];
    const extraResults = extraSettled.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
    searchResults = [...officialResults, ...priorityResults, ...openResults, ...extraResults];
  }

  const contentsResults = await contentsPromise;
  const merged = dedupeByUrl([...contentsResults, ...searchResults]).map((source) => ({
    ...source,
    ...(source.official || urlMatchesAnyDomain(source.url, officialSources) ? { official: true } : {}),
  }));
  if (sourcePolicy.requireOfficial) {
    const officialCount = merged.filter((source) => source.official).length;
    if (officialCount < sourcePolicy.minOfficialSources) {
      throw new Error(`严格来源门禁:仅检索到 ${officialCount} 个官方/一手来源,至少需要 ${sourcePolicy.minOfficialSources} 个`);
    }
  }
  return merged;
}

async function searchExaOpen({ query, options = {}, writer, fetchFn, trace }) {
  const numResults = options.numResults || writer.exaNumResults || 5;
  const url = `${trimTrailingSlash(writer.exaBaseUrl || 'https://api.exa.ai')}/search`;
  const body = {
      query,
      numResults,
      type: options.type || 'auto',
      contents: {
        text: { verbosity: 'compact' },
        highlights: { query, maxCharacters: 1200 },
        ...(options.subpages ? { subpages: options.subpages, subpageTarget: options.subpageTarget } : {}),
      },
      ...(options.category ? { category: options.category } : {}),
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      ...(options.additionalQueries ? { additionalQueries: options.additionalQueries } : {}),
    };
  const event = startTrace(trace, {
    kind: options.kind || 'open-search',
    endpoint: '/search',
    query,
    searchType: body.type,
    category: body.category,
  });
  try {
    const res = await fetchWithRetry(fetchFn, url, {
      method: 'POST',
      headers: {
        'x-api-key': writer.exaApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, { timeoutMs: writer.exaTimeoutMs || 45000 });
    if (!res.ok) throw new Error(`Exa search failed: ${res.status} ${res.statusText} ${await safeText(res)}`.trim());
    const data = await res.json();
    const roots = Array.isArray(data.results) ? data.results.slice(0, numResults) : [];
    const results = flattenExaResults(roots).map((result) => ({
      ...result,
      ...(options.kind === 'quarterly-financials' ? { financialReport: true } : {}),
    }));
    finishTrace(event, { requestId: data.requestId, costDollars: data.costDollars, results });
    return results;
  } catch (e) {
    failTrace(event, e);
    throw e;
  }
}

async function searchExaPriority({ query, writer, prioritySources, fetchFn, trace, kind = 'priority-search', official = false }) {
  const numResults = writer.exaPriorityResults || 4;
  const url = `${trimTrailingSlash(writer.exaBaseUrl || 'https://api.exa.ai')}/search`;
  const event = startTrace(trace, { kind, endpoint: '/search', query, includeDomains: prioritySources });
  try {
  const res = await fetchWithRetry(fetchFn, url, {
    method: 'POST',
    headers: {
      'x-api-key': writer.exaApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      numResults,
      type: 'auto',
      includeDomains: prioritySources,
      contents: {
        text: { verbosity: 'compact' },
        highlights: { query, maxCharacters: 1200 },
      },
    }),
  }, { timeoutMs: writer.exaTimeoutMs || 45000 });
  if (!res.ok) throw new Error(`Exa priority search failed: ${res.status} ${res.statusText} ${await safeText(res)}`.trim());
  const data = await res.json();
  const results = Array.isArray(data.results) ? data.results.slice(0, numResults) : [];
  finishTrace(event, { requestId: data.requestId, costDollars: data.costDollars, results });
  return results.map((r) => ({
    ...r,
    ...(official
      ? (urlMatchesAnyDomain(r.url, prioritySources) ? { official: true } : {})
      : { priority: true }),
  }));
  } catch (e) {
    failTrace(event, e);
    throw e;
  }
}

// 用户手工贴的 URL 走全文抓取(text: true,不做 compact verbosity),不请求 highlights
// (highlights 是围绕 query 摘取片段,对"抓整篇原文"这个用途没有意义);
// formatResearch 里再按 userSpecified 单独放宽字符上限。
async function fetchExaContents({ urls, writer, fetchFn, trace }) {
  const url = `${trimTrailingSlash(writer.exaBaseUrl || 'https://api.exa.ai')}/contents`;
  const event = startTrace(trace, { kind: 'user-contents', endpoint: '/contents', urls });
  try {
  const res = await fetchWithRetry(fetchFn, url, {
    method: 'POST',
    headers: {
      'x-api-key': writer.exaApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ urls, text: true }),
  }, { timeoutMs: writer.exaTimeoutMs || 45000 });
  if (!res.ok) throw new Error(`Exa contents failed: ${res.status} ${res.statusText} ${await safeText(res)}`.trim());
  const data = await res.json();
  const results = Array.isArray(data.results) ? data.results : [];
  finishTrace(event, { requestId: data.requestId, costDollars: data.costDollars, results });
  return results;
  } catch (e) {
    failTrace(event, e);
    throw e;
  }
}

// 从任务文本里提取 http(s) URL(默认最多取前 5 个供 /contents 抓取),并返回去掉所有 URL 后的剩余文本
// (供两路 /search 当 query 用)。
export function extractUrls(text, maxUrls = 5) {
  const re = /https?:\/\/[^\s<>()]+/g;
  const all = String(text || '').match(re) || [];
  const limit = Math.max(1, Math.floor(positiveNumber(maxUrls, 5)));
  const urls = all.map((u) => u.replace(/[.,;:!?)\]}>]+$/, '')).slice(0, limit);
  const remainder = String(text || '').replace(re, ' ').replace(/\s+/g, ' ').trim();
  return { urls, remainder };
}

// 按 URL 去重(规范化:去 trailing slash、host 大小写不敏感),先出现的保留,
// 调用方需保证「更高优先级素材先出现在数组前面」。
function dedupeByUrl(list) {
  const seen = new Set();
  const out = [];
  for (const r of list) {
    if (!r) continue;
    if (r.url) {
      const key = normalizeUrl(r.url);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(r);
  }
  return out;
}

function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return String(raw || '').trim().toLowerCase().replace(/\/+$/, '');
  }
}

function flattenExaResults(results) {
  const out = [];
  for (const result of results) {
    if (!result) continue;
    const { subpages, ...root } = result;
    out.push(root);
    if (Array.isArray(subpages)) {
      for (const subpage of subpages) {
        if (subpage) out.push({ ...subpage, deepPage: true, discoveredFrom: result.url });
      }
    }
  }
  return out;
}

function sourceForTrace(source) {
  return {
    title: source.title || '',
    url: source.url || '',
    publishedDate: source.publishedDate || null,
    kind: source.official ? 'official' : source.userSpecified ? 'user' : source.financialReport ? 'financial-report' : source.priority ? 'priority' : source.deepPage ? 'subpage' : 'open',
  };
}

function startTrace(trace, fields) {
  const event = { ...fields, status: 'running', startedAt: new Date().toISOString() };
  trace?.requests?.push(event);
  if (trace) TRACE_OWNERS.set(event, trace);
  if (trace?.live) console.log(`[research] ${trace.workflowId}/${event.kind} start: ${truncateLog(event.query || (event.urls || []).join(', '))}`);
  persistResearchTrace(trace);
  return event;
}

function finishTrace(event, { requestId, costDollars, results }) {
  event.status = 'ok';
  event.finishedAt = new Date().toISOString();
  event.durationMs = Date.parse(event.finishedAt) - Date.parse(event.startedAt);
  event.requestId = requestId || null;
  event.costDollars = costDollars || null;
  event.results = results.map(sourceForTrace);
  const trace = findOwningTrace(event);
  if (trace?.live) console.log(`[research] ${trace.workflowId}/${event.kind} done: ${event.results.length} results, ${event.durationMs}ms`);
  persistResearchTrace(trace);
}

function failTrace(event, error) {
  event.status = 'failed';
  event.finishedAt = new Date().toISOString();
  event.durationMs = Date.parse(event.finishedAt) - Date.parse(event.startedAt);
  event.error = describeFetchError(error).slice(0, 300);
  const trace = findOwningTrace(event);
  if (trace?.live) console.error(`[research] ${trace.workflowId}/${event.kind} failed: ${event.error}`);
  persistResearchTrace(trace);
}

// 避免把父 trace 作为可枚举字段写进 JSON,同时让事件完成时能即时落盘。
const TRACE_OWNERS = new WeakMap();

function findOwningTrace(event) { return TRACE_OWNERS.get(event); }

function persistResearchTrace(trace) {
  if (!trace?.tracePath) return;
  try { fs.writeFileSync(trace.tracePath, `${JSON.stringify(trace, null, 2)}\n`); } catch {}
}

function writeResearchTrace(tracePath, trace) {
  trace.tracePath = tracePath;
  persistResearchTrace(trace);
}

function truncateLog(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function buildUserPrompt({ workflow, input, research, writer, sourcePolicy, asOf }) {
  const workflowPrompt = typeof workflow.promptTemplate === 'function'
    ? workflow.promptTemplate(input)
    : `写作任务:${input}`;
  const outputInstruction = workflow.outputInstruction
    || '基于以上任务和素材,写出可直接发布到微信公众号草稿箱的 article.md 内容。';
  const dateContext = formatAsOf(asOf);
  const strictContract = sourcePolicy.requireOfficial || sourcePolicy.requireCitations
    ? `
【严格来源契约】
- 当前时间基准:${dateContext};“今日/盘前/已上市/即将上市”等表述必须按这个时间基准核对,周末要明确对应最近一个交易日
- 官方/一手来源与二手报道必须明确区分,核心数字优先采用官方/一手来源
- 至少引用 ${sourcePolicy.minOfficialCitations} 个官方/一手来源,使用可点击的 Markdown 链接并紧邻其支持的事实
- 素材不能支持的数字、因果关系或市场传闻必须删除或明确标为未证实,不得把推断写成事实
`
    : `
【时间基准】
当前时间:${dateContext};涉及“今日/最新/即将”等相对时间时必须据此核对。
`;
  return `【原始工作流写作要求】
${workflowPrompt}
${strictContract}

【系统已完成的调研素材】
${formatResearch(research, writer)}

【最终任务】
${outputInstruction}`;
}

// 用户手工贴的 URL(userSpecified)是直译等场景的第一手素材,需要保留(接近)全文,
// 上限用 writer.exaUserContentMaxChars(EXA_USER_CONTENT_MAX_CHARS,默认 24000 字符);
// 其余(优先信源/开放搜索)只是背景参考,维持原先的 2400 字符上限。
// 注意:这里只对"单条素材"做截断,不对"多条用户指定素材拼起来的 prompt 总长"做全局上限
// (一次任务最多 5 个用户 URL,每条最多到 24000 字符,理论上可累加到 12 万字符左右);
// 目标模型上下文足够大,暂不需要额外的总量控制,后续如遇模型上下文不够可在此加总量裁剪。
function formatResearch(results, writer = {}) {
  if (!results.length) return '未检索到可用素材。请明确说明信息不足,不要编造事实。';
  const userMaxChars = writer.exaUserContentMaxChars || 24000;
  return results.map((r, i) => {
    const label = r.official ? '【官方/一手信源】' : r.userSpecified ? '【用户指定素材】' : r.financialReport ? '【财报专项】' : r.priority ? '【优先信源】' : r.deepPage ? '【深层子页面】' : '';
    const maxChars = r.userSpecified ? userMaxChars : 2400;
    const full = [
      ...(Array.isArray(r.highlights) ? r.highlights : []),
      r.summary,
      r.text,
    ].filter(Boolean).join('\n');
    const truncated = full.length > maxChars;
    const excerpts = truncated ? `${full.slice(0, maxChars)}\n(原文过长已截断)` : full;
    return `### 来源 ${i + 1}: ${label}${r.title || '未命名来源'}
URL: ${r.url || '无'}
发布日期: ${r.publishedDate || '未知'}
摘录:
${excerpts || '无可用正文摘录'}`;
  }).join('\n\n');
}

function sourcePolicyFor({ input, workflow }) {
  const text = String(input || '');
  const requireOfficial = /官方|一手信源|第一手|primary\s+sources?/i.test(text);
  const requireCitations = /引用|引证|cite|citations?/i.test(text) || requireOfficial;
  return {
    requireOfficial,
    requireCitations,
    minOfficialSources: Number(workflow?.research?.minOfficialSources || 2),
    minOfficialCitations: Number(workflow?.research?.minOfficialCitations || 2),
  };
}

function validateArticleSourceContract(article, research, policy) {
  if (!policy.requireCitations) return;
  const links = [...String(article).matchAll(/https?:\/\/[^\s)>\]]+/g)].map((match) => match[0].replace(/[.,;，。；]+$/, ''));
  const officialUrls = research.filter((source) => source.official && source.url).map((source) => source.url);
  const citedOfficial = new Set(officialUrls.filter((url) => links.some((link) => normalizeUrl(link) === normalizeUrl(url))));
  if (citedOfficial.size < policy.minOfficialCitations) {
    throw new Error(`严格引用门禁:正文仅引用 ${citedOfficial.size} 个已检索官方来源,至少需要 ${policy.minOfficialCitations} 个`);
  }
}

function urlMatchesAnyDomain(rawUrl, domains) {
  if (!rawUrl || !Array.isArray(domains)) return false;
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return domains.some((domain) => {
      const normalized = String(domain || '').toLowerCase().replace(/^www\./, '');
      return host === normalized || host.endsWith(`.${normalized}`);
    });
  } catch { return false; }
}

function formatAsOf(value) {
  const date = value instanceof Date ? value : new Date(value);
  const iso = date.toISOString();
  const local = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'full',
    timeStyle: 'long',
  }).format(date);
  return `${local} (America/Los_Angeles; UTC ${iso})`;
}

async function completeArticle({ prompt, model, writer, fetchFn, timeoutMs, systemPrompt }) {
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const url = `${trimTrailingSlash(writer.baseUrl || 'https://openrouter.ai/api/v1')}/chat/completions`;
    const maxTokens = positiveNumber(writer.maxTokens, 12000);
    const configuredEffort = writer.reasoningEffort || 'none';
    let lastDiagnostic = 'unknown response';

    // 空正文通常是 reasoning 吃完输出预算或 provider 瞬时异常。应用层只重试一次,
    // 第二次强制关闭 reasoning,避免队列无限重试和重复计费。
    for (let attempt = 0; attempt < 2; attempt++) {
      const effort = attempt === 0 ? configuredEffort : 'none';
      const res = await fetchWithRetry(fetchFn, url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${writer.openrouterApiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': writer.httpReferer || 'https://zentradings.com',
          'X-OpenRouter-Title': writer.appTitle || 'Zen Content Hub',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt || DEFAULT_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          max_tokens: maxTokens,
          reasoning: { effort, exclude: true },
          temperature: writer.temperature ?? 0.4,
        }),
      });
      if (!res.ok) throw new Error(formatOpenRouterHttpError(res, await safeText(res)));
      const data = await res.json();
      const content = extractMessageContent(data?.choices?.[0]?.message?.content);
      if (content) return content;
      lastDiagnostic = describeEmptyCompletion(data);
    }
    throw new Error(`OpenRouter returned empty content after retry (${lastDiagnostic})`);
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('OpenRouter completion timed out');
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function extractMessageContent(content) {
  if (typeof content === 'string') return content.trim() ? content : '';
  if (!Array.isArray(content)) return '';
  return content.map((part) => typeof part === 'string' ? part : part?.text || '').join('').trim();
}

function describeEmptyCompletion(data) {
  const choice = data?.choices?.[0] || {};
  const usage = data?.usage || {};
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;
  return [
    `finish_reason=${choice.finish_reason || 'missing'}`,
    `reasoning_tokens=${reasoningTokens ?? 'unknown'}`,
    `completion_tokens=${usage.completion_tokens ?? 'unknown'}`,
  ].join(', ');
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeArticle(content) {
  const trimmed = String(content || '').trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function hasTitleFrontmatter(article) {
  const match = article.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  return Boolean(match && /^title\s*:\s*\S.+$/m.test(match[1]));
}

// 把 undici 的通用 "fetch failed" 展开成带真实 cause 的可诊断信息。
export function describeFetchError(e) {
  if (!e) return 'unknown error';
  const cause = e.cause;
  const causePart = cause ? ` (cause: ${cause.code || cause.message || cause.name || String(cause)})` : '';
  return `${e.message || e}${causePart}`;
}

// 判定是否为可重试的瞬时网络错误(连接被丢/TLS 抖动/超时等),AbortError(主动超时)不重试。
export function isTransientNetworkError(e) {
  if (!e || e.name === 'AbortError') return false;
  const msg = String(e.message || '');
  const code = String((e.cause && (e.cause.code || e.cause.name)) || e.code || '');
  return /fetch failed|network|socket|TLS|SSL|terminated/i.test(msg)
    || /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EPIPE|UND_ERR/i.test(`${code} ${msg}`);
}

// 对瞬时网络错误做退避重试。仅重试 fetch 抛出的网络错误;HTTP 响应(含 4xx/5xx)不在此重试。
// opts.timeoutMs:若提供,每次尝试都用一个全新的 AbortController 包裹单次请求(不复用上一次
// 已 abort 的 signal),超时即 controller.abort() 触发 AbortError;AbortError 不算瞬时网络错误
// (见 isTransientNetworkError),因此不会被重试,而是直接向上抛出,交给调用方的降级逻辑处理。
export async function fetchWithRetry(fetchFn, url, options, opts = {}) {
  const { attempts = 3, backoffMs = [500, 1500, 4000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs } = opts;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const controller = timeoutMs ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      const reqOptions = controller ? { ...options, signal: controller.signal } : options;
      return await fetchFn(url, reqOptions);
    } catch (e) {
      lastErr = e;
      if (!isTransientNetworkError(e)) throw e; // 非瞬时错误原样抛出,保留类型(如 AbortError)
      if (i === attempts - 1) break;
      await sleep(backoffMs[Math.min(i, backoffMs.length - 1)]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const err = new Error(`网络请求失败(重试 ${attempts} 次后放弃): ${describeFetchError(lastErr)}`);
  err.cause = lastErr;
  throw err;
}

async function safeText(res) {
  try { return (await res.text()).slice(0, 300); } catch { return ''; }
}

function formatOpenRouterHttpError(res, body) {
  const base = `OpenRouter completion failed: ${res.status} ${res.statusText} ${body || ''}`.trim();
  if (res.status === 401) {
    return `${base}\n请检查当前进程读取到的 OPENROUTER_API_KEY 是否来自项目根目录 .env,并运行 npm run check:openrouter 验证。修正后需要重启 VS Code task/debug 进程。`;
  }
  return base;
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}
