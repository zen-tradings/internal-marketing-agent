import { sharedResearch, officialFirstPolicy, envChannel, envModel, envTimeoutMs, workDirFor, buildPromptTemplate } from './shared.js';

const METHODOLOGY = `【行业综述框架 — 专属要求】
围绕给定行业或细分赛道撰写综述,遵循以下结构展开:
1. 市场规模与增长驱动:给出市场规模(TAM)量级、历史增速与未来增长的关键驱动因素,注明来源与统计口径。
2. 产业链与竞争格局:梳理产业链上下游环节及价值分布,识别头部玩家的市场定位、差异化优势与近期动态。
3. 关键主题与技术趋势:提炼三到五个正在塑造行业格局的结构性趋势或技术拐点,以及潜在的监管或颠覆风险。
4. 供需与价格信号:结合最新数据说明供需松紧变化、价格或成本信号,判断行业处于周期的哪个阶段。
5. 值得跟踪的公司与指标:列出应重点关注的公司名单及各自的关键跟踪指标(如出货量、产能利用率、订单能见度)。
6. 情景与风险:给出乐观、中性、悲观情景假设及触发条件,以及可能颠覆行业叙事的风险点。
数据尽量注明来源机构与统计时间,区分市场炒作预期与现实可实现的市场空间,如素材明显滞后须提示数据时效性问题。`;

export default {
  id: 'sector',
  mode: 'analysis',
  sourcePolicy: officialFirstPolicy(),
  factReview: true,
  triggers: ['slack'],
  get workDir() { return workDirFor('sector'); },
  get model() { return envModel(); },
  get channel() { return envChannel(); },
  get timeoutMs() { return envTimeoutMs(); },
  get research() { return sharedResearch(); },
  defaultMethodology: METHODOLOGY,
  retries: 0,
  promptTemplate: (task) => buildPromptTemplate({
    persona: 'Zen Trading 公众号行业研究分析师',
    task,
    methodologyBlock: METHODOLOGY,
  }),
};
