import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithRetry } from '../src/index.js';
import { createTaskCancelledError } from '../src/lib/task-cancellation.js';
import { isRetryableTranslationError } from '../src/workflows/translate.js';

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

test('工作流重试过滤器会立即停止确定性错误，只重试网络与服务端瞬时错误', async () => {
  let attempts = 0;
  await assert.rejects(() => runWithRetry(
    async () => {
      attempts += 1;
      throw new Error('Slack PDF 下载返回了登录页面而不是文件');
    },
    3,
    0,
    undefined,
    undefined,
    isRetryableTranslationError,
  ), /Slack PDF/);
  assert.equal(attempts, 1);
  assert.equal(isRetryableTranslationError(new Error('Datalab HTTP 503')), true);
  assert.equal(isRetryableTranslationError(new Error('fetch failed: ECONNRESET')), true);
  assert.equal(isRetryableTranslationError(new Error('OpenRouter completion timed out')), true);
  assert.equal(isRetryableTranslationError(new Error('PDF 页数超过上限:121/120')), false);
});

test('runWithRetry 可按工作流配置在重试间等待', async () => {
  const waits = [];
  let n = 0;
  const result = await runWithRetry(
    async () => { n++; if (n < 3) throw new Error('网络抖动'); return 'ok'; },
    2,
    15000,
    async (ms) => waits.push(ms),
  );
  assert.equal(result, 'ok');
  assert.deepEqual(waits, [15000, 15000]);
});

test('取消信号会立即打断重试等待且不再发起下一次尝试', async () => {
  const controller = new AbortController();
  let attempts = 0;
  let sleeping;
  const enteredSleep = new Promise((resolve) => { sleeping = resolve; });
  const pending = runWithRetry(
    async () => { attempts++; throw new Error('网络抖动'); },
    3,
    15000,
    () => {
      sleeping();
      return new Promise(() => {});
    },
    controller.signal,
  );
  await enteredSleep;
  controller.abort(createTaskCancelledError('stop retry'));
  await assert.rejects(pending, (error) => error?.code === 'TASK_CANCELLED');
  assert.equal(attempts, 1);
});
