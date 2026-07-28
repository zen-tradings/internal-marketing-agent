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
  removeRepeatedSourceMetadata,
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
        text: translatedFixture(unit),
      })),
    });
  };
}

function translatedFixture(unit) {
  if (unit.id === 'meta:title') return '结构化译文';
  const value = `中文译文：${unit.text}`;
  if (!['paragraph', 'quote', 'list_item'].includes(unit.kind) || value.length < 30) return value;
  const phrases = ['核心观点', '关键机制', '重要结论', '性能瓶颈', '实证结果', '系统能力'];
  const count = Math.max(1, Math.ceil(value.length / 120));
  return `${Array.from({ length: count }, (_, index) => `**${phrases[index % phrases.length]}**`).join('，')}：${value}`;
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

test('结构化翻译覆盖标题、正文和图表标题，表格正文保留为原文图片', async () => {
  const workDir = tempDir();
  const imagePath = path.join(workDir, 'figure.png');
  const tablePath = path.join(workDir, 'table.png');
  fs.writeFileSync(imagePath, Buffer.from([1, 2, 3]));
  fs.writeFileSync(tablePath, Buffer.from([4, 5, 6]));
  const source = {
    version: 5,
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
        localPath: tablePath,
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
      ]);
      assert.match(prompt, /表格正文直接保留原文截图/);
      assert.match(prompt, /每约 200 个汉字至少 1 处/);
      assert.doesNotMatch(JSON.stringify(payload), /Model|Score|Baseline|High/);
      assert.doesNotMatch(JSON.stringify(payload), /x\^2|Author \(2026\)/);
    }),
  });
  translated.translatedTitle = '结构化译文（译）';
  const article = renderTranslatedDocument(translated);
  const completeness = validateTranslationArtifact({ source, translated, article });
  assert.deepEqual(completeness.errors, []);
  assert.match(article, /!\[Architecture\]\(/);
  assert.match(article, /\*\*表 1：中文译文：Results\*\*/);
  assert.match(article, /!\[原文表 1\]\(/);
  assert.doesNotMatch(article, /^\|/m);
  assert.match(article, /\$\$\nx\^2\+y\^2=z\^2\n\$\$/);
  assert.match(article, /\[source\]\(https:\/\/example\.com\/source\)/);
  assert.match(article, /## 中文译文：Opening/);
  assert.match(article, /^title: "结构化译文"$/m);
  assert.doesNotMatch(article, /（译）|翻译范围|日期：/);
  assert.equal((article.match(/原文信息/g) || []).length, 1);
});

test('论文标题页的重复标题、作者和机构列表在摘要前被移除', () => {
  const document = removeRepeatedSourceMetadata({
    title: 'Terminal-Bench',
    author: 'Mike Merrill; Alexander Shaw; Nicholas Carlini',
    scope: { kind: 'pages', startPage: 1, endPage: 11 },
    blocks: [
      { id: 'b1', order: 0, type: 'heading', level: 1, text: 'Terminal-Bench' },
      { id: 'b2', order: 1, type: 'paragraph', text: 'Mike Merrill, Alexander Shaw, Nicholas Carlini' },
      { id: 'b3', order: 2, type: 'paragraph', text: '1 Stanford University, 2 Laude Institute' },
      { id: 'b4', order: 3, type: 'figure', images: [{ localPath: '/tmp/title-figure.png' }] },
      { id: 'b5', order: 4, type: 'heading', level: 2, text: 'Abstract' },
      { id: 'b6', order: 5, type: 'paragraph', text: 'Abstract body.' },
    ],
  });
  assert.deepEqual(document.blocks.map((block) => block.id), ['b4', 'b5', 'b6']);
  assert.deepEqual(document.blocks.map((block) => block.order), [0, 1, 2]);
  assert.equal(document.metadataBlocksRemoved, 3);
});

test('正文翻译保持高亮密度，但拒绝标题和整段加粗', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a',
    title: 'Title',
    author: '',
    sha256: 'highlight-source',
    blocks: [{
      id: 'b000001',
      order: 0,
      type: 'paragraph',
      text: 'The benchmark measures difficult realistic tasks and reveals the central performance bottleneck.',
    }],
  };
  const completeArticle = async ({ prompt }) => {
    const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
    return JSON.stringify({
      translations: payload.units.map((unit) => ({
        id: unit.id,
        text: unit.kind === 'paragraph'
          ? '该基准衡量困难的现实任务，并揭示**核心性能瓶颈**。'
          : '标题',
      })),
    });
  };
  const translated = await translateDocument({
    source,
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    completeArticle,
  });
  assert.match(renderTranslatedDocument(translated), /\*\*核心性能瓶颈\*\*/);

  await assert.rejects(() => translateDocument({
    source: { ...source, sha256: 'invalid-highlight-source' },
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title' ? '**标题**' : '**整段文字全部被错误加粗**',
        })),
      });
    },
  }), /结构化翻译校验失败/);
});

test('长段落高亮不足时机械补足高亮，不改动任何译文文字', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a',
    title: 'Title',
    author: '',
    sha256: 'low-highlight-density',
    blocks: [{
      id: 'b000001',
      order: 0,
      type: 'paragraph',
      text: 'The benchmark evaluates realistic agent tasks and identifies the decisive system bottleneck. '.repeat(4),
    }],
  };
  const body = `这是一段只包含一处**核心观点**、但整体长度已经超过两百字的中文译文。${'系统需要在真实任务中持续验证能力边界与性能瓶颈。'.repeat(10)}`;
  const translated = await translateDocument({
    source,
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title' ? '标题' : body,
        })),
      });
    },
  });
  const output = translated.blocks[0].translatedText;
  assert.equal(output.replaceAll('**', ''), body.replaceAll('**', ''));
  assert.ok((output.match(/\*\*[^*\n]+\*\*/g) || []).length >= 2);
  assert.match(output, /\*\*核心观点\*\*/);
});

test('短段落没有高亮也能通过校验，不再整篇任务失败', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a',
    title: 'Title',
    author: '',
    sha256: 'short-paragraph-source',
    blocks: [{ id: 'b000001', order: 0, type: 'paragraph', text: 'Attention is all you need here.' }],
  };
  const translated = await translateDocument({
    source,
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title' ? '标题' : '这里只需要注意力机制。',
        })),
      });
    },
  });
  assert.match(renderTranslatedDocument(translated), /这里只需要注意力机制。/);
});

test('过密或超长的加粗被机械收敛，不再让整批翻译失败', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a',
    title: 'Title',
    author: '',
    sha256: 'over-highlight-source',
    blocks: [{
      id: 'b000001',
      order: 0,
      type: 'paragraph',
      text: 'The benchmark evaluates realistic agent tasks and identifies the decisive system bottleneck.',
    }],
  };
  const translated = await translateDocument({
    source,
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title'
            ? '**标题**'
            : '该基准衡量**真实**的**智能体**任务，并**识别**出**决定性**的系统瓶颈。',
        })),
      });
    },
  });
  const article = renderTranslatedDocument(translated);
  assert.match(article, /^title: "标题"$/m);
  assert.match(article, /^该基准衡量\*\*真实\*\*的智能体任务，并识别出决定性的系统瓶颈。$/m);
});

test('校验失败会说明原因，并在重试提示中回传给模型', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a',
    title: 'Title',
    author: '',
    sha256: 'repair-hint-source',
    blocks: [{
      id: 'b000001',
      order: 0,
      type: 'paragraph',
      text: 'The benchmark evaluates realistic agent tasks and identifies the decisive system bottleneck. '.repeat(4),
    }],
  };
  const workDir = tempDir();
  const repairPrompts = [];
  await assert.rejects(() => translateDocument({
    source,
    workDir,
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      if (/上一次译文被拒绝的原因/.test(prompt)) repairPrompts.push(prompt);
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title' ? '标题' : unit.text,
        })),
      });
    },
  }), /结构化翻译校验失败:b000001\(译文仍是英文/);
  assert.equal(repairPrompts.length, 2);
  assert.match(repairPrompts[0], /- b000001:译文仍是英文，没有翻译成中文/);
  const invalid = JSON.parse(fs.readFileSync(path.join(workDir, 'translation-invalid.json'), 'utf8'));
  assert.equal(invalid.units[0].kind, 'paragraph');
  assert.match(invalid.units[0].reason, /英文/);
});

test('完整性门禁拒绝额外添加或遗漏图片、表格和公式', () => {
  const tablePath = path.join(tempDir(), 'table.png');
  fs.writeFileSync(tablePath, Buffer.from([1]));
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a',
    title: 'Title',
    sha256: 'hash',
    blocks: [
      { id: 'b000001', order: 0, type: 'paragraph', text: 'Body.' },
      {
        id: 'b000002',
        order: 1,
        type: 'table',
        caption: '',
        captionFragments: [],
        rows: [[{ text: 'A', fragments: [] }]],
        localPath: tablePath,
      },
    ],
  };
  const translated = {
    ...source,
    translatedTitle: '标题',
    blocks: [{ ...source.blocks[0], translatedText: '正文。' }, source.blocks[1]],
  };
  const result = validateTranslationArtifact({
    source,
    translated,
    article: '---\ntitle: 标题\n---\n![图](x.png)\n| A | B |\n| --- | --- |\n',
  });
  assert.match(result.errors.join(';'), /原文图片数量不一致/);
  assert.match(result.errors.join(';'), /原文表格图片数量不一致/);
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
