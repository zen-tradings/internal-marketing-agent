import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeFetchError, isTransientNetworkError, fetchWithRetry } from '../src/core/runner.js';

const noSleep = () => Promise.resolve();

test('isTransientNetworkError 识别瞬时网络错误', () => {
  const e = new TypeError('fetch failed');
  e.cause = { code: 'ECONNRESET' };
  assert.equal(isTransientNetworkError(e), true);
  const ab = new Error('aborted'); ab.name = 'AbortError';
  assert.equal(isTransientNetworkError(ab), false); // 主动超时不重试
  assert.equal(isTransientNetworkError(new Error('bad key')), false);
  assert.equal(isTransientNetworkError(null), false);
});

test('describeFetchError 展开 cause', () => {
  const e = new TypeError('fetch failed');
  e.cause = { code: 'ECONNRESET' };
  assert.match(describeFetchError(e), /fetch failed \(cause: ECONNRESET\)/);
});

test('fetchWithRetry 瞬时失败两次后第三次成功', async () => {
  let n = 0;
  const fetchFn = async () => {
    n++;
    if (n < 3) { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNRESET' }; throw e; }
    return { ok: true, marker: 'done' };
  };
  const res = await fetchWithRetry(fetchFn, 'https://x', {}, { sleep: noSleep });
  assert.equal(res.marker, 'done');
  assert.equal(n, 3);
});

test('fetchWithRetry 瞬时错误耗尽重试后抛带 cause 的错误', async () => {
  let n = 0;
  const fetchFn = async () => { n++; const e = new TypeError('fetch failed'); e.cause = { code: 'ETIMEDOUT' }; throw e; };
  await assert.rejects(
    () => fetchWithRetry(fetchFn, 'https://x', {}, { attempts: 3, sleep: noSleep }),
    (err) => { assert.match(err.message, /重试 3 次后放弃/); assert.match(err.message, /ETIMEDOUT/); return true; },
  );
  assert.equal(n, 3);
});

test('fetchWithRetry 非瞬时错误(如 AbortError)原样抛出、不重试', async () => {
  let n = 0;
  const fetchFn = async () => { n++; const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  await assert.rejects(() => fetchWithRetry(fetchFn, 'https://x', {}, { sleep: noSleep }), (err) => err.name === 'AbortError');
  assert.equal(n, 1);
});
