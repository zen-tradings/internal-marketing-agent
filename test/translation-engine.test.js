import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractSupplementaryAnalysisRequest,
  canonicalPdfUrl,
  discoverPdfUrl,
  findUntranslatedEnglishLines,
  generateStrictTranslation,
  requestsTextOnlyTranslation,
  stripTranslationVisualContent,
  requireCommand,
  validateTranslationCompleteness,
} from '../src/workflows/translate-engine.js';

test('纯文字直译请求删除原文图片、图表概括、图表标题和 Markdown 表格', () => {
  const input = [
    '正文保留。',
    '![原文图 1](assets/source-figure-1.png)',
    '<!-- source-asset:figure-1 -->',
    '图 1. 架构图。',
    '> 图 1 内容概括：图示内容。',
    '表 2. 结果。',
    '| 方法 | 得分 |',
    '|---|---|',
    '| A | 1 |',
    '正文继续，并保留“表 2 展示主要结果”这类原文叙述。',
  ].join('\n');
  const output = stripTranslationVisualContent(input);
  assert.match(output, /正文保留/);
  assert.match(output, /表 2 展示主要结果/);
  assert.doesNotMatch(output, /source-figure|source-asset|内容概括|^图 1|^表 2\.|^\|/m);
  assert.equal(requestsTextOnlyTranslation('本次只要文字，不要图片和表格'), true);
  assert.equal(requestsTextOnlyTranslation('所有文章文字，不需要图片和表格'), true);
  assert.equal(requestsTextOnlyTranslation('完整直译并保留原图'), false);
});

test('arXiv 摘要页可确定性回退到同编号原始 PDF', () => {
  assert.equal(canonicalPdfUrl('https://arxiv.org/abs/2603.01712'), 'https://arxiv.org/pdf/2603.01712.pdf');
  assert.equal(canonicalPdfUrl('https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1'), undefined);
});

test('网页中的任意示例 PDF 不得替代网页正文；只接受明确的论文 PDF 元数据或 SSRN Delivery 链接', () => {
  const samplePdf = '<a href="/news/introducing-inkling/files/breakfast.pdf">Download the sample</a>';
  assert.equal(discoverPdfUrl(samplePdf, 'https://thinkingmachines.ai/news/introducing-inkling/'), undefined);
  const citation = '<meta name="citation_pdf_url" content="/papers/original.pdf">';
  assert.equal(discoverPdfUrl(citation, 'https://example.edu/article'), 'https://example.edu/papers/original.pdf');
  const ssrn = '<a href="https://delivery.ssrn.com/Delivery.cfm?abstractid=1">Download</a>';
  assert.equal(discoverPdfUrl(ssrn, 'https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1'), 'https://delivery.ssrn.com/Delivery.cfm?abstractid=1');
});

test('直译 URL 后的中文标点不进入原文地址', async () => {
  const html = '<html><head><title>URL Paper</title></head><body><article><p>Body.</p></article></body></html>';
  let fetchedUrl = '';
  await generateStrictTranslation({
    input: '完整直译 https://example.com/paper，并分析结论。',
    workflow: { workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'translate-url-punctuation-')), model: 'test/model', timeoutMs: 1000 },
    writer: { model: 'fallback/model' }, fetchFn: async () => {}, trace: { requests: [] },
    completeArticle: async () => '正文。',
    fetchWithRetry: async (_fetch, url) => {
      fetchedUrl = url;
      return { ok: true, status: 200, statusText: 'OK', headers: { get: () => 'text/html' }, arrayBuffer: async () => Buffer.from(html) };
    },
  });
  assert.equal(fetchedUrl, 'https://example.com/paper');
});

test('英文漏译检测忽略原文 References,但继续检查 References 后的附录正文', () => {
  const markdown = [
    '参考文献',
    'Smith, J., Doe, A., et al. A long English paper title and conference publication entry.',
    '附录',
    'This appendix sentence should have been translated into Chinese but was accidentally left in English.',
  ].join('\n');
  assert.deepEqual(findUntranslatedEnglishLines(markdown), [
    'This appendix sentence should have been translated into Chinese but was accidentally left in English.',
  ]);
});

test('英文漏译检测忽略 Markdown 脚注中的书目信息，但不豁免普通英文正文', () => {
  const markdown = [
    '[^paper]: Author, A. An English paper title with publication metadata and venue details.',
    'This ordinary English sentence is still prose and must be translated for readers.',
  ].join('\n');
  assert.deepEqual(findUntranslatedEnglishLines(markdown), [
    'This ordinary English sentence is still prose and must be translated for readers.',
  ]);
});

test('英文漏译检测忽略转义星号或匕首标识的脚注说明', () => {
  const markdown = [
    '\\*Benchmark Verified: external reporting details and English model names may appear here.',
    '†Audio Evaluation: internal evaluation methodology citation details appear here.',
    'This ordinary English sentence is still prose and must be translated for readers.',
  ].join('\n');
  assert.deepEqual(findUntranslatedEnglishLines(markdown), [
    'This ordinary English sentence is still prose and must be translated for readers.',
  ]);
});

test('英文漏译检测忽略图表中文概括内的必要英文术语与行内书目信息', () => {
  const markdown = [
    '> 表 1 内容概括：Charxiv RQ with python 与 SWEBench Verified 的比较。',
    '中文句子引用 Cognition Team, “SWE-1.7: Frontier Intelligence at a Fraction of the Cost.”. 后继续。',
    'This ordinary English sentence is still prose and must be translated for readers.',
  ].join('\n');
  assert.deepEqual(findUntranslatedEnglishLines(markdown), [
    'This ordinary English sentence is still prose and must be translated for readers.',
  ]);
});

test('英文漏译检测拦截夹在中文中的英文章节标签与完整从句', () => {
  const leaked = [
    'Table 2 展示了所有实验结果。',
    '这项设计 the agent uses the feedback to improve its next training run。',
  ].join('\n');
  const result = findUntranslatedEnglishLines(leaked);
  assert.equal(result.length, 2);
});

test('英文漏译检测保留夹在中文中的必要专有名词', () => {
  const line = 'TableBench 在结构感知推理上评估模型，种子数据集 TableInstruct 依赖 Program-of-Thought。';
  assert.deepEqual(findUntranslatedEnglishLines(line), []);
});

test('直译完整性拒绝整页 PDF 截图、图表占位符与多处明显英文漏译', () => {
  const leaked = 'This entire paragraph is still untranslated English prose and must never be published to WeChat readers.';
  const article = [
    '<!-- source-page:1 -->',
    '![原文页](assets/source-page-1.png)',
    '<!-- visual-summary-required:table-1 -->',
    leaked, leaked, leaked, leaked,
  ].join('\n');
  const result = validateTranslationCompleteness(article, { pages: 1, figures: [], tables: [], equations: [] });
  assert.match(result.errors.join(';'), /PDF 整页截图/);
  assert.match(result.errors.join(';'), /未处理的图表占位/);
  assert.match(result.errors.join(';'), /未翻译英文正文/);
});

test('直译完整性:页码、图表和公式编号齐全时通过', () => {
  const article = '<!-- source-page:1 -->\n图 1\n表 2\n公式(3)\n<!-- source-page:2 -->';
  const result = validateTranslationCompleteness(article, { pages: 2, figures: [1], tables: [2], equations: [3] });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.pagesFound, [1, 2]);
});

test('直译完整性:缺页、缺图、代码围栏和缩进块均拒绝发布', () => {
  const article = '<!-- source-page:1 -->\n```\n    omitted';
  const result = validateTranslationCompleteness(article, { pages: 3, figures: [1], tables: [], equations: [] });
  assert.match(result.errors.join(';'), /缺少原文页码:2,3/);
  assert.match(result.errors.join(';'), /缺少图编号:1/);
  assert.match(result.errors.join(';'), /代码围栏/);
  assert.match(result.errors.join(';'), /四空格缩进/);
});

test('Poppler 命令可用时依赖检查通过', () => {
  assert.doesNotThrow(() => requireCommand('pdftotext', {
    spawn: () => ({ status: 0 }),
    exists: () => false,
  }));
});

test('Poppler 已安装但 launchd PATH 缺失时给出准确修复提示', () => {
  assert.throws(() => requireCommand('pdftotext', {
    spawn: () => ({ error: { code: 'ENOENT' } }),
    exists: (candidate) => candidate === '/opt/homebrew/bin/pdftotext',
  }), /已安装.*服务环境找不到.*install-launchd\.sh/);
});

test('Poppler 确实未安装时才提示 brew install poppler', () => {
  assert.throws(() => requireCommand('pdftotext', {
    spawn: () => ({ error: { code: 'ENOENT' } }),
    exists: () => false,
  }), /缺少.*brew install poppler/);
});

test('复合直译任务能提取独立的附加分析要求', () => {
  assert.equal(
    extractSupplementaryAnalysisRequest('原文翻译这篇论文 https://example.com/paper 并讲讲这篇是否提到 harness 相关的 techniques'),
    '讲讲这篇是否提到 harness 相关的 techniques',
  );
  assert.equal(extractSupplementaryAnalysisRequest('完整直译 https://example.com/paper'), '');
  assert.equal(
    extractSupplementaryAnalysisRequest('完整直译 https://example.com/paper，并讲讲是否提到 harness'),
    '讲讲是否提到 harness',
  );
});

test('复合直译先生成完整译文,再追加原文依据分析', async () => {
  const html = '<html><head><title>Harness Paper</title></head><body><article><h1>Harness Paper</h1><p>The evaluation harness uses a sandbox.</p></article></body></html>';
  const calls = [];
  const completeArticle = async (options) => {
    calls.push(options);
    if (calls.length === 1) return '# Harness Paper\n\n评估工具链使用沙箱。';
    return '**结论：原文直接使用了 evaluation harness。** 该机制依据来自原文网页。';
  };
  const result = await generateStrictTranslation({
    input: '完整直译 https://example.com/paper 并分析是否提到 harness',
    workflow: { workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'translate-compound-')), model: 'test/model', timeoutMs: 1000 },
    writer: { model: 'fallback/model', maxTokens: 12000 },
    fetchFn: async () => {},
    trace: { requests: [] },
    completeArticle,
    fetchWithRetry: async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'text/html; charset=utf-8' },
      arrayBuffer: async () => Buffer.from(html),
    }),
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].systemPrompt, /只做完整忠实的英译中/);
  assert.match(calls[1].systemPrompt, /论文分析员/);
  assert.match(calls[1].prompt, /用户问题:分析是否提到 harness/);
  assert.match(result.article, /评估工具链使用沙箱。[\s\S]*## 原文依据分析[\s\S]*原文直接使用了 evaluation harness/);
  assert.equal(result.supplementaryAnalysis.request, '分析是否提到 harness');
  assert.equal(result.supplementaryAnalysis.evidenceMode, 'full-source');
});

test('纯直译任务不触发附加分析模型', async () => {
  const html = '<html><head><title>Plain Paper</title></head><body><article><p>Body.</p></article></body></html>';
  let calls = 0;
  const result = await generateStrictTranslation({
    input: '完整直译 https://example.com/plain',
    workflow: { workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'translate-plain-')), model: 'test/model', timeoutMs: 1000 },
    writer: { model: 'fallback/model' },
    fetchFn: async () => {},
    trace: { requests: [] },
    completeArticle: async () => { calls++; return '正文。'; },
    fetchWithRetry: async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'text/html' },
      arrayBuffer: async () => Buffer.from(html),
    }),
  });
  assert.equal(calls, 1);
  assert.doesNotMatch(result.article, /原文依据分析/);
});

test('分块 checkpoint 使中断后的直译从已完成块继续', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'translate-checkpoint-'));
  const paragraphs = ['Alpha', 'Beta', 'Gamma']
    .map((word) => `<p>${`${word} `.repeat(3500)}</p>`)
    .join('');
  const html = `<html><head><title>Checkpoint Paper</title></head><body><article>${paragraphs}</article></body></html>`;
  const sourceResponse = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => 'text/html' },
    arrayBuffer: async () => Buffer.from(html),
  });
  let firstCalls = 0;
  await assert.rejects(() => generateStrictTranslation({
    input: '完整直译 https://example.com/checkpoint',
    workflow: { workDir, model: 'test/model', timeoutMs: 1000 },
    writer: { model: 'fallback/model' },
    fetchFn: async () => {},
    trace: { requests: [] },
    completeArticle: async () => {
      firstCalls++;
      if (firstCalls === 2) throw new Error('模拟进程中断');
      return '第一块译文。';
    },
    fetchWithRetry: sourceResponse,
  }), /模拟进程中断/);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(workDir, 'translation-checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.translated.length, 1);
  assert.ok(checkpoint.chunkHashes.length >= 3);

  let resumedCalls = 0;
  const result = await generateStrictTranslation({
    input: '完整直译 https://example.com/checkpoint',
    workflow: { workDir, model: 'test/model', timeoutMs: 1000 },
    writer: { model: 'fallback/model' },
    fetchFn: async () => {},
    trace: { requests: [] },
    completeArticle: async () => { resumedCalls++; return `续跑译文 ${resumedCalls}。`; },
    fetchWithRetry: sourceResponse,
  });
  assert.equal(resumedCalls, checkpoint.chunkHashes.length - 1);
  assert.match(result.article, /第一块译文。[\s\S]*续跑译文 1/);
});

test('PDF 版面四空格缩进只做去缩进处理,不删除正文', async () => {
  const html = '<html><head><title>Indent Paper</title></head><body><article><p>Body.</p></article></body></html>';
  const result = await generateStrictTranslation({
    input: '完整直译 https://example.com/indent',
    workflow: { workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'translate-indent-')), model: 'test/model', timeoutMs: 1000 },
    writer: { model: 'fallback/model' },
    fetchFn: async () => {},
    trace: { requests: [] },
    completeArticle: async () => '    保留这行正文与公式 x = 1。',
    fetchWithRetry: async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'text/html' },
      arrayBuffer: async () => Buffer.from(html),
    }),
  });
  assert.match(result.article, /^保留这行正文与公式 x = 1。$/m);
  assert.doesNotMatch(result.article, /^ {4,}\S/m);
});

test('直译规范化会结束图表概括引用块并清除 PDF 控制字符', async () => {
  const html = '<html><head><title>Figure Paper</title></head><body><article><p>Body.</p></article></body></html>';
  const result = await generateStrictTranslation({
    input: '完整直译 https://example.com/figure-paper',
    workflow: { workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'translate-figure-')), model: 'test/model', timeoutMs: 1000 },
    writer: { model: 'fallback/model' }, fetchFn: async () => {}, trace: { requests: [] },
    completeArticle: async () => '> 图 1 内容概括：中文概括。\n后续正常正文\u0001。',
    fetchWithRetry: async () => ({ ok: true, status: 200, statusText: 'OK', headers: { get: () => 'text/html' }, arrayBuffer: async () => Buffer.from(html) }),
  });
  assert.match(result.article, /> 图 1 内容概括：中文概括。\n\n后续正常正文。/);
  assert.doesNotMatch(result.article, /\u0001/);
});
