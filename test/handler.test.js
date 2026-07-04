import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHandler } from '../src/index.js';

// 极简 store 桩:内存持有单条 run 记录,记录 setStatus 调用序列供断言。
function makeStore(initial) {
  let row = { notify_json: '{}', ...initial };
  const statusCalls = [];
  return {
    _row: () => row,
    _statusCalls: statusCalls,
    getRun() { return { ...row }; },
    setStatus(id, status, patch = {}) {
      statusCalls.push({ status, patch });
      row = { ...row, status, ...patch };
    },
    setMediaId(id, mediaId, title) {
      row = { ...row, media_id: mediaId, title: title ?? row.title };
    },
  };
}

function makeNotifier() {
  const successCalls = [];
  const failureCalls = [];
  return {
    successCalls, failureCalls,
    async success(notify, payload) { successCalls.push({ notify, payload }); },
    async failure(notify, payload) { failureCalls.push({ notify, payload }); },
  };
}

function baseDeps(overrides = {}) {
  const store = overrides.store || makeStore({});
  const notifier = overrides.notifier || makeNotifier();
  const publishCalls = [];
  const channels = overrides.channels || {
    mock: {
      async publish(args) { publishCalls.push(args); return { mediaId: 'M', title: 'T' }; },
    },
  };
  const workflows = overrides.workflows || { wechat: { channel: 'mock', retries: 0 } };
  const runClaude = overrides.runClaude || (async () => ({ ok: true, articlePath: '/tmp/article.md' }));
  return {
    deps: { store, runClaude, workflows, channels, config: {}, notifier },
    store, notifier, channels, publishCalls, workflows, runClaude,
  };
}

const RUN = { id: 'r1', workflowId: 'wechat', input: 'x' };

test('幂等:已有 media_id 时跳过 publish,仍标记 done 并通知成功', async () => {
  const store = makeStore({ media_id: 'EXIST', title: '既有标题' });
  const notifier = makeNotifier();
  const publishCalls = [];
  const channels = { mock: { async publish(args) { publishCalls.push(args); return { mediaId: 'SHOULD_NOT_HAPPEN' }; } } };
  let runClaudeCalled = false;
  const runClaude = async () => { runClaudeCalled = true; return { ok: true, articlePath: '/tmp/a.md' }; };
  const { deps } = baseDeps({ store, notifier, channels, runClaude });

  const handler = makeHandler(deps);
  await handler(RUN);

  assert.equal(publishCalls.length, 0, 'publish 不应被调用');
  assert.equal(runClaudeCalled, false, 'runClaude 也不应被调用(幂等提前返回)');
  assert.equal(store._row().status, 'done');
  assert.equal(notifier.successCalls.length, 1);
  assert.equal(notifier.successCalls[0].payload.mediaId, 'EXIST');
  assert.equal(notifier.failureCalls.length, 0);
});

test('happy path:生成 + 发布成功 → done,success 调用一次,failure 不调用', async () => {
  const { deps, store, notifier, publishCalls } = baseDeps();

  const handler = makeHandler(deps);
  await handler(RUN);

  assert.equal(publishCalls.length, 1);
  assert.equal(store._row().status, 'done');
  assert.equal(store._row().media_id, 'M');
  assert.equal(notifier.successCalls.length, 1);
  assert.equal(notifier.failureCalls.length, 0);
});

test('生成失败:runClaude 返回 ok:false → failed/generate,failure 调用一次,publish 不调用', async () => {
  const runClaude = async () => ({ ok: false, stderr: 'claude 挂了' });
  const { deps, store, notifier, publishCalls } = baseDeps({ runClaude });

  const handler = makeHandler(deps);
  await handler(RUN);

  assert.equal(publishCalls.length, 0);
  assert.equal(store._row().status, 'failed');
  assert.equal(store._row().stage, 'generate');
  assert.equal(notifier.failureCalls.length, 1);
  assert.equal(notifier.failureCalls[0].payload.stage, 'generate');
  assert.equal(notifier.successCalls.length, 0);
});

test('重试后成功:workflow.retries=1,首次抛错次次成功 → 最终 done 且 success 只调用一次', async () => {
  let n = 0;
  const runClaude = async () => {
    n++;
    if (n === 1) throw new Error('瞬时故障');
    return { ok: true, articlePath: '/tmp/a.md' };
  };
  const workflows = { wechat: { channel: 'mock', retries: 1 } };
  const { deps, store, notifier, publishCalls } = baseDeps({ runClaude, workflows });

  const handler = makeHandler(deps);
  await handler(RUN);

  assert.equal(n, 2, 'runClaude 应被调用两次(首次失败+重试成功)');
  assert.equal(publishCalls.length, 1, 'publish 只应在最终成功的那次调用');
  assert.equal(store._row().status, 'done');
  assert.equal(notifier.successCalls.length, 1, '不应因重试而重复通知成功');
  assert.equal(notifier.failureCalls.length, 0);
});
