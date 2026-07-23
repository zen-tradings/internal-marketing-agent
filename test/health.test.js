import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthPayload } from '../src/lib/health.js';

const NOW = () => new Date('2026-07-21T12:00:00.000Z');

test('health 保持存活而 ready 在 Slack 断线或关闭时失败', () => {
  const status = () => ({ ready: false, queue: { active: 1 }, slackConnected: false });
  assert.equal(healthPayload('/health', status, NOW).ok, true);
  const ready = healthPayload('/ready', status, NOW);
  assert.equal(ready.ok, false);
  assert.equal(ready.ready, undefined);
  assert.equal(ready.at, '2026-07-21T12:00:00.000Z');
});

test('health 状态读取异常返回失败但不泄漏堆栈', () => {
  const payload = healthPayload('/health', () => { throw new Error('status unavailable'); }, NOW);
  assert.deepEqual(payload, {
    ok: false,
    error: 'status unavailable',
    at: '2026-07-21T12:00:00.000Z',
  });
});
