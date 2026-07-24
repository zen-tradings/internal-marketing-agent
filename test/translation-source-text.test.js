import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireSourceDocument,
  assertPdfPageLimit,
  assertSafeHttpUrl,
  buildDocumentManifest,
  isPrivateIp,
  readResponseBufferWithLimit,
  sourceDocumentFromHtml,
  sourceDocumentFromMarkdown,
  translateDocument,
  renderTranslatedDocument,
  validateTranslationArtifact,
} from '../src/workflows/translation-source-text.js';

const PUBLIC_DNS = async () => [{ address: '93.184.216.34', family: 4 }];

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zen-source-text-'));
}

function jsonTranslator(assertPayload) {
  return async ({ prompt }) => {
    const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
    assertPayload?.(payload, prompt);
    return JSON.stringify({
      translations: payload.units.map((unit) => ({
        id: unit.id,
        text: unit.id === 'meta:title' ? '结构化译文' : `中文译文：${unit.text}`,
      })),
    });
  };
}

test('流式响应超过大小上限时立即取消', async () => {
  let cancelled = false;
  let reads = 0;
  const response = {
    body: {
      getReader() {
        return {
          async read() { reads += 1; return { done: false, value: new Uint8Array(6) }; },
          async cancel() { cancelled = true; },
          releaseLock() {},
        };
      },
    },
  };
  await assert.rejects(() => readResponseBufferWithLimit(response, 10), /超过大小上限/);
  assert.equal(reads, 2);
  assert.equal(cancelled, true);
});

test('PDF 页数在文字提取前受硬上限保护', () => {
  const spawn = () => ({ status: 0, stdout: 'Pages: 121\n', stderr: '' });
  assert.throws(() => assertPdfPageLimit('/tmp/source.pdf', 120, spawn), /121\/120/);
});

test('arXiv PDF 链接在未指定页码时优先读取官方 HTML', async () => {
  const calls = [];
  const paragraph = 'Structured arXiv HTML preserves headings and paragraphs for faithful translation. '.repeat(5);
  const document = await acquireSourceDocument({
    sourceUrl: 'https://arxiv.org/pdf/2606.26350',
    workDir: tempDir(),
    fetchFn: async (url) => {
      calls.push(String(url));
      return new Response(`<article class="ltx_document"><h1>Paper</h1><p>${paragraph}</p></article>`, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    },
    fetchWithRetry: async (fetch, url, options) => fetch(url, options),
    config: { browserEnabled: false },
    dnsLookup: PUBLIC_DNS,
    scope: { kind: 'all', requestedText: '' },
  });
  assert.equal(calls[0], 'https://arxiv.org/html/2606.26350');
  assert.equal(document.sourceType, 'html');
  assert.ok(document.acquisition.attempts.includes('arxiv-html'));
});

test('HTML 保留标题、段落、图片图注、表格、代码和列表结构', async () => {
  const paragraph = 'This is a complete article paragraph with enough body text for deterministic extraction and translation. '.repeat(4);
  const html = `<!doctype html><html><head><title>Text source</title></head><body>
    <article>
      <h1>Text source</h1>
      <p>${paragraph}</p>
      <figure><img src="chart.png" alt="SECRET_IMAGE_ALT"><figcaption>SECRET_FIGURE_CAPTION</figcaption></figure>
      <table><tr><th>SECRET_TABLE_HEADER</th><td>999999</td></tr></table>
      <pre><code>SECRET_CODE_BLOCK</code></pre>
      <ul><li>Body list item</li></ul>
      <h2>Second section</h2>
      <p>${paragraph}</p>
    </article>
  </body></html>`;
  const document = await sourceDocumentFromHtml({
    html,
    sourceUrl: 'https://example.com/article',
  });
  assert.deepEqual(
    [...new Set(document.blocks.map((block) => block.type))].sort(),
    ['code', 'figure', 'heading', 'list_item', 'paragraph', 'table'],
  );
  assert.equal(document.blocks.find((block) => block.type === 'figure').caption, 'SECRET_FIGURE_CAPTION');
  assert.equal(document.blocks.find((block) => block.type === 'table').rows[0][0].text, 'SECRET_TABLE_HEADER');
  assert.equal(document.blocks.find((block) => block.type === 'code').text, 'SECRET_CODE_BLOCK');
  assert.equal(document.contentMode, 'structured-document');
  assert.equal(buildDocumentManifest(document).contentMode, 'structured-document');
});

test('章节范围先裁剪结构再下载该范围内的图片', async () => {
  const calls = [];
  const html = `<article>
    <h2>Introduction</h2>
    <figure><img src="/outside.png"><figcaption>Outside</figcaption></figure>
    <h2>Results</h2>
    <p>${'Results body with enough structured source text. '.repeat(4)}</p>
    <figure><img src="/inside.png"><figcaption>Inside</figcaption></figure>
    <h2>Conclusion</h2>
    <p>Conclusion body.</p>
  </article>`;
  const document = await sourceDocumentFromHtml({
    html,
    sourceUrl: 'https://example.com/article',
    workDir: tempDir(),
    scope: { kind: 'sections', start: 'Results', end: 'Results' },
    dnsLookup: PUBLIC_DNS,
    fetchFn: async (url) => {
      calls.push(String(url));
      if (!String(url).endsWith('/inside.png')) throw new Error('不应下载范围外图片');
      return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 'base64'), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    },
  });
  assert.deepEqual(calls, ['https://example.com/inside.png']);
  assert.deepEqual(document.blocks.map((block) => block.type), ['heading', 'paragraph', 'figure']);
  assert.equal(document.scope.appliedStartHeading, 'Results');
});

test('Markdown/Notion 保留图片、表格、代码和参考文献', async () => {
  const document = await sourceDocumentFromMarkdown({
    sourceUrl: 'https://workspace.notion.site/Report-0123456789abcdef0123456789abcdef',
    markdown: `# Report

Body paragraph.

![SECRET_IMAGE](chart.png)

| SECRET_TABLE | Value |
| --- | --- |
| Revenue | 100 |

\`\`\`js
const secretCode = true;
\`\`\`

- Body item

## References

Reference that should not be translated.
`,
  });
  assert.deepEqual(
    document.blocks.map((block) => block.type),
    ['heading', 'paragraph', 'figure', 'table', 'code', 'list_item', 'heading', 'reference'],
  );
  assert.equal(document.blocks.find((block) => block.type === 'figure').caption, 'SECRET_IMAGE');
  assert.equal(document.blocks.find((block) => block.type === 'table').rows[1][1].text, '100');
  assert.match(document.blocks.find((block) => block.type === 'code').text, /secretCode/);
  assert.match(document.blocks.find((block) => block.type === 'reference').text, /Reference that/);
});

test('结构化翻译覆盖标题、正文、图注和表格单元格并保留公式与图片', async () => {
  const workDir = tempDir();
  const imagePath = path.join(workDir, 'figure.png');
  fs.writeFileSync(imagePath, Buffer.from([1, 2, 3]));
  const source = {
    version: 4,
    contentMode: 'structured-document',
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a',
    title: 'Text source',
    author: '',
    publishedDate: '',
    sha256: 'source-hash',
    blocks: [
      { id: 'b000001', order: 0, type: 'heading', level: 1, text: 'Opening' },
      {
        id: 'b000002', order: 1, type: 'paragraph',
        text: 'See ⟦ZEN_INLINE_001⟧ now.',
        fragments: [{ token: '⟦ZEN_INLINE_001⟧', value: '[source](https://example.com/source)' }],
      },
      {
        id: 'b000003', order: 2, type: 'figure',
        images: [{ src: 'https://example.com/figure.png', localPath: imagePath, alt: 'Architecture' }],
        caption: 'System architecture', captionFragments: [],
      },
      {
        id: 'b000004', order: 3, type: 'table', caption: 'Results', captionFragments: [],
        rows: [
          [{ text: 'Model', fragments: [] }, { text: 'Score', fragments: [] }],
          [{ text: 'Baseline', fragments: [] }, { text: 'High', fragments: [] }],
        ],
      },
      { id: 'b000005', order: 4, type: 'equation', tex: 'x^2+y^2=z^2' },
      { id: 'b000006', order: 5, type: 'reference', text: 'Author (2026). Paper.' },
    ],
    scope: { kind: 'all', requestedText: '' },
  };
  const translated = await translateDocument({
    source,
    workDir,
    model: 'test-model',
    writer: {},
    completeArticle: jsonTranslator((payload, prompt) => {
      assert.deepEqual(payload.units.map((unit) => unit.kind), [
        'title', 'heading', 'paragraph', 'figure_caption', 'table_caption',
        'table_cell', 'table_cell', 'table_cell', 'table_cell',
      ]);
      assert.match(prompt, /图注和表格单元格/);
      assert.doesNotMatch(JSON.stringify(payload), /x\^2|Author \(2026\)/);
    }),
  });
  const article = renderTranslatedDocument(translated);
  const completeness = validateTranslationArtifact({ source, translated, article });
  assert.deepEqual(completeness.errors, []);
  assert.match(article, /!\[Architecture\]\(/);
  assert.match(article, /\*\*表 1：中文译文：Results\*\*/);
  assert.match(article, /^\| 中文译文：Model \| 中文译文：Score \|$/m);
  assert.match(article, /\$\$\nx\^2\+y\^2=z\^2\n\$\$/);
  assert.match(article, /\[source\]\(https:\/\/example\.com\/source\)/);
  assert.match(article, /## 中文译文：Opening/);
});

test('完整性门禁拒绝额外添加或遗漏图片、表格和公式', () => {
  const source = {
    version: 4,
    contentMode: 'structured-document',
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a',
    title: 'Title',
    sha256: 'hash',
    blocks: [{ id: 'b000001', order: 0, type: 'paragraph', text: 'Body.' }],
  };
  const translated = {
    ...source,
    translatedTitle: '标题',
    blocks: [{ ...source.blocks[0], translatedText: '正文。' }],
  };
  const result = validateTranslationArtifact({
    source,
    translated,
    article: '---\ntitle: 标题\n---\n![图](x.png)\n| A | B |\n| --- | --- |\n',
  });
  assert.match(result.errors.join(';'), /图片数量不一致/);
  assert.match(result.errors.join(';'), /表格数量不一致/);
});

test('URL 安全拦截 localhost、私网和保留地址', async () => {
  for (const value of [
    '127.0.0.1', '10.0.0.1', '192.168.1.2', '169.254.1.2',
    '192.0.2.1', '198.51.100.2', '203.0.113.3', '::1', 'fd00::1', '2001:db8::1',
  ]) assert.equal(isPrivateIp(value), true);
  assert.equal(isPrivateIp('93.184.216.34'), false);
  await assert.rejects(() => assertSafeHttpUrl('http://localhost/a'), /本机或内部地址/);
  await assert.rejects(() => assertSafeHttpUrl('https://public.example/a', {
    dnsLookup: async () => [{ address: '10.1.2.3', family: 4 }],
  }), /私网或保留地址/);
  await assert.doesNotReject(() => assertSafeHttpUrl('https://public.example/a', { dnsLookup: PUBLIC_DNS }));
});

test('验证码页面拒绝产稿', async () => {
  await assert.rejects(() => acquireSourceDocument({
    sourceUrl: 'https://example.com/captcha',
    workDir: tempDir(),
    fetchFn: async () => new Response('<html><body>Verify you are human captcha</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
    fetchWithRetry: async (fetch, url, options) => fetch(url, options),
    config: { browserEnabled: false },
    dnsLookup: PUBLIC_DNS,
  }), /验证码或反机器人/);
});

test('Notion 授权页面优先调用官方 Markdown 接口并过滤非正文内容', async () => {
  const calls = [];
  const document = await acquireSourceDocument({
    sourceUrl: 'https://workspace.notion.site/Report-0123456789abcdef0123456789abcdef',
    workDir: tempDir(),
    fetchFn: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/x.png')) {
        return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 'base64'), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      return new Response(JSON.stringify({
        markdown: '# Full report\n\nComplete body text.\n\n![ignored](x.png)',
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
  const figure = document.blocks.find((block) => block.type === 'figure');
  assert.equal(figure.caption, 'ignored');
  assert.ok(fs.existsSync(figure.images[0].localPath));
});
