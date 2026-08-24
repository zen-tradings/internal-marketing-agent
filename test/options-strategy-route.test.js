import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPTIONS_STRATEGY_PROFILE,
  classifyOptionsStrategyIntent,
  optionsStrategyWritingGuidance,
  resolveOptionsStrategyProfile,
} from '../src/lib/options-strategy-route.js';

test('中英文具体期权策略与隐式构建意图命中专用 profile', () => {
  for (const prompt of [
    '比较牛市看涨价差和铁鹰策略，哪一个更适合财报前的波动率环境',
    'Newsletter: evaluate a covered call versus a cash-secured put for NVDA',
    '财报前期权怎么做，请给出风险收益结构和失效条件',
    'Use options to construct a hedge and compare the payoff profiles',
  ]) {
    assert.equal(classifyOptionsStrategyIntent(prompt).decision, OPTIONS_STRATEGY_PROFILE, prompt);
  }
});

test('纯 IV、Greeks、期权流、OIC 和普通市场解读不触发 Fable', () => {
  for (const prompt of [
    '分析 NVDA 的隐含波动率和波动率偏度变化',
    'Explain today options flow, open interest and gamma positioning',
    '解读 OIC trending options volume 表格',
    '写一篇期权市场分析，覆盖成交量和未平仓量',
    '分析半导体行业供需策略',
    '不要讨论期权策略，只解释隐含波动率',
  ]) {
    assert.equal(classifyOptionsStrategyIntent(prompt).decision, 'standard', prompt);
  }
});

test('模糊期权分析只复用现有 classifier，且受目标工作流白名单约束', async () => {
  let calls = 0;
  const classify = async () => {
    calls += 1;
    return { workflowId: 'wechat', contentProfile: OPTIONS_STRATEGY_PROFILE };
  };
  const ambiguous = await resolveOptionsStrategyProfile('分析这只股票的期权机会', {
    workflowId: 'wechat', workflowIds: ['wechat'], classify,
  });
  assert.equal(ambiguous.modelProfile, OPTIONS_STRATEGY_PROFILE);
  assert.equal(ambiguous.reason, 'model-classifier');
  assert.equal(calls, 1);

  const generic = await resolveOptionsStrategyProfile('写一篇期权策略分析', {
    workflowId: 'email', workflowIds: ['email'], classify,
  });
  assert.equal(generic.modelProfile, OPTIONS_STRATEGY_PROFILE);
  assert.equal(generic.reason, 'model-classifier');
  assert.equal(calls, 2);

  for (const workflowId of ['translate', 'opening-digest', 'qdii']) {
    const route = await resolveOptionsStrategyProfile('构建 covered call 期权策略', {
      workflowId, workflowIds: [workflowId], classify,
    });
    assert.equal(route.modelProfile, '', workflowId);
    assert.equal(route.reason, 'ineligible-workflow');
  }
  assert.equal(calls, 2);
});

test('期权策略写作边界禁止无行情估算，macro 继续禁止具体交易 legs', () => {
  const ordinary = optionsStrategyWritingGuidance('email');
  assert.match(ordinary, /行情时间戳、到期日、执行价和报价依据/);
  assert.match(ordinary, /不得估算或编造 premium、Greeks、胜率/);
  assert.doesNotMatch(ordinary, /本文属于 macro/);
  const macro = optionsStrategyWritingGuidance('macro');
  assert.match(macro, /不得写具体买卖 legs、入场、退出、止损或仓位指令/);
});
