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

// 模拟网络 hang:fetchFn 永不 resolve/reject,只在传入的 signal 被 abort 时才拒绝(与真实
// undici fetch 行为一致)。用于验证 fetchWithRetry 的 opts.timeoutMs 能把"永久卡住"转成
// AbortError,而不是让调用方永远挂起。
function hangingFetchFn() {
  let calls = 0;
  const fn = (url, options) => {
    calls++;
    return new Promise((resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {
        const e = new Error('The operation was aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
  };
  return { fn, getCalls: () => calls };
}

test('fetchWithRetry: timeoutMs 触发后网络 hang 请求变为 AbortError 且不重试(单次尝试)', async () => {
  const { fn, getCalls } = hangingFetchFn();
  await assert.rejects(
    () => fetchWithRetry(fn, 'https://x', {}, { timeoutMs: 20, sleep: noSleep }),
    (err) => { assert.equal(err.name, 'AbortError'); return true; },
  );
  assert.equal(getCalls(), 1); // AbortError 不算瞬时网络错误,只尝试一次就向上抛出
});

test('fetchWithRetry: timeoutMs 每次尝试使用独立的 AbortController(不复用已 abort 的 signal)', async () => {
  // 第一次调用真正 hang 到超时,第二次(若发生)应拿到全新、未 abort 的 signal。
  let call = 0;
  const signals = [];
  const fetchFn = (url, options) => {
    call++;
    signals.push(options.signal);
    if (call === 1) {
      // 第一次:瞬时网络错误(非超时),触发重试
      return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
    }
    // 第二次:立即成功,顺带断言这次拿到的 signal 是全新的、未被 abort 过的
    assert.notEqual(signals[1], signals[0]);
    assert.equal(signals[1].aborted, false);
    return Promise.resolve({ ok: true, marker: 'done' });
  };
  const res = await fetchWithRetry(fetchFn, 'https://x', {}, { timeoutMs: 5000, sleep: noSleep });
  assert.equal(res.marker, 'done');
  assert.equal(call, 2);
});
