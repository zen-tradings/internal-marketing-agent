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

export function assertMainProcessDirect(env = process.env) {
  for (const k of ['https_proxy', 'http_proxy', 'all_proxy', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']) {
    if (env[k]) throw new Error(`主进程不得设置代理(${k});代理只允许注入 Claude 子进程。把代理配置放到 CHILD_HTTPS_PROXY 等专用变量。`);
  }
}

export async function start() {
  assertMainProcessDirect();
  const config = loadConfig();
  const store = openStore(config.dbPath);
  const interrupted = store.markInterrupted();
  if (interrupted) console.log(`[hub] 启动:${interrupted} 个残留任务标记为 interrupted`);

  let notifier;
  const handler = async (run) => {
    const wf = WORKFLOWS[run.workflowId];
    const notify = JSON.parse(store.getRun(run.id).notify_json || '{}');
    store.setStatus(run.id, 'running', { startedAt: Date.now() });
    const res = await runClaude({ workflow: wf, input: run.input, config });
    if (!res.ok) { store.setStatus(run.id, 'failed', { stage: 'generate', error: res.stderr, finishedAt: Date.now() });
      await notifier.failure(notify, { stage: 'generate', error: res.stderr }); return; }
    try {
      const channel = CHANNELS[wf.channel];
      const { mediaId, title } = await channel.publish({ articlePath: res.articlePath, config, workflow: wf, notify, notifier });
      store.setStatus(run.id, 'done', { title, mediaId, finishedAt: Date.now() });
      await notifier.success(notify, { title, mediaId });
    } catch (e) {
      const stage = e.stage || 'publish';
      store.setStatus(run.id, 'failed', { stage, error: e.message, finishedAt: Date.now() });
      await notifier.failure(notify, { stage, error: e.message });
    }
  };

  const queue = createQueue({ store, maxConcurrency: config.maxConcurrency, handler });
  const enqueue = (t) => queue.enqueue({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...t });
  const app = await registerSlack({ config, enqueue });
  registerCron({ workflows: WORKFLOWS, enqueue });
  notifier = createNotifier((m) => app.client.chat.postMessage(m));
  console.log('⚡ Zen Content Hub 已启动');
}

if (import.meta.url === `file://${process.argv[1]}`) start();
