import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireSourceDocument,
  assertSafeHttpUrl,
  buildDocumentManifest,
  isPrivateIp,
  renderTranslatedDocument,
  sourceDocumentFromHtml,
  sourceDocumentFromMarkdown,
  translateDocument,
  validateTranslationArtifact,
} from '../src/workflows/source-document-v2.js';
import { generateStrictTranslation } from '../src/workflows/translate-engine.js';

const PUBLIC_DNS = async () => [{ address: '93.184.216.34', family: 4 }];

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zen-source-v2-'));
}

test('V2 HTML:锁定标题、正文、嵌套列表、图片、图题和复杂表格的原始顺序', async () => {
  const workDir = tempDir();
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000002000000030806000000', 'hex');
  const html = `<!doctype html><html><head><title>Source title</title><meta name="author" content="Author A"></head><body>
    <article>
      <h1>Source title</h1>
      <p>Opening paragraph with enough English words to be a real article block and keep the complete source structure.</p>
      <ul><li>First item<ul><li>Nested item</li></ul></li></ul>
      <figure><img src="https://cdn.example.com/chart.png" alt="Revenue chart"><figcaption>Figure 1. Revenue rose 20%.</figcaption></figure>
      <table><caption>Table 1. Results</caption><tr><th rowspan="2">Company</th><th colspan="2">2026</th></tr><tr><th>Revenue</th><th>Margin</th></tr><tr><td>Zen</td><td>100</td><td>25%</td></tr></table>
      <p>Closing paragraph with additional complete article content so Readability retains every semantic block in this fixture.</p>
    </article>
  </body></html>`;
  const document = await sourceDocumentFromHtml({
    html,
    sourceUrl: 'https://example.com/article',
    workDir,
    fetchFn: async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }),
    dnsLookup: PUBLIC_DNS,
    localizeAssets: true,
  });
  const types = document.blocks.map((block) => block.type);
  assert.deepEqual(types, [
    'heading', 'paragraph', 'list_item', 'list_item', 'image', 'caption', 'table', 'paragraph',
  ]);
  assert.equal(document.assets.length, 1);
  assert.ok(fs.existsSync(document.assets[0].path));
  const table = document.blocks.find((block) => block.type === 'table');
  assert.equal(table.grid.length, 3);
  assert.equal(table.grid[0].length, 3);
  assert.equal(table.cells.length, 7);
  assert.equal(table.grid[0][0], table.grid[1][0]);
  assert.equal(table.grid[0][1], table.grid[0][2]);
});

test('V2 Markdown/Notion:本地化临时图片并保留表格全部单元格', async () => {
  const workDir = tempDir();
  const sourceDir = path.join(workDir, 'notion-export');
  fs.mkdirSync(sourceDir);
  const imagePath = path.join(sourceDir, 'chart.png');
  fs.writeFileSync(imagePath, Buffer.from('89504e470d0a1a0a0000000d4948445200000002000000030806000000', 'hex'));
  const markdown = `# Notion title

Paragraph 2026.

![Chart](chart.png)

| Company | Revenue | Margin |
| --- | --- | --- |
| Zen | 100 | 25% |
`;
  const document = await sourceDocumentFromMarkdown({
    markdown,
    sourceUrl: 'https://workspace.notion.site/Notion-title-0123456789abcdef0123456789abcdef',
    workDir,
    localAssetBase: sourceDir,
  });
  assert.equal(document.sourceType, 'notion');
  assert.equal(document.assets.length, 1);
  assert.equal(document.blocks.find((block) => block.type === 'table').cells.length, 6);
  assert.deepEqual(document.blocks.map((block) => block.type), ['heading', 'paragraph', 'image', 'table']);
});

test('V2 翻译:模型只返回 ID 文本，程序确定性重组并通过结构/数字/图片门禁', async () => {
  const workDir = tempDir();
  const assetDir = path.join(workDir, 'assets');
  fs.mkdirSync(assetDir);
  const assetPath = path.join(assetDir, 'source-v2-0001.png');
  fs.writeFileSync(assetPath, Buffer.from('89504e470d0a1a0a0000000d4948445200000002000000030806000000', 'hex'));
  const source = {
    version: 2,
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a',
    title: 'Revenue in 2026',
    publishedDate: '2026-01-02',
    sha256: 'source-hash',
    assets: [{
      id: 'a0001',
      relative: 'assets/source-v2-0001.png',
      path: assetPath,
      sha256: '8eaccc8edfa394f8b26ad59ab2dcf33088dd363572a9e3c92cb6f2efde21d343',
    }],
    blocks: [
      { id: 'b000001', order: 0, type: 'heading', level: 1, text: 'Revenue in 2026' },
      { id: 'b000002', order: 1, type: 'paragraph', text: 'Revenue reached 100 million in 2026.' },
      { id: 'b000003', order: 2, type: 'image', assetId: 'a0001', alt: '' },
      {
        id: 'b000004',
        order: 3,
        type: 'table',
        caption: 'Table 1',
        cells: [
          { id: 'b000004:c1', text: 'Revenue', header: true },
          { id: 'b000004:c2', text: '100', header: false },
        ],
        grid: [['b000004:c1'], ['b000004:c2']],
      },
    ],
  };
  // Use the actual hash of the fixture asset.
  source.assets[0].sha256 = crypto.createHash('sha256').update(fs.readFileSync(assetPath)).digest('hex');
  const completeArticle = async ({ prompt }) => {
    const input = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
    return JSON.stringify({
      translations: input.units.map((unit) => ({
        id: unit.id,
        text: ({
          'meta:title': '2026 年营收',
          b000001: '2026 年营收',
          b000002: '2026 年营收达到 100 million。',
          'b000004:caption': '表 1',
          'b000004:c1': '营收',
          'b000004:c2': '100',
        })[unit.id],
      })),
    });
  };
  const translated = await translateDocument({
    source,
    workDir,
    model: 'test-model',
    writer: {},
    completeArticle,
  });
  const article = renderTranslatedDocument(translated);
  const completeness = validateTranslationArtifact({ source, translated, article });
  assert.deepEqual(completeness.errors, []);
  assert.match(article, /2026 年营收达到 100 million/);
  assert.ok(article.indexOf('source-v2-0001.png') < article.indexOf('| 营收 |'));
  assert.equal(buildDocumentManifest(source).tableCells, 2);
});

test('V2 翻译校验:允许中文日期月份、可翻译缩写和保持原文的作者署名', async () => {
  const source = {
    version: 2,
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/report',
    title: 'DiligenceBench',
    sha256: 'real-world-validation-cases',
    assets: [],
    blocks: [
      { id: 'b000001', order: 0, type: 'paragraph', text: 'Jul 17, 2026' },
      {
        id: 'b000002',
        order: 1,
        type: 'paragraph',
        text: 'Malthe Have Musaeus¹, Faisal Sayed², Mersad Abbasi², Daanish Khazi¹, Karina Nguyen²',
      },
      {
        id: 'b000003',
        order: 2,
        type: 'paragraph',
        text: 'DiligenceBench consists of 150 equity-research tasks across large US equities.',
      },
      {
        id: 'b000004',
        order: 3,
        type: 'list_item',
        text: '+10Connects $32.3B deposit growth at 0.39% cost to reduced need for wholesale LTD funding',
      },
    ],
  };
  const translations = {
    'meta:title': 'DiligenceBench',
    b000001: '2026 年 7 月 17 日',
    b000002: source.blocks[1].text,
    b000003: 'DiligenceBench 包含覆盖美国大型股票的 150 项股票研究任务。',
    b000004: '+10 将 $32.3B 的存款增长和 0.39% 的成本，与批发贷款存款比融资需求下降联系起来',
  };
  const translated = await translateDocument({
    source,
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      const input = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      return JSON.stringify({
        translations: input.units.map((unit) => ({ id: unit.id, text: translations[unit.id] })),
      });
    },
  });
  assert.equal(translated.blocks[0].translatedText, '2026 年 7 月 17 日');
  assert.equal(translated.blocks[1].translatedText, source.blocks[1].text);
});

test('V2 URL 安全:拦截 localhost、私网 IPv4/IPv6 和解析到私网的域名', async () => {
  for (const value of ['127.0.0.1', '10.0.0.1', '192.168.1.2', '::1', 'fd00::1', '169.254.1.2']) {
    assert.equal(isPrivateIp(value), true);
  }
  await assert.rejects(() => assertSafeHttpUrl('http://localhost/a'), /本机或内部地址/);
  await assert.rejects(
    () => assertSafeHttpUrl('https://public.example/a', {
      dnsLookup: async () => [{ address: '10.1.2.3', family: 4 }],
    }),
    /私网或保留地址/,
  );
  await assert.doesNotReject(() => assertSafeHttpUrl('https://public.example/a', { dnsLookup: PUBLIC_DNS }));
});

test('V2 入口:开关启用后走结构化抓取、按 ID 翻译并写入 trace，不回到旧 Markdown 分块', async () => {
  const workDir = tempDir();
  const paragraph = 'This is a complete source paragraph containing enough words for deterministic article extraction and translation validation. '.repeat(3);
  const html = `<article><h1>Structured translation</h1><p>${paragraph}</p><h2>Second section</h2><p>${paragraph}</p><p>${paragraph}</p></article>`;
  const trace = {};
  const completeArticle = async ({ prompt }) => {
    assert.match(prompt, /"units":/);
    const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
    return JSON.stringify({
      translations: payload.units.map((unit) => ({ id: unit.id, text: `这是完整的中文直译内容${unit.id}` })),
    });
  };
  const result = await generateStrictTranslation({
    input: '请翻译 https://example.com/article',
    workflow: { workDir, model: 'test-model', timeoutMs: 1000 },
    writer: { model: 'test-model' },
    fetchFn: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    fetchWithRetry: async (fetch, url, options) => fetch(url, options),
    completeArticle,
    trace,
    translationConfig: { v2Enabled: true, browserEnabled: false },
  });
  assert.equal(result.manifest.version, 2);
  assert.equal(result.manifest.extractor, 'readability-static');
  assert.equal(result.completeness.errors.length, 0);
  assert.equal(trace.translationV2.enabled, true);
  assert.match(result.article, /这是完整的中文直译内容/);
});

test('V2 失败关闭:验证码、关闭浏览器时的 SVG 图表和模型漏 block 均拒绝产稿', async () => {
  const retry = async (fetch, url, options) => fetch(url, options);
  await assert.rejects(() => acquireSourceDocument({
    sourceUrl: 'https://example.com/captcha',
    workDir: tempDir(),
    fetchFn: async () => new Response('<html><body>Verify you are human captcha</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
    fetchWithRetry: retry,
    config: { browserEnabled: false },
    dnsLookup: PUBLIC_DNS,
  }), /验证码或反机器人/);

  const longText = 'A complete article paragraph with enough source text for strict structural extraction. '.repeat(10);
  await assert.rejects(() => acquireSourceDocument({
    sourceUrl: 'https://example.com/chart',
    workDir: tempDir(),
    fetchFn: async () => new Response(
      `<article><h1>Chart</h1><p>${longText}</p><svg width="300" height="200"><rect width="300" height="200"></rect></svg><p>${longText}</p></article>`,
      { status: 200, headers: { 'content-type': 'text/html' } },
    ),
    fetchWithRetry: retry,
    config: { browserEnabled: false },
    dnsLookup: PUBLIC_DNS,
  }), /浏览器抓取已关闭/);

  const source = {
    version: 2,
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a',
    title: 'A complete title',
    sha256: 'missing-block-source',
    assets: [],
    blocks: [{ id: 'b000001', order: 0, type: 'paragraph', text: longText }],
  };
  await assert.rejects(() => translateDocument({
    source,
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    completeArticle: async () => '{"translations":[]}',
  }), /结构化翻译校验失败/);
});

test('V2 Notion:授权页面优先调用官方整页 Markdown 接口', async () => {
  const calls = [];
  const document = await acquireSourceDocument({
    sourceUrl: 'https://workspace.notion.site/Report-0123456789abcdef0123456789abcdef',
    workDir: tempDir(),
    fetchFn: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({
        markdown: '# Full report\n\nComplete Notion page body with 2026 data.',
        title: 'Full report',
        last_edited_time: '2026-01-02',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    fetchWithRetry: async (fetch, url, options) => fetch(url, options),
    config: { notionApiToken: 'secret', browserEnabled: false },
    dnsLookup: PUBLIC_DNS,
  });
  assert.equal(document.extractor, 'notion-markdown-api');
  assert.match(calls[0], /api\.notion\.com\/v1\/pages\/01234567-89ab-cdef-0123-456789abcdef\/markdown/);
  assert.equal(document.blocks[0].type, 'heading');
});
