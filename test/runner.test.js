import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isGovernmentFundedMediaSource,
  runWriter,
  sanitizeExaDomains,
  selectAnalysisSources,
  sourcePolicyFor,
} from '../src/core/runner.js';
import { loadConfig } from '../src/config/index.js';

function tempWorkflow(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
  return {
    workDir: dir,
    timeoutMs: 1000,
    promptTemplate: (task) => `写作任务:${task}\n必须写入 article.md`,
    ...overrides,
  };
}

function jsonResponse(body, init = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText || 'OK',
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

test('Exa includeDomains 会移除已知不支持的 X/Twitter 域名，避免整条优先检索 403', () => {
  assert.deepEqual(
    sanitizeExaDomains(['trendforce.com', 'x.com', 'twitter.com', 'www.x.com', 'trendforce.com']),
    ['trendforce.com'],
  );
});

test('搜索门禁排除政府资助媒体，但保留监管原始文件和独立报道', () => {
  assert.equal(isGovernmentFundedMediaSource({ url: 'https://www.bbc.com/news/a' }), true);
  assert.equal(isGovernmentFundedMediaSource({ url: 'https://www.sec.gov/Archives/a' }), false);
  assert.equal(isGovernmentFundedMediaSource({ url: 'https://www.reuters.com/world/a' }), false);
  assert.deepEqual(
    sanitizeExaDomains(['news.bbc.co.uk', 'reuters.com', 'sec.gov']),
    ['reuters.com', 'sec.gov'],
  );
});

test('同一检索层级优先英文或独立第三方，并从候选结果中剔除政府资助媒体', () => {
  const selected = selectAnalysisSources([
    {
      title: '政府资助媒体',
      url: 'https://www.bbc.com/news/a',
      publishedDate: '2026-07-26',
      retrievalLane: 'open',
      text: 'English report',
    },
    {
      title: 'Generic English source',
      url: 'https://generic.example/en',
      publishedDate: '2026-07-26',
      retrievalLane: 'open',
      text: 'English market report from an unknown publisher.',
    },
    {
      title: '财新独立报道',
      url: 'https://www.caixin.com/2026/a.html',
      publishedDate: '2026-07-26',
      retrievalLane: 'open',
      text: '中文市场报道。',
    },
    {
      title: '普通中文来源',
      url: 'https://generic.example/zh',
      publishedDate: '2026-07-26',
      retrievalLane: 'open',
      text: '中文市场信息。',
    },
  ], new Date('2026-07-27T00:00:00Z'), 60);

  assert.deepEqual(
    selected.map((source) => source.url),
    [
      'https://generic.example/en',
      'https://www.caixin.com/2026/a.html',
      'https://generic.example/zh',
    ],
  );
  assert.equal(selected[1].independentThirdParty, true);
});

test('成功:Exa 调研 + OpenRouter 写作后写出带 title frontmatter 的 article.md', async () => {
  const workflow = tempWorkflow({ model: 'workflow/model' });
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url: String(url), opts, body: JSON.parse(opts.body) });
    if (String(url).endsWith('/search')) {
      assert.equal(opts.headers['x-api-key'], 'exa-key');
      return jsonResponse({
        results: [
          {
            title: 'NVIDIA results',
            url: 'https://example.com/nvidia',
            publishedDate: '2026-07-01',
            text: 'Revenue rose because data center demand stayed strong.',
            highlights: ['Data center demand stayed strong.'],
          },
        ],
      });
    }
    assert.equal(opts.headers.Authorization, 'Bearer or-key');
    return jsonResponse({
      choices: [
        { message: { content: '---\ntitle: 英伟达业绩拆解\n---\n正文引用了数据中心需求。' } },
      ],
    });
  };

  const result = await runWriter({
    workflow,
    input: '英伟达业绩',
    config: {
      writer: {
        openrouterApiKey: 'or-key',
        model: 'config/model',
        baseUrl: 'https://openrouter.test/api/v1',
        exaApiKey: 'exa-key',
        exaBaseUrl: 'https://exa.test',
      },
    },
    fetchFn,
  });

  assert.equal(result.ok, true);
  assert.equal(result.articlePath, path.join(workflow.workDir, 'article.md'));
  assert.match(fs.readFileSync(result.articlePath, 'utf8'), /^---\ntitle: 英伟达业绩拆解\n---/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://exa.test/search');
  assert.equal(calls[0].body.query, '英伟达业绩');
  assert.equal(calls[1].url, 'https://openrouter.test/api/v1/chat/completions');
  assert.equal(calls[1].body.model, 'workflow/model');
  assert.equal(calls[1].body.max_tokens, 12000);
  assert.deepEqual(calls[1].body.reasoning, { effort: 'none', exclude: true });
  assert.match(calls[1].body.messages[0].content, /Zen Trading/);
  assert.match(calls[1].body.messages[1].content, /NVIDIA results/);
  assert.match(calls[1].body.messages[1].content, /写作任务:英伟达业绩/);
});

test('工作流确定性内容门禁在 article.md 落盘前执行并可 fail closed', async () => {
  let validationCalls = 0;
  const workflow = tempWorkflow({
    mode: 'newsletter',
    validateArticle: ({ article, research, asOf }) => {
      validationCalls += 1;
      assert.match(article, /待拦截正文/);
      assert.equal(research.length, 1);
      assert.ok(asOf instanceof Date);
      const error = new Error('专用内容门禁未通过');
      error.stage = 'gate';
      throw error;
    },
  });
  const fetchFn = async (url) => String(url).endsWith('/search')
    ? jsonResponse({ results: [{ title: 'Source', url: 'https://example.com/source', text: 'Evidence' }] })
    : jsonResponse({ choices: [{ message: { content: '---\ntitle: Test\n---\n待拦截正文' } }] });
  const result = await runWriter({
    workflow,
    input: 'test gate',
    config: { writer: {
      openrouterApiKey: 'or-key', model: 'model', baseUrl: 'https://openrouter.test/api/v1',
      exaApiKey: 'exa-key', exaBaseUrl: 'https://exa.test',
    } },
    fetchFn,
  });
  assert.equal(validationCalls, 1);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /专用内容门禁未通过/);
  assert.equal(fs.existsSync(path.join(workflow.workDir, 'article.md')), false);
});

test('V1 应急链路为四个中文原创工作流注入确定性编辑方法并记录 trace', async () => {
  const workflow = tempWorkflow({
    id: 'wechat',
    mode: 'analysis',
    editorialSkill: 'latepost-ai-writer',
    model: 'workflow/model',
    factReview: false,
  });
  let writingBody;
  const fetchFn = async (url, opts) => {
    if (String(url).endsWith('/search')) {
      return jsonResponse({
        results: [{
          title: 'Agent product test',
          url: 'https://example.com/agent-test',
          text: 'The product completed one controlled task with human intervention.',
        }],
      });
    }
    writingBody = JSON.parse(opts.body);
    return jsonResponse({
      choices: [{
        message: {
          content: '---\ntitle: 一次成功仍不是稳定能力\n---\n\n受控测试需要人工介入。',
        },
      }],
    });
  };
  const result = await runWriter({
    workflow,
    input: '实测一个 AI Agent 产品',
    config: {
      analysis: { pipelineVersion: 'v1' },
      writer: {
        openrouterApiKey: 'or-key',
        model: 'config/model',
        baseUrl: 'https://openrouter.test/api/v1',
        exaApiKey: 'exa-key',
        exaBaseUrl: 'https://exa.test',
      },
    },
    fetchFn,
  });

  assert.equal(result.ok, true);
  assert.match(writingBody.messages[1].content, /LatePost AI Writer 编辑方法/);
  assert.match(writingBody.messages[1].content, /稿型:产品实测/);
  const trace = JSON.parse(fs.readFileSync(result.researchTracePath, 'utf8'));
  assert.equal(trace.editorialSkill.id, 'latepost-ai-writer');
  assert.equal(trace.editorialSkill.archetype, '产品实测');
  assert.equal(trace.editorialSkill.routingSource, 'deterministic-fallback');
});

test('macro 应急链路按优先级组合双 skill，并把稿型、路由和证据边界写入 trace', async () => {
  const workflow = tempWorkflow({
    id: 'macro',
    mode: 'analysis',
    editorialSkills: ['latepost-ai-writer', 'global-macro-strategy-writer'],
    model: 'workflow/model',
    factReview: false,
  });
  let writingBody;
  const fetchFn = async (url, opts) => {
    if (String(url).endsWith('/search')) {
      return jsonResponse({
        results: [{
          title: 'Federal Reserve release',
          url: 'https://www.federalreserve.gov/example',
          text: 'The policy rate was unchanged.',
        }],
      });
    }
    writingBody = JSON.parse(opts.body);
    return jsonResponse({
      choices: [{ message: { content: '---\ntitle: 利率不变之后\n---\n\n我们的判断仍取决于后续数据。' } }],
    });
  };
  const result = await runWriter({
    workflow,
    input: '美联储会议结果后写一篇宏观快评',
    config: {
      analysis: { pipelineVersion: 'v1' },
      writer: {
        openrouterApiKey: 'or-key',
        model: 'config/model',
        baseUrl: 'https://openrouter.test/api/v1',
        exaApiKey: 'exa-key',
        exaBaseUrl: 'https://exa.test',
      },
    },
    fetchFn,
    taskContext: { routeReason: 'natural-rule' },
  });

  assert.equal(result.ok, true);
  assert.match(writingBody.messages[1].content, /LatePost AI Writer 编辑方法/);
  assert.match(writingBody.messages[1].content, /Global Macro Strategy Writer 主导方法/);
  assert.match(writingBody.messages[1].content, /本宏观方法主导问题、预期差、传导、情景和观察信号/);
  const trace = JSON.parse(fs.readFileSync(result.researchTracePath, 'utf8'));
  assert.equal(trace.routing.reason, 'natural-rule');
  assert.deepEqual(trace.editorialSkills.map((item) => item.id), [
    'latepost-ai-writer',
    'global-macro-strategy-writer',
  ]);
  assert.equal(trace.macroBrief.archetype, '事件快评');
  assert.match(trace.macroBrief.evidenceBoundary, /没有可确认的一手依据/);
});

test('工作流可覆盖 system prompt 与最终产出指令', async () => {
  const workflow = tempWorkflow({
    systemPrompt: 'CUSTOM NEWSLETTER SYSTEM',
    outputInstruction: 'CREATE CUSTOMER.IO NEWSLETTER MARKDOWN',
  });
  let completionBody;
  const fetchFn = async (url, opts) => {
    if (String(url).endsWith('/search')) return jsonResponse({ results: [] });
    completionBody = JSON.parse(opts.body);
    return completionResponse();
  };

  const result = await runWriter({ workflow, input: 'Vol. 1', config: baseConfig(), fetchFn });
  assert.equal(result.ok, true);
  assert.equal(completionBody.messages[0].content, 'CUSTOM NEWSLETTER SYSTEM');
  assert.match(completionBody.messages[1].content, /CREATE CUSTOMER\.IO NEWSLETTER MARKDOWN/);
  assert.doesNotMatch(completionBody.messages[1].content, /微信公众号草稿箱/);
});

test('关系型 Newsletter:首封问候/需求收集不搜索、不要求引用、不运行金融事实审查', async () => {
  const workflow = tempWorkflow({
    id: 'email',
    mode: 'newsletter',
    factReview: true,
    sourcePolicy: { officialFirst: true, requireCitations: true, minOfficialSources: 2 },
  });
  const input = 'support@zentradings.com作为测试邮箱 发给用户的第一篇newsletter，主要内容是收集用户需求 介绍我们专门的agent对接，发到草稿箱';
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return jsonResponse({ choices: [{ message: { content: '---\ntitle: Welcome to Zen Research\n---\nTell us what you need.' } }] });
  };
  const config = baseConfig();
  config.writer.exaApiKey = '';

  const result = await runWriter({ workflow, input, config, fetchFn });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1, '只应调用一次写作模型，不应调用 Exa 或事实审查模型');
  assert.match(calls[0].body.messages[1].content, /关系\/通知型 Newsletter/);
  assert.doesNotMatch(calls[0].body.messages[1].content, /至少引用 2 个官方/);
  const trace = JSON.parse(fs.readFileSync(result.researchTracePath, 'utf8'));
  assert.equal(trace.sourcePolicy.kind, 'relationship-newsletter');
  assert.equal(trace.sourcePolicy.skipResearch, true);
  assert.deepEqual(trace.factReview, { skipped: true, reason: 'non-research-newsletter' });
});

test('研究型 Newsletter:即使同时提到首封，明确要求市场分析时仍保留官方来源门禁', () => {
  const workflow = { mode: 'newsletter', sourcePolicy: { officialFirst: true, requireCitations: true } };
  const policy = sourcePolicyFor({ input: '第一篇 newsletter，请做 AI 基建市场分析并使用官方数据', workflow });
  assert.equal(policy.kind, 'research-newsletter');
  assert.equal(policy.skipResearch, false);
  assert.equal(policy.requireOfficial, true);
  assert.equal(policy.requireCitations, true);
});

test('Qwen3.8-Max 首次空正文时从 high 降到 low 重试并成功', async () => {
  const workflow = tempWorkflow({ model: 'qwen/qwen3.8-max' });
  const config = baseConfig();
  config.writer.reasoningEffort = 'high';
  config.writer.maxTokens = 16000;
  const completionBodies = [];
  const fetchFn = async (url, opts) => {
    if (String(url).endsWith('/search')) return jsonResponse({ results: [] });
    completionBodies.push(JSON.parse(opts.body));
    if (completionBodies.length === 1) {
      return jsonResponse({
        choices: [{ finish_reason: 'length', message: { content: null, reasoning: 'thinking' } }],
        usage: { completion_tokens: 16000, completion_tokens_details: { reasoning_tokens: 16000 } },
      });
    }
    return jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: '---\ntitle: 重试成功\n---\n正文。' } }] });
  };
  const result = await runWriter({ workflow, input: 'AMAT', config, fetchFn });
  assert.equal(result.ok, true);
  assert.equal(completionBodies.length, 2);
  assert.deepEqual(completionBodies[0].reasoning, { effort: 'high', exclude: true });
  assert.deepEqual(completionBodies[1].reasoning, { effort: 'low', exclude: true });
  assert.equal(completionBodies[1].max_tokens, 16000);
});

test('OpenRouter 连续空正文时返回 finish reason 与 token 诊断', async () => {
  const workflow = tempWorkflow();
  let completions = 0;
  const fetchFn = async (url) => {
    if (String(url).endsWith('/search')) return jsonResponse({ results: [] });
    completions++;
    return jsonResponse({
      choices: [{ finish_reason: 'length', message: { content: null } }],
      usage: { completion_tokens: 12000, completion_tokens_details: { reasoning_tokens: 12000 } },
    });
  };
  const result = await runWriter({ workflow, input: 'AMAT', config: baseConfig(), fetchFn });
  assert.equal(result.ok, false);
  assert.equal(completions, 2);
  assert.match(result.stderr, /empty content after retry/);
  assert.match(result.stderr, /finish_reason=length/);
  assert.match(result.stderr, /reasoning_tokens=12000/);
});

test('OpenRouter 输出缺 title frontmatter 时返回 ok:false 且不保留 article.md', async () => {
  const workflow = tempWorkflow();
  const fetchFn = async (url) => {
    if (String(url).endsWith('/search')) return jsonResponse({ results: [] });
    return jsonResponse({ choices: [{ message: { content: '# 没有 frontmatter' } }] });
  };

  const result = await runWriter({
    workflow,
    input: 'x',
    config: {
      writer: {
        openrouterApiKey: 'or-key',
        model: 'm',
        baseUrl: 'https://openrouter.test/api/v1',
        exaApiKey: 'exa-key',
        exaBaseUrl: 'https://exa.test',
      },
    },
    fetchFn,
  });

  assert.equal(result.ok, false);
  assert.match(result.stderr, /title frontmatter/);
  assert.equal(fs.existsSync(result.articlePath), false);
});

test('Exa HTTP 失败时返回 generate 失败信息', async () => {
  const workflow = tempWorkflow();
  const fetchFn = async () => jsonResponse({ error: 'bad key' }, { ok: false, status: 401, statusText: 'Unauthorized' });

  const result = await runWriter({
    workflow,
    input: 'x',
    config: {
      writer: {
        openrouterApiKey: 'or-key',
        model: 'm',
        baseUrl: 'https://openrouter.test/api/v1',
        exaApiKey: 'exa-key',
        exaBaseUrl: 'https://exa.test',
      },
    },
    fetchFn,
  });

  assert.equal(result.ok, false);
  assert.match(result.stderr, /Exa search failed: 401 Unauthorized/);
});

test('OpenRouter 401 返回可操作的本地配置提示', async () => {
  const workflow = tempWorkflow();
  const fetchFn = async (url) => {
    if (String(url).endsWith('/search')) return jsonResponse({ results: [] });
    return jsonResponse({ error: { message: 'User not found.', code: 401 } }, { ok: false, status: 401, statusText: 'Unauthorized' });
  };

  const result = await runWriter({
    workflow,
    input: 'x',
    config: {
      writer: {
        openrouterApiKey: 'bad-key',
        model: 'm',
        baseUrl: 'https://openrouter.test/api/v1',
        exaApiKey: 'exa-key',
        exaBaseUrl: 'https://exa.test',
      },
    },
    fetchFn,
  });

  assert.equal(result.ok, false);
  assert.match(result.stderr, /OpenRouter completion failed: 401 Unauthorized/);
  assert.match(result.stderr, /OPENROUTER_API_KEY/);
  assert.match(result.stderr, /npm run check:openrouter/);
});

function baseConfig() {
  return {
    writer: {
      openrouterApiKey: 'or-key',
      model: 'm',
      baseUrl: 'https://openrouter.test/api/v1',
      exaApiKey: 'exa-key',
      exaBaseUrl: 'https://exa.test',
    },
  };
}

function completionResponse() {
  return jsonResponse({ choices: [{ message: { content: '---\ntitle: 标题\n---\n正文。' } }] });
}

function openingWorkflow(overrides = {}) {
  return tempWorkflow({
    id: 'opening-digest',
    mode: 'newsletter',
    model: 'm',
    factReview: true,
    factReviewPolicy: 'severe-only',
    sourcePolicy: { requireCitations: true, officialFirst: false, minOfficialSources: 0 },
    validateArticle: () => ({ warnings: [], stats: {} }),
    ...overrides,
  });
}

test('Opening Digest 零研究结果时写出确定性数据版并记录 trace', async () => {
  const workflow = openingWorkflow();
  const result = await runWriter({
    workflow,
    input: 'opening',
    config: baseConfig(),
    fetchFn: async (url) => {
      if (String(url).endsWith('/search')) return jsonResponse({ results: [] });
      throw new Error(`unexpected ${url}`);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.contentMode, 'data-only');
  assert.match(fs.readFileSync(result.articlePath, 'utf8'), /Editorial update unavailable for this edition/);
  const trace = JSON.parse(fs.readFileSync(result.researchTracePath, 'utf8'));
  assert.equal(trace.contentMode, 'data-only');
  assert.match(trace.fallbackReason, /未检索到可用研究来源/);
});

test('Opening Digest OpenRouter 失败时降级为数据版而不返回 generate 失败', async () => {
  const workflow = openingWorkflow();
  const result = await runWriter({
    workflow,
    input: 'opening',
    config: baseConfig(),
    fetchFn: async (url) => String(url).endsWith('/search')
      ? jsonResponse({ results: [{ title: 'Source', url: 'https://example.com/a', text: 'Supported market fact.' }] })
      : jsonResponse({ error: 'down' }, { ok: false, status: 503, statusText: 'Unavailable' }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.contentMode, 'data-only');
  assert.match(fs.readFileSync(result.articlePath, 'utf8'), /title: Zen Opening Digest/);
});

test('Opening Digest 普通审查问题只记录 trace，不修改或阻断稿件', async () => {
  const workflow = openingWorkflow();
  const draft = '---\ntitle: Zen Opening Digest\n---\n## Today\nOne item.';
  let completion = 0;
  const result = await runWriter({
    workflow,
    input: 'opening',
    config: baseConfig(),
    fetchFn: async (url) => {
      if (String(url).endsWith('/search')) return jsonResponse({ results: [{ title: 'Source', url: 'https://example.com/a', text: 'Supported market fact.' }] });
      completion += 1;
      return completion === 1
        ? jsonResponse({ choices: [{ message: { content: draft } }] })
        : jsonResponse({ choices: [{ message: { content: JSON.stringify({ issues: [{ category: 'freshness', confidence: 'high', core: false, message: 'old source' }], revised_markdown: '' }) } }] });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.contentMode, 'editorial');
  assert.equal(fs.readFileSync(result.articlePath, 'utf8'), draft);
  const trace = JSON.parse(fs.readFileSync(result.researchTracePath, 'utf8'));
  assert.equal(trace.factReview.policy, 'severe-only');
  assert.equal(trace.factReview.severeIssues.length, 0);
});

test('Opening Digest 严重事实问题修复并复核通过后可继续', async () => {
  const workflow = openingWorkflow();
  const bad = '---\ntitle: Zen Opening Digest\n---\nRevenue was 900 billion.';
  const fixed = '---\ntitle: Zen Opening Digest\n---\nRevenue was 90 billion.';
  const severe = { category: 'fabricated_number_or_date', confidence: 'high', core: true, claim: 'Revenue was 900 billion.', evidence: 'Source reports revenue of 90 billion.', source_url: 'https://example.com/a', message: 'wrong revenue' };
  let completion = 0;
  const result = await runWriter({
    workflow,
    input: 'opening',
    config: baseConfig(),
    fetchFn: async (url) => {
      if (String(url).endsWith('/search')) return jsonResponse({ results: [{ title: 'Source', url: 'https://example.com/a', text: 'Source reports revenue of 90 billion.' }] });
      completion += 1;
      if (completion === 1) return jsonResponse({ choices: [{ message: { content: bad } }] });
      if (completion === 2) return jsonResponse({ choices: [{ message: { content: JSON.stringify({ issues: [severe], revised_markdown: fixed }) } }] });
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ issues: [] }) } }] });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(result.articlePath, 'utf8'), fixed);
  const trace = JSON.parse(fs.readFileSync(result.researchTracePath, 'utf8'));
  assert.equal(trace.factReview.repaired, true);
});

test('Opening Digest 严重事实问题两轮修复仍失败时硬停，不降级为数据版', async () => {
  const workflow = openingWorkflow();
  const bad = '---\ntitle: Zen Opening Digest\n---\nRevenue was 900 billion.';
  const severe = { category: 'fabricated_number_or_date', confidence: 'high', core: true, claim: 'Revenue was 900 billion.', evidence: 'Source reports revenue of 90 billion.', source_url: 'https://example.com/a', message: 'wrong revenue' };
  let completion = 0;
  const result = await runWriter({
    workflow,
    input: 'opening',
    config: baseConfig(),
    fetchFn: async (url) => {
      if (String(url).endsWith('/search')) return jsonResponse({ results: [{ title: 'Source', url: 'https://example.com/a', text: 'Source reports revenue of 90 billion.' }] });
      completion += 1;
      if (completion === 1) return jsonResponse({ choices: [{ message: { content: bad } }] });
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ issues: [severe], revised_markdown: bad }) } }] });
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /严重事实问题/);
  assert.equal(fs.existsSync(result.articlePath), false);
  const trace = JSON.parse(fs.readFileSync(result.researchTracePath, 'utf8'));
  assert.equal(trace.factReview.approved, false);
  assert.equal(trace.factReview.policy, 'severe-only');
  assert.equal(trace.factReview.verificationHistory.length, 2);
  assert.equal(trace.factReview.unresolvedSevereIssues.length, 1);
});

test('双路调研:优先路带 includeDomains,开放路不带,结果按优先在前合并去重', async () => {
  const workflow = tempWorkflow({ research: { prioritySources: ['trendforce.com'] } });
  const calls = [];
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/search')) {
      if (body.includeDomains) {
        assert.deepEqual(body.includeDomains, ['trendforce.com']);
        assert.equal(body.numResults, 4); // exaPriorityResults 默认
        return jsonResponse({
          results: [
            { title: 'TrendForce HBM', url: 'https://trendforce.com/hbm', text: '优先信源正文' },
            { title: '重复来源', url: 'https://open.example.com/dup', text: '会被开放路重复命中' },
          ],
        });
      }
      return jsonResponse({
        results: [
          { title: '重复来源', url: 'https://open.example.com/dup/', text: '开放路正文' }, // trailing slash,规范化后与优先路重复
          { title: '开放来源', url: 'https://other.example.com/x', text: '开放路独有' },
        ],
      });
    }
    return completionResponse();
  };

  const result = await runWriter({ workflow, input: 'HBM 需求', config: baseConfig(), fetchFn });

  assert.equal(result.ok, true);
  const searchCalls = calls.filter((c) => c.url.endsWith('/search'));
  assert.equal(searchCalls.length, 2);
  assert.ok(searchCalls.some((c) => c.body.includeDomains));
  assert.ok(searchCalls.some((c) => !c.body.includeDomains));
  // 合并顺序:优先路在前,重复 URL(规范化后)只保留优先路那条
  assert.deepEqual(result.sources, [
    'https://trendforce.com/hbm',
    'https://open.example.com/dup',
    'https://other.example.com/x',
  ]);
});

test('严格任务:独立检索官方域名,注入当前时间,正文引用已检索官方 URL 后才成功', async () => {
  const workflow = tempWorkflow({
    research: {
      prioritySources: [],
      officialSources: ['sec.gov', 'nasdaq.com'],
      minOfficialSources: 2,
    },
  });
  const searchBodies = [];
  let completionBody;
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (String(url).endsWith('/search')) {
      searchBodies.push(body);
      if (body.includeDomains) {
        return jsonResponse({
          results: [
            { title: 'SEC filing', url: 'https://www.sec.gov/filing', text: 'Official filing.' },
            { title: 'Nasdaq event', url: 'https://www.nasdaq.com/event', text: 'Official exchange event.' },
          ],
        });
      }
      return jsonResponse({ results: [{ title: 'Secondary', url: 'https://news.example/a', text: 'Secondary report.' }] });
    }
    completionBody = body;
    return jsonResponse({
      choices: [{ message: { content: [
        '---',
        'title: 严格来源测试',
        '---',
        '据[SEC 文件](https://www.sec.gov/filing)与[Nasdaq 公告](https://www.nasdaq.com/event)，事实成立。',
      ].join('\n') } }],
    });
  };

  const result = await runWriter({
    workflow,
    input: '充分搜集并引用官方与一手信源的数据',
    config: baseConfig(),
    fetchFn,
  });

  assert.equal(result.ok, true);
  const officialSearch = searchBodies.find((body) => body.includeDomains);
  assert.deepEqual(officialSearch.includeDomains, ['sec.gov', 'nasdaq.com']);
  assert.match(officialSearch.query, /official filing investor relations exchange data/);
  const prompt = completionBody.messages[1].content;
  assert.match(prompt, /America\/Los_Angeles/);
  assert.match(prompt, /周末要明确对应最近一个交易日/);
  assert.match(prompt, /【一级优先·官方\/一手信源】SEC filing/);
  assert.match(prompt, /依次追加内容调研问卷图和社群封底图，二者是最终两个节点/);
  const trace = JSON.parse(fs.readFileSync(result.researchTracePath, 'utf8'));
  assert.equal(trace.selectedSources.filter((source) => source.kind === 'official').length, 2);
});

test('研究型 Newsletter:正文未引用官方链接时不再因数量门禁失败', async () => {
  const workflow = tempWorkflow({
    mode: 'newsletter',
    factReview: false,
    sourcePolicy: { officialFirst: true, requireCitations: true, minOfficialSources: 2 },
    research: {
      prioritySources: [],
      officialSources: ['sec.gov', 'nasdaq.com'],
      minOfficialSources: 2,
    },
  });
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (String(url).endsWith('/search')) {
      if (body.includeDomains) {
        return jsonResponse({ results: [
          { title: 'SEC filing', url: 'https://www.sec.gov/filing', text: 'Official.' },
          { title: 'Nasdaq event', url: 'https://www.nasdaq.com/event', text: 'Official.' },
        ] });
      }
      return jsonResponse({ results: [] });
    }
    return jsonResponse({ choices: [{ message: { content: '---\ntitle: 无链接 Newsletter\n---\n正文没有来源链接。' } }] });
  };

  const result = await runWriter({
    workflow,
    input: '请基于官方一手信源撰写市场分析 Newsletter',
    config: baseConfig(),
    fetchFn,
  });

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(result.articlePath), true);
  const trace = JSON.parse(fs.readFileSync(result.researchTracePath, 'utf8'));
  assert.equal(trace.citationValidation.matchedOfficialSourceCount, 0);
  assert.equal(trace.citationValidation.passed, true);
});

test('严格任务:开放搜索成功但官方来源不足时在生成前失败', async () => {
  const workflow = tempWorkflow({
    research: {
      prioritySources: [],
      officialSources: ['sec.gov', 'nasdaq.com'],
      minOfficialSources: 2,
    },
  });
  let completionCalls = 0;
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (String(url).endsWith('/search')) {
      if (body.includeDomains) {
        return jsonResponse({ results: [{ title: 'SEC filing', url: 'https://www.sec.gov/only-one', text: 'Official.' }] });
      }
      return jsonResponse({ results: [
        { title: 'Secondary A', url: 'https://news.example/a' },
        { title: 'Secondary B', url: 'https://news.example/b' },
      ] });
    }
    completionCalls++;
    return completionResponse();
  };

  const result = await runWriter({ workflow, input: '请用官方一手信源并引用', config: baseConfig(), fetchFn });

  assert.equal(result.ok, false);
  assert.equal(completionCalls, 0);
  assert.match(result.stderr, /仅检索到 1 个官方\/一手来源,至少需要 2 个/);
});

test('公众号严格任务:缺少文末引用链接章节时拒绝落盘', async () => {
  const workflow = tempWorkflow({
    research: {
      prioritySources: [],
      officialSources: ['sec.gov', 'nasdaq.com'],
      minOfficialSources: 2,
    },
  });
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (String(url).endsWith('/search')) {
      if (body.includeDomains) {
        return jsonResponse({ results: [
          { title: 'SEC filing', url: 'https://www.sec.gov/filing', text: 'Official.' },
          { title: 'Nasdaq event', url: 'https://www.nasdaq.com/event', text: 'Official.' },
        ] });
      }
      return jsonResponse({ results: [] });
    }
    return jsonResponse({ choices: [{ message: { content: '---\ntitle: 无引用稿\n---\n正文只有无链接断言。' } }] });
  };

  const result = await runWriter({ workflow, input: '请充分引用官方与一手信源', config: baseConfig(), fetchFn });

  assert.equal(result.ok, false);
  assert.match(result.stderr, /缺少文末唯一的“引用链接”/);
  assert.equal(fs.existsSync(result.articlePath), false);
});

test('法律案件:先读取用户案卷再按案名案号深搜,不套用公司官方域名,引用统一移到文末并去重', async () => {
  const caseUrl = 'https://www.pacermonitor.com/public/case/65430363/example';
  const complaintUrl = 'https://assets.example.com/complaint.pdf';
  const workflow = tempWorkflow({
    id: 'wechat',
    mode: 'analysis',
    sourcePolicy: { officialFirst: true, requireCitations: true, minOfficialSources: 2 },
    research: {
      prioritySources: ['trendforce.com'],
      officialSources: ['sec.gov', 'sse.com.cn', 'szse.cn'],
    },
  });
  const searchBodies = [];
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    if (String(url).endsWith('/contents')) {
      return jsonResponse({ results: [{
        title: 'Susquehanna Securities, LLC v. John Does, 1:26-cv-05474',
        url: caseUrl,
        text: 'Docket and party information for the exact case.',
      }] });
    }
    if (String(url).endsWith('/search')) {
      searchBodies.push(body);
      if (/Find materials about this exact case only/.test(body.systemPrompt || '')) {
        return jsonResponse({ results: [{ title: 'Complaint PDF', url: complaintUrl, text: 'Susquehanna v. John Does, 1:26-cv-05474, filed complaint allegations.' }] });
      }
      if (body.includeDomains) return jsonResponse({ results: [] });
      return jsonResponse({ results: [] });
    }
    return jsonResponse({ choices: [{ message: { content: [
      '---',
      'title: 案件拆解',
      '---',
      `根据[公开案卷](${caseUrl})，案件已经立案。起诉方在[起诉状](${complaintUrl})中提出相关指控，但这不是法院认定。`,
      `重复引用[公开案卷](${caseUrl})。`,
    ].join('\n') } }] });
  };

  const result = await runWriter({
    workflow,
    input: `拆解分析这份法院案件文件 ${caseUrl}`,
    config: baseConfig(),
    fetchFn,
  });

  assert.equal(result.ok, true);
  const policy = sourcePolicyFor({ input: `拆解分析这份法院案件文件 ${caseUrl}`, workflow });
  assert.equal(policy.kind, 'legal-document-analysis');
  assert.equal(policy.minOfficialSources, 0);
  assert.equal('minOfficialCitations' in policy, false);
  assert.equal(policy.requireUserSource, true);
  assert.equal(policy.maxReferences, 5);
  const domainSearch = searchBodies.find((body) => body.includeDomains);
  assert.deepEqual(domainSearch.includeDomains, [
    'pacer.uscourts.gov', 'uscourts.gov', 'nysd.uscourts.gov', 'justice.gov', 'sec.gov',
  ]);
  assert.ok(searchBodies.some((body) => /1:26-cv-05474/.test(body.query)));
  assert.ok(searchBodies.every((body) => !/重点解释案情/.test(body.query)));
  assert.ok(searchBodies.some((body) => /Find materials about this exact case only/.test(body.systemPrompt || '')));

  const article = fs.readFileSync(result.articlePath, 'utf8');
  const [body, references] = article.split('## 引用链接');
  assert.doesNotMatch(body, /https?:\/\//);
  assert.match(references, new RegExp(caseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(references, new RegExp(complaintUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal((references.match(/https?:\/\//g) || []).length, 2);
  assert.equal((article.match(new RegExp(caseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1);
  const trace = JSON.parse(fs.readFileSync(result.researchTracePath, 'utf8'));
  assert.ok(trace.researchLanes.includes('legal-record-search'));
  assert.equal(trace.models.writer, 'm');
});

test('严格任务:官方域名检索偶发返回站外 URL 时不得计入官方来源', async () => {
  const workflow = tempWorkflow({
    research: {
      prioritySources: [],
      officialSources: ['sec.gov', 'nasdaq.com'],
      minOfficialSources: 2,
    },
  });
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (String(url).endsWith('/search')) {
      if (body.includeDomains) {
        return jsonResponse({ results: [
          { title: 'SEC filing', url: 'https://www.sec.gov/filing', text: 'Official.' },
          { title: 'Unexpected mirror', url: 'https://mirror.example/nasdaq-event', text: 'Not official.' },
        ] });
      }
      return jsonResponse({ results: [] });
    }
    return completionResponse();
  };

  const result = await runWriter({ workflow, input: '请引用官方一手信源', config: baseConfig(), fetchFn });

  assert.equal(result.ok, false);
  assert.match(result.stderr, /仅检索到 1 个官方\/一手来源/);
});

test('company 专项调研:基础查询之外并行执行 extraQueries', async () => {
  const workflow = tempWorkflow({
    research: {
      prioritySources: [],
      extraQueries: (task) => [`${task} 历史季度`, `${task} 竞争产业链`],
    },
  });
  const queries = [];
  const fetchFn = async (url, opts) => {
    if (String(url).endsWith('/search')) {
      const body = JSON.parse(opts.body);
      queries.push(body.query);
      return jsonResponse({ results: [{ title: body.query, url: `https://example.com/${queries.length}` }] });
    }
    return completionResponse();
  };
  const result = await runWriter({ workflow, input: 'AMAT', config: baseConfig(), fetchFn });
  assert.equal(result.ok, true);
  assert.deepEqual(queries, ['AMAT', 'AMAT 历史季度', 'AMAT 竞争产业链']);
});

test('company 财报深搜:传递 deep/financial report 参数,展开 subpages 并写调研轨迹', async () => {
  const workflow = tempWorkflow({
    id: 'company',
    research: {
      prioritySources: [],
      extraQueries: () => [{
        query: 'AMAT five quarters',
        type: 'deep',
        category: 'financial report',
        numResults: 8,
        kind: 'quarterly-financials',
        systemPrompt: 'Prefer official filings',
        additionalQueries: ['AMAT SEC 10-Q'],
      }],
    },
  });
  let deepBody;
  const fetchFn = async (url, opts) => {
    if (String(url).endsWith('/search')) {
      const body = JSON.parse(opts.body);
      if (body.category === 'financial report') {
        deepBody = body;
        return jsonResponse({
          requestId: 'exa-deep-1',
          costDollars: { total: 0.012 },
          results: [{
            title: 'FY26 Q2', url: 'https://sec.example/q2', text: 'Q2 data',
            subpages: [{ title: 'FY26 Q1', url: 'https://sec.example/q1', text: 'Q1 data' }],
          }],
        });
      }
      return jsonResponse({ requestId: 'exa-open-1', results: [] });
    }
    return completionResponse();
  };
  const result = await runWriter({ workflow, input: 'AMAT', config: baseConfig(), fetchFn });
  assert.equal(result.ok, true);
  assert.equal(deepBody.type, 'deep');
  assert.equal(deepBody.category, 'financial report');
  assert.equal(deepBody.numResults, 8);
  assert.match(deepBody.systemPrompt, /^Prefer official filings /);
  assert.match(deepBody.systemPrompt, /Exclude state-owned, public-service, and government-funded media/);
  assert.deepEqual(deepBody.additionalQueries, ['AMAT SEC 10-Q']);
  assert.ok(result.sources.includes('https://sec.example/q1'));

  const trace = JSON.parse(fs.readFileSync(result.researchTracePath, 'utf8'));
  const deepEvent = trace.requests.find((event) => event.kind === 'quarterly-financials');
  assert.equal(deepEvent.status, 'ok');
  assert.equal(deepEvent.requestId, 'exa-deep-1');
  assert.ok(deepEvent.results.some((source) => source.url === 'https://sec.example/q1'));
  assert.ok(trace.selectedSources.some((source) => source.kind === 'financial-report'));
});

test('优先路网络 hang(fetchFn 永不返回)时,exaTimeoutMs 超时后按失败降级为仅开放路结果,任务不会永久挂起', async () => {
  const workflow = tempWorkflow({ research: { prioritySources: ['trendforce.com'] } });
  const config = baseConfig();
  config.writer.exaTimeoutMs = 30; // 很短的超时,让测试快速触发
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    if (String(url).endsWith('/search')) {
      if (body.includeDomains) {
        // 模拟网络 hang:永不 resolve/reject,只在 signal 被 abort 时才拒绝
        return new Promise((resolve, reject) => {
          opts.signal?.addEventListener('abort', () => {
            const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
          });
        });
      }
      return jsonResponse({ results: [{ title: '开放来源', url: 'https://open.example.com/a' }] });
    }
    return completionResponse();
  };

  const result = await runWriter({ workflow, input: 'HBM 需求', config, fetchFn });
  assert.equal(result.ok, true);
  assert.deepEqual(result.sources, ['https://open.example.com/a']);
});

test('外部取消信号会中断进行中的网络请求且不会写出 article.md', async () => {
  const workflow = tempWorkflow();
  const controller = new AbortController();
  let requestStarted;
  const entered = new Promise((resolve) => { requestStarted = resolve; });
  const fetchFn = async (_url, opts) => {
    requestStarted();
    return new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
    });
  };
  const pending = runWriter({
    workflow,
    input: 'Analyze Nvidia',
    config: baseConfig(),
    fetchFn,
    signal: controller.signal,
  });
  await entered;
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  assert.equal(fs.existsSync(path.join(workflow.workDir, 'article.md')), false);
});

test('优先路失败时降级为仅开放路结果,不抛错', async () => {
  const workflow = tempWorkflow({ research: { prioritySources: ['trendforce.com'] } });
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    if (String(url).endsWith('/search')) {
      if (body.includeDomains) return jsonResponse({ error: 'boom' }, { ok: false, status: 500, statusText: 'Error' });
      return jsonResponse({ results: [{ title: '开放来源', url: 'https://open.example.com/a' }] });
    }
    return completionResponse();
  };

  const result = await runWriter({ workflow, input: 'HBM 需求', config: baseConfig(), fetchFn });
  assert.equal(result.ok, true);
  assert.deepEqual(result.sources, ['https://open.example.com/a']);
});

test('开放路失败但优先路成功时降级为仅优先路结果,不抛错', async () => {
  const workflow = tempWorkflow({ research: { prioritySources: ['trendforce.com'] } });
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    if (String(url).endsWith('/search')) {
      if (body.includeDomains) return jsonResponse({ results: [{ title: '优先来源', url: 'https://trendforce.com/a' }] });
      return jsonResponse({ error: 'boom' }, { ok: false, status: 500, statusText: 'Error' });
    }
    return completionResponse();
  };

  const result = await runWriter({ workflow, input: 'HBM 需求', config: baseConfig(), fetchFn });
  assert.equal(result.ok, true);
  assert.deepEqual(result.sources, ['https://trendforce.com/a']);
});

test('优先路与开放路都失败时才抛错', async () => {
  const workflow = tempWorkflow({ research: { prioritySources: ['trendforce.com'] } });
  const fetchFn = async (url) => {
    if (String(url).endsWith('/search')) return jsonResponse({ error: 'boom' }, { ok: false, status: 500, statusText: 'Server Error' });
    return completionResponse();
  };

  const result = await runWriter({ workflow, input: 'HBM 需求', config: baseConfig(), fetchFn });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /Exa search failed: 500 Server Error/);
});

test('任务 input 含单个 URL 时调用 /contents 抓取,结果作为最高优先素材', async () => {
  const workflow = tempWorkflow();
  const calls = [];
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/contents')) {
      assert.deepEqual(body.urls, ['https://x.com/post/1']);
      assert.equal(body.text, true);
      return jsonResponse({ results: [{ title: '用户贴的推文', url: 'https://x.com/post/1', text: '推文正文' }] });
    }
    if (String(url).endsWith('/search')) {
      assert.equal(body.query, '分析一下这条'); // URL 已从 query 里去掉
      return jsonResponse({ results: [{ title: '开放来源', url: 'https://open.example.com/a' }] });
    }
    return completionResponse();
  };

  const result = await runWriter({
    workflow,
    input: '分析一下这条 https://x.com/post/1',
    config: baseConfig(),
    fetchFn,
  });

  assert.equal(result.ok, true);
  assert.ok(calls.some((c) => c.url.endsWith('/contents')));
  assert.deepEqual(result.sources, ['https://x.com/post/1', 'https://open.example.com/a']);
});

test('任务 input 含多个 URL 时 /contents 一次性抓取全部(最多 5 个)', async () => {
  const workflow = tempWorkflow();
  const urls = ['https://a.com/1', 'https://b.com/2', 'https://c.com/3'];
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    if (String(url).endsWith('/contents')) {
      assert.deepEqual(body.urls, urls);
      return jsonResponse({ results: urls.map((u, i) => ({ title: `素材${i}`, url: u, text: 'x' })) });
    }
    if (String(url).endsWith('/search')) return jsonResponse({ results: [] });
    return completionResponse();
  };

  const result = await runWriter({
    workflow,
    input: `看看这几条:${urls.join(' ')}`,
    config: baseConfig(),
    fetchFn,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.sources, urls);
});

test('严格官方任务允许一次抓取最多 8 个用户指定 URL', async () => {
  const workflow = tempWorkflow({
    research: {
      prioritySources: [],
      officialSources: ['sec.gov'],
      minOfficialSources: 8,
    },
  });
  const urls = Array.from({ length: 8 }, (_, i) => `https://www.sec.gov/source-${i + 1}`);
  let contentsBody;
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (String(url).endsWith('/contents')) {
      contentsBody = body;
      return jsonResponse({ results: urls.map((sourceUrl, i) => ({ title: `SEC ${i + 1}`, url: sourceUrl, text: 'Official.' })) });
    }
    if (String(url).endsWith('/search')) return jsonResponse({ results: [] });
    return jsonResponse({ choices: [{ message: { content: [
      '---',
      'title: 八个官方来源',
      '---',
      ...urls.map((sourceUrl, i) => `[SEC ${i + 1}](${sourceUrl})`),
    ].join('\n') } }] });
  };

  const result = await runWriter({
    workflow,
    input: `请充分引用官方一手信源 ${urls.join(' ')}`,
    config: baseConfig(),
    fetchFn,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(contentsBody.urls, urls);
});

test('input 去掉 URL 后为空白时跳过两路搜索,只用 /contents 素材', async () => {
  const workflow = tempWorkflow();
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push(String(url));
    if (String(url).endsWith('/contents')) {
      return jsonResponse({ results: [{ title: '用户素材', url: 'https://x.com/post/1', text: '正文' }] });
    }
    return completionResponse();
  };

  const result = await runWriter({
    workflow,
    input: 'https://x.com/post/1',
    config: baseConfig(),
    fetchFn,
  });

  assert.equal(result.ok, true);
  assert.equal(calls.some((u) => u.endsWith('/search')), false);
  assert.deepEqual(result.sources, ['https://x.com/post/1']);
});

test('/contents 抓取失败时降级,不影响两路搜索结果且不报错', async () => {
  const workflow = tempWorkflow();
  const fetchFn = async (url, opts) => {
    if (String(url).endsWith('/contents')) return jsonResponse({ error: 'boom' }, { ok: false, status: 500, statusText: 'Error' });
    if (String(url).endsWith('/search')) return jsonResponse({ results: [{ title: '开放来源', url: 'https://open.example.com/a' }] });
    return completionResponse();
  };

  const result = await runWriter({
    workflow,
    input: '分析一下 https://x.com/post/1',
    config: baseConfig(),
    fetchFn,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.sources, ['https://open.example.com/a']);
});

test('素材顺序:用户指定 > 优先信源 > 开放搜索,用户链接并入一级优先层', async () => {
  const workflow = tempWorkflow({ research: { prioritySources: ['trendforce.com'] } });
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    if (String(url).endsWith('/contents')) {
      return jsonResponse({ results: [{ title: '用户贴的推文', url: 'https://x.com/post/1', text: '用户正文' }] });
    }
    if (String(url).endsWith('/search')) {
      if (body.includeDomains) return jsonResponse({ results: [{ title: 'TrendForce 报告', url: 'https://trendforce.com/r', text: '优先正文' }] });
      return jsonResponse({ results: [{ title: '公开报道', url: 'https://open.example.com/n', text: '开放正文' }] });
    }
    return jsonResponse({
      choices: [{ message: { content: '---\ntitle: 标题\n---\n正文。' } }],
    });
  };
  const calls = [];
  const wrappedFetch = async (url, opts) => { calls.push({ url: String(url), opts }); return fetchFn(url, opts); };

  const result = await runWriter({
    workflow,
    input: '综合分析一下 https://x.com/post/1',
    config: baseConfig(),
    fetchFn: wrappedFetch,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.sources, [
    'https://x.com/post/1',
    'https://trendforce.com/r',
    'https://open.example.com/n',
  ]);
  const completionCall = calls.find((c) => c.url.endsWith('/chat/completions'));
  const prompt = JSON.parse(completionCall.opts.body).messages[1].content;
  assert.match(prompt, /【一级优先·用户指定素材】用户贴的推文/);
  assert.match(prompt, /【一级优先·既定优先信源】TrendForce 报告/);
  assert.match(prompt, /【三级·开放检索】公开报道/);
  const trace = JSON.parse(fs.readFileSync(result.researchTracePath, 'utf8'));
  assert.deepEqual(trace.sourceTiers, { firstPriority: 2, specialist: 0, open: 1 });
  assert.equal(trace.selectedSources[0].priorityTier, 1);
  assert.equal(trace.selectedSources[0].userSpecified, true);
});

test('用户指定素材全文(< 24000 字符默认上限)不截断,原样进入 prompt', async () => {
  const workflow = tempWorkflow();
  const longText = 'A'.repeat(20000); // 低于默认上限 24000,不应截断
  const calls = [];
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    calls.push({ url: String(url), opts });
    if (String(url).endsWith('/contents')) {
      return jsonResponse({ results: [{ title: '长文', url: 'https://x.com/post/1', text: longText }] });
    }
    return completionResponse();
  };

  const result = await runWriter({ workflow, input: 'https://x.com/post/1', config: baseConfig(), fetchFn });

  assert.equal(result.ok, true);
  const completionCall = calls.find((c) => c.url.endsWith('/chat/completions'));
  const prompt = JSON.parse(completionCall.opts.body).messages[1].content;
  assert.ok(prompt.includes(longText)); // 全文原样保留
  assert.ok(!prompt.includes('原文过长已截断'));
});

test('用户指定素材超过 exaUserContentMaxChars 时截断并标注"原文过长已截断"', async () => {
  const workflow = tempWorkflow();
  const longText = 'B'.repeat(30000); // 超过默认上限 24000
  const calls = [];
  const fetchFn = async (url, opts) => {
    if (String(url).endsWith('/contents')) {
      return jsonResponse({ results: [{ title: '超长文', url: 'https://x.com/post/2', text: longText }] });
    }
    calls.push({ url: String(url), opts });
    return completionResponse();
  };

  const result = await runWriter({ workflow, input: 'https://x.com/post/2', config: baseConfig(), fetchFn });

  assert.equal(result.ok, true);
  const completionCall = calls.find((c) => c.url.endsWith('/chat/completions'));
  const prompt = JSON.parse(completionCall.opts.body).messages[1].content;
  assert.ok(!prompt.includes(longText)); // 未原样保留全文
  assert.ok(prompt.includes(`${'B'.repeat(24000)}\n(原文过长已截断)`));
});

test('搜索素材(非用户指定)仍维持 2400 字符上限截断', async () => {
  const workflow = tempWorkflow();
  const longText = 'C'.repeat(5000);
  const calls = [];
  const fetchFn = async (url, opts) => {
    if (String(url).endsWith('/search')) {
      return jsonResponse({ results: [{ title: '开放来源', url: 'https://open.example.com/a', text: longText }] });
    }
    calls.push({ url: String(url), opts });
    return completionResponse();
  };

  const result = await runWriter({ workflow, input: '综述一下行业', config: baseConfig(), fetchFn });

  assert.equal(result.ok, true);
  const completionCall = calls.find((c) => c.url.endsWith('/chat/completions'));
  const prompt = JSON.parse(completionCall.opts.body).messages[1].content;
  assert.ok(prompt.includes(`${'C'.repeat(2400)}\n(原文过长已截断)`));
  assert.ok(!prompt.includes(longText));
});

test('writer.exaUserContentMaxChars 可覆盖用户指定素材截断上限', async () => {
  const workflow = tempWorkflow();
  const text = 'D'.repeat(100);
  const calls = [];
  const fetchFn = async (url, opts) => {
    if (String(url).endsWith('/contents')) {
      return jsonResponse({ results: [{ title: '短文', url: 'https://x.com/post/3', text }] });
    }
    calls.push({ url: String(url), opts });
    return completionResponse();
  };

  const config = baseConfig();
  config.writer.exaUserContentMaxChars = 50; // 覆盖为很小的上限

  const result = await runWriter({ workflow, input: 'https://x.com/post/3', config, fetchFn });

  assert.equal(result.ok, true);
  const completionCall = calls.find((c) => c.url.endsWith('/chat/completions'));
  const prompt = JSON.parse(completionCall.opts.body).messages[1].content;
  assert.ok(prompt.includes(`${'D'.repeat(50)}\n(原文过长已截断)`));
  assert.ok(!prompt.includes(text));
});

test('loadConfig:EXA_USER_CONTENT_MAX_CHARS 覆盖默认值,未设置时默认 24000', () => {
  const baseEnv = {
    SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x',
    WECHAT_APP_ID: 'wx', WECHAT_APP_SECRET: 'sec',
    OPENROUTER_API_KEY: 'or-key',
    EXA_API_KEY: 'exa-key',
  };
  assert.equal(loadConfig(baseEnv).writer.exaUserContentMaxChars, 24000);
  assert.equal(loadConfig({ ...baseEnv, EXA_USER_CONTENT_MAX_CHARS: '5000' }).writer.exaUserContentMaxChars, 5000);
});
