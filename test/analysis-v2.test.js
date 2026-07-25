import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendDeterministicReferences,
  applyAuditIssues,
  buildWritingPrompt,
  extractExplicitEntityVersions,
  fallbackTaskContract,
  normalizeAuditIssues,
  normalizePlanningResult,
} from '../src/core/analysis-v2.js';
import { runWriter } from '../src/core/runner.js';

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
    model: 'z-ai/glm-5.2',
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
      searchMaxQueries: 6,
      recentWindowDays: 90,
    },
    writer: {
      openrouterApiKey: 'or-key',
      model: 'z-ai/glm-5.2',
      plannerModel: 'z-ai/glm-5.2',
      reviewModel: 'z-ai/glm-5.2',
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

test('用户明确两方结构时 sector 方法论只能补空白，不能强制 TAM/供需章节', () => {
  const input = 'please write an analyze report pointing out the two argument sides and assess which side will spend more on lobbying';
  const contract = fallbackTaskContract(input, { id: 'sector' });
  const prompt = buildWritingPrompt({
    contract,
    evidenceMatrix: { relevant_source_ids: ['S1'] },
    sources: [{ id: 'S1', title: 'Lobbying disclosure', url: 'https://example.com/a', text: 'Evidence.' }],
    workflow: { id: 'sector', defaultMethodology: '必须写 TAM、产业链、供需与三种情景。' },
    asOf: '2026-07-25',
  });
  assert.match(prompt, /用户已经指定结构，不得套用任何固定行业、公司或财报框架/);
  assert.doesNotMatch(prompt, /必须写 TAM/);
  assert.equal(contract.requested_structure.length, 1);
});

test('局部审计只替换逐字命中的句子，不允许审查器整篇重写', () => {
  const article = '---\ntitle: 测试\n---\n\n第一段可靠。\n\nOpus 4.5 比所有模型都强。\n\n最后一段保留。';
  const matrix = { relevant_source_ids: ['S1'] };
  const issues = normalizeAuditIssues({
    issues: [
      {
        article_quote: 'Opus 4.5 比所有模型都强。',
        severity: 'non_core',
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
        clarification_needed: false,
      }) } }] });
    }
    if (completionIndex === 3) {
      const prompt = body.messages[1].content;
      assert.match(prompt, /不可修改的 Slack 原始 Prompt/);
      assert.match(prompt, /Opus 5/);
      assert.match(prompt, /Kimi K2/);
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
  assert.equal(searchBodies.length, 4);
  assert.ok(searchBodies.every((body) => /Opus 5|Kimi K2/.test(body.query)));
  assert.ok(searchBodies.every((body) => !/Opus Genetics|KMI|10-Q|K2\.6|Opus 4\.5/.test(body.query)));
  const article = fs.readFileSync(result.articlePath, 'utf8');
  assert.equal((article.match(/^title:/gm) || []).length, 1);
  assert.match(article, /^---\ntitle: "Opus 5 与 Kimi K2"\n---/);
  assert.match(article, /## 引用链接/);
  assert.match(article, /anthropic\.com\/news\/opus-5/);
  assert.match(article, /kimi\.com\/blog\/kimi-k2/);
  const trace = JSON.parse(fs.readFileSync(result.researchTracePath, 'utf8'));
  assert.equal(trace.pipelineVersion, 'v2');
  assert.equal(trace.taskContract.prompt_revision, 3);
  assert.deepEqual(trace.evidenceMatrix.entities.map((item) => item.literal), ['Opus 5', 'Kimi K2']);
  assert.equal(trace.factReview.approved, true);
});

test('V2 无法从一手来源确认精确型号时返回 needs_input 而不是改用附近版本', async () => {
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
  assert.equal(result.needsInput, true);
  assert.match(result.clarification.question, /暂未确认 Opus 5/);
  assert.equal(fs.existsSync(result.articlePath), false);
  const trace = JSON.parse(fs.readFileSync(result.researchTracePath, 'utf8'));
  assert.equal(trace.needsInput.kind, 'evidence-conflict');
});
