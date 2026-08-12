import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeHandler } from '../src/index.js';
import { FIXED_DRAFT_TEMPLATE_IDS } from '../src/lib/draft-template.js';
import { createTaskCancelledError } from '../src/lib/task-cancellation.js';

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
    setOutputKind(id, outputKind) { row = { ...row, output_kind: outputKind }; },
    setSlackResponseTs(id, responseTs) { row = { ...row, slack_response_ts: responseTs }; },
  };
}

function makeNotifier() {
  const successCalls = [];
  const failureCalls = [];
  const cancelledCalls = [];
  const needsInputCalls = [];
  const warnCalls = [];
  const respondCalls = [];
  return {
    successCalls, failureCalls, cancelledCalls, needsInputCalls, warnCalls, respondCalls,
    async success(notify, payload) { successCalls.push({ notify, payload }); },
    async failure(notify, payload) { failureCalls.push({ notify, payload }); },
    async cancelled(notify, payload) { cancelledCalls.push({ notify, payload }); },
    async needsInput(notify, payload) { needsInputCalls.push({ notify, payload }); },
    async warn(notify, message) { warnCalls.push({ notify, message }); },
    async respond(notify, payload) { respondCalls.push({ notify, payload }); return { responseTs: 'reply-ts' }; },
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

test('QDII 直接查询回复 Slack 后 done，media_id 保持为空', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qdii-handler-'));
  const store = makeStore({
    notify_json: JSON.stringify({ channel: 'C1', ts: '1.1', qdiiPlan: { qdii: true, codes: ['513100'], destination: 'slack', language: 'en' } }),
  });
  const notifier = makeNotifier();
  const { deps } = baseDeps({
    store,
    notifier,
    workflows: { qdii: { id: 'qdii', mode: 'qdii-query', workDir: root, retries: 0 } },
  });
  deps.runQdiiQuery = async () => ({
    taskPlan: { language: 'en' },
    query: { language: 'en' },
    results: [{
      code: '513100', fundName: 'NASDAQ 100 QDII', reportPeriod: { key: '2026-Q1', type: 'Q1' }, disclosureScope: 'top10',
      source: { provider: 'Eastmoney / AKShare', url: 'https://fundf10.eastmoney.com/ccmx_513100.html' }, freshness: { status: 'current' }, warnings: [],
      holdings: [{ rank: 1, securityCode: 'AAPL', securityName: 'Apple', navRatioPct: 8.2, marketValue: 100, marketValueUnit: '10k CNY' }],
    }],
    failures: [],
  });

  await makeHandler(deps)({ id: 'qdii-run', workflowId: 'qdii', input: '513100 holdings' });

  assert.equal(store._row().status, 'done');
  assert.equal(store._row().output_kind, 'slack-response');
  assert.equal(store._row().slack_response_ts, 'reply-ts');
  assert.equal(store._row().media_id, undefined);
  assert.equal(notifier.respondCalls.length, 1);
  assert.equal(notifier.successCalls.length, 0);
});

test('QDII Newsletter 把结构化数据注入 writer 后仍只创建草稿', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qdii-draft-handler-'));
  const store = makeStore({
    notify_json: JSON.stringify({ channel: 'C1', ts: '1.1', qdiiPlan: { qdii: true, codes: ['513100'], destination: 'newsletter', language: 'en', dualReply: false } }),
  });
  let capturedContext;
  const runWriter = async ({ taskContext }) => {
    capturedContext = taskContext;
    return { ok: true, articlePath: '/tmp/qdii-newsletter.md', sources: [] };
  };
  const { deps, publishCalls } = baseDeps({
    store,
    runWriter,
    workflows: { email: { id: 'email', mode: 'newsletter', workDir: root, channel: 'mock', retries: 0 } },
  });
  deps.runQdiiQuery = async () => ({
    query: { language: 'en', fundCodes: ['513100'] }, artifactPath: '/tmp/qdii-result.json', failures: [],
    results: [{
      code: '513100', fundName: 'NASDAQ 100 QDII', reportPeriod: { key: '2026-Q1', type: 'Q1', end: '2026-03-31' }, disclosureScope: 'top10',
      source: { provider: 'Eastmoney / AKShare', url: 'https://fundf10.eastmoney.com/ccmx_513100.html' }, freshness: { status: 'current' }, warnings: [],
      holdings: [{ rank: 1, securityCode: 'AAPL', securityName: 'Apple', navRatioPct: 8.2, marketValue: 100, marketValueUnit: '10k CNY' }],
    }],
  });

  await makeHandler(deps)({ id: 'email-qdii', workflowId: 'email', input: 'Use fund 513100 holdings for a newsletter' });

  assert.equal(store._row().status, 'done');
  assert.equal(store._row().output_kind, 'draft');
  assert.equal(publishCalls.length, 1);
  assert.equal(capturedContext.qdiiSources.length, 1);
  assert.match(capturedContext.qdiiSources[0].text, /AAPL/);
});

test('QDII 双输出重试保留已发 Slack 摘要，只继续创建草稿', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qdii-dual-handler-'));
  const store = makeStore({
    slack_response_ts: 'existing-reply',
    notify_json: JSON.stringify({ channel: 'C1', ts: '1.1', qdiiPlan: { qdii: true, codes: ['513100'], destination: 'newsletter', language: 'en', dualReply: true } }),
  });
  const notifier = makeNotifier();
  const { deps, publishCalls } = baseDeps({
    store,
    notifier,
    workflows: { email: { id: 'email', mode: 'newsletter', workDir: root, channel: 'mock', retries: 0 } },
  });
  deps.runQdiiQuery = async () => ({
    query: { language: 'en', fundCodes: ['513100'] }, failures: [],
    results: [{
      code: '513100', fundName: 'NASDAQ 100 QDII', reportPeriod: { key: '2026-Q1', type: 'Q1', end: '2026-03-31' }, disclosureScope: 'top10',
      source: { provider: 'Eastmoney / AKShare', url: 'https://fundf10.eastmoney.com/ccmx_513100.html' }, freshness: { status: 'current' }, warnings: [],
      holdings: [{ rank: 1, securityCode: 'AAPL', securityName: 'Apple', navRatioPct: 8.2, marketValue: 100, marketValueUnit: '10k CNY' }],
    }],
  });

  await makeHandler(deps)({ id: 'email-qdii-dual', workflowId: 'email', input: 'Reply and create a Newsletter draft for 513100 holdings' });

  assert.equal(notifier.respondCalls.length, 0);
  assert.equal(publishCalls.length, 1);
  assert.equal(store._row().slack_response_ts, 'existing-reply');
  assert.equal(store._row().output_kind, 'draft-with-slack-summary');
  assert.equal(store._row().media_id, 'M');
});

test('macro 高风险推断保留时发 Slack 提醒但不阻断草稿', async () => {
  const workflows = { macro: { id: 'macro', mode: 'analysis', channel: 'mock', retries: 0 } };
  const runWriter = async () => ({
    ok: true,
    articlePath: '/tmp/macro.md',
    warnings: ['事实审计已保留待人工复核(medium/high/core):美元可能维持偏强'],
  });
  const { deps, store, notifier, publishCalls } = baseDeps({ workflows, runWriter });

  await makeHandler(deps)({ id: 'macro-1', workflowId: 'macro', input: '分析美元路径' });

  assert.equal(publishCalls.length, 1);
  assert.equal(store._row().status, 'done');
  assert.equal(notifier.warnCalls.length, 1);
  assert.match(notifier.warnCalls[0].message, /高风险推断\/表述已保留，不阻断草稿/);
  assert.equal(notifier.successCalls.length, 1);
});

test('Opening Digest 可发送降级只写 trace，不发送 Slack warning', async () => {
  const workflows = {
    'opening-digest': {
      id: 'opening-digest', mode: 'newsletter', channel: 'customerio-opening-digest', retries: 0,
    },
  };
  const channels = {
    'customerio-opening-digest': {
      templateId: FIXED_DRAFT_TEMPLATE_IDS['customerio-opening-digest'],
      templateLocked: true,
      async publish() { return { mediaId: 'customerio-newsletter:1', title: 'Zen Opening Digest' }; },
    },
  };
  const runWriter = async () => ({
    ok: true,
    articlePath: '/tmp/opening.md',
    contentMode: 'data-only',
    warnings: ['研究失败，已发送数据版', '行情缺失'],
  });
  const { deps, store, notifier } = baseDeps({ workflows, channels, runWriter });

  await makeHandler(deps)({ id: 'opening-soft', workflowId: 'opening-digest', input: 'opening', source: 'cron' });

  assert.equal(store._row().status, 'done');
  assert.equal(notifier.warnCalls.length, 0);
  assert.equal(notifier.failureCalls.length, 0);
  assert.equal(notifier.successCalls.length, 1);
});

test('Opening Digest 微信异常不改变邮件 done，成功通知后另发精确 warning', async () => {
  const workflows = {
    'opening-digest': {
      id: 'opening-digest', mode: 'newsletter', channel: 'customerio-opening-digest', retries: 0,
    },
  };
  const channels = {
    'customerio-opening-digest': {
      templateId: FIXED_DRAFT_TEMPLATE_IDS['customerio-opening-digest'],
      templateLocked: true,
      async publish() {
        return {
          mediaId: 'customerio-newsletter:8', title: 'Zen Opening Digest',
          deliveryWarnings: ['Opening Digest 邮件已成功，但微信草稿第三次回读仍不一致。Media ID:wx-8；OIC NVDA 字段 6 缺失'],
        };
      },
    },
  };
  const runWriter = async () => ({ ok: true, articlePath: '/tmp/opening.md' });
  const { deps, store, notifier } = baseDeps({ workflows, channels, runWriter });
  await makeHandler(deps)({ id: 'opening-wechat-warning', workflowId: 'opening-digest', input: 'opening', source: 'cron' });
  assert.equal(store._row().status, 'done');
  assert.equal(store._row().media_id, 'customerio-newsletter:8');
  assert.equal(notifier.successCalls.length, 1);
  assert.equal(notifier.warnCalls.length, 1);
  assert.match(notifier.warnCalls[0].message, /wx-8.*NVDA 字段 6/);
  assert.equal(notifier.failureCalls.length, 0);
});

test('Opening Digest 硬失败发送 Slack failure，但不发送 warning', async () => {
  const workflows = {
    'opening-digest': {
      id: 'opening-digest', mode: 'newsletter', channel: 'customerio-opening-digest', retries: 0,
    },
  };
  const channels = {
    'customerio-opening-digest': {
      templateId: FIXED_DRAFT_TEMPLATE_IDS['customerio-opening-digest'],
      templateLocked: true,
      async publish() { const error = new Error('segment 名称不是 test2'); error.stage = 'publish'; throw error; },
    },
  };
  const { deps, store, notifier } = baseDeps({ workflows, channels });

  await makeHandler(deps)({ id: 'opening-hard', workflowId: 'opening-digest', input: 'opening', source: 'cron' });

  assert.equal(store._row().status, 'failed');
  assert.equal(notifier.warnCalls.length, 0);
  assert.equal(notifier.failureCalls.length, 1);
  assert.match(notifier.failureCalls[0].payload.error, /不是 test2/);
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

test('直译确定性 PDF 权限错误不会重复运行或重复发送进度', async () => {
  let attempts = 0;
  let progressCalls = 0;
  const runWriter = async ({ onProgress }) => {
    attempts += 1;
    await onProgress({ stage: 'source', message: '正在提取原文结构' });
    return {
      ok: false,
      stderr: 'Slack PDF 下载返回了登录页面而不是文件。请添加 files:read 并重新安装 App。',
    };
  };
  const workflows = {
    translate: {
      id: 'translate',
      mode: 'translation',
      workDir: '/tmp/zen-handler-test',
      channel: 'mock',
      retries: 3,
      retryDelayMs: 0,
      shouldRetry: (error) => /网络|超时|HTTP 5\d\d/.test(error?.message || ''),
    },
  };
  const notifier = makeNotifier();
  notifier.progress = async () => { progressCalls += 1; };
  const { deps, store, publishCalls } = baseDeps({ runWriter, workflows, notifier });

  await makeHandler(deps)({ id: 'pdf-run', workflowId: 'translate', input: 'translate attachment' });

  assert.equal(attempts, 1);
  assert.equal(progressCalls, 1);
  assert.equal(publishCalls.length, 0);
  assert.equal(store._row().status, 'failed');
  assert.match(store._row().error, /files:read/);
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

test('Slack 取消生成中任务后标记 cancelled 并删除独立运行目录', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-handler-cancel-'));
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  let actualWorkDir;
  const workflows = { wechat: { id: 'wechat', workDir: baseDir, channel: 'mock', retries: 0 } };
  const runWriter = async ({ workflow, signal }) => {
    actualWorkDir = workflow.workDir;
    fs.mkdirSync(actualWorkDir, { recursive: true });
    fs.writeFileSync(path.join(actualWorkDir, 'partial.tmp'), 'unfinished');
    started();
    await new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const { deps, store, notifier, publishCalls } = baseDeps({ workflows, runWriter });
  const controller = new AbortController();
  const pending = makeHandler(deps)(RUN, { signal: controller.signal, setPhase() {} });
  await entered;
  controller.abort(createTaskCancelledError('Slack stop'));
  await pending;

  assert.equal(store._row().status, 'cancelled');
  assert.equal(store._row().stage, 'cancelled');
  assert.equal(fs.existsSync(actualWorkDir), false);
  assert.equal(publishCalls.length, 0);
  assert.equal(notifier.failureCalls.length, 0);
  assert.equal(notifier.cancelledCalls.length, 1);
  assert.equal(notifier.cancelledCalls[0].payload.cleaned, true);
});

test('分析核心冲突转为 needs_input，保留研究轨迹并清理其它半成品，不进入发布', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-handler-needs-input-'));
  let actualWorkDir;
  const clarificationCalls = [];
  const store = makeStore({
    notify_json: JSON.stringify({
      channel: 'C1',
      ts: '1.0',
      user: 'U1',
      threadKey: 'C1:1.0',
      promptRevision: 2,
    }),
  });
  store.setSlackClarification = (threadKey, payload) => clarificationCalls.push({ threadKey, payload });
  const workflows = { wechat: { id: 'wechat', mode: 'analysis', workDir: baseDir, channel: 'mock', retries: 0 } };
  const runWriter = async ({ workflow, taskContext }) => {
    actualWorkDir = workflow.workDir;
    assert.equal(taskContext.promptRevision, 2);
    fs.mkdirSync(actualWorkDir, { recursive: true });
    fs.writeFileSync(path.join(actualWorkDir, 'research-trace.json'), '{"needsInput":true}\n');
    fs.writeFileSync(path.join(actualWorkDir, 'article.md'), 'partial');
    return {
      ok: false,
      needsInput: true,
      stderr: '请确认 Opus 5',
      clarification: { question: '请确认 Opus 5', conflicts: [] },
    };
  };
  const { deps, notifier, publishCalls } = baseDeps({ store, workflows, runWriter });

  await makeHandler(deps)(RUN);

  assert.equal(store._row().status, 'needs_input');
  assert.equal(store._row().stage, 'needs_input');
  assert.equal(publishCalls.length, 0);
  assert.equal(notifier.failureCalls.length, 0);
  assert.equal(notifier.needsInputCalls.length, 1);
  assert.equal(clarificationCalls.length, 1);
  assert.equal(clarificationCalls[0].threadKey, 'C1:1.0');
  assert.equal(fs.existsSync(path.join(actualWorkDir, 'research-trace.json')), true);
  assert.equal(fs.existsSync(path.join(actualWorkDir, 'article.md')), false);
});
