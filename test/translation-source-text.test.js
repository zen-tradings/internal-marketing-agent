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
        text: unit.id === 'meta:title' ? '纯文字译文' : `这是忠实的中文正文译文，保留原有语义。${unit.id}`,
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

test('HTML 只提取正文文字，图片、图题和表格不会进入 SourceDocument', async () => {
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
  assert.deepEqual([...new Set(document.blocks.map((block) => block.type))].sort(), ['heading', 'list_item', 'paragraph']);
  const extracted = document.blocks.map((block) => block.text).join('\n');
  assert.doesNotMatch(extracted, /SECRET_IMAGE|SECRET_FIGURE|SECRET_TABLE|SECRET_CODE_BLOCK|999999/);
  assert.equal(document.contentMode, 'body-text-only');
  assert.equal('assets' in document, false);
  assert.equal(buildDocumentManifest(document).contentMode, 'body-text-only');
});

test('Markdown/Notion 只保留正文段落、小标题和列表', async () => {
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
  assert.deepEqual(document.blocks.map((block) => block.type), ['heading', 'paragraph', 'list_item']);
  const extracted = document.blocks.map((block) => block.text).join('\n');
  assert.doesNotMatch(extracted, /SECRET_IMAGE|SECRET_TABLE|secretCode|Reference that/);
});

test('结构化翻译只把正文文字单元发送给模型', async () => {
  const source = {
    version: 3,
    contentMode: 'body-text-only',
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a',
    title: 'Text source',
    author: '',
    publishedDate: '',
    sha256: 'source-hash',
    blocks: [
      { id: 'b000001', order: 0, type: 'heading', level: 1, text: 'Opening' },
      { id: 'b000002', order: 1, type: 'paragraph', text: 'Complete body paragraph.' },
    ],
  };
  const translated = await translateDocument({
    source,
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    completeArticle: jsonTranslator((payload, prompt) => {
      assert.deepEqual(payload.units.map((unit) => unit.kind), ['title', 'heading', 'paragraph']);
      assert.match(prompt, /不要补充任何图/);
    }),
  });
  const article = renderTranslatedDocument(translated);
  const completeness = validateTranslationArtifact({ source, translated, article });
  assert.deepEqual(completeness.errors, []);
  assert.doesNotMatch(article, /!\[|<img|<table|^\|/m);
});

test('完整性门禁拒绝模型重新添加图片或表格', () => {
  const source = {
    version: 3,
    contentMode: 'body-text-only',
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
    article: '---\ntitle: 标题\n---\n![图](x.png)\n| A | B |\n',
  });
  assert.match(result.errors.join(';'), /图片内容/);
  assert.match(result.errors.join(';'), /表格内容/);
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
  assert.doesNotMatch(document.blocks.map((block) => block.text).join(' '), /ignored/);
});
