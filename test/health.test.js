import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOpenRouterHealth, checkClaudeAuth } from '../src/lib/health.js';

function jsonResponse(body, init = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText || 'OK',
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

test('OpenRouter models 探活成功 → ok', async () => {
  const seen = {};
  const res = await checkOpenRouterHealth({
    config: { writer: { openrouterApiKey: 'or-key', baseUrl: 'https://openrouter.test/api/v1' } },
    fetchFn: async (url, opts) => {
      seen.url = String(url);
      seen.auth = opts.headers.Authorization;
      return jsonResponse({ data: [{ id: 'deepseek/deepseek-chat' }] });
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.detail, 'models:1');
  assert.equal(seen.url, 'https://openrouter.test/api/v1/models');
  assert.equal(seen.auth, 'Bearer or-key');
});

test('OpenRouter models 探活失败 → not ok', async () => {
  const res = await checkOpenRouterHealth({
    config: { writer: { openrouterApiKey: 'bad', baseUrl: 'https://openrouter.test/api/v1' } },
    fetchFn: async () => jsonResponse({ error: 'unauthorized' }, { ok: false, status: 401, statusText: 'Unauthorized' }),
  });
  assert.equal(res.ok, false);
  assert.match(res.detail, /401 Unauthorized/);
});

test('旧 health 导出名兼容到 OpenRouter 探活', async () => {
  assert.equal(checkClaudeAuth, checkOpenRouterHealth);
});
