import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHandler } from '../src/index.js';
import { FIXED_DRAFT_TEMPLATE_IDS } from '../src/lib/draft-template.js';

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
  const runWriter = overrides.runWriter || (async () => ({ ok: true, articlePath: '/tmp/article.md' }));
  return {
    deps: { store, runWriter, workflows, channels, config: {}, notifier },
    store, notifier, channels, publishCalls, workflows, runWriter,
  };
}

const RUN = { id: 'r1', workflowId: 'wechat', input: 'x' };

test('幂等:已有 media_id 时跳过 publish,仍标记 done 并通知成功', async () => {
  const store = makeStore({ media_id: 'EXIST', title: '既有标题' });
  const notifier = makeNotifier();
  const publishCalls = [];
  const channels = { mock: { async publish(args) { publishCalls.push(args); return { mediaId: 'SHOULD_NOT_HAPPEN' }; } } };
  let runWriterCalled = false;
  const runWriter = async () => { runWriterCalled = true; return { ok: true, articlePath: '/tmp/a.md' }; };
  const { deps } = baseDeps({ store, notifier, channels, runWriter });

  const handler = makeHandler(deps);
  await handler(RUN);

  assert.equal(publishCalls.length, 0, 'publish 不应被调用');
  assert.equal(runWriterCalled, false, 'runWriter 也不应被调用(幂等提前返回)');
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

test('真实草稿渠道未锁定登记模板时在 publish 前拦截', async () => {
  let published = false;
  const workflows = { wechat: { channel: 'wechat-draft', retries: 0 } };
  const channels = {
    'wechat-draft': {
      async publish() { published = true; return { mediaId: 'M', title: 'T' }; },
    },
  };
  const { deps, store } = baseDeps({ workflows, channels });

  await makeHandler(deps)(RUN);

  assert.equal(published, false);
  assert.equal(store._row().status, 'failed');
  assert.equal(store._row().stage, 'render');
  assert.match(store._row().error, /未锁定模板/);
});

test('真实草稿渠道只有锁定中央登记模板后才允许 publish', async () => {
  let published = false;
  const workflows = { wechat: { channel: 'wechat-draft', retries: 0 } };
  const channels = {
    'wechat-draft': {
      templateId: FIXED_DRAFT_TEMPLATE_IDS['wechat-draft'],
      templateLocked: true,
      async publish() { published = true; return { mediaId: 'M', title: 'T' }; },
    },
  };
  const { deps, store } = baseDeps({ workflows, channels });

  await makeHandler(deps)(RUN);

  assert.equal(published, true);
  assert.equal(store._row().status, 'done');
});

test('生成失败:runWriter 返回 ok:false → failed/generate,failure 调用一次,publish 不调用', async () => {
  const runWriter = async () => ({ ok: false, stderr: 'writer 挂了' });
  const { deps, store, notifier, publishCalls } = baseDeps({ runWriter });

  const handler = makeHandler(deps);
  await handler(RUN);

  assert.equal(publishCalls.length, 0);
  assert.equal(store._row().status, 'failed');
  assert.equal(store._row().stage, 'generate');
  assert.equal(notifier.failureCalls.length, 1);
  assert.equal(notifier.failureCalls[0].payload.stage, 'generate');
  assert.equal(notifier.successCalls.length, 0);
});

test('旧公网出口配置与注入钩子不再参与任务发布', async () => {
  let writerCalled = false;
  const runWriter = async () => { writerCalled = true; return { ok: true, articlePath: '/tmp/a.md' }; };
  const { deps, store, notifier, publishCalls } = baseDeps({ runWriter });
  deps.config = { egress: { enabled: true } };
  deps.assertEgress = async () => { throw new Error('旧钩子不应调用'); };
  deps.waitForEgress = async () => { throw new Error('旧钩子不应调用'); };

  await makeHandler(deps)(RUN);

  assert.equal(writerCalled, true);
  assert.equal(publishCalls.length, 1);
  assert.equal(store._row().status, 'done');
  assert.equal(notifier.failureCalls.length, 0);
  assert.equal(notifier.successCalls.length, 1);
});

test('重试后成功:workflow.retries=1,首次抛错次次成功 → 最终 done 且 success 只调用一次', async () => {
  let n = 0;
  const runWriter = async () => {
    n++;
    if (n === 1) throw new Error('瞬时故障');
    return { ok: true, articlePath: '/tmp/a.md' };
  };
  const workflows = { wechat: { channel: 'mock', retries: 1 } };
  const { deps, store, notifier, publishCalls } = baseDeps({ runWriter, workflows });

  const handler = makeHandler(deps);
  await handler(RUN);

  assert.equal(n, 2, 'runWriter 应被调用两次(首次失败+重试成功)');
  assert.equal(publishCalls.length, 1, 'publish 只应在最终成功的那次调用');
  assert.equal(store._row().status, 'done');
  assert.equal(notifier.successCalls.length, 1, '不应因重试而重复通知成功');
  assert.equal(notifier.failureCalls.length, 0);
});

test('成功通知失败不反向把已发布任务改成 failed', async () => {
  const notifier = {
    async success() { throw new Error('Slack channel_required'); },
    async failure() { throw new Error('Slack channel_required'); },
  };
  const { deps, store } = baseDeps({ notifier });
  await makeHandler(deps)(RUN);
  assert.equal(store._row().status, 'done');
  assert.equal(store._row().media_id, 'M');
});

test('损坏 notify_json 被标记 config failed,不会留成 queued 毒任务', async () => {
  const store = makeStore({ notify_json: '{bad json' });
  const { deps } = baseDeps({ store });
  await makeHandler(deps)(RUN);
  assert.equal(store._row().status, 'failed');
  assert.equal(store._row().stage, 'config');
});

test('服务任务使用 run 级工作目录隔离同工作流并发', async () => {
  let actualWorkDir;
  const workflows = { wechat: { id: 'wechat', workDir: '/tmp/zen-base', channel: 'mock', retries: 0 } };
  const runWriter = async ({ workflow }) => {
    actualWorkDir = workflow.workDir;
    return { ok: true, articlePath: `${workflow.workDir}/article.md` };
  };
  const { deps } = baseDeps({ workflows, runWriter });
  await makeHandler(deps)(RUN);
  assert.match(actualWorkDir, /^\/tmp\/zen-base\/runs\/r1-/);
});
