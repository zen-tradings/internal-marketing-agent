import dotenv from 'dotenv';
import fs from 'node:fs';
import { loadConfig } from './config/index.js';
import { openStore } from './core/store.js';
import { createQueue } from './core/queue.js';
import { runWriter } from './core/runner.js';
import { createNotifier } from './core/notifier.js';
import { registerSlack } from './triggers/slack.js';
import { registerCron } from './triggers/cron.js';
import { isTransientSocketModeError } from './lib/slack-resilience.js';
import { runWorkDir, workflowForRun } from './lib/run-workdir.js';
import { startHealthServer, stopHealthServer } from './lib/health.js';
import { assertFixedDraftTemplate } from './lib/draft-template.js';
import {
  cancellationErrorFromSignal,
  isTaskCancelled,
  throwIfTaskCancelled,
} from './lib/task-cancellation.js';
import wechatWorkflow from './workflows/wechat.js';
import earningsWorkflow from './workflows/earnings.js';
import sectorWorkflow from './workflows/sector.js';
import morningWorkflow from './workflows/morning.js';
import translateWorkflow from './workflows/translate.js';
import companyWorkflow from './workflows/company.js';
import emailWorkflow from './workflows/email.js';
import mockChannel from './channels/mock.js';
import wechatDraft from './channels/wechat-draft.js';
import customerioDraft from './channels/customerio-draft.js';

dotenv.config({ override: true });

const WORKFLOWS = {
  wechat: wechatWorkflow,
  earnings: earningsWorkflow,
  sector: sectorWorkflow,
  morning: morningWorkflow,
  translate: translateWorkflow,
  company: companyWorkflow,
  email: emailWorkflow,
};
const CHANNELS = { mock: mockChannel, 'wechat-draft': wechatDraft, 'customerio-draft': customerioDraft };

export async function runWithRetry(
  fn,
  retries = 0,
  retryDelayMs = 0,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  signal,
  shouldRetry,
) {
  let last;
  for (let i = 0; i <= retries; i++) {
    throwIfTaskCancelled(signal);
    try { return await fn(); }
    catch (e) {
      if (isTaskCancelled(e, signal)) throw cancellationErrorFromSignal(signal);
      last = e;
      const retryAllowed = typeof shouldRetry !== 'function' || shouldRetry(e);
      if (i < retries && retryAllowed) {
        console.error(`[hub] 执行失败,准备第 ${i + 2}/${retries + 1} 次尝试:${e?.message || e}`);
        if (retryDelayMs > 0) await sleepWithCancellation(sleep, retryDelayMs, signal);
      } else {
        break;
      }
    }
  }
  throw last;
}

// 队列处理器工厂,便于注入 stub 做单测(store/runWriter/channels 均可替换)。
// 注意:`deps` 对象本身(而非解构出的局部变量)被闭包持有,notifier 字段在
// start() 中是稍后才赋值的(registerSlack 之后)——沿用原来 `let notifier` 的
// "调用时才读取当前值" 语义,不在这里提前修复这个时序,只是原样保留。
export function makeHandler(deps) {
  const { store, runWriter, workflows, channels, config } = deps;
  return async function handler(run, { signal, setPhase = () => {} } = {}) {
    let notify = {};
    let writerAttempt = 0;
    let runtimeWorkflow;
    try {
      throwIfTaskCancelled(signal);
      const persisted = store.getRun(run.id);
      if (!persisted) throw stageError('config', `任务记录不存在:${run.id}`);
      try {
        notify = JSON.parse(persisted.notify_json || '{}');
        if (!notify || typeof notify !== 'object' || Array.isArray(notify)) throw new Error('notify_json 不是对象');
      } catch (error) {
        throw stageError('config', `任务通知配置损坏:${error.message}`);
      }
      const wf = workflows[run.workflowId];
      if (!wf) throw stageError('config', `未知工作流:${run.workflowId}`);
      runtimeWorkflow = wf.workDir ? workflowForRun(wf, run.id) : wf;
      store.setStatus(run.id, 'running', { startedAt: Date.now() });
      setPhase('generate');

      const { title, mediaId, sourceCount, completeness } = await runWithRetry(async () => {
        throwIfTaskCancelled(signal);
        // 发布幂等:已有 media_id 说明上一轮(重试循环内或重启后重投)已经发布成功过,
        // 跳过重新生成/发布,避免产生重复草稿。
        const existing = store.getRun(run.id);
        if (existing.media_id) {
          setPhase('published');
          return { title: existing.title, mediaId: existing.media_id };
        }

        const resumeFromCheckpoint = Boolean(run.restored || writerAttempt > 0);
        writerAttempt += 1;
        const res = await runWriter({
          workflow: runtimeWorkflow,
          input: run.input,
          config,
          taskContext: {
            promptRevision: notify.promptRevision,
            threadKey: notify.threadKey,
            attachments: notify.attachments,
            resolvedClarification: notify.resolvedClarification,
          },
          onProgress: (progress) => notifyBestEffort(deps.notifier, 'progress', notify, progress),
          resumeFromCheckpoint,
          signal,
        });
        if (res.needsInput) {
          const err = stageError('needs_input', res.stderr || res.clarification?.question || '任务需要用户确认');
          err.needsInput = true;
          err.details = res.clarification || { question: err.message };
          throw err;
        }
        if (!res.ok) { const err = new Error(res.stderr); err.stage = 'generate'; throw err; }
        throwIfTaskCancelled(signal);
        if (Array.isArray(res.warnings) && res.warnings.length) {
          await notifyBestEffort(
            deps.notifier,
            'warn',
            notify,
            `事实审计已自动处理 ${res.warnings.length} 项:\n${res.warnings.slice(0, 6).map((item) => `• ${item}`).join('\n')}`,
          );
        }

        // dry-run:HUB_DRY_RUN 置位时,不管 workflow 声明的是哪个渠道,一律强制走 mock,
        // 用于本地/CI 演练全流程而不触碰真实微信 API。严格真值判断,避免 "0"/"false"/空串
        // 被当成开启(例如 shell 里误写 HUB_DRY_RUN=0 却仍然触发 dry-run)。
        const DRY = /^(1|true|yes|on)$/i.test(process.env.HUB_DRY_RUN || '');
        const channelId = DRY ? 'mock' : runtimeWorkflow.channel;
        const channel = channels[channelId];
        if (!channel?.publish) throw stageError('config', `未知发布渠道:${channelId || '(empty)'}`);
        assertFixedDraftTemplate(channelId, channel);
        if (runtimeWorkflow.mode === 'translation' && deps.notifier?.progress) {
          await notifyBestEffort(deps.notifier, 'progress', notify, {
            stage: 'draft',
            message: DRY ? '完整性校验通过，正在生成 dry-run 草稿结果' : '完整性校验通过，正在创建微信公众号草稿',
            completed: 1,
            total: 1,
          });
        }
        setPhase('publish');
        throwIfTaskCancelled(signal);
        const { mediaId, title } = await channel.publish({
          articlePath: res.articlePath,
          config,
          workflow: runtimeWorkflow,
          notify,
          notifier: deps.notifier,
          runId: run.id,
          resumeFromCheckpoint,
        });
        store.setMediaId(run.id, mediaId, title); // 早写,发布成功后立刻落库,支撑上面的幂等判断
        setPhase('published');
        return { mediaId, title, sourceCount: res.sources?.length || 0, completeness: res.completeness };
      },
      runtimeWorkflow.retries,
      runtimeWorkflow.retryDelayMs,
      undefined,
      signal,
      runtimeWorkflow.shouldRetry,
    );
      store.setStatus(run.id, 'done', { title, mediaId, finishedAt: Date.now() });
      if (deps.notifier) await notifyBestEffort(deps.notifier, 'success', notify, { title, mediaId, channelId: runtimeWorkflow.channel, sourceCount, completeness });
      else console.error('[hub] notifier 未就绪,跳过 success 通知(启动窗口期竞态)', { runId: run.id, title, mediaId });
    } catch (e) {
      if (isTaskCancelled(e, signal)) {
        const cleanup = cleanupRunArtifacts(workflows, run);
        store.setStatus(run.id, 'cancelled', {
          stage: 'cancelled',
          error: cancellationErrorFromSignal(signal).message,
          finishedAt: Date.now(),
        });
        if (deps.notifier) {
          await notifyBestEffort(deps.notifier, 'cancelled', notify, {
            runId: run.id,
            cleaned: cleanup.cleaned,
            cleanupError: cleanup.error,
          });
        }
        return;
      }
      if (e.needsInput || e.stage === 'needs_input') {
        const cleanup = cleanupRunArtifacts(workflows, run, { preserveResearchTrace: true });
        store.setStatus(run.id, 'needs_input', {
          stage: 'needs_input',
          error: e.message,
          finishedAt: Date.now(),
        });
        if (notify.threadKey) {
          try {
            store.setSlackClarification?.(notify.threadKey, {
              runId: run.id,
              question: e.details?.question || e.message,
              details: e.details || {},
              cleaned: cleanup.cleaned,
              createdAt: Date.now(),
            });
          } catch (storeError) {
            console.error('[hub] 澄清上下文写入失败:', storeError?.message || storeError);
          }
        }
        if (deps.notifier) {
          await notifyBestEffort(deps.notifier, 'needsInput', notify, {
            question: e.details?.question || e.message,
            details: e.details || {},
          });
        }
        return;
      }
      const stage = e.stage || 'publish';
      store.setStatus(run.id, 'failed', { stage, error: e.message, finishedAt: Date.now() });
      if (deps.notifier) await notifyBestEffort(deps.notifier, 'failure', notify, { stage, error: e.message });
      else console.error('[hub] notifier 未就绪,跳过 failure 通知(启动窗口期竞态)', { runId: run.id, stage, error: e.message });
    }
  };
}

async function sleepWithCancellation(sleep, ms, signal) {
  if (!signal) return sleep(ms);
  throwIfTaskCancelled(signal);
  let onAbort;
  try {
    await Promise.race([
      Promise.resolve().then(() => sleep(ms)),
      new Promise((_, reject) => {
        onAbort = () => reject(cancellationErrorFromSignal(signal));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export function cleanupRunArtifacts(workflows, run, { preserveResearchTrace = false } = {}) {
  const workflow = workflows?.[run?.workflowId];
  if (!workflow?.workDir || !run?.id) return { cleaned: false };
  const artifactDir = runWorkDir(workflow.workDir, run.id);
  try {
    if (preserveResearchTrace && fs.existsSync(artifactDir)) {
      for (const entry of fs.readdirSync(artifactDir)) {
        if (entry === 'research-trace.json') continue;
        fs.rmSync(`${artifactDir}/${entry}`, { recursive: true, force: true });
      }
      return { cleaned: true, artifactDir, preserved: ['research-trace.json'] };
    }
    fs.rmSync(artifactDir, { recursive: true, force: true });
    return { cleaned: true, artifactDir };
  } catch (error) {
    console.error(`[hub] 已取消任务目录清理失败:${artifactDir}:${error?.message || error}`);
    return { cleaned: false, artifactDir, error: error?.message || String(error) };
  }
}

function stageError(stage, message) {
  const error = new Error(message);
  error.stage = stage;
  return error;
}

async function notifyBestEffort(notifier, method, notify, payload) {
  try { return await notifier?.[method]?.(notify, payload); }
  catch (error) {
    console.error(`[hub] notifier.${method} 失败(已忽略):`, error?.message || error);
    return undefined;
  }
}

export async function start() {
  const config = loadConfig();
  const store = openStore(config.dbPath);
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const runBefore = now - config.runRetentionDays * DAY_MS;
  for (const expired of store.listPrunableRuns(runBefore)) {
    const workflow = WORKFLOWS[expired.workflow_id];
    if (!workflow?.workDir) continue;
    const artifactDir = runWorkDir(workflow.workDir, expired.id);
    try { fs.rmSync(artifactDir, { recursive: true, force: true }); }
    catch (error) { console.error(`[hub] 历史任务目录清理失败:${artifactDir}:${error?.message || error}`); }
  }
  const pruned = store.prune({
    runBefore,
    threadBefore: now - config.slackThreadRetentionDays * DAY_MS,
    eventBefore: now - config.slackThreadRetentionDays * DAY_MS,
  });
  if (pruned.runs || pruned.threads || pruned.events) {
    console.log(`[hub] 已清理历史记录:runs=${pruned.runs},threads=${pruned.threads},events=${pruned.events}`);
  }
  // 长篇直译按分块保存 checkpoint，可在进程重启后安全续跑。
  // 其它工作流仍标记 interrupted 并等待人工确认，避免自动重复创建草稿。
  const recoveredTranslations = store.recoverRunningWorkflow('translate');
  if (recoveredTranslations) console.log(`[hub] 启动:自动恢复 ${recoveredTranslations} 个直译任务`);
  const interrupted = store.markInterrupted();
  if (interrupted) console.log(`[hub] 启动:${interrupted} 个残留任务标记为 interrupted`);
  // 只恢复显式处于 queued 的持久化任务。interrupted 不会自动重跑，必须先由
  // 管理操作明确 requeue，避免旧任务在重启后意外创建草稿。
  const persistedQueued = store.listByStatus('queued');

  const deps = {
    store,
    runWriter,
    workflows: WORKFLOWS,
    channels: CHANNELS,
    config,
    notifier: undefined,
  };
  const handler = makeHandler(deps);

  const queue = createQueue({
    store,
    maxConcurrency: config.maxConcurrency,
    maxQueueSize: config.maxQueueSize,
    handler,
  });
  const enqueue = (t) => {
    const result = queue.enqueue({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...t });
    // 收到即回执:不等待任务真正被处理(那要等到出队),用户提交后立刻有反馈。
    // 守卫住 notifier 可能还没就绪(启动窗口期竞态)以及 ack 本身可能抛错,两者都不能拖垮入队。
    try {
      Promise.resolve(deps.notifier?.ack?.(t.notify, t.input)).catch((e) => {
        console.error('[hub] notifier.ack 失败(已忽略)', e.message);
      });
    } catch (e) {
      console.error('[hub] notifier.ack 失败(已忽略)', e.message);
    }
    return result;
  };
  const cancelTask = ({ runId, channel, user, reason }) => {
    const result = queue.cancel({ runId, channel, user, reason });
    if (result.kind === 'pending') {
      const cleanup = cleanupRunArtifacts(WORKFLOWS, result.run);
      return { ...result, cleanupError: cleanup.error };
    }
    return result;
  };
  // Slack 连接监督:退避重试首连;并对 @slack/socket-mode 1.x 的瞬时崩溃容忍 + 自动重连,
  // 不让一次套接字断开拖垮整个进程(queue/cron 等仍存活)。
  let currentSlackApp;
  let connectPromise;
  let shuttingDown = false;
  const healthServer = await startHealthServer({
    ...config.health,
    status: () => {
      const queueStatus = queue.stats();
      return {
        queue: queueStatus,
        slackConnected: Boolean(currentSlackApp),
        shuttingDown,
        ready: !shuttingDown && !queueStatus.stopped && Boolean(currentSlackApp),
      };
    },
  });
  if (healthServer) console.log(`[hub] 健康检查监听 http://${config.health.host}:${config.health.port}/health`);
  const backoffs = [2000, 5000, 10000, 20000, 30000];
  async function connectSlack() {
    for (let attempt = 0; ; attempt++) {
      if (shuttingDown) return undefined;
      try {
        if (currentSlackApp) {
          try { await currentSlackApp.stop(); } catch {}
          currentSlackApp = undefined;
        }
        const app = await registerSlack({
          config,
          enqueue,
          cancelTask,
          store,
          workflowIds: Object.keys(WORKFLOWS),
        });
        currentSlackApp = app;
        deps.notifier = createNotifier((m) => app.client.chat.postMessage(m));
        console.log('⚡ Slack 已连接');
        return app;
      } catch (e) {
        const wait = backoffs[Math.min(attempt, backoffs.length - 1)];
        console.error(`[hub] Slack 连接失败: ${e.message};${wait / 1000}s 后重试。请核对 SLACK_APP_TOKEN(xapp-)是否有效、应用是否已开启 Socket Mode、以及是否有重复实例在用同一 token。`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  function ensureSlackConnected() {
    if (connectPromise) return connectPromise;
    connectPromise = connectSlack().finally(() => { connectPromise = undefined; });
    return connectPromise;
  }
  function scheduleSlackReconnect() {
    if (shuttingDown || connectPromise) return;
    const timer = setTimeout(() => { void ensureSlackConnected(); }, 3000);
    timer.unref?.();
  }

  process.on('unhandledRejection', (reason) => {
    console.error('[hub] 未处理 Promise 拒绝,退出:', (reason && reason.message) || reason);
    process.exitCode = 1;
    void shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    if (isTransientSocketModeError(err)) {
      console.error('[hub] 已容忍 socket-mode 瞬时崩溃(连接期被 Slack 断开),进程保活并自动重连:', err.message);
      scheduleSlackReconnect();
      return;
    }
    console.error('[hub] 未捕获异常,退出:', err);
    void shutdown('uncaughtException', 1);
  });

  // Slack 的 Socket Mode 是交互入口，不是已持久化发布任务的前置条件。
  // 网络瞬断时 connectSlack 会自行退避重试；若在这里 await，它会把恢复中的
  // 长篇直译永远卡在队列外，直到 Slack 恢复。先让队列恢复并执行，通知器随后
  // 连接成功时再接管回执/进度通知。
  void ensureSlackConnected();
  for (const row of persistedQueued) {
    queue.restore({
      id: row.id,
      workflowId: row.workflow_id,
      source: row.source,
      input: row.input,
      // handler 会从数据库读取并校验 notify_json；恢复阶段不解析，避免一条损坏
      // 记录阻断整个服务启动。
      notify: {},
      restored: true,
    });
  }
  if (persistedQueued.length) console.log(`[hub] 已恢复 ${persistedQueued.length} 个持久化排队任务`);
  registerCron({
    workflows: WORKFLOWS,
    enqueue,
    notifyChannel: config.slack.notifyChannel,
    timezone: config.cronTimezone,
  });

  async function shutdown(signal, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[hub] 收到 ${signal},停止接单并等待活动任务收尾`);
    queue.stop();
    await stopHealthServer(healthServer).catch(() => {});
    if (currentSlackApp) {
      try { await currentSlackApp.stop(); } catch (error) { console.error('[hub] Slack 停止失败:', error?.message || error); }
      currentSlackApp = undefined;
    }
    const timeout = new Promise((resolve) => {
      setTimeout(resolve, 25000);
    });
    await Promise.race([queue.whenIdle(), timeout]);
    try { store.close(); } catch {}
    process.exit(exitCode);
  }
  process.once('SIGTERM', () => { void shutdown('SIGTERM', 0); });
  process.once('SIGINT', () => { void shutdown('SIGINT', 0); });
  console.log('⚡ Zen Content Hub 已启动');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((error) => {
    console.error('[hub] 启动失败:', error?.stack || error);
    process.exitCode = 1;
  });
}
