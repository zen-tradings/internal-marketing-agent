import {
  buildPromptTemplate,
  envChannel,
  envModel,
  envTimeoutMs,
  officialFirstPolicy,
  sharedResearch,
  workDirFor,
} from './shared.js';

const MACRO_OFFICIAL_SOURCES = [
  'federalreserve.gov',
  'fred.stlouisfed.org',
  'bls.gov',
  'bea.gov',
  'treasury.gov',
  'cftc.gov',
  'eia.gov',
  'imf.org',
  'bis.org',
  'worldbank.org',
  'oecd.org',
  'ecb.europa.eu',
  'boj.or.jp',
  'pbc.gov.cn',
  'stats.gov.cn',
  'safe.gov.cn',
  'chinabond.com.cn',
  'cmegroup.com',
];

const METHODOLOGY = `【全资产宏观策略框架 — 专属要求】
先区分可确认事实、市场已定价预期、增量信息与我们的判断，再解释政策或数据如何经利率、汇率、盈利、流动性、风险溢价或供需传导到资产。全球框架默认突出中美与美元体系，但只写与任务相关的链路。

给出一个基准情景和一个能真正推翻它的反向情景，分别写明触发条件、观察信号、反例和失效条件。一个直接一手或原始来源足以支持核心事实；没有一手依据时，主动收窄为已证实事实、待验证点和观察条件。公开稿不写买卖、目标价、入场、退出、止损或仓位指令。`;

export default {
  id: 'macro',
  mode: 'analysis',
  editorialSkills: ['latepost-ai-writer', 'global-macro-strategy-writer'],
  sourcePolicy: { ...officialFirstPolicy(), minOfficialSources: 1 },
  factReview: true,
  triggers: ['slack'],
  get workDir() { return workDirFor('macro'); },
  get model() { return envModel(); },
  get channel() { return envChannel(); },
  get timeoutMs() { return envTimeoutMs(); },
  get research() {
    const common = sharedResearch();
    return {
      ...common,
      officialSources: [...new Set([...MACRO_OFFICIAL_SOURCES, ...common.officialSources])],
      minOfficialSources: 1,
    };
  },
  defaultMethodology: METHODOLOGY,
  retries: 0,
  promptTemplate: (task) => buildPromptTemplate({
    persona: 'Zen Trading 全球宏观策略分析师',
    task,
    methodologyBlock: METHODOLOGY,
  }),
};
