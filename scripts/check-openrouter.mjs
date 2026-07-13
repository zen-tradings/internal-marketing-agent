import dotenv from 'dotenv';

dotenv.config({ override: true });

const key = process.env.OPENROUTER_API_KEY || '';
const baseUrl = String(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const model = process.env.OPENROUTER_MODEL || 'qwen/qwen3-235b-a22b';

if (!key) {
  console.error('OPENROUTER_API_KEY is missing. Add it to the project .env file.');
  process.exit(1);
}

console.log(`OpenRouter key detected: len=${key.length}`);
console.log(`OpenRouter base URL: ${baseUrl}`);
console.log(`OpenRouter model: ${model}`);

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

const completion = await request(`${baseUrl}/chat/completions`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
    max_tokens: 64,
    reasoning: { effort: 'none', exclude: true },
    temperature: 0,
  }),
});

if (!completion.ok) {
  console.error(`OpenRouter /chat/completions failed: ${completion.status} ${completion.statusText}`);
  console.error(completion.body.slice(0, 500));
  process.exit(1);
}

try {
  const data = JSON.parse(completion.body);
  if (!data?.choices?.[0]?.message?.content) throw new Error(`empty content, finish_reason=${data?.choices?.[0]?.finish_reason || 'missing'}`);
} catch (e) {
  console.error(`OpenRouter completion response invalid: ${e.message}`);
  process.exit(1);
}

console.log('OpenRouter auth and completion check passed.');

async function request(url, options) {
  try {
    const res = await fetch(url, options);
    return { ok: res.ok, status: res.status, statusText: res.statusText, body: await res.text() };
  } catch (e) {
    return { ok: false, status: 'NETWORK', statusText: e.message || String(e), body: '' };
  }
}
