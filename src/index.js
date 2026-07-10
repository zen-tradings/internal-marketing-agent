import dotenv from 'dotenv';
import { loadConfig } from './config/index.js';
import { openStore } from './core/store.js';
import { createQueue } from './core/queue.js';
import { runClaude } from './core/runner.js';
import { createNotifier } from './core/notifier.js';
import { registerSlack } from './triggers/slack.js';
import { registerCron } from './triggers/cron.js';
import { isTransientSocketModeError } from './lib/slack-resilience.js';
import wechatWorkflow from './workflows/wechat.js';
import earningsWorkflow from './workflows/earnings.js';
import sectorWorkflow from './workflows/sector.js';
import morningWorkflow from './workflows/morning.js';
import translateWorkflow from './workflows/translate.js';
import mockChannel from './channels/mock.js';
import wechatDraft from './channels/wechat-draft.js';

dotenv.config({ override: true });

const WORKFLOWS = {
  wechat: wechatWorkflow,
  earnings: earningsWorkflow,
  sector: sectorWorkflow,
  morning: morningWorkflow,
  translate: translateWorkflow,
};
const CHANNELS = { mock: mockChannel, 'wechat-draft': wechatDraft };

export async function runWithRetry(fn, retries = 0) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); } catch (e) { last = e; }
  }
  throw last;
}

export function assertMainProcessDirect(env = process.env) {
  for (const k of ['https_proxy', 'http_proxy', 'all_proxy', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']) {
    if (env[k]) throw new Error(`主进程不得设置代理(${k});海外 VPS 部署应让 OpenRouter/Exa/微信全部直连。`);
  }
}

// 队列处理器工厂,便于注入 stub 做单测(store/runClaude/channels 均可替换)。
// runClaude 是旧依赖名,当前实际指向 OpenRouter runWriter,保留以减少装配层 churn。
// 注意:`deps` 对象本身(而非解构出的局部变量)被闭包持有,notifier 字段在
// start() 中是稍后才赋值的(registerSlack 之后)——沿用原来 `let notifier` 的
// "调用时才读取当前值" 语义,不在这里提前修复这个时序,只是原样保留。
export function makeHandler(deps) {
  const { store, runClaude, workflows, channels, config } = deps;
  return async function handler(run) {
    const wf = workflows[run.workflowId];
    const notify = JSON.parse(store.getRun(run.id).notify_json || '{}');
    store.setStatus(run.id, 'running', { startedAt: Date.now() });
    try {
      const { title, mediaId } = await runWithRetry(async () => {
        // 发布幂等:已有 media_id 说明上一轮(重试循环内或重启后重投)已经发布成功过,
        // 跳过重新生成/发布,避免产生重复草稿。
        const existing = store.getRun(run.id);
        if (existing.media_id) return { title: existing.title, mediaId: existing.media_id };

        const res = await runClaude({ workflow: wf, input: run.input, config });
        if (!res.ok) { const err = new Error(res.stderr); err.stage = 'generate'; throw err; }

        // dry-run:HUB_DRY_RUN 置位时,不管 workflow 声明的是哪个渠道,一律强制走 mock,
        // 用于本地/CI 演练全流程而不触碰真实微信 API。严格真值判断,避免 "0"/"false"/空串
        // 被当成开启(例如 shell 里误写 HUB_DRY_RUN=0 却仍然触发 dry-run)。
        const DRY = /^(1|true|yes|on)$/i.test(process.env.HUB_DRY_RUN || '');
        const channelId = DRY ? 'mock' : wf.channel;
        const channel = channels[channelId];
        const { mediaId, title } = await channel.publish({ articlePath: res.articlePath, config, workflow: wf, notify, notifier: deps.notifier });
        store.setMediaId(run.id, mediaId, title); // 早写,发布成功后立刻落库,支撑上面的幂等判断
        return { mediaId, title };
      }, wf.retries);
      store.setStatus(run.id, 'done', { title, mediaId, finishedAt: Date.now() });
      if (deps.notifier) await deps.notifier.success(notify, { title, mediaId });
      else console.error('[hub] notifier 未就绪,跳过 success 通知(启动窗口期竞态)', { runId: run.id, title, mediaId });
    } catch (e) {
      const stage = e.stage || 'publish';
      store.setStatus(run.id, 'failed', { stage, error: e.message, finishedAt: Date.now() });
      if (deps.notifier) await deps.notifier.failure(notify, { stage, error: e.message });
      else console.error('[hub] notifier 未就绪,跳过 failure 通知(启动窗口期竞态)', { runId: run.id, stage, error: e.message });
    }
  };
}

export async function start() {
  assertMainProcessDirect();
  const config = loadConfig();
  const store = openStore(config.dbPath);
  const interrupted = store.markInterrupted();
  if (interrupted) console.log(`[hub] 启动:${interrupted} 个残留任务标记为 interrupted`);

  const deps = { store, runClaude, workflows: WORKFLOWS, channels: CHANNELS, config, notifier: undefined };
  const handler = makeHandler(deps);

  const queue = createQueue({ store, maxConcurrency: config.maxConcurrency, handler });
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
  // Slack 连接监督:退避重试首连;并对 @slack/socket-mode 1.x 的瞬时崩溃容忍 + 自动重连,
  // 不让一次套接字断开拖垮整个进程(queue/cron 等仍存活)。
  let reconnecting = false;
  const backoffs = [2000, 5000, 10000, 20000, 30000];
  async function connectSlack() {
    for (let attempt = 0; ; attempt++) {
      try {
        const app = await registerSlack({ config, enqueue, workflowIds: Object.keys(WORKFLOWS) });
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
  function scheduleSlackReconnect() {
    if (reconnecting) return;
    reconnecting = true;
    setTimeout(async () => { try { await connectSlack(); } finally { reconnecting = false; } }, 3000);
  }

  process.on('unhandledRejection', (reason) => {
    console.error('[hub] unhandledRejection(已记录,进程不退出):', (reason && reason.message) || reason);
  });
  process.on('uncaughtException', (err) => {
    if (isTransientSocketModeError(err)) {
      console.error('[hub] 已容忍 socket-mode 瞬时崩溃(连接期被 Slack 断开),进程保活并自动重连:', err.message);
      scheduleSlackReconnect();
      return;
    }
    console.error('[hub] 未捕获异常,退出:', err);
    process.exit(1);
  });

  await connectSlack();
  registerCron({ workflows: WORKFLOWS, enqueue });
  console.log('⚡ Zen Content Hub 已启动');
}

if (import.meta.url === `file://${process.argv[1]}`) start();
