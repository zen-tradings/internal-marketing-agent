import 'dotenv/config';
import { loadConfig } from './config/index.js';
import { openStore } from './core/store.js';
import { createQueue } from './core/queue.js';
import { runClaude } from './core/runner.js';
import { createNotifier } from './core/notifier.js';
import { registerSlack } from './triggers/slack.js';
import { registerCron } from './triggers/cron.js';
import wechatWorkflow from './workflows/wechat.js';
import mockChannel from './channels/mock.js';
import wechatDraft from './channels/wechat-draft.js';

const WORKFLOWS = { wechat: wechatWorkflow };
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
    if (env[k]) throw new Error(`主进程不得设置代理(${k});代理只允许注入 Claude 子进程。把代理配置放到 CHILD_HTTPS_PROXY 等专用变量。`);
  }
}

// 队列处理器工厂,便于注入 stub 做单测(store/runClaude/channels 均可替换)。
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
        // 用于本地/CI 演练全流程而不触碰真实微信 API。
        const channelId = process.env.HUB_DRY_RUN ? 'mock' : wf.channel;
        const channel = channels[channelId];
        const { mediaId, title } = await channel.publish({ articlePath: res.articlePath, config, workflow: wf, notify, notifier: deps.notifier });
        store.setMediaId(run.id, mediaId, title); // 早写,发布成功后立刻落库,支撑上面的幂等判断
        return { mediaId, title };
      }, wf.retries);
      store.setStatus(run.id, 'done', { title, mediaId, finishedAt: Date.now() });
      await deps.notifier.success(notify, { title, mediaId });
    } catch (e) {
      const stage = e.stage || 'publish';
      store.setStatus(run.id, 'failed', { stage, error: e.message, finishedAt: Date.now() });
      await deps.notifier.failure(notify, { stage, error: e.message });
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
  const enqueue = (t) => queue.enqueue({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...t });
  const app = await registerSlack({ config, enqueue });
  registerCron({ workflows: WORKFLOWS, enqueue });
  deps.notifier = createNotifier((m) => app.client.chat.postMessage(m));
  console.log('⚡ Zen Content Hub 已启动');
}

if (import.meta.url === `file://${process.argv[1]}`) start();
