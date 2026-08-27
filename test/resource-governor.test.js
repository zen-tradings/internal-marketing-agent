import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createResourceGovernor,
  createSemaphore,
  RESOURCE_TELEMETRY,
  retryAfterMilliseconds,
} from '../src/core/resource-governor.js';

test('资源 semaphore FIFO、限制并发且等待者可取消', async () => {
  const semaphore = createSemaphore('browser', 1);
  const release = await semaphore.acquire();
  const controller = new AbortController();
  const waiting = semaphore.acquire(controller.signal);
  assert.deepEqual(semaphore.stats(), { active: 1, waiting: 1, limit: 1 });
  controller.abort(new Error('cancelled'));
  await assert.rejects(waiting, /cancelled|取消/i);
  release();
  assert.deepEqual(semaphore.stats(), { active: 0, waiting: 0, limit: 1 });
});

test('Exa search 全局按 8 QPS 起步，OpenRouter 遵守 Retry-After 后只重试一次', async () => {
  let current = 1000;
  const delays = [];
  let openrouterCalls = 0;
  const telemetry = [];
  const governor = createResourceGovernor({
    now: () => current,
    sleep: async (ms) => { delays.push(ms); current += ms; },
    fetchFn: async (url) => {
      if (String(url).includes('openrouter.ai')) {
        openrouterCalls += 1;
        return openrouterCalls === 1
          ? { status: 429, headers: { get: () => '0.01' } }
          : { status: 200, headers: { get: () => null } };
      }
      return { status: 200, headers: { get: () => null } };
    },
  });
  await governor.fetch('https://api.exa.ai/search', {});
  await governor.fetch('https://api.exa.ai/search', {});
  await governor.fetch('https://openrouter.ai/api/v1/chat/completions', {
    [RESOURCE_TELEMETRY]: (event) => telemetry.push(event),
  });
  assert.deepEqual(delays, [125, 10]);
  assert.equal(openrouterCalls, 2);
  assert.deepEqual(telemetry, [
    { resource: 'openrouter', queueWaitMs: 0 },
    { resource: 'openrouter', queueWaitMs: 0 },
  ]);
  assert.equal(retryAfterMilliseconds('2'), 2000);
});
