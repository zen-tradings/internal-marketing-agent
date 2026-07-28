import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireSourceDocument,
  assertPdfPageLimit,
  assertPdfResponse,
  assertSafeHttpUrl,
  buildDocumentManifest,
  hasPdfSignature,
  isPrivateIp,
  readResponseBufferWithLimit,
  removeRepeatedSourceMetadata,
  safeFetchResource,
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

test('私有文件跨域重定向时不会把 Authorization 带到 CDN', async () => {
  const requests = [];
  const result = await safeFetchResource({
    url: 'https://files.slack.com/private/report.pdf',
    headers: { Authorization: 'Bearer xoxb-secret', 'X-Trace': 'keep' },
    dnsLookup: PUBLIC_DNS,
    fetchFn: async (url, options) => {
      requests.push({ url: String(url), headers: options.headers });
      if (requests.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.com/report.pdf?signature=ok' },
        });
      }
      return new Response('%PDF-test', {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    },
    fetchWithRetry: async (fetch, url, options) => fetch(url, options),
  });
  assert.equal(result.buffer.toString(), '%PDF-test');
  assert.equal(requests[0].headers.Authorization, 'Bearer xoxb-secret');
  assert.equal(requests[1].headers.Authorization, undefined);
  assert.equal(requests[1].headers['X-Trace'], 'keep');
});

test('PDF 页数在文字提取前受硬上限保护', () => {
  const spawn = () => ({ status: 0, stdout: 'Pages: 121\n', stderr: '' });
  assert.throws(() => assertPdfPageLimit('/tmp/source.pdf', 120, spawn), /121\/120/);
});

test('PDF 在进入 Poppler/Datalab 前验证真实签名，Slack 登录页返回 files:read 指引', async () => {
  assert.equal(hasPdfSignature(Buffer.from('%PDF-1.7\n')), true);
  assert.equal(hasPdfSignature(Buffer.from('prefix\n%PDF-1.7\n')), true);
  assert.equal(hasPdfSignature(Buffer.from('<!DOCTYPE html>')), false);
  assert.throws(() => assertPdfResponse({
    buffer: Buffer.from('<!DOCTYPE html><html><title>Slack</title></html>'),
    sourceUrl: 'https://files.slack.com/files-pri/T1-F1/download/report.pdf',
    contentType: 'text/html; charset=utf-8',
  }), /files:read.*重新安装 App/);
  assert.throws(() => assertPdfResponse({
    buffer: Buffer.from('not a pdf'),
    sourceUrl: 'https://example.com/report.pdf',
    contentType: 'text/plain',
  }), /不是有效 PDF.*text\/plain/);

  await assert.rejects(() => acquireSourceDocument({
    sourceUrl: 'https://files.slack.com/files-pri/T1-F1/download/report.pdf',
    workDir: tempDir(),
    requestHeaders: { Authorization: 'Bearer xoxb-secret' },
    fetchFn: async () => new Response(
      '<!DOCTYPE html><html><title>Slack</title><body>Sign in</body></html>',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    ),
    fetchWithRetry: async (fetch, url, options) => fetch(url, options),
    config: { browserEnabled: false, datalabApiKey: 'datalab-key' },
    dnsLookup: PUBLIC_DNS,
    scope: { kind: 'all', requestedText: '' },
  }), /files:read.*重新安装 App/);
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

test('正文翻译保持合理高亮，标题或整段异常加粗会安全降级为纯文本', async () => {
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

  const normalized = await translateDocument({
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
  });
  const normalizedArticle = renderTranslatedDocument(normalized);
  assert.doesNotMatch(normalized.translatedTitle, /\*\*/);
  assert.doesNotMatch(normalized.blocks[0].translatedText, /\*\*/);
  assert.match(normalizedArticle, /整段文字全部被错误加粗/);
});

test('长段落高亮不足在修复后不阻断忠实译文', async () => {
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
            ? '标题'
            : `这是一段只包含一处**核心观点**、但整体长度已经超过两百字的中文译文。${'系统需要在真实任务中持续验证能力边界与性能瓶颈。'.repeat(10)}`,
        })),
      });
    },
  });
  assert.match(renderTranslatedDocument(translated), /\*\*核心观点\*\*/);
});

test('样式可降级，但数字不一致仍由内容级硬门禁拒绝', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'html',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a',
    title: 'Title',
    author: '',
    sha256: 'invariant-mismatch',
    blocks: [{
      id: 'b000001',
      order: 0,
      type: 'paragraph',
      text: 'The reported portfolio return was 100 percent.',
    }],
  };
  await assert.rejects(() => translateDocument({
    source,
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title' ? '标题' : '报告的投资组合回报率为 99%。',
        })),
      });
    },
  }), /结构化翻译校验失败:b000001/);
});

test('同段多个英文月份可忠实翻译为对应月份数字，其它数字仍保持一致', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'pdf',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a.pdf',
    title: 'Monthly Returns',
    author: '',
    sha256: 'multiple-months',
    blocks: [{
      id: 'b000001',
      order: 0,
      type: 'paragraph',
      text: 'The sample runs from January 1995 through December 2009, with a reported return of 8.04%.',
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
            ? '月度回报'
            : '**样本期**从 1995 年 1 月持续到 2009 年 12 月，报告回报率为 8.04%。',
        })),
      });
    },
  });
  assert.match(renderTranslatedDocument(translated), /1995 年 1 月.*2009 年 12 月.*8\.04%/);
});

test('英文分数词组和月份可转换为对应数字且不放宽其它数字', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'pdf',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a.pdf',
    title: 'Assets',
    author: '',
    sha256: 'fraction-and-month-numbers',
    blocks: [{
      id: 'b000001',
      order: 0,
      type: 'paragraph',
      text: 'Assets exceeded one and a half trillion dollars from January 1995 through December 2009, based on 8,400 funds.',
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
            ? '资产'
            : '**管理资产**超过 1.5 万亿美元，样本期从 1995 年 1 月持续到 2009 年 12 月，基于 8,400 只基金。',
        })),
      });
    },
  });
  assert.match(renderTranslatedDocument(translated), /1\.5 万亿美元.*1995 年 1 月.*2009 年 12 月.*8,400/);
});

test('英文 billion 与中文亿按数值等价校验，修复稿多出数字时保留原译稿', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'pdf',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a.pdf',
    title: 'Assets',
    author: '',
    sha256: 'billion-to-yi',
    blocks: [{
      id: 'b000001',
      order: 0,
      type: 'paragraph',
      text: 'In 1990, 530 hedge funds managed about $50 billion, and the industry continued to expand during the sample.',
    }],
  };
  let calls = 0;
  const translated = await translateDocument({
    source,
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      calls += 1;
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title'
            ? '资产'
            : calls === 1
              ? '**1990 年，530 只对冲基金管理着约 500 亿美元，行业在样本期内继续扩张。**'
              : '1990 年，530 只对冲基金管理着约 $50 0 亿美元，行业在样本期内继续扩张。',
        })),
      });
    },
  });
  assert.equal(calls, 2);
  assert.match(renderTranslatedDocument(translated), /500 亿美元/);
  assert.doesNotMatch(renderTranslatedDocument(translated), /\$50 0 亿美元/);
});

test('英文数字词可选择性译为阿拉伯数字，但原有数字仍必须全部保留', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'pdf',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a.pdf',
    title: 'Constraints',
    author: '',
    sha256: 'selective-word-number-expansion',
    blocks: [{
      id: 'b000001',
      order: 0,
      type: 'paragraph',
      text: 'Sharpe (1992) requires all weights to sum to one and allows each weight to be above one. The S&P 500 benchmark is retained.',
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
            ? '约束'
            : 'Sharpe（1992）的**权重约束**要求全部权重之和为 1，并允许单项权重大于 1，同时保留 S&P 500 基准。',
        })),
      });
    },
  });
  assert.match(renderTranslatedDocument(translated), /1992.*为 1.*大于 1.*500/);
});

test('长文正常翻译批次最多 24 个单元，尽早写入分块 checkpoint', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'pdf',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a.pdf',
    title: 'Batch Test',
    author: '',
    sha256: 'bounded-translation-batches',
    blocks: Array.from({ length: 25 }, (_, index) => ({
      id: `b${String(index + 1).padStart(6, '0')}`,
      order: index,
      type: 'paragraph',
      text: `Source item ${index + 1}.`,
    })),
  };
  const batchSizes = [];
  const workDir = tempDir();
  await translateDocument({
    source,
    workDir,
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      batchSizes.push(payload.units.length);
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title' ? '批次测试' : `译文条目 ${unit.text.match(/\d+/)[0]}。`,
        })),
      });
    },
  });
  const checkpoint = JSON.parse(fs.readFileSync(path.join(workDir, 'translation-checkpoint.json'), 'utf8'));
  assert.deepEqual(batchSizes, [24, 2]);
  assert.equal(checkpoint.translations.length, 26);
});

test('样式修复稿破坏数字时回退到内容完整的原始译稿', async () => {
  const source = {
    version: 5,
    contentMode: 'structured-document',
    sourceType: 'pdf',
    extractor: 'fixture',
    sourceUrl: 'https://example.com/a.pdf',
    title: 'Returns',
    author: '',
    sha256: 'prefer-hard-valid-original',
    blocks: [{
      id: 'b000001',
      order: 0,
      type: 'paragraph',
      text: 'The reported portfolio return was 100% and remained stable across the complete sample.',
    }],
  };
  let calls = 0;
  const translated = await translateDocument({
    source,
    workDir: tempDir(),
    model: 'test-model',
    writer: {},
    completeArticle: async ({ prompt }) => {
      calls += 1;
      const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
      return JSON.stringify({
        translations: payload.units.map((unit) => ({
          id: unit.id,
          text: unit.kind === 'title'
            ? '回报'
            : calls === 1
              ? '**报告的投资组合回报率为 100%，并在整个完整样本期间持续保持稳定且没有明显变化。**'
              : '报告的投资组合回报率为 99%，并在整个完整样本期间持续保持稳定且没有明显变化。',
        })),
      });
    },
  });
  assert.equal(calls, 2);
  assert.match(renderTranslatedDocument(translated), /100%/);
  assert.doesNotMatch(renderTranslatedDocument(translated), /99%/);
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
