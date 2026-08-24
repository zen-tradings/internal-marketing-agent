import dotenv from 'dotenv';

dotenv.config({ override: true });

const key = process.env.OPENROUTER_API_KEY || '';
const baseUrl = String(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const model = process.env.OPENROUTER_MODEL || 'qwen/qwen3.8-max';
const reasoningEffort = process.env.OPENROUTER_REASONING_EFFORT || 'high';
const openingDigestModel = process.env.OPENING_DIGEST_MODEL || model;
const plannerModel = process.env.OPENROUTER_PLANNER_MODEL || model;
const plannerReasoningEffort = process.env.OPENROUTER_PLANNER_REASONING_EFFORT || 'high';
const optionsStrategyModel = process.env.OPTIONS_STRATEGY_MODEL || 'anthropic/claude-fable-5';
const optionsStrategyReasoningEffort = process.env.OPTIONS_STRATEGY_REASONING_EFFORT || 'high';
const timeoutMs = positiveInteger(process.env.OPENROUTER_CHECK_TIMEOUT_MS, 60000);
const optionsStrategyCheckTimeoutMs = positiveInteger(process.env.OPTIONS_STRATEGY_TIMEOUT_MS, 900000);

if (!key) {
  console.error('OPENROUTER_API_KEY is missing. Add it to the project .env file.');
  process.exit(1);
}

console.log(`OpenRouter key detected: len=${key.length}`);
console.log(`OpenRouter base URL: ${baseUrl}`);
console.log(`OpenRouter model: ${model}`);
console.log(`OpenRouter reasoning effort: ${reasoningEffort}`);
console.log(`Opening Digest writer model: ${openingDigestModel}`);
console.log(`OpenRouter planner model: ${plannerModel}`);
console.log(`OpenRouter planner reasoning effort: ${plannerReasoningEffort}`);
console.log(`Options strategy model: ${optionsStrategyModel}`);
console.log(`Options strategy reasoning effort: ${optionsStrategyReasoningEffort}`);

const headers = {
  Authorization: `Bearer ${key}`,
  'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'https://zentradings.com',
  'X-OpenRouter-Title': process.env.OPENROUTER_APP_TITLE || 'Zen Content Hub',
};

const currentKey = await request(`${baseUrl}/key`, { method: 'GET', headers });
if (!currentKey.ok) {
  console.error(`OpenRouter /key failed: ${currentKey.status} ${currentKey.statusText}`);
  console.error(currentKey.body.slice(0, 300));
  console.error('This key is not accepted by OpenRouter for authenticated API usage. Create or copy a regular API key from https://openrouter.ai/keys, update OPENROUTER_API_KEY in .env, then restart the bot.');
  process.exit(1);
}

const models = await request(`${baseUrl}/models`, { method: 'GET', headers });
if (!models.ok) {
  console.error(`OpenRouter /models failed: ${models.status} ${models.statusText}`);
  console.error(models.body.slice(0, 300));
  process.exit(1);
}
try {
  const available = JSON.parse(models.body)?.data || [];
  for (const requiredModel of new Set([model, openingDigestModel, plannerModel, optionsStrategyModel])) {
    if (!available.some((item) => item?.id === requiredModel)) {
      console.error(`OpenRouter model is not available: ${requiredModel}`);
      process.exit(1);
    }
  }
} catch {
  console.error('OpenRouter /models returned invalid JSON.');
  process.exit(1);
}

for (const role of [
  { name: 'writer', model, reasoningEffort, json: false },
  { name: 'opening-digest-writer', model: openingDigestModel, reasoningEffort, json: false, requireEnglish: true, maxTokens: 1024 },
  { name: 'planner', model: plannerModel, reasoningEffort: plannerReasoningEffort, json: true },
  {
    name: 'options-strategy', model: optionsStrategyModel,
    reasoningEffort: optionsStrategyReasoningEffort, json: true,
    maxTokens: 1024, timeoutMs: optionsStrategyCheckTimeoutMs,
  },
]) {
  const completion = await request(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: role.model,
      messages: role.json
        ? [
            { role: 'system', content: 'Return valid JSON only.' },
            { role: 'user', content: 'Return {"ok":true}.' },
          ]
        : [{ role: 'user', content: 'Reply with exactly: ok' }],
      // Reasoning models consume hidden tokens; reserve sufficient output budget for the connectivity check.
      max_tokens: role.maxTokens || (role.json ? 1024 : 256),
      reasoning: { effort: role.reasoningEffort, exclude: true },
      temperature: 0,
      ...(role.json ? { response_format: { type: 'json_object' } } : {}),
    }),
  }, role.timeoutMs);

  if (!completion.ok) {
    console.error(`OpenRouter ${role.name} completion failed: ${completion.status} ${completion.statusText}`);
    console.error(completion.body.slice(0, 500));
    process.exit(1);
  }

  try {
    const data = JSON.parse(completion.body);
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error(`empty content, finish_reason=${data?.choices?.[0]?.finish_reason || 'missing'}`);
    if (role.requireEnglish && !/[A-Za-z]/.test(content)) throw new Error('Opening Digest writer did not return English text');
    if (role.json && JSON.parse(content)?.ok !== true) throw new Error('planner JSON did not contain ok=true');
  } catch (e) {
    console.error(`OpenRouter ${role.name} completion response invalid: ${e.message}`);
    process.exit(1);
  }
}

console.log('OpenRouter writer, Opening Digest writer, planner, and options-strategy completion checks passed.');

async function request(url, options, requestTimeoutMs = timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return { ok: res.ok, status: res.status, statusText: res.statusText, body: await res.text() };
  } catch (e) {
    const statusText = e?.name === 'AbortError'
      ? `request timed out after ${requestTimeoutMs}ms`
      : e.message || String(e);
    return { ok: false, status: 'NETWORK', statusText, body: '' };
  } finally {
    clearTimeout(timer);
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
