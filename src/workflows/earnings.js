import { sharedResearch, envChannel, envModel, envTimeoutMs, workDirFor, buildPromptTemplate } from './shared.js';

const METHODOLOGY = `【财报分析框架 — 专属要求】
围绕本季度财报撰写更新点评,聚焦本季度"新变化",不复述公司背景:
1. 实际 vs 预期:营收、毛利率、每股收益(EPS)等核心指标,逐项列出实际值与市场预期,明确超预期或不及预期,并量化差异幅度。
2. 分部与运营指标:按业务分部或地区拆解表现,指出关键运营指标(出货量、订单、留存率等)的变化及驱动因素。
3. 指引变化:对比本次与上季度指引,说明上调、下调或维持及原因。
4. 预期修正方向:研判财报后市场一致预期(营收、盈利)可能如何修正,给出方向与依据。
5. 投资论点复核:评估本季度结果对既有投资逻辑是强化、削弱还是不变。
6. 风险与催化剂:列出未来一到两个季度可能影响股价的关键风险与催化事件。
所有数字须来自素材,注明数据口径(如 GAAP/Non-GAAP、同比/环比)与截止时间(财报发布日期或数据统计截止日),素材没有的数字不得杜撰。`;

export default {
  id: 'earnings',
  triggers: ['slack'],
  get workDir() { return workDirFor('earnings'); },
  get model() { return envModel(); },
  get channel() { return envChannel(); },
  get timeoutMs() { return envTimeoutMs(); },
  get research() { return sharedResearch(); },
  retries: 0,
  promptTemplate: (task) => buildPromptTemplate({
    persona: 'Zen Trading 公众号财报分析师',
    task,
    methodologyBlock: METHODOLOGY,
  }),
};
