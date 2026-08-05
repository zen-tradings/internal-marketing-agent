import boltPkg from '@slack/bolt';
import { extractExplicitEntityVersions, extractUserUrls } from '../core/analysis-v2.js';
import { attachmentsFromSlackMessages, normalizeSlackAttachments } from '../core/user-sources.js';
import { decodeBasicHtmlEntities } from '../lib/html-entities.js';
const { App } = boltPkg;

export function cleanSlackText(text) {
  return decodeBasicHtmlEntities(text)
    .replace(/<(https?:\/\/[^|>]+)\|[^>]*>/g, '$1')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .trim();
}

// Slack 在公共频道 @Bot 时可能同时投递 message 与 app_mention，两次投递的
// event_id 不同，但 channel + message ts 相同。任务去重必须使用消息身份，
// 不能优先使用 event_id，否则同一条指令会进入队列两次并创建重复草稿。
export function slackMessageEventKey({ channel, ts, eventId, revision } = {}) {
  if (channel && ts) {
    const suffix = revision && String(revision) !== '0' ? `:rev:${revision}` : '';
    return `message:${channel}:${ts}${suffix}`;
  }
  return eventId ? `event:${eventId}` : '';
}

export function parseSlackTask(raw, botUserId, { channelType, channel } = {}) {
  const t = raw.trim();
  if (/^(?:任务|task)\s*[:：]/i.test(t)) {
    return cleanSlackText(t.replace(/^(?:任务|task)\s*[:：]\s*/i, ''));
  }
  const m = t.match(/^<@([A-Z0-9]+)>\s+([\s\S]+)/);
  if (m && (m[1] === botUserId || !botUserId)) return cleanSlackText(m[2]);
  // 私聊中不要求“任务:”或 @mention，像普通 AI 对话一样直接接受自然语言。
  if (channelType === 'im' || String(channel || '').startsWith('D')) return cleanSlackText(t);
  return null;
}

// 中文别名 → 工作流 id。别名同样必须命中 workflowIds 才会真正路由。
const WORKFLOW_ALIASES = { 微信: 'wechat', 宏观: 'macro', 公司: 'company', 个股: 'company', 深度: 'company', 邮件: 'email', 财报: 'earnings', 行业: 'sector', 晨报: 'morning', 直译: 'translate', 翻译: 'translate' };

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

const MACRO_THEME_RE = /(?:宏观|央行|美联储|联储|欧洲央行|日本央行|人民银行|货币政策|财政政策|经济数据|通胀|非农|就业数据|CPI|PCE|GDP|PMI|利率|收益率曲线|实际利率|汇率|美元|人民币|日元|欧元|流动性|信用利差|风险偏好|波动率|跨资产|股票.{0,20}(?:债券|商品|汇率)|股债|黄金|原油|大宗商品|比特币|以太坊|数字资产|加密资产|\bmacro(?:economic)?\b|central\s+bank|Federal\s+Reserve|\bFed\b|monetary\s+policy|fiscal\s+policy|inflation|payrolls?|employment\s+data|interest\s+rates?|yield\s+curve|real\s+yields?|foreign\s+exchange|\bFX\b|liquidity|credit\s+spreads?|risk\s+(?:appetite|sentiment)|volatility|cross[- ]asset|equities.{0,30}(?:bonds?|commodities|currencies)|gold|crude\s+oil|commodit(?:y|ies)|bitcoin|ethereum|digital\s+assets?|crypto(?:currency|currencies)?)/i;
const MACRO_ANALYSIS_INTENT_RE = /(?:快评|点评|解读|分析|深度|机制|传导|定价|预期|增量|影响|策略|展望|情景|风险|观察|周报|复盘|框架|判断|市场反应|交易逻辑|\banaly(?:sis|ze|se)\b|commentary|quick\s+take|deep\s+dive|mechanism|transmission|pric(?:e|ed|ing)|expectations?|incremental|impact|strategy|outlook|scenario|risk|watch|weekly|review|framework|market\s+reaction)/i;

const NATURAL_RULES = [
  { id: 'email', re: /(?:newsletter|customer\.?io|email\s+(?:draft|campaign|newsletter)|subscriber\s+email|订阅者|邮件草稿|邮件通讯|电子报|发邮件)/i },
  // URL 只是素材，不代表翻译意图。只有用户明确要求翻译时才进入完整直译引擎。
  { id: 'translate', re: /(?:\btranslate\b|\b(?:full|complete|faithful|literal|direct)\s+translation\b|\btranslation\s+of\s+(?:this|the)\s+(?:article|paper|pdf|link|file|attachment)\b|直译|全文翻译|完整翻译|忠实翻译|逐字翻译|翻译成(?:简体)?中文|(?:请|帮我|需要|要)(?:完整)?翻译(?:这篇|这个|这份|全文|链接|文章|文件|附件|文档|PDF))/i },
  { id: 'morning', re: /(?:\b(?:morning|daily|pre-?market|overnight)\s+(?:brief|briefing|report|digest)\b|晨报|早报|盘前简报|隔夜(?:市场|要闻))/i },
  { id: 'earnings', re: /(?:\bearnings\s+(?:review|analysis|recap|update|report)\b|\bquarterly\s+(?:earnings|results?)\b|\bactuals?\s+(?:vs\.?\s+)?(?:consensus|expectations?)\b|\bguidance\s+(?:change|update|revision)\b|财报点评|业绩点评|本季财报|实际.*预期|指引变化)/i },
  { id: 'sector', re: /(?:\b(?:industry|sector)\s+(?:analysis|research|review|report|overview|deep\s*dive)\b|\bmarket\s+landscape\b|行业综述|产业综述|赛道分析|行业研究|产业研究|研究.{0,20}(?:行业|产业)|(?:行业|产业).{0,12}(?:供需|格局|研究|分析))/i },
  { id: 'company', re: /(?:\b(?:company|stock|equity)\s+(?:analysis|research|deep\s*dive)\b|\b(?:in-?depth\s+analysis|company\s+deep\s+dive)\b|\b(?:financial\s+analysis|competitive\s+landscape|competitors?|value\s+chain|supply\s+chain)\b|\b(?:recent|last)\s+(?:four|five|six|[4-6])\s+quarters?\b|公司深度|个股深度|公司分析|公司研究|个股分析|个股研究|深度分析|财务分析|竞争格局|竞争对手|产业链|上下游|最近[四五六0-9]+个季度)/i },
  {
    id: 'macro',
    test: (text) => MACRO_THEME_RE.test(text) && MACRO_ANALYSIS_INTENT_RE.test(text),
    reason: 'macro-theme+analysis-intent',
  },
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
  if (/https?:\/\/\S+/i.test(task) && /(?:\btranslate\b|\b(?:full|complete|faithful|literal|direct)\s+translation\b|\btranslation\s+of\s+(?:this|the)\s+(?:article|paper|pdf|link|file|attachment)\b|直译|全文翻译|完整翻译|忠实翻译|逐字翻译|翻译)/i.test(task)) {
    const matched = workflowIds.find((id) => id.toLowerCase() === 'translate');
    if (matched) return { workflowId: matched, task, reason: 'translation-keyword-with-url' };
  }

  // 模型/产品能力比较是 prompt 驱动分析，不是“公司深度”。不能仅因出现
  // deep dive/in-depth analysis 就触发财务、SEC、季度数据和价值链搜索。
  const explicitModelEntities = extractExplicitEntityVersions(task);
  if (explicitModelEntities.length >= 2
    && /(?:比较|对比|\bcompar(?:e|ing|ison)\b|\bversus\b|\bvs\.?\b)/i.test(task)) {
    const matched = workflowIds.find((id) => id.toLowerCase() === 'wechat');
    if (matched) return { workflowId: matched, task, reason: 'model-comparison' };
  }

  for (const rule of NATURAL_RULES) {
    if (rule.test ? !rule.test(task) : !rule.re.test(task)) continue;
    const matched = workflowIds.find((id) => id.toLowerCase() === rule.id);
    if (matched) return { workflowId: matched, task, reason: rule.reason || 'natural-rule' };
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
          reasoning: { effort: writer.routerReasoningEffort || 'none', exclude: true },
          messages: [
            { role: 'system', content: `Classify a Slack writing request. Return JSON only: {"workflowId":"..."}. Allowed: ${workflowIds.join(', ')}. A URL is research material, not translation intent. Never choose translate for a URL alone; choose translate only when the user explicitly asks for faithful/full translation. email=newsletter/Customer.io; earnings=quarterly earnings; sector=industry; morning=daily brief; company=single-company deep dive including financials, competitors, or value chain; macro=cross-asset macro analysis that combines a macro/market theme with analytical intent, including policy, economic data, rates, FX, liquidity, equities, commodities, credit, risk appetite, volatility, or digital assets; sector=single-industry research; wechat=other public-account analysis and bare URLs. For mixed requests, choose the one workflow that answers the user's final question.` },
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
    macro: '原创全球宏观策略 → 微信草稿箱',
    wechat: '原创分析 → 微信草稿箱',
  })[workflowId] || `${workflowId} → 草稿`;
}

export function isSlackStopCommand(task) {
  const value = String(task || '')
    .trim()
    .replace(/[。.!！?？]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  return /^(?:(?:请|麻烦)(?:你)?\s*)?(?:停止|取消|终止)(?:(?:当前|这个|正在运行的)?(?:任务|作业|进程))?(?:吧|一下)?$/.test(value)
    || /^(?:停一下|别做了|不要继续(?:了)?|不用继续(?:了)?)$/.test(value)
    || /^(?:please\s+)?(?:stop|cancel|abort|terminate|kill)(?:\s+(?:the\s+)?(?:current\s+|running\s+|this\s+)?(?:task|job|process))?(?:\s+it)?$/.test(value);
}

export function slackStopResponse(result) {
  if (result?.kind === 'active' || result?.kind === 'stopping') {
    return `🛑 已收到停止指令，正在中断任务 ${result.run?.id || ''}；完成后会在原任务线程确认文件清理结果。`;
  }
  if (result?.kind === 'pending') {
    return result.cleanupError
      ? `⚠️ 已取消排队任务 ${result.run?.id || ''}，但文件清理失败:${result.cleanupError}`
      : `🛑 已取消排队任务 ${result.run?.id || ''}；未创建草稿，未完成文件已清理。`;
  }
  if (result?.kind === 'too-late') {
    return '⚠️ 当前任务已经进入草稿创建阶段。为避免出现“草稿已创建但本地没有记录”，此时不再强制中断；本次只会创建草稿，不会发送或排期。';
  }
  return 'ℹ️ 当前频道没有可停止的运行中或排队任务。';
}

export function mergeSlackThreadMessages(messages, incoming) {
  const next = Array.isArray(messages) ? messages.map((message) => ({ ...message })) : [];
  const index = next.findIndex((message) => String(message.ts) === String(incoming.ts));
  if (index >= 0) next[index] = { ...next[index], ...incoming };
  else next.push({ ...incoming });
  return next
    .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
    .slice(-12);
}

export function buildSlackThreadInput(messages, { clarification } = {}) {
  const list = Array.isArray(messages) ? messages.filter((message) => message?.text) : [];
  if (!list.length) return '';
  if (list.length === 1) return list[0].text;
  const followups = list.slice(1).map((message) => `- ${message.text}`).join('\n');
  const clarificationBlock = clarification?.question
    ? `\n\n【系统曾询问的核心确认】\n${clarification.question}\n\n【用户确认与后续要求】\n${followups}`
    : `\n\n【同一 Slack 线程的后续要求】\n${followups}`;
  return `${list[0].text}${clarificationBlock}`;
}

export function slackPromptMetadata(input, promptRevision = 1, attachments = []) {
  return {
    promptRevision,
    promptEntities: extractExplicitEntityVersions(input).map((entity) => entity.literal),
    userUrlCount: extractUserUrls(input).length,
    userFileCount: Array.isArray(attachments) ? attachments.length : 0,
    freshnessRequirement: /(?:最新|近期|刚发布|新发布|当前|\blatest\b|\bcurrent\b|\bnewly\s+released\b|\brecent(?:ly)?\b)/i.test(input)
      ? '最新信息'
      : '按任务需要核对当前信息',
  };
}

export async function registerSlack({
  config,
  enqueue,
  cancelTask,
  store,
  onReady,
  workflowIds = [],
  defaultWorkflowId = 'wechat',
}) {
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
  const handle = async ({
    channel,
    ts,
    threadTs,
    channelType,
    raw,
    user,
    eventId,
    revision,
    attachments = [],
    isEdit = false,
  }) => {
    const task = parseSlackTask(raw, botId, { channelType, channel });
    if (!task) return;
    if (!isAuthorized({ user, channel })) {
      console.error(`[slack] 已拒绝未授权任务:user=${user || 'unknown'} channel=${channel || 'unknown'}`);
      return;
    }
    const eventKey = slackMessageEventKey({ channel, ts, eventId, revision });
    if (!dedup(eventKey)) return;
    const stopCommand = isSlackStopCommand(task);
    if (!stopCommand && !withinRateLimit(user)) {
      console.error(`[slack] 已限流:user=${user || 'unknown'} 每分钟上限=${rateLimit}`);
      return;
    }
    const claimed = store?.claimSlackEvent ? store.claimSlackEvent(eventKey) : true;
    if (!claimed) return;
    if (stopCommand) {
      try {
        const rootTs = threadTs || ts;
        const threadRunId = threadTs
          ? store?.getSlackThread?.(`${channel}:${threadTs}`)?.last_run_id
          : undefined;
        const result = await cancelTask?.({
          runId: threadRunId,
          channel,
          user,
          reason: `Slack 用户 ${user || 'unknown'} 请求停止当前任务`,
        }) || { kind: 'none' };
        await app.client.chat.postMessage({
          channel,
          thread_ts: rootTs,
          text: slackStopResponse(result),
        });
        return;
      } catch (error) {
        store?.releaseSlackEvent?.(eventKey);
        throw error;
      }
    }
    let enqueued = false;
    try {
      const rootTs = threadTs || ts;
      const threadKey = `${channel}:${rootTs}`;
      const previous = store?.getSlackThread?.(threadKey);
      const isThreadRevision = Boolean(previous && (isEdit || threadTs));
      if (isThreadRevision && previous?.last_run_id) {
        const result = await cancelTask?.({
          runId: previous.last_run_id,
          channel,
          user,
          reason: isEdit
            ? `Slack 用户 ${user || 'unknown'} 编辑了原始 Prompt，旧修订已被替换`
            : `Slack 用户 ${user || 'unknown'} 在线程补充了 Prompt，旧修订已被替换`,
        });
        if (result?.kind === 'too-late') {
          await app.client.chat.postMessage({
            channel,
            thread_ts: rootTs,
            text: '⚠️ 这条任务已经进入草稿创建阶段或已经创建草稿，当前编辑/补充不会覆盖它。请重新 @zenbot 提交完整 Prompt，避免产生无法确认的新旧版本。',
          });
          return;
        }
        if (result?.done) await result.done;
      }
      const route = await resolveNaturalWorkflowTask(task, {
        workflowIds,
        defaultWorkflowId,
        previousWorkflowId: previous?.workflow_id,
        classify,
      });
      const incomingText = String(ts) === String(rootTs) ? route.task : task;
      const promptRevision = previous ? Number(previous.prompt_revision || 1) + 1 : 1;
      const incomingAttachments = normalizeSlackAttachments(attachments);
      const messages = mergeSlackThreadMessages(previous?.messages, {
        text: incomingText,
        ts,
        revision: revision || '0',
        edited: Boolean(isEdit),
        ...(incomingAttachments.length ? { attachments: incomingAttachments } : {}),
      });
      const input = buildSlackThreadInput(messages, { clarification: previous?.clarification });
      const userAttachments = attachmentsFromSlackMessages(messages);
      const metadata = slackPromptMetadata(input, promptRevision, userAttachments);
      const run = enqueue({
        workflowId: route.workflowId,
        source: 'slack',
        input,
        notify: {
          channel,
          ts: rootTs,
          user,
          routeLabel: workflowRouteLabel(route.workflowId),
          routeReason: route.reason,
          threadKey,
          attachments: userAttachments,
          ...(previous?.clarification?.question ? {
            resolvedClarification: {
              question: previous.clarification.question,
              answered: true,
            },
          } : {}),
          ...metadata,
        },
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
          promptRevision,
        });
      } catch (error) {
        console.error('[slack] 线程上下文写入失败(任务已入队):', error?.message || error);
      }
    } catch (error) {
      if (!enqueued) store?.releaseSlackEvent?.(eventKey);
      throw error;
    }
  };
  const pendingMessages = new Map();
  const debounceMs = Number(config.slack.editDebounceMs ?? 5000);
  const scheduleHandle = (payload) => {
    const parsed = parseSlackTask(payload.raw, botId, { channelType: payload.channelType, channel: payload.channel });
    if (parsed && isSlackStopCommand(parsed)) return handle(payload);
    const identity = `${payload.channel}:${payload.ts}`;
    const existing = pendingMessages.get(identity);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pendingMessages.delete(identity);
      Promise.resolve(handle(payload)).catch((error) => {
        console.error('[slack] 延迟任务处理失败:', error?.message || error);
      });
    }, Math.max(0, debounceMs));
    pendingMessages.set(identity, timer);
    return Promise.resolve();
  };
  app.message(async ({ message, body }) => {
    if (!message.bot_id
      && (!message.subtype || message.subtype === 'file_share')
      && (message.text || message.files?.length)) {
      await scheduleHandle({
        channel: message.channel,
        ts: message.ts,
        threadTs: message.thread_ts,
        channelType: message.channel_type,
        raw: message.text || '',
        attachments: message.files,
        user: message.user,
        eventId: body?.event_id,
        revision: '0',
      });
      return;
    }
    if (message.subtype === 'message_changed' && !message.message?.bot_id && message.message?.text) {
      const edited = message.message;
      await scheduleHandle({
        channel: message.channel,
        ts: edited.ts,
        threadTs: edited.thread_ts,
        channelType: edited.channel_type || message.channel_type,
        raw: edited.text,
        attachments: edited.files,
        user: edited.user,
        eventId: body?.event_id,
        revision: edited.edited?.ts || message.event_ts || body?.event_id,
        isEdit: true,
      });
    }
  });
  app.event('app_mention', async ({ event, body }) => {
    await scheduleHandle({
      channel: event.channel,
      ts: event.ts,
      threadTs: event.thread_ts,
      channelType: event.channel_type,
      raw: event.text,
      attachments: event.files,
      user: event.user,
      eventId: body?.event_id,
      revision: '0',
    });
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
