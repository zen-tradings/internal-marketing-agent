import boltPkg from '@slack/bolt';
import { extractExplicitEntityVersions, extractUserUrls } from '../core/analysis-v2.js';
import { attachmentsFromSlackMessages, normalizeSlackAttachments } from '../core/user-sources.js';
import { detectQdiiTaskPlan } from '../core/qdii.js';
import { decodeBasicHtmlEntities } from '../lib/html-entities.js';
import { createSlackPostScheduler } from '../core/notifier.js';
import {
  OPTIONS_STRATEGY_PROFILE,
  resolveOptionsStrategyProfile,
} from '../lib/options-strategy-route.js';
const { App } = boltPkg;

export function cleanSlackText(text) {
  return decodeBasicHtmlEntities(text)
    .replace(/<(https?:\/\/[^|>]+)\|[^>]*>/g, '$1')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .trim();
}

// A public-channel @Bot can deliver both message and app_mention with distinct event_id values but identical
// channel/message timestamps. Deduplicate by message identity, not event_id, to prevent duplicate drafts.
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
  // Direct messages accept natural language without a task prefix or @mention.
  if (channelType === 'im' || String(channel || '').startsWith('D')) return cleanSlackText(t);
  return null;
}

// Chinese aliases map to workflow IDs and must still resolve to a registered workflow.
const WORKFLOW_ALIASES = { 微信: 'wechat', 宏观: 'macro', 公司: 'company', 个股: 'company', 深度: 'company', 邮件: 'email', 财报: 'earnings', 行业: 'sector', 晨报: 'morning', 开市日报: 'opening-digest', 开市简报: 'opening-digest', 直译: 'translate', 翻译: 'translate', 基金查询: 'qdii' };

const ENGLISH_ROUTE_ALIASES = Object.freeze({ fund: 'qdii', holding: 'qdii', holdings: 'qdii', newsletter: 'email' });

function englishAliasTask(task, workflowIds) {
  const match = String(task || '').match(/^([A-Za-z-]+)\s*[:：]\s*([\s\S]*)$/);
  if (!match) return null;
  const candidate = ENGLISH_ROUTE_ALIASES[match[1].toLowerCase()];
  if (!candidate) return null;
  const workflowId = workflowIds.find((id) => id.toLowerCase() === candidate);
  return workflowId ? { workflowId, task: match[2].trim() } : null;
}

// Sort Chinese aliases longest-first so aliases that share prefixes choose the longest match.
const SORTED_ALIAS_KEYS = Object.keys(WORKFLOW_ALIASES).sort((a, b) => b.length - a.length);

// Task-routing rules: Chinese aliases do not require a delimiter and may be followed by content, whitespace, or
// a colon. English workflow IDs still require an id: prefix to avoid false positives in body text. Route only a
// registered ID (or a registered alias mapping); otherwise use defaultWorkflowId. Empty post-prefix text still routes.
export function resolveWorkflowTask(task, workflowIds = [], defaultWorkflowId = 'wechat') {
  const englishAlias = englishAliasTask(task, workflowIds);
  if (englishAlias) return englishAlias;
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
  { id: 'opening-digest', re: /(?:opening\s+digest|market\s+open(?:ing)?\s+digest|开市日报|开市简报)/i },
  { id: 'email', re: /(?:newsletter|customer\.?io|email\s+(?:draft|campaign|newsletter)|subscriber\s+email|订阅者|邮件草稿|邮件通讯|电子报|发邮件)/i },
  // A URL is source material, not translation intent; use the full translation engine only for an explicit request.
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
  // A single URL without a task verb is an ambiguous request and defaults to WeChat analysis, never translation.
  { id: 'wechat', re: /^\s*https?:\/\/\S+\s*$/i },
];

function explicitWorkflowTask(task, workflowIds = []) {
  const englishAlias = englishAliasTask(task, workflowIds);
  if (englishAlias) return { ...englishAlias, explicit: true };
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

  const qdiiPlan = detectQdiiTaskPlan(task);
  if (qdiiPlan.qdii) {
    const target = qdiiPlan.destination === 'newsletter' ? 'email'
      : qdiiPlan.destination === 'wechat' ? 'wechat'
        : 'qdii';
    const matched = workflowIds.find((id) => id.toLowerCase() === target);
    if (matched) return { workflowId: matched, task, reason: 'qdii-data-intent', qdiiPlan };
  }

  // Common Slack translations mention a translation word with a link in natural language rather than as a prefix.
  // A URL plus explicit translation language is strong intent and outranks topic routing.
  if (/https?:\/\/\S+/i.test(task) && /(?:\btranslate\b|\b(?:full|complete|faithful|literal|direct)\s+translation\b|\btranslation\s+of\s+(?:this|the)\s+(?:article|paper|pdf|link|file|attachment)\b|直译|全文翻译|完整翻译|忠实翻译|逐字翻译|翻译)/i.test(task)) {
    const matched = workflowIds.find((id) => id.toLowerCase() === 'translate');
    if (matched) return { workflowId: matched, task, reason: 'translation-keyword-with-url' };
  }

  // Model or product capability comparison is prompt-driven analysis, not a company deep dive. Do not trigger
  // financial, SEC, quarterly-data, or value-chain research solely because deep-dive wording appears.
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

  // Short thread follow-ups often lack complete intent, so inherit the prior task workflow.
  if (previousWorkflowId && workflowIds.includes(previousWorkflowId) && String(task).trim().length < 160) {
    return { workflowId: previousWorkflowId, task, reason: 'thread-context' };
  }

  if (typeof classify === 'function') {
    try {
      const classification = await classify(task, workflowIds);
      const id = typeof classification === 'object' ? classification?.workflowId : classification;
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
          // Models such as GLM can consume hidden tokens even with reasoning=none. Reserve enough for short JSON
          // so an empty 80-token body cannot incorrectly fall back to the default route.
          max_tokens: 256,
          reasoning: { effort: writer.routerReasoningEffort || 'none', exclude: true },
          messages: [
            { role: 'system', content: `Classify a Slack request. Return JSON only: {"workflowId":"...","contentProfile":"standard|options-strategy"}. Allowed workflows: ${workflowIds.join(', ')}. contentProfile=options-strategy only when the user asks to construct, compare, recommend, hedge with, or evaluate a concrete options strategy or named multi-leg/covered/protective strategy. Pure implied-volatility, Greeks, options-flow, volume, open-interest, OIC-table, or general options-market analysis is standard. A URL is research material, not translation intent. Never choose translate for a URL alone; choose translate only when the user explicitly asks for faithful/full translation. qdii=direct Slack lookup of disclosed equity holdings for one or more six-digit public QDII fund codes; email=newsletter/Customer.io draft; earnings=quarterly earnings; sector=industry; morning=daily brief; company=single-company deep dive including financials, competitors, or value chain; macro=cross-asset macro analysis; wechat=other public-account analysis and bare URLs. A WeChat or Newsletter request that uses QDII holdings keeps its destination workflow rather than qdii. For mixed requests, choose the workflow that answers the user's final requested destination.` },
            { role: 'user', content: String(task).slice(0, 4000) },
          ],
        }),
      });
      if (!response.ok) return undefined;
      const data = await response.json();
      const raw = data?.choices?.[0]?.message?.content;
      const text = Array.isArray(raw) ? raw.map((part) => part?.text || '').join('') : String(raw || '');
      const json = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
      return {
        workflowId: json.workflowId,
        contentProfile: json.contentProfile === OPTIONS_STRATEGY_PROFILE
          ? OPTIONS_STRATEGY_PROFILE
          : 'standard',
      };
    } finally { clearTimeout(timer); }
  };
}

export function workflowRouteLabel(workflowId) {
  return ({
    translate: '完整直译 → 微信草稿箱',
    email: 'Newsletter → Customer.io 草稿',
    'opening-digest': 'Zen Opening Digest 测试 → Customer.io + 微信草稿',
    earnings: '原创财报分析 → 微信草稿箱',
    sector: '原创行业分析 → 微信草稿箱',
    morning: '原创晨报 → 微信草稿箱',
    company: '原创公司深度 → 微信草稿箱',
    macro: '原创全球宏观策略 → 微信草稿箱',
    qdii: 'QDII 股票持仓 → Slack 回复',
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
  if (result?.kind === 'ambiguous') {
    const runs = (result.runs || []).slice(0, 8)
      .map((run) => `• ${String(run.id || '').slice(0, 12)} · 线程 ${run.notify?.ts || '未知'}`)
      .join('\n');
    return `⚠️ 当前频道有多个可停止任务，未执行含糊停止。请回到需要停止的原任务线程发送“停止”。${runs ? `\n${runs}` : ''}`;
  }
  return 'ℹ️ 当前频道没有可停止的运行中或排队任务。';
}

export function createKeyedMutex() {
  const tails = new Map();
  return {
    async run(key, fn) {
      const previous = tails.get(key) || Promise.resolve();
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const tail = previous.catch(() => {}).then(() => gate);
      tails.set(key, tail);
      await previous.catch(() => {});
      try { return await fn(); }
      finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    },
  };
}

export function memoizedClassify(classify) {
  const cache = new Map();
  return async (task, workflowIds) => {
    if (typeof classify !== 'function') return undefined;
    const key = `${String(task || '')}\u0000${(workflowIds || []).join(',')}`;
    if (!cache.has(key)) cache.set(key, Promise.resolve().then(() => classify(task, workflowIds)));
    return cache.get(key);
  };
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
  fetchFn = globalThis.fetch,
  workflowIds = [],
  defaultWorkflowId = 'wechat',
}) {
  const app = new App({ token: config.slack.botToken, appToken: config.slack.appToken, socketMode: true, logLevel: 'warn' });
  const postMessage = createSlackPostScheduler(
    (payload) => app.client.chat.postMessage(payload),
    { intervalMs: Number(config.slack.postIntervalMs || 1000) },
  );
  app.zenPostMessage = postMessage;
  // Catch Bolt dispatch-layer errors such as handler throws to prevent propagation. Finty state-machine crashes do
  // not reach this handler; the process-level guard in index.js tolerates them and reconnects.
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
  const classify = createSlackIntentClassifier(config, fetchFn);
  const threadMutex = createKeyedMutex();
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
        await postMessage({
          channel,
          thread_ts: rootTs,
          text: slackStopResponse(result),
        }, { priority: 3, kind: 'terminal' });
        return;
      } catch (error) {
        store?.releaseSlackEvent?.(eventKey);
        throw error;
      }
    }
    let enqueued = false;
    const rootTs = threadTs || ts;
    const threadKey = `${channel}:${rootTs}`;
    try {
      await threadMutex.run(threadKey, async () => {
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
          await postMessage({
            channel,
            thread_ts: rootTs,
            text: '⚠️ 这条任务已经进入草稿创建阶段或已经创建草稿，当前编辑/补充不会覆盖它。请重新 @zenbot 提交完整 Prompt，避免产生无法确认的新旧版本。',
          }, { priority: 3, kind: 'terminal' });
          return;
        }
        if (result?.done) await result.done;
      }
      const classifyForTask = memoizedClassify(classify);
      const route = await resolveNaturalWorkflowTask(task, {
        workflowIds,
        defaultWorkflowId,
        previousWorkflowId: previous?.workflow_id,
        classify: classifyForTask,
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
      const modelRoute = await resolveOptionsStrategyProfile(input, {
        workflowId: route.workflowId,
        workflowIds,
        classify: classifyForTask,
      });
      const userAttachments = attachmentsFromSlackMessages(messages);
      const metadata = slackPromptMetadata(input, promptRevision, userAttachments);
      const detectedQdiiPlan = detectQdiiTaskPlan(input);
      const qdiiPlan = detectedQdiiPlan.qdii
        ? {
            ...detectedQdiiPlan,
            destination: route.workflowId === 'email' ? 'newsletter'
              : route.workflowId === 'wechat' ? 'wechat'
                : detectedQdiiPlan.destination,
          }
        : detectedQdiiPlan;
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
          ...(modelRoute.modelProfile ? {
            modelProfile: modelRoute.modelProfile,
            modelRouteReason: modelRoute.reason,
            modelRouteLabel: `${modelRoute.modelProfile} → ${config.writer.optionsStrategyModel}`,
          } : {}),
          ...(qdiiPlan.qdii ? { qdiiPlan } : {}),
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
      });
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
