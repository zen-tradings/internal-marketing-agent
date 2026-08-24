import dotenv from 'dotenv';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config/index.js';
import { installResourceGovernor, installRuntimeConfig } from './config/runtime.js';
import { openStore } from './core/store.js';
import { createQueue } from './core/queue.js';
import { createResourceGovernor } from './core/resource-governor.js';
import { runWriter } from './core/runner.js';
import { createNotifier } from './core/notifier.js';
import { deliverOrQueueNotification, flushNotificationOutbox } from './core/notification-outbox.js';
import { flushDiscordDeliveryOutbox, queueDiscordDelivery } from './core/delivery-outbox.js';
import { formatQdiiSlackMessages, qdiiSourcesForWriter, runQdiiQuery } from './core/qdii.js';
import { registerSlack } from './triggers/slack.js';
import { reconcileCronWorkflows, registerCron, validateCronConfiguration } from './triggers/cron.js';
import { isSlackAppConnected, isTransientSocketModeError } from './lib/slack-resilience.js';
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
import macroWorkflow from './workflows/macro.js';
import openingDigestWorkflow from './workflows/opening-digest.js';
import qdiiWorkflow from './workflows/qdii.js';
import mockChannel from './channels/mock.js';
import wechatDraft from './channels/wechat-draft.js';
import customerioDraft from './channels/customerio-draft.js';
import { makeChannel as makeOpeningDigestChannel } from './channels/customerio-opening-digest.js';

dotenv.config();

const WORKFLOWS = {
  wechat: wechatWorkflow,
  earnings: earningsWorkflow,
  sector: sectorWorkflow,
  morning: morningWorkflow,
  translate: translateWorkflow,
  company: companyWorkflow,
  email: emailWorkflow,
  macro: macroWorkflow,
  'opening-digest': openingDigestWorkflow,
  qdii: qdiiWorkflow,
};
const CHANNELS = {
  mock: mockChannel,
  'wechat-draft': wechatDraft,
  'customerio-draft': customerioDraft,
  'customerio-opening-digest': makeOpeningDigestChannel(),
};

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

export function openingDigestPublishContext(run) {
  if (run?.workflowId !== 'opening-digest' || run?.source !== 'slack') {
    return { source: run?.source, acceptanceId: '' };
  }
  const raw = String(run.id || '');
  const normalized = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const acceptanceId = /^[a-z0-9-]{8,80}$/.test(normalized)
    ? normalized
    : `slack-${normalized.slice(0, 54) || 'run'}-${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12)}`.slice(0, 80);
  return { source: 'acceptance', acceptanceId };
}

// Queue-handler factory with injectable store, runner, and channels for unit tests.
// The closure retains the deps object itself rather than destructured locals. start() assigns notifier later,
// after registerSlack, so retain the original read-current-value-at-call-time behavior.
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
      store.setStatus(run.id, 'running', { startedAt: Date.now(), stage: null, error: null, nextRetryAt: null });
      setPhase('generate');

      const qdiiPlan = notify.qdiiPlan?.qdii ? notify.qdiiPlan : null;
      if (runtimeWorkflow.mode === 'qdii-query') {
        if (persisted.slack_response_ts) {
          store.setOutputKind?.(run.id, 'slack-response');
          store.setStatus(run.id, 'done', {
            title: persisted.title || 'QDII holdings response',
            finishedAt: Date.now(),
          });
          return;
        }
        const payload = await deps.runQdiiQuery({
          input: run.input,
          taskPlan: qdiiPlan,
          config,
          workDir: runtimeWorkflow.workDir,
          signal,
          onProgress: (progress) => notifyBestEffort(deps.notifier, 'progress', notify, progress),
        });
        if (!payload.results.length) throw stageError('generate', payload.failures.map((item) => `${item.code}: ${item.error}`).join('; ') || '未取得可用 QDII 持仓');
        setPhase('respond');
        const delivered = await deliverOrQueueNotification({
          store, notifier: deps.notifier, runId: run.id, method: 'respond', notify,
          payload: { messages: formatQdiiSlackMessages(payload, { language: payload.taskPlan?.language || payload.query?.language }) },
        });
        store.setOutputKind?.(run.id, 'slack-response');
        if (delivered.result?.responseTs) store.setSlackResponseTs?.(run.id, delivered.result.responseTs);
        store.setStatus(run.id, 'done', {
          title: `QDII holdings: ${payload.results.map((item) => item.code).join(', ')}`,
          finishedAt: Date.now(),
        });
        return;
      }

      let qdiiPayload;
      if (qdiiPlan) {
        qdiiPayload = await deps.runQdiiQuery({
          input: run.input,
          taskPlan: qdiiPlan,
          config,
          workDir: runtimeWorkflow.workDir,
          signal,
          onProgress: (progress) => notifyBestEffort(deps.notifier, 'progress', notify, progress),
        });
        if (!qdiiPayload.results.length) throw stageError('generate', qdiiPayload.failures.map((item) => `${item.code}: ${item.error}`).join('; ') || '未取得可用 QDII 持仓');
        if (qdiiPlan.dualReply && !persisted.slack_response_ts) {
          setPhase('respond');
          const delivered = await deliverOrQueueNotification({
            store, notifier: deps.notifier, runId: run.id, method: 'respond', notify,
            payload: { messages: formatQdiiSlackMessages(qdiiPayload, { language: qdiiPayload.taskPlan?.language || qdiiPayload.query?.language }) },
          });
          if (delivered.result?.responseTs) store.setSlackResponseTs?.(run.id, delivered.result.responseTs);
        }
        store.setOutputKind?.(run.id, qdiiPlan.dualReply ? 'draft-with-slack-summary' : 'draft');
        setPhase('generate');
      }

      const { title, mediaId, sourceCount, completeness, deliveryWarnings = [] } = await runWithRetry(async () => {
        throwIfTaskCancelled(signal);
        // A media_id proves a prior retry or restart republish succeeded; skip regeneration/publication to avoid duplicates.
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
              routeReason: notify.routeReason,
              modelProfile: notify.modelProfile,
              modelRouteReason: notify.modelRouteReason,
              ...(runtimeWorkflow.id === 'opening-digest' ? {
                openingDigestHistory: {
                  recordCapture: (entry) => store.recordOpeningDigestOicCapture?.(entry),
                  listHistory: (options) => store.listOpeningDigestIvHistory?.(options),
                },
              } : {}),
              ...(qdiiPayload ? {
                qdiiPayload,
                qdiiSources: qdiiSourcesForWriter(qdiiPayload),
              } : {}),
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
        if (runtimeWorkflow.id !== 'opening-digest' && Array.isArray(res.warnings) && res.warnings.length) {
          const highRiskRetained = res.warnings
            .filter((item) => /保留待人工复核\([^/]+\/high\//.test(item)).length;
          const warningHeading = runtimeWorkflow.mode === 'translation'
            ? `直译有 ${res.completeness?.reviewRequiredCount || res.warnings.length} 个译块需人工复核，已按策略创建草稿:`
            : runtimeWorkflow.id === 'macro' && highRiskRetained
              ? `宏观事实审计提醒 ${res.warnings.length} 项，其中 ${highRiskRetained} 项高风险推断/表述已保留，不阻断草稿，请人工复核:`
              : `事实审计报告 ${res.warnings.length} 项（含自动修复与保留待复核）:`;
          const shownWarnings = res.warnings.slice(0, 6).map((item) => `• ${item}`);
          if (res.warnings.length > shownWarnings.length) {
            shownWarnings.push(`• 其余 ${res.warnings.length - shownWarnings.length} 项见 research-trace.json`);
          }
          await notifyBestEffort(
            deps.notifier,
            'warn',
            notify,
            `${warningHeading}\n${shownWarnings.join('\n')}`,
          );
        }

        // With HUB_DRY_RUN enabled, force every declared workflow channel to mock for local/CI end-to-end rehearsal
        // without touching the live WeChat API. Use strict truthiness so 0, false, and empty strings do not enable it.
        const DRY = /^(1|true|yes|on)$/i.test(process.env.HUB_DRY_RUN || '');
        const channelId = DRY ? 'mock' : runtimeWorkflow.channel;
        const channel = channels[channelId];
        if (!channel?.publish) throw stageError('config', `未知发布渠道:${channelId || '(empty)'}`);
        if (!channel.skipTemplateCheck) assertFixedDraftTemplate(channelId, channel);
        if (runtimeWorkflow.mode === 'translation' && deps.notifier?.progress) {
          await notifyBestEffort(deps.notifier, 'progress', notify, {
            stage: 'draft',
            message: res.completeness?.reviewRequiredCount
              ? (DRY
                ? '结构完整性通过且存在待复核译块，正在生成 dry-run 草稿结果'
                : '结构完整性通过且存在待复核译块，正在创建微信公众号草稿')
              : (DRY
                ? '严格等价与完整性校验通过，正在生成 dry-run 草稿结果'
                : '严格等价与完整性校验通过，正在创建微信公众号草稿'),
            completed: 1,
            total: 1,
          });
        }
        setPhase('publish');
        throwIfTaskCancelled(signal);
        const publishContext = openingDigestPublishContext(run);
        const { mediaId, title, deliveryWarnings = [] } = await channel.publish({
          articlePath: res.articlePath,
          config,
          workflow: runtimeWorkflow,
          notify,
          notifier: deps.notifier,
          runId: run.id,
          createdAt: persisted.created_at,
          existingRemoteId: store.getRun(run.id)?.remote_id || '',
          existingDeliveries: store.listDeliveries?.(run.id) || [],
          onCreated: ({ remoteId }) => store.setRemoteId(run.id, remoteId),
          remoteOperations: {
            get: (operation) => store.getRemoteOperation?.(run.id, operation),
            prepare: (entry) => store.prepareRemoteOperation?.({ runId: run.id, ...entry }),
            increment: (operation) => store.incrementRemoteOperationAttempt?.(run.id, operation),
            update: (operation, patch) => store.updateRemoteOperation?.(run.id, operation, patch),
          },
          onDelivery: (delivery) => store.upsertDelivery?.(run.id, delivery),
          onDeferredDelivery: (delivery) => {
            const row = queueDiscordDelivery({ store, runId: run.id, ...delivery });
            deps.kickDeliveryOutbox?.();
            return row;
          },
          resumeFromCheckpoint,
          contentPolicy: res.contentPolicy || {},
          signal,
          contentMode: res.contentMode,
          source: publishContext.source,
          acceptanceId: publishContext.acceptanceId,
        });
        store.setMediaId(run.id, mediaId, title); // Persist immediately after publish to support the idempotency check above.
        setPhase('published');
        return { mediaId, title, sourceCount: res.sources?.length || 0, completeness: res.completeness, deliveryWarnings };
      },
      runtimeWorkflow.retries,
      runtimeWorkflow.retryDelayMs,
      undefined,
      signal,
      runtimeWorkflow.shouldRetry,
    );
      store.setStatus(run.id, 'done', { title, mediaId, finishedAt: Date.now() });
      await deliverOrQueueNotification({
        store, notifier: deps.notifier, runId: run.id, method: 'success', notify,
        payload: { title, mediaId, channelId: runtimeWorkflow.channel, sourceCount, completeness },
      });
      for (const warning of deliveryWarnings) {
        if (deps.notifier) await notifyBestEffort(deps.notifier, 'warn', notify, warning);
      }
    } catch (e) {
      if (isTaskCancelled(e, signal)) {
        const cleanup = cleanupRunArtifacts(workflows, run);
        store.setStatus(run.id, 'cancelled', {
          stage: 'cancelled',
          error: cancellationErrorFromSignal(signal).message,
          finishedAt: Date.now(),
        });
        await deliverOrQueueNotification({
          store, notifier: deps.notifier, runId: run.id, method: 'cancelled', notify,
          payload: { runId: run.id, cleaned: cleanup.cleaned, cleanupError: cleanup.error },
        });
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
        await deliverOrQueueNotification({
          store, notifier: deps.notifier, runId: run.id, method: 'needsInput', notify,
          payload: { question: e.details?.question || e.message, details: e.details || {} },
        });
        return;
      }
      const stage = e.stage || 'publish';
      store.setStatus(run.id, 'failed', { stage, error: e.message, finishedAt: Date.now() });
      await deliverOrQueueNotification({
        store, notifier: deps.notifier, runId: run.id, method: 'failure', notify,
        payload: { stage, error: e.message },
      });
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
  const config = installRuntimeConfig(loadConfig());
  const governor = installResourceGovernor(createResourceGovernor({
    ...config.resources,
    fetchFn: globalThis.fetch,
  }));
  validateCronConfiguration({ workflows: WORKFLOWS, timezone: config.cronTimezone });
  const store = openStore(config.dbPath);
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const runBefore = now - config.runRetentionDays * DAY_MS;
  let prunedRuns = 0;
  for (const expired of store.listPrunableRuns(runBefore)) {
    const workflow = WORKFLOWS[expired.workflow_id];
    let cleaned = true;
    if (workflow?.workDir) {
      const artifactDir = runWorkDir(workflow.workDir, expired.id);
      try { fs.rmSync(artifactDir, { recursive: true, force: true }); }
      catch (error) {
        cleaned = false;
        console.error(`[hub] 历史任务目录清理失败，保留数据库记录待下次重试:${artifactDir}:${error?.message || error}`);
      }
    }
    if (cleaned) prunedRuns += store.deletePrunableRun(expired.id, runBefore);
  }
  const pruned = store.prune({
    threadBefore: now - config.slackThreadRetentionDays * DAY_MS,
    eventBefore: now - config.slackThreadRetentionDays * DAY_MS,
  });
  if (prunedRuns || pruned.threads || pruned.events) {
    console.log(`[hub] 已清理历史记录:runs=${prunedRuns},threads=${pruned.threads},events=${pruned.events}`);
  }
  // Long translations persist chunk checkpoints and can safely resume after restart.
  // Other workflows remain interrupted pending explicit confirmation to avoid duplicate drafts.
  const recoveredTranslations = store.recoverRunningWorkflow('translate');
  if (recoveredTranslations) console.log(`[hub] 启动:自动恢复 ${recoveredTranslations} 个直译任务`);
  const interrupted = store.markInterrupted();
  if (interrupted) console.log(`[hub] 启动:${interrupted} 个残留任务标记为 interrupted`);
  // Restore only persisted tasks explicitly queued. Interrupted tasks require an explicit administrative requeue
  // to prevent an old task from creating an unexpected draft after restart.
  const persistedQueued = store.listByStatus('queued');
  let deliveryFlushPromise;
  let shuttingDown = false;

  const deps = {
    store,
    runWriter: (args) => runWriter({ ...args, fetchFn: governor.fetch }),
    workflows: WORKFLOWS,
    channels: CHANNELS,
    config,
    notifier: undefined,
    runQdiiQuery: (args) => runQdiiQuery({ ...args, fetchFn: governor.fetch }),
  };
  deps.kickDeliveryOutbox = () => {
    if (shuttingDown || deliveryFlushPromise || !config.discord.openingDigestEnabled) return deliveryFlushPromise;
    deliveryFlushPromise = flushDiscordDeliveryOutbox({
      store,
      config,
      fetchFn: governor.fetch,
      onTerminalFailure: async ({ row, error, attempts }) => {
        const run = store.getRun(row.run_id);
        let notify = {};
        try { notify = JSON.parse(run?.notify_json || '{}'); } catch {}
        await deliverOrQueueNotification({
          store,
          notifier: deps.notifier,
          runId: row.run_id,
          method: 'warn:discord',
          notify,
          payload: `Opening Digest 邮件已成功，但 Discord #newsletter-feed 在 ${attempts} 次尝试后仍投递失败:${error?.message || error}`,
        });
      },
    }).catch((error) => {
      console.error('[hub] Discord delivery outbox 补发失败:', error?.message || error);
    }).finally(() => { deliveryFlushPromise = undefined; });
    return deliveryFlushPromise;
  };
  const handler = makeHandler(deps);

  const queue = createQueue({
    store,
    maxConcurrency: config.maxConcurrency,
    maxQueueSize: config.maxQueueSize,
    handler,
  });
  const restoreRun = (rowOrRun) => queue.restore({
    id: rowOrRun.id,
    workflowId: rowOrRun.workflowId || rowOrRun.workflow_id,
    source: rowOrRun.source,
    input: rowOrRun.input,
    notify: {},
    priority: Number(rowOrRun.priority || 0),
    restored: true,
  });
  const enqueue = (t) => {
    const result = queue.enqueue({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...t });
    // Acknowledge on receipt instead of waiting for queue execution, giving the user immediate feedback.
    // Guard both the startup-window notifier race and acknowledgement failures; neither may prevent enqueueing.
    try {
      Promise.resolve(deps.notifier?.ack?.({
        ...t.notify,
        runId: result.id,
        queueState: queue.state(result.id),
      }, t.input)).catch((e) => {
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
  // Supervise Slack connection with backoff. Tolerate transient @slack/socket-mode 1.x crashes and reconnect so
  // one socket disconnect cannot stop the queue, cron, or process.
  let currentSlackApp;
  let connectPromise;
  let outboxFlushPromise;
  const healthServer = await startHealthServer({
    ...config.health,
    status: () => {
      const queueStatus = queue.stats();
      const slackConnected = isSlackAppConnected(currentSlackApp);
      return {
        queue: queueStatus,
        resources: governor.stats(),
        deliveries: store.deliveryOutboxStats(),
        slackConnected,
        shuttingDown,
        ready: !shuttingDown && !queueStatus.stopped && slackConnected,
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
          fetchFn: governor.fetch,
        });
        currentSlackApp = app;
        deps.notifier = createNotifier(app.zenPostMessage || ((m) => app.client.chat.postMessage(m)));
        outboxFlushPromise = flushNotificationOutbox({ store, notifier: deps.notifier })
          .catch((error) => console.error('[hub] Slack outbox 首次补发失败:', error?.message || error))
          .finally(() => { outboxFlushPromise = undefined; });
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

  // Slack Socket Mode is an interactive entry point, not a prerequisite for persisted publication tasks.
  // connectSlack retries after a transient outage; awaiting it here would keep recovered long translations outside
  // the queue. Restore and execute the queue first, then let the notifier take over when Slack reconnects.
  void ensureSlackConnected();
  void deps.kickDeliveryOutbox();
  const outboxTimer = setInterval(() => {
    void deps.kickDeliveryOutbox();
    if (deps.notifier && !outboxFlushPromise) {
      outboxFlushPromise = flushNotificationOutbox({ store, notifier: deps.notifier })
        .catch((error) => console.error('[hub] Slack outbox 补发失败:', error?.message || error))
        .finally(() => { outboxFlushPromise = undefined; });
    }
  }, 30000);
  outboxTimer.unref?.();
  for (const row of persistedQueued) {
    restoreRun(row);
  }
  if (persistedQueued.length) console.log(`[hub] 已恢复 ${persistedQueued.length} 个持久化排队任务`);
  registerCron({
    workflows: WORKFLOWS,
    enqueue,
    notifyChannel: config.slack.notifyChannel,
    timezone: config.cronTimezone,
  });
  const caughtUp = await reconcileCronWorkflows({
    workflows: WORKFLOWS,
    enqueue,
    notifyChannel: config.slack.notifyChannel,
    timezone: config.cronTimezone,
  });
  if (caughtUp) console.log(`[hub] 启动:补排 ${caughtUp} 个错过触发窗口的定时任务`);

  async function shutdown(signal, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[hub] 收到 ${signal},停止接单并等待活动任务收尾`);
    queue.stop();
    clearInterval(outboxTimer);
    await stopHealthServer(healthServer).catch(() => {});
    if (currentSlackApp) {
      try { await currentSlackApp.stop(); } catch (error) { console.error('[hub] Slack 停止失败:', error?.message || error); }
      currentSlackApp = undefined;
    }
    const timeout = new Promise((resolve) => {
      setTimeout(resolve, 25000);
    });
    await Promise.race([Promise.all([queue.whenIdle(), deliveryFlushPromise].filter(Boolean)), timeout]);
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
    process.exit(1);
  });
}
