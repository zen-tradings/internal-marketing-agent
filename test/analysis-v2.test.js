import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendDeterministicReferences,
  applyAuditIssues,
  buildAuditPrompt,
  buildCoreRepairPrompt,
  buildEvidencePrompt,
  buildWritingPrompt,
  contentPolicyForPrompt,
  extractExplicitEntityVersions,
  extractUserUrls,
  fallbackTaskContract,
  inferNumericCriticalClaims,
  normalizeAuditCriticalClaims,
  normalizeAuditIssues,
  normalizeCoreRepairs,
  normalizeEvidenceMatrix,
  normalizePlanningResult,
  selectFinalReferenceIds,
} from '../src/core/analysis-v2.js';
import { extractUrls, normalizeAnalysisArticle, runWriter } from '../src/core/runner.js';

function jsonResponse(body, init = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText || 'OK',
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

function workflow(overrides = {}) {
  return {
    id: 'wechat',
    mode: 'analysis',
    editorialSkill: 'latepost-ai-writer',
    model: 'qwen/qwen3.8-max',
    timeoutMs: 3000,
    workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-v2-')),
    research: {
      prioritySources: ['semianalysis.com'],
      officialSources: ['sec.gov', 'nasdaq.com', 'nvidia.com'],
    },
    ...overrides,
  };
}

function config() {
  return {
    analysis: {
      pipelineVersion: 'v2',
      searchMaxQueries: 8,
      recentWindowDays: 60,
    },
    writer: {
      openrouterApiKey: 'or-key',
      model: 'qwen/qwen3.8-max',
      plannerModel: 'moonshotai/kimi-k3',
      reviewModel: 'z-ai/glm-5.2',
      reasoningEffort: 'high',
      plannerReasoningEffort: 'high',
      reviewReasoningEffort: 'none',
      baseUrl: 'https://openrouter.test/api/v1',
      exaApiKey: 'exa-key',
      exaBaseUrl: 'https://exa.test',
      maxTokens: 12000,
    },
  };
}

test('TaskContract 锁定 Slack 原文型号，规划器不得偷偷加入附近版本', () => {
  const input = 'please write a deep dive analysis report comparing newly released Opus 5 and Kimi K2';
  assert.deepEqual(
    extractExplicitEntityVersions(input).map((item) => item.literal),
    ['Opus 5', 'Kimi K2'],
  );
  const normalized = normalizePlanningResult({
    task_contract: {
      exact_entities_and_versions: [
        { literal: 'Opus 4.5', version: '4.5' },
        { literal: 'Kimi K2.6', version: 'K2.6' },
      ],
      requested_structure: [],
    },
    search_plan: [
      { query: 'Opus 4.5 versus Kimi K2.6', lane: 'official' },
    ],
  }, input, { id: 'company' }, { promptRevision: 2 }, { maxQueries: 6 });

  assert.deepEqual(
    normalized.taskContract.exact_entities_and_versions.map((item) => item.literal),
    ['Opus 5', 'Kimi K2'],
  );
  assert.equal(normalized.taskContract.article_type, 'prompt-driven-model-comparison');
  assert.equal(normalized.taskContract.prompt_revision, 2);
  assert.ok(normalized.taskContract.must_avoid.some((item) => /Opus 5/.test(item)));
  assert.ok(normalized.taskContract.must_avoid.some((item) => /Kimi K2/.test(item)));
  assert.ok(normalized.searchPlan.length >= 4 && normalized.searchPlan.length <= 6);
  assert.ok(normalized.searchPlan.every((item) => /Opus 5|Kimi K2/.test(item.query)));
  assert.ok(normalized.searchPlan.every((item) => !/Opus 4\.5|Kimi K2\.6/.test(item.query)));
});

test('Slack HTML 转义不会污染用户 URL，规划器也不能擅自关闭补充搜索', () => {
  const input = 'please write an analysis about this: https://kalshi.com/company-reports?week=2026-08-03&amp;utm_source=news.kalshi.com';
  const expected = 'https://kalshi.com/company-reports?week=2026-08-03&utm_source=news.kalshi.com';
  assert.deepEqual(extractUserUrls(input), [expected]);
  assert.deepEqual(extractUrls(input).urls, [expected]);

  const normalized = normalizePlanningResult({
    task_contract: {
      exact_entities_and_versions: [{ literal: 'Kalshi' }],
      search_aliases: ['Kalshi Public Companies Hub'],
      must_cover: ['分析 Kalshi Public Companies Hub'],
      only_user_links: true,
    },
    search_plan: [
      { query: 'Kalshi Public Companies Hub launch', lane: 'official', language: 'en' },
      { query: 'Kalshi 公司数据中心 分析', lane: 'open', language: 'zh' },
    ],
  }, input, { id: 'wechat' }, {}, { maxQueries: 6 });

  assert.equal(normalized.taskContract.only_user_links, false);
  assert.ok(normalized.searchPlan.length >= 2);
  assert.ok(normalized.searchPlan.some((item) => /Public Companies Hub/i.test(item.query)));
});

test('原始 Prompt 明确只依据链接时保留排他约束且不生成搜索计划', () => {
  const input = 'only use this link https://example.com/report';
  const normalized = normalizePlanningResult({
    task_contract: { only_user_links: false },
    search_plan: [{ query: 'unrelated supplement', lane: 'open', language: 'en' }],
  }, input, { id: 'wechat' });
  assert.equal(normalized.taskContract.only_user_links, true);
  assert.deepEqual(normalized.searchPlan, []);
});

test('用户明确两方结构时 sector 方法论只能补空白，不能强制 TAM/供需章节', () => {
  const input = 'please write an analyze report pointing out the two argument sides and assess which side will spend more on lobbying';
  const contract = fallbackTaskContract(input, { id: 'sector' });
  const prompt = buildWritingPrompt({
    contract,
    evidenceMatrix: { relevant_source_ids: ['S1'] },
    sources: [{ id: 'S1', title: 'Lobbying disclosure', url: 'https://example.com/a', text: 'Evidence.' }],
    workflow: {
      id: 'sector',
      editorialSkill: 'latepost-ai-writer',
      defaultMethodology: '必须写 TAM、产业链、供需与三种情景。',
    },
    asOf: '2026-07-25',
  });
  assert.match(prompt, /用户已经指定结构，不得套用任何固定行业、公司或财报框架/);
  assert.doesNotMatch(prompt, /必须写 TAM/);
  assert.match(prompt, /LatePost AI Writer 编辑方法/);
  assert.match(prompt, /用户已经指定结构：稿型方法只能改善段落推进和证据表达/);
  assert.doesNotMatch(prompt, /标题备选 3 条/);
  assert.equal(contract.requested_structure.length, 1);
});

test('EvidenceMatrix 在证据判断后选择受控稿型，审计增加阶段与口径检查', () => {
  const contract = fallbackTaskContract('实测一个 AI Agent 产品', { id: 'wechat' });
  const sources = [{
    id: 'S1',
    title: 'Product test',
    url: 'https://example.com/test',
    text: 'The product completed one controlled task with human intervention.',
  }];
  const workflowWithSkill = { id: 'wechat', editorialSkill: 'latepost-ai-writer' };
  const evidencePrompt = buildEvidencePrompt(contract, sources, workflowWithSkill);
  assert.match(evidencePrompt, /editorial_brief/);
  assert.match(evidencePrompt, /在完成来源评估和需求覆盖判断之后/);

  const matrix = normalizeEvidenceMatrix({
    source_assessments: [{
      source_id: 'S1',
      source_type: 'primary',
      relevant: true,
      safe_statements: ['一次受控测试需要人工介入'],
    }],
    relevant_source_ids: ['S1'],
    selected_reference_ids: ['S1'],
    editorial_brief: {
      archetype: '产品实测',
      angle: '一次成功还不能证明稳定能力',
      tension: '受控演示与真实使用存在落差',
      ending_constraint: '失败恢复和成本仍待验证',
    },
  }, sources, contract, workflowWithSkill);
  assert.equal(matrix.editorial_brief.archetype, '产品实测');
  assert.equal(matrix.editorial_brief.routing_source, 'evidence-model');

  const auditPrompt = buildAuditPrompt({
    article: '---\ntitle: 测试\n---\n\n一次成功证明产品已经规模化。',
    contract,
    evidenceMatrix: matrix,
    sources,
  });
  assert.match(auditPrompt, /演示、内部基准、公开评测、真实用户使用/);
  assert.match(auditPrompt, /融资额、估值、合同额、回款、确认收入和 ARR/);
  assert.match(auditPrompt, /不得因文风偏好、段落长度或标题审美重写文章/);
});

test('macro EvidenceMatrix 生成三类稿型与双向情景，并把一手证据边界送入写作和审计', () => {
  const contract = fallbackTaskContract('解释美元实际利率如何跨资产传导', { id: 'macro' });
  const sources = [{
    id: 'S1',
    title: 'Federal Reserve primary data',
    url: 'https://www.federalreserve.gov/example',
    text: 'The federal funds target range was unchanged.',
    official: true,
  }];
  const macroWorkflow = {
    id: 'macro',
    editorialSkills: ['latepost-ai-writer', 'global-macro-strategy-writer'],
  };
  const evidencePrompt = buildEvidencePrompt(contract, sources, macroWorkflow);
  assert.match(evidencePrompt, /macro_brief/);
  assert.match(evidencePrompt, /priced_expectation/);
  assert.match(evidencePrompt, /一个直接一手或原始来源可以支撑核心事实/);

  const matrix = normalizeEvidenceMatrix({
    source_assessments: [{
      source_id: 'S1',
      source_type: 'primary',
      relevant: true,
      safe_statements: ['政策利率目标区间保持不变'],
    }],
    relevant_source_ids: ['S1'],
    selected_reference_ids: ['S1'],
    editorial_brief: {
      archetype: '技术解释',
      angle: '实际利率是跨资产共同变量',
      tension: '同一因子在不同时间尺度上传导不同',
      ending_constraint: '后续通胀与增长数据仍会改变路径',
    },
    macro_brief: {
      archetype: '机制型深度',
      thesis: '实际利率通过美元和风险溢价影响多类资产',
      priced_expectation: '市场预期仍需由可观察数据验证',
      incremental_information: '政策路径的时点发生变化',
      transmission: '政策预期到实际利率，再到美元与风险溢价',
      baseline_scenario: '数据温和降温时传导延续',
      counter_scenario: '增长骤降将改变风险资产反应',
      invalidation: '实际利率与美元持续背离',
    },
  }, sources, contract, macroWorkflow);
  assert.equal(matrix.macro_brief.archetype, '机制型深度');
  assert.match(matrix.macro_brief.evidence_boundary, /核心事实已有直接一手或原始来源支持/);

  const writingPrompt = buildWritingPrompt({
    contract,
    evidenceMatrix: matrix,
    sources,
    workflow: macroWorkflow,
    asOf: '2026-08-01',
  });
  assert.match(writingPrompt, /LatePost AI Writer 编辑方法/);
  assert.match(writingPrompt, /Global Macro Strategy Writer 主导方法/);
  assert.match(writingPrompt, /以 Zen Trading 的“我们”表达/);

  const auditPrompt = buildAuditPrompt({
    article: '---\ntitle: 测试\n---\n\n我们建议在 100 买入并设置 95 止损。',
    contract,
    evidenceMatrix: matrix,
    sources,
  });
  assert.match(auditPrompt, /关键价格、收益率、估值、利差、汇率或指数水平必须有允许证据直接支持/);
  assert.match(auditPrompt, /买入、卖出、目标价、入场、退出、止损、仓位/);
  assert.match(auditPrompt, /情景中的新增数字或事件没有来源时按 unsupported/);
  assert.match(auditPrompt, /critical_claims/);
  assert.match(auditPrompt, /所有项合计最多 4 个不同来源/);
});

test('macro 优先保留关键市场数字证据，审计后把它们补入最多五条精选来源', () => {
  const contract = fallbackTaskContract('分析 FOMC 决议、市场定价与美元反应', { id: 'macro' });
  const sources = Array.from({ length: 28 }, (_, index) => {
    const id = `S${index + 1}`;
    return {
      id,
      title: `Source ${id}`,
      url: `https://example.com/${id}`,
      official: index < 12,
    };
  });
  const assessments = sources.map((source, index) => ({
    source_id: source.id,
    source_type: index < 12 ? 'primary' : 'secondary',
    relevant: true,
    safe_statements: source.id === 'S20'
      ? ['会前加息概率为32%']
      : source.id === 'S27'
        ? ['另一市场调查显示加息概率为35%']
        : [`来源 ${source.id} 的背景事实`],
  }));
  const macroWorkflow = {
    id: 'macro',
    editorialSkills: ['latepost-ai-writer', 'global-macro-strategy-writer'],
  };
  const matrix = normalizeEvidenceMatrix({
    source_assessments: assessments,
    requirements: [{
      requirement: '区分已定价预期与增量信息',
      source_ids: ['S1', 'S20', 'S27'],
      safe_statements: ['市场在会前定价加息概率约32%至35%'],
      covered: true,
    }],
    relevant_source_ids: sources.map((source) => source.id),
    selected_reference_ids: ['S1', 'S2', 'S3', 'S4', 'S5'],
    macro_brief: { archetype: '事件快评' },
  }, sources, contract, macroWorkflow);
  assert.equal(matrix.relevant_source_ids.length, 20);
  assert.ok(matrix.relevant_source_ids.includes('S20'));
  assert.ok(matrix.relevant_source_ids.includes('S27'));

  const article = '---\ntitle: 测试\n---\n\n市场在会前定价加息概率约32%至35%。';
  const criticalClaims = normalizeAuditCriticalClaims({
    critical_claims: [{
      article_quote: '市场在会前定价加息概率约32%至35%。',
      claim_type: 'market_pricing',
      evidence_ids: ['S20', 'S27'],
    }],
  }, article, matrix);
  assert.deepEqual(criticalClaims[0].evidence_ids, ['S20', 'S27']);
  const fallbackClaims = inferNumericCriticalClaims(article, matrix);
  assert.deepEqual(fallbackClaims[0].evidence_ids, ['S20', 'S27']);
  const finalIds = selectFinalReferenceIds({
    initialReferenceIds: matrix.selected_reference_ids,
    criticalClaims,
    auditReview: { retained: [{ risk: 'high', impact: 'core', evidence_ids: ['S27'] }] },
    sources,
  });
  assert.deepEqual(finalIds.slice(0, 3), ['S1', 'S20', 'S27']);
  assert.ok(finalIds.length <= 5);
});

test('macro 没有一手证据时保留事实与观察条件，但明确禁止完整确定性因果叙事', () => {
  const contract = fallbackTaskContract('写一篇比特币流动性展望', { id: 'macro' });
  const sources = [{ id: 'S1', title: 'Specialist note', url: 'https://example.com/note', text: 'A market view.' }];
  const matrix = normalizeEvidenceMatrix({
    source_assessments: [{
      source_id: 'S1',
      source_type: 'specialist',
      relevant: true,
      safe_statements: ['该报告提出一种流动性解释'],
    }],
    relevant_source_ids: ['S1'],
    selected_reference_ids: ['S1'],
  }, sources, contract, {
    id: 'macro',
    editorialSkills: ['latepost-ai-writer', 'global-macro-strategy-writer'],
  });
  assert.match(matrix.macro_brief.evidence_boundary, /没有可确认的一手依据/);
  assert.match(matrix.macro_brief.evidence_boundary, /待验证点与观察条件/);
});

test('中文公司任务补齐英文别名查询，并给动态来源加时效窗口', () => {
  const input = '分析长鑫存储的IPO、技术、市场份额和供应链';
  const normalized = normalizePlanningResult({
    task_contract: {
      article_type: 'company',
      exact_entities_and_versions: [{ literal: '长鑫存储' }],
      search_aliases: ['ChangXin Memory Technologies', 'CXMT', '长鑫科技'],
    },
    search_plan: [
      { query: '长鑫存储 官网 招股书', lane: 'official', recent: false },
      { query: '长鑫存储 市场份额', lane: 'priority', recent: false },
      { query: '长鑫存储 最新动态', lane: 'open', recent: false },
    ],
  }, input, { id: 'company' }, {}, { maxQueries: 8 });
  const english = normalized.searchPlan.filter((item) => /ChangXin|CXMT/.test(item.query));
  assert.ok(english.length >= 2);
  assert.ok(normalized.searchPlan.filter((item) => item.lane !== 'official').every((item) => item.recent));
  assert.deepEqual(normalized.taskContract.search_aliases, [
    'ChangXin Memory Technologies',
    'CXMT',
    '长鑫科技',
  ]);
  assert.deepEqual(
    [...new Set(normalized.searchPlan.map((item) => item.language))].sort(),
    ['en', 'zh'],
  );
});

test('纯英文任务也会确定性补齐中文查询，搜索计划始终覆盖中英双语', () => {
  const normalized = normalizePlanningResult({
    task_contract: {
      article_type: 'company',
      exact_entities_and_versions: [{ literal: 'NVIDIA' }],
      search_aliases: ['NVIDIA Corporation', 'NVDA'],
    },
    search_plan: [
      {
        query: 'NVIDIA official investor relations filing',
        lane: 'official',
        language: 'en',
        recent: false,
      },
      {
        query: 'NVIDIA latest independent analysis',
        lane: 'priority',
        language: 'en',
        recent: true,
      },
    ],
  }, 'Analyze NVIDIA market share and supply chain', { id: 'company' }, {}, { maxQueries: 8 });

  assert.ok(normalized.searchPlan.some((item) => item.language === 'en'));
  assert.ok(normalized.searchPlan.some((item) => item.language === 'zh'));
  assert.ok(normalized.searchPlan.find((item) => item.language === 'zh').query.includes('独立第三方'));
});

test('缺少一手确认不会触发澄清，只有双边核心冲突才询问一次', () => {
  const contract = fallbackTaskContract('分析 Opus 5', { id: 'wechat' });
  const sources = [
    { id: 'S1', title: '用户材料', url: 'https://example.com/user', text: 'Opus 5', userSpecified: true },
    { id: 'S2', title: '官方材料', url: 'https://example.com/official', text: 'Opus 5', official: true },
  ];
  const missing = normalizeEvidenceMatrix({
    source_assessments: [{ source_id: 'S1', source_type: 'user', relevant: true }],
    entities: [{ literal: 'Opus 5', verified: false, source_ids: [] }],
    relevant_source_ids: ['S1'],
    clarification_needed: true,
  }, sources, contract);
  assert.equal(missing.clarification_needed, false);

  const conflict = normalizeEvidenceMatrix({
    source_assessments: [
      { source_id: 'S1', source_type: 'user', relevant: true },
      { source_id: 'S2', source_type: 'primary', relevant: true },
    ],
    conflicts: [{
      severity: 'core',
      topic: '核心版本',
      user_source_ids: ['S1'],
      official_source_ids: ['S2'],
      question: '采用哪一版？',
    }],
    relevant_source_ids: ['S1', 'S2'],
  }, sources, contract);
  assert.equal(conflict.clarification_needed, true);
  assert.equal(conflict.clarification_question, '采用哪一版？');
});

test('用户主动提供的政府资助媒体只能作为上下文，不能佐证事实或进入引用', () => {
  const contract = fallbackTaskContract('分析一项市场政策', { id: 'wechat' });
  const sources = [
    {
      id: 'S1',
      title: '用户提供的公共广播报道',
      url: 'https://www.bbc.com/news/example',
      text: '一项市场政策。',
      userSpecified: true,
      editorialWarning: 'user-specified-government-funded-media',
    },
    {
      id: 'S2',
      title: 'Reuters independent report',
      url: 'https://www.reuters.com/world/example',
      text: 'Independent evidence.',
      independentThirdParty: true,
    },
  ];
  const matrix = normalizeEvidenceMatrix({
    source_assessments: [
      {
        source_id: 'S1',
        source_type: 'primary',
        relevant: true,
        entity_matches: ['市场政策'],
        safe_statements: ['不得采用'],
      },
      {
        source_id: 'S2',
        source_type: 'secondary',
        relevant: true,
        safe_statements: ['可采用'],
      },
    ],
    requirements: [{
      requirement: '分析政策',
      source_ids: ['S1', 'S2'],
      safe_statements: ['有来源'],
      covered: true,
    }],
    relevant_source_ids: ['S1', 'S2'],
    selected_reference_ids: ['S1', 'S2'],
  }, sources, contract);

  const warned = matrix.source_assessments.find((item) => item.source_id === 'S1');
  assert.equal(warned.source_type, 'user');
  assert.deepEqual(warned.safe_statements, []);
  assert.deepEqual(matrix.requirements[0].source_ids, ['S2']);
  assert.deepEqual(matrix.selected_reference_ids, ['S2']);

  const article = appendDeterministicReferences(
    '---\ntitle: 测试\n---\n\n正文。',
    sources,
    ['S1', 'S2'],
  );
  assert.doesNotMatch(article, /bbc\.com/);
  assert.match(article, /reuters\.com/);
});

test('局部审计只替换逐字命中的句子，不允许审查器整篇重写', () => {
  const article = '---\ntitle: 测试\n---\n\n第一段可靠。\n\nOpus 4.5 比所有模型都强。\n\n最后一段保留。';
  const matrix = { relevant_source_ids: ['S1'] };
  const issues = normalizeAuditIssues({
    issues: [
      {
        article_quote: 'Opus 4.5 比所有模型都强。',
        issue_type: 'unsupported',
        impact: 'core',
        risk: 'high',
        origin: 'model_added',
        confidence: 'high',
        evidence_ids: [],
        action: 'replace',
        replacement: '审查器想加入的新事实。',
      },
      {
        article_quote: '稿件里不存在的句子。',
        severity: 'core',
        action: 'clarify',
      },
    ],
  }, article, matrix);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].action, 'delete');
  const repaired = applyAuditIssues(article, issues).article;
  assert.match(repaired, /第一段可靠/);
  assert.match(repaired, /最后一段保留/);
  assert.doesNotMatch(repaired, /Opus 4\.5/);
  assert.doesNotMatch(repaired, /审查器想加入的新事实/);
});

test('分级审计保留低风险次要表述、用户明确前提和用户材料前提', () => {
  const article = '---\ntitle: 测试\n---\n\n这套工具上手很自然。\n\npyfolio 是评估底座，不是环境底座。\n\n据项目 README，该组件负责回测。';
  const contract = {
    raw_prompt: 'Core thesis: pyfolio 是评估底座，不是环境底座。',
  };
  const issues = normalizeAuditIssues({
    issues: [
      {
        article_quote: '这套工具上手很自然。',
        issue_type: 'unsupported',
        impact: 'incidental',
        risk: 'low',
        origin: 'model_added',
        confidence: 'high',
        action: 'delete',
      },
      {
        article_quote: 'pyfolio 是评估底座，不是环境底座。',
        issue_type: 'unsupported',
        impact: 'core',
        risk: 'high',
        origin: 'user_requirement',
        confidence: 'high',
        contract_quote: 'pyfolio 是评估底座，不是环境底座',
        action: 'delete',
      },
      {
        article_quote: '据项目 README，该组件负责回测。',
        issue_type: 'unsupported',
        impact: 'supporting',
        risk: 'high',
        origin: 'user_source',
        confidence: 'high',
        action: 'delete',
      },
    ],
  }, article, { relevant_source_ids: [] }, contract);
  assert.deepEqual(issues.map((issue) => issue.action), ['retain', 'retain', 'retain']);
  const result = applyAuditIssues(article, issues);
  assert.equal(result.applied.length, 0);
  assert.equal(result.retained.length, 3);
  assert.match(result.article, /上手很自然/);
  assert.match(result.article, /评估底座/);
  assert.match(result.article, /项目 README/);
});

test('核心高风险删句必须由现有证据完成一次局部补写', () => {
  const issues = [{
    article_quote: '该系统已经在生产环境全面部署。',
    issue_type: 'stage_conflation',
    impact: 'core',
    evidence_ids: [],
  }];
  const matrix = { relevant_source_ids: ['S1'] };
  const prompt = buildCoreRepairPrompt({
    article: '该系统已经在生产环境全面部署。',
    issues,
    evidenceMatrix: matrix,
    sources: [{ id: 'S1', title: 'README', url: 'https://example.com', text: '项目处于试点阶段。' }],
  });
  assert.match(prompt, /项目处于试点阶段/);
  const normalized = normalizeCoreRepairs({
    repairs: [{
      article_quote: '该系统已经在生产环境全面部署。',
      replacement: '据项目 README，该系统目前处于试点阶段。',
      evidence_ids: ['S1'],
    }],
  }, issues, matrix);
  assert.equal(normalized.unresolved.length, 0);
  assert.equal(normalized.repairs[0].evidence_ids[0], 'S1');
  const unresolved = normalizeCoreRepairs({ repairs: [] }, issues, matrix);
  assert.deepEqual(unresolved.unresolved, ['该系统已经在生产环境全面部署。']);
});

test('代码授权只从原始 Prompt 确定，规划模型不能自行开启', () => {
  assert.equal(contentPolicyForPrompt('include a Python code example and ASCII diagram').allow_code_blocks, true);
  assert.equal(contentPolicyForPrompt('写一篇普通公司分析').allow_code_blocks, false);
  const normalized = normalizePlanningResult({
    task_contract: { content_policy: { allow_code_blocks: true } },
  }, '写一篇普通公司分析', { id: 'wechat' });
  assert.equal(normalized.taskContract.content_policy.allow_code_blocks, false);
});

test('系统从证据矩阵确定性生成唯一引用章节，不依赖模型手工维护链接', () => {
  const article = '---\ntitle: 测试\n---\n\n正文没有链接。';
  const sources = [
    { id: 'S1', title: 'Official release', url: 'https://official.example/release' },
    { id: 'S2', title: 'Secondary', url: 'https://secondary.example/a' },
  ];
  const output = appendDeterministicReferences(article, sources, ['S1', 'S2']);
  assert.equal((output.match(/^## 引用链接$/gm) || []).length, 1);
  assert.match(output, /https:\/\/official\.example\/release/);
  assert.match(output, /https:\/\/secondary\.example\/a/);
});

test('V2 把开头 yaml 标题围栏收敛为唯一 frontmatter，不把标题代码块留在正文', () => {
  const output = normalizeAnalysisArticle(
    '```yaml\ntitle: 三票反对与通胀张力\n```\n\n正文。',
    { exact_entities_and_versions: [] },
  );
  assert.match(output, /^---\ntitle: "三票反对与通胀张力"\n---/);
  assert.doesNotMatch(output, /```yaml/);
  assert.equal((output.match(/^title:/gm) || []).length, 1);
});

test('V2 完整链路按 Opus 5/Kimi K2 定向搜索、写作、局部审计并确定性追加引用', async () => {
  const calls = [];
  let completionIndex = 0;
  const fetchFn = async (url, options) => {
    const body = JSON.parse(options.body || '{}');
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/search')) {
      return jsonResponse({
        results: [
          {
            title: 'Anthropic announces Opus 5',
            url: 'https://www.anthropic.com/news/opus-5',
            publishedDate: '2026-07-20',
            text: 'Anthropic officially announces Opus 5 and its capabilities.',
          },
          {
            title: 'Kimi K2 official release',
            url: 'https://www.kimi.com/blog/kimi-k2',
            publishedDate: '2026-07-18',
            text: 'Kimi officially releases Kimi K2 and describes its capabilities.',
          },
        ],
      });
    }
    completionIndex++;
    if (completionIndex === 1) {
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({
        task_contract: {
          output_language: '简体中文',
          article_type: 'prompt-driven-model-comparison',
          exact_entities_and_versions: [
            { literal: 'Opus 5', version: '5' },
            { literal: 'Kimi K2', version: 'K2' },
          ],
          must_cover: ['比较两者能力'],
          requested_structure: [],
          freshness_requirement: 'recent',
        },
        search_plan: [
          { query: 'Opus 5 official release capabilities', lane: 'official', recent: false },
          { query: 'Kimi K2 official release capabilities', lane: 'official', recent: false },
        ],
      }) } }] });
    }
    if (completionIndex === 2) {
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({
        source_assessments: [
          { source_id: 'S1', source_type: 'primary', relevant: true, entity_matches: ['Opus 5'], safe_statements: ['Opus 5 已发布'] },
          { source_id: 'S2', source_type: 'primary', relevant: true, entity_matches: ['Kimi K2'], safe_statements: ['Kimi K2 已发布'] },
        ],
        requirements: [{ requirement: '比较两者能力', source_ids: ['S1', 'S2'], safe_statements: [], covered: true }],
        entities: [
          { literal: 'Opus 5', verified: true, source_ids: ['S1'] },
          { literal: 'Kimi K2', verified: true, source_ids: ['S2'] },
        ],
        conflicts: [],
        relevant_source_ids: ['S1', 'S2'],
        selected_reference_ids: ['S1', 'S2'],
        editorial_brief: {
          archetype: '技术解释',
          angle: '两款模型的能力差异取决于具体任务与部署约束',
          tension: '公开能力描述与真实使用边界需要分开',
          ending_constraint: '真实任务表现仍需持续验证',
        },
        clarification_needed: false,
      }) } }] });
    }
    if (completionIndex === 3) {
      const prompt = body.messages[1].content;
      assert.match(prompt, /不可修改的 Slack 原始 Prompt/);
      assert.match(prompt, /Opus 5/);
      assert.match(prompt, /Kimi K2/);
      assert.match(prompt, /LatePost AI Writer 编辑方法/);
      assert.match(prompt, /稿型:技术解释/);
      assert.match(prompt, /两款模型的能力差异取决于具体任务与部署约束/);
      assert.doesNotMatch(prompt, /Opus 4\.5|Kimi K2\.6|SEC 10-Q/);
      return jsonResponse({ choices: [{ message: { content: '---\ntitle: English duplicate\n---\ntitle: Opus 5 与 Kimi K2\n---\n\n两者需要按用户指定维度比较。' } }] });
    }
    return jsonResponse({ choices: [{ message: { content: '{"approved":true,"issues":[]}' } }] });
  };

  const result = await runWriter({
    workflow: workflow(),
    input: 'please write a deep dive analysis report comparing newly released Opus 5 and Kimi K2',
    config: config(),
    fetchFn,
    taskContext: { promptRevision: 3 },
  });

  assert.equal(result.ok, true);
  const searchBodies = calls.filter((call) => call.url.endsWith('/search')).map((call) => call.body);
  assert.ok(searchBodies.length >= 6);
  assert.ok(searchBodies.every((body) => /Opus 5|Kimi K2/.test(body.query)));
  assert.ok(searchBodies.every((body) => !/Opus Genetics|KMI|10-Q|K2\.6|Opus 4\.5/.test(body.query)));
  const completionBodies = calls.filter((call) => call.url.endsWith('/chat/completions')).map((call) => call.body);
  assert.deepEqual(completionBodies.slice(0, 2).map((body) => body.model), [
    'moonshotai/kimi-k3',
    'moonshotai/kimi-k3',
  ]);
  assert.ok(completionBodies.slice(0, 2).every((body) => body.reasoning.effort === 'high'));
  assert.equal(completionBodies[2].model, 'qwen/qwen3.8-max');
  assert.equal(completionBodies[2].reasoning.effort, 'high');
  assert.ok(completionBodies.slice(3).every((body) => body.model === 'z-ai/glm-5.2'));
  assert.ok(completionBodies.slice(3).every((body) => body.reasoning.effort === 'none'));
  const article = fs.readFileSync(result.articlePath, 'utf8');
  assert.equal((article.match(/^title:/gm) || []).length, 1);
  assert.match(article, /^---\ntitle: "Opus 5 与 Kimi K2"\n---/);
  assert.match(article, /## 引用链接/);
  assert.match(article, /anthropic\.com\/news\/opus-5/);
  assert.match(article, /kimi\.com\/blog\/kimi-k2/);
  const trace = JSON.parse(fs.readFileSync(result.researchTracePath, 'utf8'));
  assert.equal(trace.pipelineVersion, 'v2');
  assert.deepEqual(trace.models, {
    writer: 'qwen/qwen3.8-max',
    planner: 'moonshotai/kimi-k3',
    review: 'z-ai/glm-5.2',
  });
  assert.equal(trace.taskContract.prompt_revision, 3);
  assert.deepEqual(trace.evidenceMatrix.entities.map((item) => item.literal), ['Opus 5', 'Kimi K2']);
  assert.equal(trace.editorialSkill.id, 'latepost-ai-writer');
  assert.match(trace.editorialSkill.digest, /^[a-f0-9]{64}$/);
  assert.equal(trace.editorialSkill.archetype, '技术解释');
  assert.equal(trace.editorialSkill.routingSource, 'evidence-model');
  assert.equal(trace.factReview.approved, true);
});

test('V2 无法从一手来源确认精确型号时停止无依据写作，但不反复向用户确认', async () => {
  let completionIndex = 0;
  const fetchFn = async (url, options) => {
    if (String(url).endsWith('/search')) {
      return jsonResponse({
        results: [{ title: 'Old Opus release', url: 'https://anthropic.com/news/opus-4-5', text: 'Opus 4.5 release.' }],
      });
    }
    completionIndex++;
    if (completionIndex === 1) {
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({
        task_contract: {
          exact_entities_and_versions: [{ literal: 'Opus 5', version: '5' }],
          must_cover: ['分析 Opus 5'],
          freshness_requirement: 'recent',
        },
        search_plan: [{ query: 'Opus 5 official release', lane: 'official', recent: false }],
      }) } }] });
    }
    return jsonResponse({ choices: [{ message: { content: JSON.stringify({
      source_assessments: [{ source_id: 'S1', source_type: 'irrelevant', relevant: false }],
      entities: [{ literal: 'Opus 5', verified: false, source_ids: [] }],
      relevant_source_ids: [],
      clarification_needed: true,
      clarification_question: '暂未确认 Opus 5，请提供官方链接或确认准确版本。',
    }) } }] });
  };
  const wf = workflow();
  const result = await runWriter({
    workflow: wf,
    input: 'analyze newly released Opus 5',
    config: config(),
    fetchFn,
  });
  assert.equal(result.ok, false);
  assert.equal(result.needsInput, undefined);
  assert.match(result.stderr, /已停止生成以避免无依据写作/);
  assert.equal(fs.existsSync(result.articlePath), false);
  const trace = JSON.parse(fs.readFileSync(result.researchTracePath, 'utf8'));
  assert.equal(trace.needsInput, undefined);
  assert.equal(trace.evidenceMatrix.entities[0].verified, false);
});

test('V2 完全没有检索结果时直接失败，不把缺资料变成 needs_input', async () => {
  const fetchFn = async (url) => {
    if (String(url).endsWith('/search')) return jsonResponse({ results: [] });
    return jsonResponse({ choices: [{ message: { content: JSON.stringify({
      task_contract: {
        article_type: 'company',
        exact_entities_and_versions: [{ literal: '长鑫存储' }],
        search_aliases: ['ChangXin Memory Technologies', 'CXMT'],
        must_cover: ['分析长鑫存储'],
      },
      search_plan: [
        { query: 'ChangXin Memory Technologies official filing', lane: 'official', recent: false },
        { query: 'CXMT latest DRAM market share', lane: 'priority', recent: true },
      ],
    }) } }] });
  };
  const result = await runWriter({
    workflow: workflow(),
    input: '分析长鑫存储',
    config: config(),
    fetchFn,
  });
  assert.equal(result.ok, false);
  assert.equal(result.needsInput, undefined);
  assert.match(result.stderr, /未检索到与任务直接相关的可靠材料/);
});

test('V2 用户页面抓取失败时用 URL 语义定向恢复，不被规划器伪造的 only_user_links 卡死', async () => {
  const calls = [];
  let completionIndex = 0;
  const fetchFn = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/contents')) {
      return jsonResponse({
        requestId: 'contents-kalshi',
        results: [],
        statuses: [{
          id: body.urls[0],
          status: 'error',
          error: { tag: 'CRAWL_UNKNOWN_ERROR', httpStatusCode: 500 },
        }],
      });
    }
    if (String(url).endsWith('/search')) {
      if (/one stop shop for tracking corporate metrics/i.test(body.query || '')) {
        return jsonResponse({
          requestId: 'recovery-kalshi',
          results: [{
            title: 'Kalshi launches Public Companies Hub',
            url: 'https://news.kalshi.com/p/kalshi-public-companies-hub',
            publishedDate: '2026-08-03',
            text: 'Kalshi launched a Public Companies Hub for company earnings schedules, corporate metrics, and related prediction markets.',
          }],
        });
      }
      return jsonResponse({ requestId: 'generic-empty', results: [] });
    }

    completionIndex++;
    if (completionIndex === 1) {
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({
        task_contract: {
          exact_entities_and_versions: [{ literal: 'Kalshi' }],
          search_aliases: ['Kalshi Public Companies Hub'],
          must_cover: [
            'Analyze the linked company reports page',
            'Cover the launch as a one-stop shop for tracking corporate metrics',
          ],
          only_user_links: true,
        },
        search_plan: [
          { query: 'Kalshi latest analysis', lane: 'priority', language: 'en', recent: true },
          { query: 'Kalshi 最新分析', lane: 'open', language: 'zh', recent: true },
        ],
      }) } }] });
    }
    if (completionIndex === 2) {
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({
        source_assessments: [{
          source_id: 'S1',
          source_type: 'primary',
          relevant: true,
          entity_matches: ['Kalshi'],
          safe_statements: ['Kalshi 发布 Public Companies Hub'],
        }],
        requirements: [{
          requirement: '分析 Public Companies Hub',
          source_ids: ['S1'],
          safe_statements: ['该页面汇集财报日程、公司指标和相关预测市场'],
          covered: true,
        }],
        entities: [{ literal: 'Kalshi', verified: true, source_ids: ['S1'] }],
        relevant_source_ids: ['S1'],
        selected_reference_ids: ['S1'],
        conflicts: [],
      }) } }] });
    }
    if (completionIndex === 3) {
      return jsonResponse({ choices: [{ message: { content: '---\ntitle: Kalshi 公司数据入口的意义\n---\n\nKalshi 把财报日程、公司指标与相关预测市场集中到同一入口。' } }] });
    }
    return jsonResponse({ choices: [{ message: { content: '{"approved":true,"issues":[],"critical_claims":[]}' } }] });
  };

  const input = 'please write an analysis about this: https://kalshi.com/company-reports?week=2026-08-03&amp;utm_campaign=kalshi-launches-public-companies-hub-as-one-stop-shop-for-tracking-corporate-metrics';
  const result = await runWriter({ workflow: workflow(), input, config: config(), fetchFn });
  assert.equal(result.ok, true);
  assert.deepEqual(result.sources, ['https://news.kalshi.com/p/kalshi-public-companies-hub']);
  assert.ok(calls.some((call) => call.url.endsWith('/search')
    && /one stop shop for tracking corporate metrics/i.test(call.body.query || '')));
  const trace = JSON.parse(fs.readFileSync(result.researchTracePath, 'utf8'));
  assert.equal(trace.taskContract.only_user_links, false);
  assert.deepEqual(trace.requests.find((request) => request.kind === 'user-contents').contentStatuses, [{
    id: 'https://kalshi.com/company-reports?week=2026-08-03&utm_campaign=kalshi-launches-public-companies-hub-as-one-stop-shop-for-tracking-corporate-metrics',
    status: 'error',
    error: { tag: 'CRAWL_UNKNOWN_ERROR', httpStatusCode: 500 },
  }]);
  assert.deepEqual(trace.userSourceRecovery.supplementalUrls, [
    'https://news.kalshi.com/p/kalshi-public-companies-hub',
  ]);
});
