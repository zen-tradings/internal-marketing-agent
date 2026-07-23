import boltPkg from '@slack/bolt';
const { App } = boltPkg;

export function cleanSlackText(text) {
  return text
    .replace(/<(https?:\/\/[^|>]+)\|[^>]*>/g, '$1')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .trim();
}

export function parseSlackTask(raw, botUserId, { channelType, channel } = {}) {
  const t = raw.trim();
  if (/^任务[:：]/.test(t)) return cleanSlackText(t.replace(/^任务[:：]\s*/, ''));
  const m = t.match(/^<@([A-Z0-9]+)>\s+([\s\S]+)/);
  if (m && (m[1] === botUserId || !botUserId)) return cleanSlackText(m[2]);
  // 私聊中不要求“任务:”或 @mention，像普通 AI 对话一样直接接受自然语言。
  if (channelType === 'im' || String(channel || '').startsWith('D')) return cleanSlackText(t);
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

const NATURAL_RULES = [
  { id: 'email', re: /(?:newsletter|customer\.?io|订阅者|邮件草稿|邮件通讯|电子报|发邮件)/i },
  // URL 只是素材，不代表翻译意图。只有用户明确要求翻译时才进入完整直译引擎。
  { id: 'translate', re: /(?:直译|全文翻译|完整翻译|忠实翻译|逐字翻译|翻译成(?:简体)?中文|(?:请|帮我|需要|要)(?:完整)?翻译(?:这篇|这个|全文|链接|文章))/i },
  { id: 'morning', re: /(?:晨报|早报|盘前简报|隔夜(?:市场|要闻))/i },
  { id: 'earnings', re: /(?:财报点评|业绩点评|本季财报|earnings\s+(?:review|analysis)|实际.*预期|指引变化)/i },
  { id: 'sector', re: /(?:行业综述|产业综述|赛道分析|行业研究|产业研究)/i },
  { id: 'company', re: /(?:公司深度|个股深度|公司分析|公司研究|个股分析|个股研究|深度分析|财务分析|竞争格局|竞争对手|产业链|上下游|最近[四五六0-9]+个季度)/i },
  // 只有一个 URL 且没有任务动词时，按“模糊任务默认公众号分析”处理；绝不猜成直译。
  { id: 'wechat', re: /^\s*https?:\/\/\S+\s*$/i },
];

function explicitWorkflowTask(task, workflowIds = []) {
  for (const alias of SORTED_ALIAS_KEYS) {
    if (!task.startsWith(alias)) continue;
    const candidate = WORKFLOW_ALIASES[alias];
    const matched = workflowIds.find((id) => id.toLowerCase() === candidate.toLowerCase());
    if (!matched) continue;
    return { workflowId: matched, task: task.slice(alias.length).replace(/^[:：]?\s*/, '').trim(), explicit: true };
  }
  const m = task.match(/^([^\s:：]+)[:：]\s*([\s\S]*)$/);
  if (!m) return null;
  const matched = workflowIds.find((id) => id.toLowerCase() === m[1].toLowerCase());
  return matched ? { workflowId: matched, task: m[2].trim(), explicit: true } : null;
}

export async function resolveNaturalWorkflowTask(task, {
  workflowIds = [],
  defaultWorkflowId = 'wechat',
  previousWorkflowId,
  classify,
} = {}) {
  const explicit = explicitWorkflowTask(task, workflowIds);
  if (explicit) return { ...explicit, reason: 'explicit-prefix' };

  // Slack 中最常见的直译用法是自然语言里出现“翻译/直译”并附链接，不一定把
  // 关键词放在句首。URL + 明确翻译词构成稳定的强意图，优先于其它主题词路由。
  if (/https?:\/\/\S+/i.test(task) && /(?:直译|全文翻译|完整翻译|忠实翻译|逐字翻译|翻译)/i.test(task)) {
    const matched = workflowIds.find((id) => id.toLowerCase() === 'translate');
    if (matched) return { workflowId: matched, task, reason: 'translation-keyword-with-url' };
  }

  for (const rule of NATURAL_RULES) {
    if (!rule.re.test(task)) continue;
    const matched = workflowIds.find((id) => id.toLowerCase() === rule.id);
    if (matched) return { workflowId: matched, task, reason: 'natural-rule' };
  }

  // 线程里的短补充通常不包含完整意图，默认继承上一任务的工作流。
  if (previousWorkflowId && workflowIds.includes(previousWorkflowId) && String(task).trim().length < 160) {
    return { workflowId: previousWorkflowId, task, reason: 'thread-context' };
  }

  if (typeof classify === 'function') {
    try {
      const id = await classify(task, workflowIds);
      const matched = workflowIds.find((workflowId) => workflowId.toLowerCase() === String(id || '').toLowerCase());
      if (matched) return { workflowId: matched, task, reason: 'model-classifier' };
    } catch (error) {
      console.error('[slack] 自然语言路由模型失败,回退微信公众号:', error.message);
    }
  }
  return { workflowId: defaultWorkflowId, task, reason: 'default-wechat' };
}

export function createSlackIntentClassifier(config, fetchFn = globalThis.fetch) {
  return async function classify(task, workflowIds) {
    const writer = config?.writer || {};
    if (!writer.openrouterApiKey || !writer.model) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetchFn(`${String(writer.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${writer.openrouterApiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': writer.httpReferer || 'https://zentradings.com',
          'X-OpenRouter-Title': writer.appTitle || 'Zen Content Hub',
        },
        body: JSON.stringify({
          model: writer.routerModel || writer.model,
          temperature: 0,
          // GLM 等模型即使 reasoning=none 也可能消耗少量隐藏 token。
          // 给短 JSON 足够预算，避免 80 token 时正文为空而错误回退默认路由。
          max_tokens: 256,
          reasoning: { effort: 'none', exclude: true },
          messages: [
            { role: 'system', content: `Classify a Slack writing request. Return JSON only: {"workflowId":"..."}. Allowed: ${workflowIds.join(', ')}. A URL is research material, not translation intent. Never choose translate for a URL alone; choose translate only when the user explicitly asks for faithful/full translation. email=newsletter/Customer.io; earnings=quarterly earnings; sector=industry; morning=daily brief; company=company deep dive including financials, competitors, or value chain; wechat=other public-account analysis and bare URLs.` },
            { role: 'user', content: String(task).slice(0, 4000) },
          ],
        }),
      });
      if (!response.ok) return undefined;
      const data = await response.json();
      const raw = data?.choices?.[0]?.message?.content;
      const text = Array.isArray(raw) ? raw.map((part) => part?.text || '').join('') : String(raw || '');
      const json = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
      return json.workflowId;
    } finally { clearTimeout(timer); }
  };
}

export function workflowRouteLabel(workflowId) {
  return ({
    translate: '完整直译 → 微信草稿箱',
    email: 'Newsletter → Customer.io 草稿',
    earnings: '原创财报分析 → 微信草稿箱',
    sector: '原创行业分析 → 微信草稿箱',
    morning: '原创晨报 → 微信草稿箱',
    company: '原创公司深度 → 微信草稿箱',
    wechat: '原创分析 → 微信草稿箱',
  })[workflowId] || `${workflowId} → 草稿`;
}

export async function registerSlack({ config, enqueue, store, onReady, workflowIds = [], defaultWorkflowId = 'wechat' }) {
  const app = new App({ token: config.slack.botToken, appToken: config.slack.appToken, socketMode: true, logLevel: 'warn' });
  // bolt 分发层错误(事件处理器抛错等)在此兜底,避免冒泡。注意:socket-mode 状态机
  // 内部的 finity 崩溃不走这里,由 index.js 的进程级守卫容忍并触发重连。
  app.error(async (error) => { console.error('[slack] bolt error:', (error && error.message) || error); });
  const seen = new Set();
  const dedup = (key) => { if (seen.has(key)) return false; seen.add(key); setTimeout(() => seen.delete(key), 1800000).unref?.(); return true; };
  const rateWindows = new Map();
  const allowedUsers = new Set(config.slack.allowedUserIds || []);
  const allowedChannels = new Set(config.slack.allowedChannelIds || []);
  const rateLimit = Number(config.slack.rateLimitPerMinute || 10);
  const isAuthorized = ({ user, channel }) => {
    if (allowedUsers.size && !allowedUsers.has(user)) return false;
    if (allowedChannels.size && !allowedChannels.has(channel)) return false;
    return true;
  };
  const withinRateLimit = (user) => {
    const key = user || 'unknown';
    const cutoff = Date.now() - 60000;
    const recent = (rateWindows.get(key) || []).filter((at) => at >= cutoff);
    if (recent.length >= rateLimit) { rateWindows.set(key, recent); return false; }
    recent.push(Date.now());
    rateWindows.set(key, recent);
    return true;
  };
  let botId = '';
  const classify = createSlackIntentClassifier(config);
  const handle = async ({ channel, ts, threadTs, channelType, raw, user, eventId }) => {
    const task = parseSlackTask(raw, botId, { channelType, channel });
    if (!task) return;
    if (!isAuthorized({ user, channel })) {
      console.error(`[slack] 已拒绝未授权任务:user=${user || 'unknown'} channel=${channel || 'unknown'}`);
      return;
    }
    const eventKey = eventId || `${channel}:${ts}`;
    if (!dedup(eventKey)) return;
    if (!withinRateLimit(user)) {
      console.error(`[slack] 已限流:user=${user || 'unknown'} 每分钟上限=${rateLimit}`);
      return;
    }
    const claimed = store?.claimSlackEvent ? store.claimSlackEvent(eventKey) : true;
    if (!claimed) return;
    let enqueued = false;
    try {
    const rootTs = threadTs || ts;
    const threadKey = `${channel}:${rootTs}`;
    const previous = store?.getSlackThread?.(threadKey);
    const route = await resolveNaturalWorkflowTask(task, {
      workflowIds,
      defaultWorkflowId,
      previousWorkflowId: previous?.workflow_id,
      classify,
    });
    const messages = [...(previous?.messages || []), { text: task, ts }].slice(-12);
    const input = messages.length === 1
      ? route.task
      : `${messages[0].text}\n\n【同一 Slack 线程的后续要求】\n${messages.slice(1).map((message) => `- ${message.text}`).join('\n')}`;
    const run = enqueue({
      workflowId: route.workflowId,
      source: 'slack',
      input,
      notify: { channel, ts: rootTs, routeLabel: workflowRouteLabel(route.workflowId), threadKey },
    });
    enqueued = true;
    try {
      store?.upsertSlackThread?.({
        threadKey,
        channelId: channel,
        threadTs: rootTs,
        workflowId: route.workflowId,
        messages,
        lastRunId: run?.id,
      });
    } catch (error) {
      console.error('[slack] 线程上下文写入失败(任务已入队):', error?.message || error);
    }
    } catch (error) {
      if (!enqueued) store?.releaseSlackEvent?.(eventKey);
      throw error;
    }
  };
  app.message(async ({ message, body }) => {
    if (!message.bot_id && !message.subtype && message.text) {
      await handle({ channel: message.channel, ts: message.ts, threadTs: message.thread_ts, channelType: message.channel_type, raw: message.text, user: message.user, eventId: body?.event_id });
    }
  });
  app.event('app_mention', async ({ event, body }) => {
    await handle({ channel: event.channel, ts: event.ts, threadTs: event.thread_ts, channelType: event.channel_type, raw: event.text, user: event.user, eventId: body?.event_id });
  });
  botId = (await app.client.auth.test()).user_id;
  try { await app.start(); }
  catch (error) {
    try { await app.stop(); } catch {}
    throw error;
  }
  onReady?.(app);
  return app;
}
