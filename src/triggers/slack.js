import boltPkg from '@slack/bolt';
const { App } = boltPkg;

export function cleanSlackText(text) {
  return text
    .replace(/<(https?:\/\/[^|>]+)\|[^>]*>/g, '$1')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .trim();
}

export function parseSlackTask(raw, botUserId) {
  const t = raw.trim();
  if (/^任务[:：]/.test(t)) return cleanSlackText(t.replace(/^任务[:：]\s*/, ''));
  const m = t.match(/^<@([A-Z0-9]+)>\s+([\s\S]+)/);
  if (m && (m[1] === botUserId || !botUserId)) return cleanSlackText(m[2]);
  return null;
}

export async function registerSlack({ config, enqueue, onReady }) {
  const app = new App({ token: config.slack.botToken, appToken: config.slack.appToken, socketMode: true, logLevel: 'warn' });
  // bolt 分发层错误(事件处理器抛错等)在此兜底,避免冒泡。注意:socket-mode 状态机
  // 内部的 finity 崩溃不走这里,由 index.js 的进程级守卫容忍并触发重连。
  app.error(async (error) => { console.error('[slack] bolt error:', (error && error.message) || error); });
  const seen = new Set();
  const dedup = (ts) => { if (seen.has(ts)) return false; seen.add(ts); setTimeout(() => seen.delete(ts), 1800000); return true; };
  let botId = '';
  const handle = (channel, ts, raw) => {
    if (!dedup(ts)) return;
    const task = parseSlackTask(raw, botId);
    if (!task) return;
    enqueue({ workflowId: 'wechat', source: 'slack', input: task, notify: { channel, ts } });
  };
  app.message(async ({ message }) => { if (!message.bot_id && message.text) handle(message.channel, message.ts, message.text); });
  app.event('app_mention', async ({ event }) => handle(event.channel, event.ts, event.text));
  await app.start();
  botId = (await app.client.auth.test()).user_id;
  onReady?.(app);
  return app;
}
