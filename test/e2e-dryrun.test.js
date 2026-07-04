import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/core/store.js';
import { createQueue } from '../src/core/queue.js';
import { makeHandler } from '../src/index.js';
import mockChannel from '../src/channels/mock.js';

// 装配级 dry-run 测试:走真实 makeHandler(而不是只测 queue),
// 验证 HUB_DRY_RUN 时即使 workflow 声明的是 'wechat-draft' 渠道,
// 实际发布也会被强制改道 mock,全程不碰真实网络/Claude/微信。

async function waitUntil(fn, timeoutMs = 1000, stepMs = 5) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitUntil 超时');
}

test('dry-run:HUB_DRY_RUN 强制走 mock 渠道,任务落 done 且拿到 mock media_id', async () => {
  const prevDryRun = process.env.HUB_DRY_RUN;
  process.env.HUB_DRY_RUN = '1';
  try {
    const store = openStore(':memory:');

    let realChannelCalled = false;
    const channels = {
      mock: mockChannel,
      'wechat-draft': {
        async publish() {
          realChannelCalled = true;
          throw new Error('dry-run 下不应调用真实渠道');
        },
      },
    };

    // workflow 声明的是真实渠道 'wechat-draft',dry-run 应把它换成 mock。
    const workflows = { wechat: { channel: 'wechat-draft', retries: 0 } };

    let runClaudeCalled = false;
    const runClaude = async () => {
      runClaudeCalled = true;
      return { ok: true, articlePath: '/tmp/fake-article.md' };
    };

    const successCalls = [];
    const failureCalls = [];
    const notifier = {
      async success(notify, payload) { successCalls.push(payload); },
      async failure(notify, payload) { failureCalls.push(payload); },
    };

    const handler = makeHandler({ store, runClaude, workflows, channels, config: {}, notifier });
    const queue = createQueue({ store, maxConcurrency: 1, handler });

    queue.enqueue({ id: 'e1', workflowId: 'wechat', source: 'slack', input: 'x', notify: {} });

    await waitUntil(() => store.getRun('e1').status !== 'queued' && store.getRun('e1').status !== 'running');

    const row = store.getRun('e1');
    assert.equal(row.status, 'done');
    assert.equal(row.media_id, 'MOCK');
    assert.equal(row.title, 'MOCK');
    assert.equal(runClaudeCalled, true, 'runClaude 应被调用');
    assert.equal(realChannelCalled, false, 'dry-run 下不应调用真实渠道');
    assert.equal(successCalls.length, 1);
    assert.equal(failureCalls.length, 0);
  } finally {
    if (prevDryRun === undefined) delete process.env.HUB_DRY_RUN;
    else process.env.HUB_DRY_RUN = prevDryRun;
  }
});
