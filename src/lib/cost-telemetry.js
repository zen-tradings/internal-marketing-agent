import crypto from 'node:crypto';
import { costContext, COST_STAGE } from './cost-context.js';
import { decorateFetchTransport, rebindFetchTransport } from './task-cancellation.js';
import { observeResponseUsage } from './response-usage.js';

export function knownNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,160}$/.test(value) ? value : null;
export function normalizeCostEvent(value) {
  return {
    source: value.source === 'legacy-trace' ? 'legacy-trace' : 'live',
    attemptId: id(value.attemptId) || crypto.randomUUID(),
    generationId: id(value.generationId),
    occurredAt: knownNumber(value.occurredAt) ?? Date.now(),
    vendor: ['openrouter', 'exa', 'datalab'].includes(value.vendor) ? value.vendor : 'other',
    workflowId: id(value.workflowId) || 'unassigned', runId: id(value.runId),
    stage: id(value.stage) || 'unspecified', model: id(value.model), provider: id(value.provider),
    configurationId: id(value.configurationId),
    outcome: ['attempting', 'completed', 'empty', 'error', 'unknown', 'cancelled'].includes(value.outcome) ? value.outcome : 'unknown',
    httpStatus: knownNumber(value.httpStatus), durationMs: knownNumber(value.durationMs),
    costUsd: knownNumber(value.costUsd),
    promptTokens: knownNumber(value.promptTokens), completionTokens: knownNumber(value.completionTokens),
    reasoningTokens: knownNumber(value.reasoningTokens), cachedTokens: knownNumber(value.cachedTokens),
    cacheWriteTokens: knownNumber(value.cacheWriteTokens), pages: knownNumber(value.pages),
    mode: ['fast', 'balanced', 'accurate'].includes(value.mode) ? value.mode : null,
  };
}

export function effectiveReasoningEffort(model, effort = 'none') {
  return effort === 'none' && /^z-ai\/glm-5\.3-flash(?:$|[-:])/i.test(String(model)) ? 'low' : effort;
}

export function costConfigurationId({ writer = {}, translation = {}, openingDigest = {} } = {}) {
  const keys = ['model', 'routerModel', 'plannerModel', 'reviewModel', 'optionsStrategyModel',
    'reasoningEffort', 'routerReasoningEffort', 'plannerReasoningEffort', 'reviewReasoningEffort',
    'optionsStrategyReasoningEffort', 'maxTokens', 'optionsStrategyMaxTokens'];
  return crypto.createHash('sha256').update(JSON.stringify({
    writer: keys.map(key => [key, writer[key] ?? null]),
    translation: ['model', 'reasoningEffort', 'maxTokens', 'batchConcurrency'].map(key => [key, translation[key] ?? null]),
    openingDigest: ['model'].map(key => [key, openingDigest[key] ?? null]),
  })).digest('hex');
}

// Observe the body already consumed by the caller, without cloning, eager reads,
// recording content, or changing timeout/retry/resource-permit semantics.
export function createCostAwareFetch(transport, { record = () => {}, writer = {}, translation = {}, openingDigest = {} } = {}) {
  const bases = {
    openrouter: writer.baseUrl || 'https://openrouter.ai/api/v1',
    exa: writer.exaBaseUrl || 'https://api.exa.ai',
    datalab: translation.datalabBaseUrl || 'https://www.datalab.to/api/v1',
  };
  const emit = event => { try { record(event); } catch {} };
  const configurationId = costConfigurationId({ writer, translation, openingDigest });
  async function wrapped(resource, options = {}) {
    const url = String(resource?.url || resource);
    const vendor = Object.entries(bases).find(([, base]) => url.startsWith(`${base.replace(/\/+$/, '')}/`))?.[0];
    if (!vendor) return transport(resource, options);
    // Only these endpoints return usage. Never observe customer data or assets.
    if (vendor === 'openrouter' && !url.split('?')[0].endsWith('/chat/completions')) return transport(resource, options);
    if (vendor === 'exa' && !/\/(search|contents)(?:\?|$)/.test(url)) return transport(resource, options);
    if (vendor === 'datalab' && !/\/convert(?:\/|\?|$)/.test(url)) return transport(resource, options);
    const fields = costContext();
    const started = Date.now();
    let body;
    try { body = typeof options.body === 'string' ? JSON.parse(options.body) : null; } catch {}
    const next = { ...options };
    delete next[COST_STAGE];
    if (vendor === 'openrouter' && body?.reasoning?.effort === 'none') {
      const effort = effectiveReasoningEffort(body.model, body.reasoning.effort);
      if (effort !== body.reasoning.effort) next.body = JSON.stringify({ ...body, reasoning: { ...body.reasoning, effort } });
    }
    const event = { ...fields, stage: options[COST_STAGE] || fields.stage || vendor,
      attemptId: crypto.randomUUID(), occurredAt: started, vendor,
      configurationId, model: body?.model, mode: options.body?.get?.('mode') || fields.mode,
      outcome: 'attempting', costUsd: null };
    emit(event);
    let response;
    try { response = await transport(resource, next); }
    catch (error) {
      emit({ ...event, durationMs: Date.now() - started, outcome: next.signal?.aborted ? 'cancelled' : 'error' });
      throw error;
    }
    event.httpStatus = response.status;
    event.outcome = response.ok ? 'unknown' : 'error';
    emit({ ...event, durationMs: Date.now() - started });
    const observe = data => {
      const usage = data?.usage || {};
      const finished = { ...event, durationMs: Date.now() - started,
        generationId: response.headers?.get?.('x-generation-id') || data?.id || data?.requestId || data?.request_id,
        model: data?.model || event.model, provider: data?.provider,
        outcome: response.ok ? 'completed' : 'error' };
      if (vendor === 'openrouter') {
        finished.costUsd = usage.cost;
        finished.promptTokens = usage.prompt_tokens;
        finished.completionTokens = usage.completion_tokens;
        finished.reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
        finished.cachedTokens = usage.prompt_tokens_details?.cached_tokens;
        finished.cacheWriteTokens = usage.prompt_tokens_details?.cache_write_tokens;
        if (response.ok && !data?.choices?.[0]?.message?.content) finished.outcome = 'empty';
      } else if (vendor === 'exa') finished.costUsd = typeof data?.costDollars === 'object' ? data?.costDollars?.total : data?.costDollars;
      else {
        finished.generationId ||= /\/convert\/([^/?]+)/.exec(url)?.[1];
        finished.pages = data?.page_count;
        // Datalab does not guarantee a dollar amount in cost_breakdown; do not
        // mistake credits/token counts for USD. Only explicit USD fields count.
        finished.costUsd = data?.cost_usd ?? data?.cost_breakdown?.total_cost_usd;
        if (data?.status && data.status !== 'complete') finished.outcome = data.status === 'failed' ? 'error' : 'unknown';
      }
      emit(finished);
    };
    return observeResponseUsage(response, {
      completed: observe,
      unknown: () => emit({ ...event, durationMs: Date.now() - started }),
      failed: () => emit({ ...event, durationMs: Date.now() - started, outcome: next.signal?.aborted ? 'cancelled' : 'error' }),
    });
  }
  return decorateFetchTransport(wrapped, transport, next => createCostAwareFetch(rebindFetchTransport(transport, next), { record, writer, translation, openingDigest }));
}
