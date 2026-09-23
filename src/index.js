import { runWithRetry, openingDigestPublishContext, makeHandler, cleanupRunArtifacts } from './core/task-handler.js';
export { runWithRetry, openingDigestPublishContext, makeHandler, cleanupRunArtifacts } from './core/task-handler.js';
import { pruneHistory } from './core/retention.js';

import dotenv from 'dotenv';



import { loadConfig } from './config/index.js';
import { installResourceGovernor, installRuntimeConfig, isDryRun } from './config/runtime.js';
import { openStore } from './core/store.js';
import { createQueue } from './core/queue.js';
import { createResourceGovernor } from './core/resource-governor.js';
import { runWriter } from './core/runner.js';
import { createNotifier } from './core/notifier.js';
import { deliverOrQueueNotification, flushNotificationOutbox } from './core/notification-outbox.js';
import { flushDiscordDeliveryOutbox, queueDiscordDelivery } from './core/delivery-outbox.js';
import {
  flushOpeningDigestWechatOutbox,
  queueOpeningDigestWechatDelivery,
} from './core/opening-digest-wechat-outbox.js';
import { formatQdiiSlackMessages, qdiiSourcesForWriter, runQdiiQuery } from './core/qdii.js';
import { registerSlack } from './triggers/slack.js';
import { reconcileCronWorkflows, registerCron, validateCronConfiguration } from './triggers/cron.js';
import { isSlackAppConnected, isTransientSocketModeError } from './lib/slack-resilience.js';

import { startHealthServer, stopHealthServer } from './lib/health.js';


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

export async function start() {
  const config = installRuntimeConfig(loadConfig());
  const governor = installResourceGovernor(createResourceGovernor({
    ...config.resources,
    fetchFn: globalThis.fetch,
  }));
  validateCronConfiguration({ workflows: WORKFLOWS, timezone: config.cronTimezone });
  const store = openStore(config.dbPath);
  pruneHistory({ store, workflows: WORKFLOWS, config });
  // Long translations persist chunk checkpoints and can safely resume after restart.
  // Other workflows remain interrupted pending explicit confirmation to avoid duplicate drafts.
  store.recoverPublications();
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
    if (isDryRun(config) || shuttingDown || deliveryFlushPromise) return deliveryFlushPromise;
    const terminalWarning = (method, message) => async ({ row, error, attempts }) => {
      const run = store.getRun(row.run_id);
      let notify = {};
      try { notify = JSON.parse(run?.notify_json || '{}'); } catch {}
      await deliverOrQueueNotification({
        store, notifier: deps.notifier, runId: row.run_id, method, notify,
        payload: message({ error, attempts }),
      });
    };
    deliveryFlushPromise = Promise.all([
      flushDiscordDeliveryOutbox({
        store,
        config,
        fetchFn: governor.fetch,
        onTerminalFailure: terminalWarning('warn:discord', ({ error, attempts }) => `Opening Digest 邮件已成功，但 Discord #newsletter-feed 在 ${attempts} 次尝试后仍投递失败:${error?.message || error}`),
      }).catch((error) => console.error('[hub] Discord delivery outbox 补发失败:', error?.message || error)),
      flushOpeningDigestWechatOutbox({
        store,
        config,
        fetchFn: governor.fetch,
        onTerminalFailure: terminalWarning('warn:wechat', ({ error, attempts }) => `Opening Digest 邮件已成功，但中文微信草稿在 ${attempts} 次尝试后仍失败:${error?.message || error}`),
        onDelivered: ({ row, wechat }) => {
          let notify = {};
          try { notify = JSON.parse(store.getRun(row.run_id)?.notify_json || '{}'); } catch {}
          return deliverOrQueueNotification({
            store, notifier: deps.notifier, runId: row.run_id, method: 'success:wechat', notify,
            payload: { title: wechat.title, mediaId: wechat.mediaId, channelId: 'wechat-opening-digest' },
          });
        },
      }).catch((error) => console.error('[hub] WeChat delivery outbox 补发失败:', error?.message || error)),
    ]).finally(() => { deliveryFlushPromise = undefined; });
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
  const retentionTimer = setInterval(() => {
    if (!shuttingDown) {
      try { pruneHistory({ store, workflows: WORKFLOWS, config }); }
      catch (error) { console.error('[hub] 定期清理失败:', error.message); }
    }
  }, 60 * 60 * 1000);
  retentionTimer.unref?.();
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
    clearInterval(retentionTimer);
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
