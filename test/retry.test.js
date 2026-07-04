import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithRetry } from '../src/index.js';

test('失败后按 retries 重试', async () => {
  let n = 0;
  const r = await runWithRetry(async () => { n++; if (n < 3) throw new Error('x'); return 'ok'; }, 3);
  assert.equal(r, 'ok'); assert.equal(n, 3);
});
test('超过 retries 抛最后错误', async () => {
  await assert.rejects(() => runWithRetry(async () => { throw new Error('boom'); }, 1), /boom/);
});
