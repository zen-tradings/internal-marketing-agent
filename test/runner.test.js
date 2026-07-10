import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWriter, runClaude } from '../src/core/runner.js';
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
  assert.match(calls[1].body.messages[0].content, /Zen Trading/);
  assert.match(calls[1].body.messages[1].content, /NVIDIA results/);
  assert.match(calls[1].body.messages[1].content, /写作任务:英伟达业绩/);
});

test('兼容旧注入名:runClaude 等价于 runWriter', async () => {
  assert.equal(runClaude, runWriter);
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

test('素材顺序:用户指定 > 优先信源 > 开放搜索,formatResearch 标签正确', async () => {
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
  assert.match(prompt, /【用户指定素材】用户贴的推文/);
  assert.match(prompt, /【优先信源】TrendForce 报告/);
  assert.match(prompt, /### 来源 3: 公开报道/); // 开放搜索无前缀标签
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
