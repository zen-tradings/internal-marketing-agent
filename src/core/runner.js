import fs from 'node:fs';
import path from 'node:path';

const SYSTEM_PROMPT = `你是 Zen Trading 公众号分析师。你会基于系统提供的调研素材写中文金融分析文章。

严格要求:
- 只使用用户任务与调研素材中可支持的信息,不编造数字、新闻或来源
- 风格严谨专业,机构分析师口吻
- 不用破折号,改用逗号或冒号
- 括号内容极度克制,非必要不加
- 金额用中文单位,例如亿美元、百万美元,不出现美元符号
- 口径说明板块每个控制在 1-2 句
- 结尾蓝色板块固定三行:
  ZEN TRADING STRATEGIES
  板块模型 · 量化策略 · 前沿解读
  本文为研究用途,不构成任何投资建议。

输出必须是完整 Markdown,且文件开头必须是 YAML frontmatter:
---
title: 文章标题
---
正文从 frontmatter 后开始。不要输出解释、代码围栏或发布指令。`;

export async function runWriter({ workflow, input, config, fetchFn = globalThis.fetch }) {
  const articlePath = path.join(workflow.workDir, 'article.md');
  try { fs.rmSync(articlePath, { force: true }); } catch {}

  try {
    fs.mkdirSync(workflow.workDir, { recursive: true });
    const writer = config.writer || {};
    const model = workflow.model || writer.model;
    if (!writer.openrouterApiKey) throw new Error('缺少 OpenRouter API key');
    if (!writer.exaApiKey) throw new Error('缺少 Exa API key');
    if (!model) throw new Error('缺少 OpenRouter model');

    const research = await searchExa({ input, writer, fetchFn });
    const prompt = buildUserPrompt({ workflow, input, research });
    const content = await completeArticle({ prompt, model, writer, fetchFn, timeoutMs: workflow.timeoutMs });
    const article = normalizeArticle(content);
    if (!hasTitleFrontmatter(article)) {
      throw new Error('OpenRouter 输出缺少 title frontmatter');
    }

    fs.writeFileSync(articlePath, article);
    return { ok: true, articlePath, model, sources: research.map((r) => r.url).filter(Boolean) };
  } catch (e) {
    try { fs.rmSync(articlePath, { force: true }); } catch {}
    return { ok: false, articlePath, exitCode: 1, stderr: describeFetchError(e).slice(0, 600) };
  }
}

export const runClaude = runWriter;

async function searchExa({ input, writer, fetchFn }) {
  const url = `${trimTrailingSlash(writer.exaBaseUrl || 'https://api.exa.ai')}/search`;
  const res = await fetchWithRetry(fetchFn, url, {
    method: 'POST',
    headers: {
      'x-api-key': writer.exaApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: input,
      numResults: writer.exaNumResults || 5,
      type: 'auto',
      contents: {
        text: { verbosity: 'compact' },
        highlights: { query: input, maxCharacters: 1200 },
      },
    }),
  });
  if (!res.ok) throw new Error(`Exa search failed: ${res.status} ${res.statusText} ${await safeText(res)}`.trim());
  const data = await res.json();
  return Array.isArray(data.results) ? data.results.slice(0, writer.exaNumResults || 5) : [];
}

function buildUserPrompt({ workflow, input, research }) {
  const workflowPrompt = typeof workflow.promptTemplate === 'function'
    ? workflow.promptTemplate(input)
    : `写作任务:${input}`;
  return `【原始工作流写作要求】
${workflowPrompt}

【系统已完成的调研素材】
${formatResearch(research)}

【最终任务】
基于以上任务和素材,写出可直接发布到微信公众号草稿箱的 article.md 内容。`;
}

function formatResearch(results) {
  if (!results.length) return '未检索到可用素材。请明确说明信息不足,不要编造事实。';
  return results.map((r, i) => {
    const excerpts = [
      ...(Array.isArray(r.highlights) ? r.highlights : []),
      r.summary,
      r.text,
    ].filter(Boolean).join('\n').slice(0, 2400);
    return `### 来源 ${i + 1}: ${r.title || '未命名来源'}
URL: ${r.url || '无'}
发布日期: ${r.publishedDate || '未知'}
摘录:
${excerpts || '无可用正文摘录'}`;
  }).join('\n\n');
}

async function completeArticle({ prompt, model, writer, fetchFn, timeoutMs }) {
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const url = `${trimTrailingSlash(writer.baseUrl || 'https://openrouter.ai/api/v1')}/chat/completions`;
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
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: writer.temperature ?? 0.4,
      }),
    });
    if (!res.ok) throw new Error(`OpenRouter completion failed: ${res.status} ${res.statusText} ${await safeText(res)}`.trim());
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenRouter response missing choices[0].message.content');
    return content;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('OpenRouter completion timed out');
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
export async function fetchWithRetry(fetchFn, url, options, opts = {}) {
  const { attempts = 3, backoffMs = [500, 1500, 4000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = opts;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchFn(url, options);
    } catch (e) {
      lastErr = e;
      if (!isTransientNetworkError(e)) throw e; // 非瞬时错误原样抛出,保留类型(如 AbortError)
      if (i === attempts - 1) break;
      await sleep(backoffMs[Math.min(i, backoffMs.length - 1)]);
    }
  }
  const err = new Error(`网络请求失败(重试 ${attempts} 次后放弃): ${describeFetchError(lastErr)}`);
  err.cause = lastErr;
  throw err;
}

async function safeText(res) {
  try { return (await res.text()).slice(0, 300); } catch { return ''; }
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}
