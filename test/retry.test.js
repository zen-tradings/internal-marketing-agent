import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithRetry } from '../src/index.js';

test('失败后按 retries 重试', async () => {
  let n = 0;
  const r = await runWithRetry(async () => { n++; if (n < 3) throw new Error('x'); return 'ok'; }, 3);
  assert.equal(r, 'ok'); assert.equal(n, 3);
});
test('超过 retries 抛最后错误,且恰好调用 retries+1 次', async () => {
  let n = 0;
  await assert.rejects(() => runWithRetry(async () => { n++; throw new Error('boom'); }, 1), /boom/);
  assert.equal(n, 2, 'retries=1 应恰好尝试 2 次(首次 + 1 次重试)');
});
test('恰好在最后一次允许的尝试(第 retries+1 次)成功', async () => {
  let n = 0;
  const r = await runWithRetry(async () => { n++; if (n < 3) throw new Error('x'); return 'ok'; }, 2);
  assert.equal(r, 'ok');
  assert.equal(n, 3, 'retries=2 允许 3 次尝试,应恰好在第 3 次成功');
});
