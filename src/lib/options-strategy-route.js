export const OPTIONS_STRATEGY_PROFILE = 'options-strategy';

export const OPTIONS_STRATEGY_WORKFLOWS = new Set([
  'wechat',
  'company',
  'earnings',
  'sector',
  'macro',
  'morning',
  'email',
]);

const NAMED_STRATEGY_RE = /(?:牛市(?:看涨|看跌)?价差|熊市(?:看涨|看跌)?价差|看涨价差|看跌价差|垂直价差|日历价差|对角价差|比例价差|跨式|宽跨式|铁鹰|铁蝶|蝶式|备兑(?:看涨)?|保护性看跌|领口策略|现金担保看跌|风险逆转|合成多头|合成空头|盒式价差|\bcovered\s+calls?\b|\bcash[- ]secured\s+puts?\b|\bprotective\s+puts?\b|\bcollars?\b|\b(?:bull|bear)\s+(?:call|put)\s+spreads?\b|\bvertical\s+spreads?\b|\bdebit\s+spreads?\b|\bcredit\s+spreads?\b|\bcalendar\s+spreads?\b|\bdiagonal\s+spreads?\b|\bratio\s+spreads?\b|\bstraddles?\b|\bstrangles?\b|\biron\s+condors?\b|\biron\s+butterfl(?:y|ies)\b|\bbutterfl(?:y|ies)\s+spreads?\b|\brisk\s+reversals?\b|\bsynthetic\s+(?:long|short)s?\b|\bbox\s+spreads?\b|\bwheel\s+strateg(?:y|ies)\b)/i;
const OPTION_INSTRUMENT_RE = /(?:期权|购权|沽权|认购|认沽|\boptions?\b|\bcalls?\b|\bputs?\b)/i;
const STRATEGY_INTENT_RE = /(?:构建|设计|比较|对比|选择|推荐|评估|优化|对冲|保护|收益曲线|盈亏|回报结构|风险收益|怎么做|如何做|如何交易|表达观点|\bconstruct(?:ion)?\b|\bbuild\b|\bdesign\b|\bcompar(?:e|ison|ing)\b|\bevaluat(?:e|ion)\b|\brecommend(?:ation|ed|ing)?\b|\bhedg(?:e|ing)\b|\bpayoffs?\b|\brisk[ /-]reward\b|\btrade\s+structure\b|\bexpress\s+(?:a|the)\s+view\b)/i;
const GENERIC_OPTIONS_STRATEGY_RE = /(?:期权策略|期权组合|\boptions?\s+strateg(?:y|ies)\b|\boptions?\s+portfolio\b)/i;
const MARKET_ONLY_RE = /(?:期权流|期权成交|期权持仓|期权市场|成交量|未平仓量|隐含波动率|波动率曲面|偏度|希腊字母|\boptions?\s+(?:flow|volume|activity|market|positioning|open\s+interest)\b|\b(?:implied\s+volatility|volatility\s+(?:surface|skew)|greeks?|delta|gamma|theta|vega|rho)\b)/i;
const ANALYSIS_RE = /(?:分析|解读|观察|说明|变化|走势|数据|\banaly(?:sis|ze|se)\b|\bexplain\b|\breview\b|\boutlook\b)/i;
const NEGATED_STRATEGY_RE = /(?:不要|无需|不需要|不讨论|排除|禁止).{0,12}(?:期权策略|期权组合)|(?:without|exclude|avoid|do\s+not\s+(?:include|discuss|recommend)).{0,20}(?:options?\s+strateg|option\s+trade)/i;

export function classifyOptionsStrategyIntent(input) {
  const text = String(input || '').trim();
  if (!text || NEGATED_STRATEGY_RE.test(text)) return { decision: 'standard', reason: 'no-options-strategy' };
  if (NAMED_STRATEGY_RE.test(text)) return { decision: OPTIONS_STRATEGY_PROFILE, reason: 'named-options-strategy' };
  if (!OPTION_INSTRUMENT_RE.test(text)) return { decision: 'standard', reason: 'no-option-instrument' };
  if (STRATEGY_INTENT_RE.test(text)) return { decision: OPTIONS_STRATEGY_PROFILE, reason: 'option-instrument+strategy-intent' };
  if (MARKET_ONLY_RE.test(text)) return { decision: 'standard', reason: 'options-market-analysis-only' };
  if (GENERIC_OPTIONS_STRATEGY_RE.test(text)) return { decision: 'ambiguous', reason: 'generic-options-strategy' };
  if (ANALYSIS_RE.test(text)) return { decision: 'ambiguous', reason: 'ambiguous-options-analysis' };
  return { decision: 'standard', reason: 'option-mention-only' };
}

export function isOptionsStrategyWorkflow(workflowId) {
  return OPTIONS_STRATEGY_WORKFLOWS.has(String(workflowId || '').toLowerCase());
}

export async function resolveOptionsStrategyProfile(input, {
  workflowId,
  classify,
  workflowIds = [],
} = {}) {
  if (!isOptionsStrategyWorkflow(workflowId)) {
    return { modelProfile: '', reason: 'ineligible-workflow' };
  }
  const detected = classifyOptionsStrategyIntent(input);
  if (detected.decision === OPTIONS_STRATEGY_PROFILE) {
    return { modelProfile: OPTIONS_STRATEGY_PROFILE, reason: detected.reason };
  }
  if (detected.decision !== 'ambiguous' || typeof classify !== 'function') {
    return { modelProfile: '', reason: detected.reason };
  }
  try {
    const classified = await classify(input, workflowIds);
    const contentProfile = typeof classified === 'object'
      ? String(classified?.contentProfile || classified?.modelProfile || '')
      : '';
    return contentProfile === OPTIONS_STRATEGY_PROFILE
      ? { modelProfile: OPTIONS_STRATEGY_PROFILE, reason: 'model-classifier' }
      : { modelProfile: '', reason: 'model-classifier-standard' };
  } catch {
    return { modelProfile: '', reason: 'model-classifier-unavailable' };
  }
}

export function optionsStrategyWritingGuidance(workflowId) {
  const macroBoundary = String(workflowId || '').toLowerCase() === 'macro'
    ? '\n- 本文属于 macro 公开稿：即使存在合格期权链，也只能讨论策略类型、适用条件、风险、观察信号与失效条件；不得写具体买卖 legs、入场、退出、止损或仓位指令。'
    : '';
  return `【期权策略研究边界】
- 这是条件化研究分析，不是面向个人的交易指令或适当性建议。
- 只有给定证据同时包含可核验的行情时间戳、到期日、执行价和报价依据时，才可讨论具体合约、premium、Greeks 或概率；缺少任一项时，只能给出策略类型、适用条件、核心风险和失效条件。
- 不得估算或编造 premium、Greeks、胜率/盈利概率、具体合约、仓位或流动性。明确区分到期盈亏与到期前的市值变化。
- 对每个策略说明最大损失是否有限、波动率变化、时间衰减、流动性、提前行权/指派和股息风险中与任务相关的部分；没有证据时使用定性表述。${macroBoundary}`;
}
