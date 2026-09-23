import { RESOURCE_TELEMETRY } from '../resource-governor.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';


export const DEFAULT_SYSTEM_PROMPT = `你是 Zen Trading 公众号分析师。你会基于系统提供的调研素材写中文金融分析文章。

严格要求:
- 只使用用户任务与调研素材中可支持的信息,不编造数字、新闻或来源
- 风格严谨专业,机构分析师口吻
- 不用破折号,改用逗号或冒号
- 括号内容极度克制,非必要不加
- 金额用中文单位,例如亿美元、百万美元,不出现美元符号
- 口径说明板块每个控制在 1-2 句
- 系统自行组织的正文分区标题写成 ## English｜中文,不要手写序号;用户点名的章节名必须原样保留

输出必须是完整 Markdown,且文件开头必须是 YAML frontmatter:
---
title: 文章标题
---
正文从 frontmatter 后开始。不要输出解释、代码围栏或发布指令。`;

export async function completeReviewJson(options) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await completeArticle({
      ...options,
      // JSON roles use their own reasoning settings; auditing defaults off and the Kimi planner can enable it independently.
      writer: {
        ...options.writer,
        reasoningEffort: options.reasoningEffort
          ?? options.writer.reviewReasoningEffort
          ?? 'none',
      },
      prompt: attempt === 0
        ? options.prompt
        : `${options.prompt}\n\n${options.retryInstruction || '上一次输出不是有效 JSON。本次只能返回一个语法有效的 JSON 对象，字符串内换行必须转义，不要代码围栏或解释。'}`,
      responseFormat: { type: 'json_object' },
    });
    try { return parseJsonObject(raw); }
    catch (error) { lastError = error; }
  }
  throw new Error(`事实审查失败:审查模型连续两次未返回有效 JSON (${lastError?.message || 'unknown'})`);
}

export function parseJsonObject(raw) {
  const clean = String(raw || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(clean); } catch {}
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1));
  throw new Error('未找到有效 JSON 对象');
}

export async function completeArticle({
  prompt,
  model,
  writer,
  fetchFn,
  timeoutMs,
  systemPrompt,
  responseFormat,
  onTelemetry,
  inferenceContext,
  // Optional mutable flag: set to true when the response returned visible content but
  // finished with finish_reason=length (budget exhausted mid-output). Empty responses are
  // still retried inside this function; non-empty truncation must be handled by the caller.
  truncationSignal,
}) {
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const url = `${trimTrailingSlash(writer.baseUrl || 'https://openrouter.ai/api/v1')}/chat/completions`;
    const maxTokens = positiveNumber(writer.maxTokens, 12000);
    const configuredEffort = writer.reasoningEffort || 'none';
    let lastDiagnostic = 'unknown response';

    // Empty bodies usually mean reasoning exhausted the output budget or a transient provider failure. Retry once at
    // application level: lower forced reasoning to low and disable it for other models to avoid useless repeat billing.
    for (let attempt = 0; attempt < 2; attempt++) {
      let effort = attempt === 0
        ? configuredEffort
        : (writer.preserveReasoningOnEmpty || modelRequiresReasoning(model)) ? 'low' : 'none';
      const requestStartedAt = new Date().toISOString();
      const requestStartedMs = Date.now();
      let queueWaitMs = 0;
      let transportRequests = 0;
      let res;
      // OpenRouter hard-rejects `reasoning: { effort: 'none' }` on endpoints where reasoning is mandatory
      // (e.g. z-ai/glm-5.3-flash) with a router-level 400 before dispatching to any provider. Escalate that
      // specific rejection to 'low' within the same attempt instead of failing the whole task.
      for (let send = 0; ; send++) {
      try {
        res = await fetchWithRetry(fetchFn, url, {
        method: 'POST',
        signal: controller.signal,
        [RESOURCE_TELEMETRY]: (event) => {
          queueWaitMs += Number(event?.queueWaitMs) || 0;
          transportRequests += 1;
        },
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
          ...(responseFormat ? { response_format: responseFormat } : {}),
        }),
      });
      } catch (error) {
        emitInferenceTelemetry(onTelemetry, buildInferenceTelemetry({
          inferenceContext, requestStartedAt, requestStartedMs, queueWaitMs, transportRequests,
          attempt, effort, model, error,
        }));
        throw error;
      }
      if (!res.ok) {
        const errorBody = await safeText(res);
        if (send === 0 && effort === 'none' && REASONING_MANDATORY_RE.test(errorBody)) {
          emitInferenceTelemetry(onTelemetry, buildInferenceTelemetry({
            inferenceContext, requestStartedAt, requestStartedMs, queueWaitMs, transportRequests,
            attempt, effort, model, response: res, outcome: 'reasoning-mandatory-rejection',
            error: new Error('reasoning effort none rejected: endpoint mandates reasoning'),
          }));
          effort = 'low';
          continue;
        }
        const error = new Error(formatOpenRouterHttpError(res, errorBody));
        emitInferenceTelemetry(onTelemetry, buildInferenceTelemetry({
          inferenceContext, requestStartedAt, requestStartedMs, queueWaitMs, transportRequests,
          attempt, effort, model, response: res, error,
        }));
        throw error;
      }
      break;
      }
      let data;
      try {
        const rawResponse = await res.text();
        data = JSON.parse(rawResponse);
      } catch (error) {
        lastDiagnostic = `malformed_json=${String(error?.message || error || 'unknown')}`;
        emitInferenceTelemetry(onTelemetry, buildInferenceTelemetry({
          inferenceContext, requestStartedAt, requestStartedMs, queueWaitMs, transportRequests,
          attempt, effort, model, response: res, error, outcome: 'malformed-json',
        }));
        if (attempt === 0) continue;
        const malformed = new Error(
          `OpenRouter returned malformed JSON response after retry (${lastDiagnostic})`,
          { cause: error },
        );
        malformed.retryableTranslationResponse = true;
        throw malformed;
      }
      const content = extractMessageContent(data?.choices?.[0]?.message?.content);
      const finishReason = data?.choices?.[0]?.finish_reason || null;
      const truncated = Boolean(content) && finishReason === 'length';
      if (truncated && truncationSignal) {
        truncationSignal.truncated = true;
        truncationSignal.finishReason = finishReason;
      }
      const outcome = content ? 'completed' : 'empty';
      emitInferenceTelemetry(onTelemetry, buildInferenceTelemetry({
        inferenceContext, requestStartedAt, requestStartedMs, queueWaitMs, transportRequests,
        attempt, effort, model, response: res, data, outcome,
      }));
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

export function buildInferenceTelemetry({
  inferenceContext,
  requestStartedAt,
  requestStartedMs,
  queueWaitMs,
  transportRequests,
  attempt,
  effort,
  model,
  response,
  data,
  error,
  outcome,
}) {
  const usage = data?.usage || {};
  return {
    ...(inferenceContext || {}),
    requestStartedAt,
    durationMs: Math.max(0, Date.now() - requestStartedMs),
    queueWaitMs: Math.max(0, Math.round(queueWaitMs || 0)),
    transportRequests: Math.max(transportRequests || 0, response ? 1 : 0),
    applicationAttempt: attempt + 1,
    reasoningEffort: effort,
    requestedModel: model,
    resolvedModel: data?.model || null,
    provider: data?.provider || null,
    generationId: response?.headers?.get?.('x-generation-id') || data?.id || null,
    httpStatus: Number(response?.status) || null,
    finishReason: data?.choices?.[0]?.finish_reason || null,
    promptTokens: Number(usage.prompt_tokens) || 0,
    completionTokens: Number(usage.completion_tokens) || 0,
    reasoningTokens: Number(usage.completion_tokens_details?.reasoning_tokens) || 0,
    cost: Number(usage.cost) || 0,
    outcome: outcome || (error ? 'error' : 'completed'),
    ...(error ? { error: String(error?.message || error).slice(0, 300) } : {}),
  };
}

export function emitInferenceTelemetry(callback, event) {
  if (typeof callback !== 'function') return;
  try { callback(event); } catch {}
}

export function summarizeInferenceTelemetry(requests) {
  const values = Array.isArray(requests) ? requests : [];
  const sum = (key) => values.reduce((total, item) => total + (Number(item?.[key]) || 0), 0);
  return {
    requestAttempts: values.length,
    completedRequests: values.filter((item) => item?.outcome === 'completed').length,
    emptyRequests: values.filter((item) => item?.outcome === 'empty').length,
    failedRequests: values.filter((item) => !['completed', 'empty'].includes(item?.outcome)).length,
    totalInferenceMs: sum('durationMs'),
    totalQueueWaitMs: sum('queueWaitMs'),
    maxRequestMs: values.reduce((maximum, item) => Math.max(maximum, Number(item?.durationMs) || 0), 0),
    promptTokens: sum('promptTokens'),
    completionTokens: sum('completionTokens'),
    reasoningTokens: sum('reasoningTokens'),
    cost: sum('cost'),
  };
}

// z-ai/glm-5.3-flash mandates reasoning on OpenRouter: `reasoning: { effort: 'none' }` is rejected with a
// router-level 400 ("Reasoning is mandatory for this endpoint and cannot be disabled.") before any provider routing.
export function modelRequiresReasoning(model) {
  return /^z-ai\/glm-5\.3-flash(?:$|[-:])/i.test(String(model || ''))
    || /^qwen\/qwen3\.8-max(?:$|[-:])/i.test(String(model || ''))
    || /^anthropic\/claude-fable-5(?:$|[-:])/i.test(String(model || ''))
    || /^openai\/gpt-oss-(?:20b|120b)(?:$|[-:])/i.test(String(model || ''));
}

export const REASONING_MANDATORY_RE = /reasoning is mandatory for this endpoint/i;

export function extractMessageContent(content) {
  if (typeof content === 'string') return content.trim() ? content : '';
  if (!Array.isArray(content)) return '';
  return content.map((part) => typeof part === 'string' ? part : part?.text || '').join('').trim();
}

export function describeEmptyCompletion(data) {
  const choice = data?.choices?.[0] || {};
  const usage = data?.usage || {};
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;
  return [
    `finish_reason=${choice.finish_reason || 'missing'}`,
    `reasoning_tokens=${reasoningTokens ?? 'unknown'}`,
    `completion_tokens=${usage.completion_tokens ?? 'unknown'}`,
  ].join(', ');
}

export function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function safeText(res) {
  try { return (await res.text()).slice(0, 300); } catch { return ''; }
}

export function formatOpenRouterHttpError(res, body) {
  const base = `OpenRouter completion failed: ${res.status} ${res.statusText} ${body || ''}`.trim();
  if (res.status === 401) {
    return `${base}\n请检查当前进程读取到的 OPENROUTER_API_KEY 是否来自项目根目录 .env,并运行 npm run check:openrouter 验证。修正后需要重启 VS Code task/debug 进程。`;
  }
  return base;
}

export function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}
