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

// 中文别名 → 工作流 id。别名同样必须命中 workflowIds 才会真正路由。
const WORKFLOW_ALIASES = { 微信: 'wechat', 公司: 'company', 个股: 'company', 深度: 'company', 邮件: 'email', 财报: 'earnings', 行业: 'sector', 晨报: 'morning', 直译: 'translate', 翻译: 'translate' };

// 中文别名按长度从长到短排序,支持多个别名互为前缀时优先取最长匹配。
const SORTED_ALIAS_KEYS = Object.keys(WORKFLOW_ALIASES).sort((a, b) => b.length - a.length);

// 任务文本路由规则:
// 1) 中文别名(WORKFLOW_ALIASES 的键)不要求分隔符——别名后紧跟内容、空格或冒号均可识别,
//    例如 "直译https://x"、"直译 https://x"、"直译：x" 都路由到 translate。
// 2) 英文工作流 id(workflowIds 本身)仍要求冒号前缀 "id: 内容",避免正文里出现同名英文单词
//    被误判为路由前缀(如 "wechatXXX 写点东西" 不应被当成 wechat 工作流)。
// 命中已注册的 workflowIds(或其中文别名映射到的 workflowIds)才路由,否则整段文本走
// defaultWorkflowId,不报错。剥离别名/前缀后任务文本为空也照常路由,交给工作流兜底处理。
export function resolveWorkflowTask(task, workflowIds = [], defaultWorkflowId = 'wechat') {
  for (const alias of SORTED_ALIAS_KEYS) {
    if (!task.startsWith(alias)) continue;
    const candidate = WORKFLOW_ALIASES[alias];
    const matched = workflowIds.find((id) => id.toLowerCase() === candidate.toLowerCase());
    if (!matched) continue;
    const rest = task.slice(alias.length).replace(/^[:：]?\s*/, '');
    return { workflowId: matched, task: rest.trim() };
  }

  const m = task.match(/^([^\s:：]+)[:：]\s*([\s\S]*)$/);
  if (m) {
    const matched = workflowIds.find((id) => id.toLowerCase() === m[1].toLowerCase());
    if (matched) return { workflowId: matched, task: m[2].trim() };
  }
  const company = workflowIds.find((id) => id.toLowerCase() === 'company');
  if (company && /(?:财务|财报|营收|毛利)/.test(task) && /(?:竞争对手|竞争格局)/.test(task) && /(?:上下游|产业链|供应链)/.test(task)) {
    return { workflowId: company, task };
  }
  return { workflowId: defaultWorkflowId, task };
}

export async function registerSlack({ config, enqueue, onReady, workflowIds = [], defaultWorkflowId = 'wechat' }) {
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
    const { workflowId, task: input } = resolveWorkflowTask(task, workflowIds, defaultWorkflowId);
    enqueue({ workflowId, source: 'slack', input, notify: { channel, ts } });
  };
  app.message(async ({ message }) => { if (!message.bot_id && message.text) handle(message.channel, message.ts, message.text); });
  app.event('app_mention', async ({ event }) => handle(event.channel, event.ts, event.text));
  await app.start();
  botId = (await app.client.auth.test()).user_id;
  onReady?.(app);
  return app;
}
