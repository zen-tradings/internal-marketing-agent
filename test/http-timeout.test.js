import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithTimeout } from '../src/lib/http-timeout.js';

test('有界 HTTP 在底层请求挂起时按 deadline 失败并中止 signal', async () => {
  let requestSignal;
  await assert.rejects(() => fetchWithTimeout((_resource, options) => {
    requestSignal = options.signal;
    return new Promise(() => {});
  }, 'https://example.com', {}, { timeoutMs: 10, label: '测试 API' }), (error) => {
    assert.equal(error.code, 'ETIMEDOUT');
    assert.match(error.message, /测试 API 请求超时/);
    return true;
  });
  assert.equal(requestSignal.aborted, true);
});

test('有界 HTTP 保留调用方取消信号', async () => {
  const controller = new AbortController();
  const pending = fetchWithTimeout((_resource, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }), 'https://example.com', {}, { timeoutMs: 1000, signal: controller.signal });
  controller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
});
