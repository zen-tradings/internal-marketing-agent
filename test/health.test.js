import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkClaudeAuth } from '../src/lib/health.js';

test('exec 成功 → ok', async () => {
  const res = await checkClaudeAuth({ execFn: async () => ({ stdout: 'pong' }) });
  assert.equal(res.ok, true);
  assert.equal(res.detail, 'pong');
});

test('exec 失败 → not ok', async () => {
  const res = await checkClaudeAuth({ execFn: async () => { throw new Error('unauthorized'); } });
  assert.equal(res.ok, false);
  assert.match(res.detail, /unauthorized/);
});
