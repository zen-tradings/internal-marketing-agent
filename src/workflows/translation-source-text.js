import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import {
  cancellationErrorFromSignal,
  throwIfTaskCancelled,
} from '../lib/task-cancellation.js';
import { convertPdfWithDatalab } from './datalab-parser.js';
import {
  applyTranslationScope,
  datalabPageRange,
  parseTranslationScope,
  scopeLabel,
} from './translation-scope.js';

// 单一现役直译源：保留正文结构与视觉素材，模型只替换可翻译文字单元。
const DOCUMENT_VERSION = 5;
const CHECKPOINT_VERSION = 6;
const TRANSLATION_BATCH_MAX_CHARS = 8000;
const TRANSLATION_BATCH_MAX_ITEMS = 24;
const REPAIR_BATCH_MAX_CHARS = 4000;
const REPAIR_BATCH_MAX_ITEMS = 6;
const DEFAULT_LIMITS = {
  maxSourceBytes: 50 * 1024 * 1024,
  maxPdfPages: 120,
  browserTimeoutMs: 45000,
  fetchTimeoutMs: 30000,
  maxRedirects: 5,
  maxAssetCount: 80,
  maxAssetBytes: 40 * 1024 * 1024,
  maxSingleAssetBytes: 10 * 1024 * 1024,
};
const DOCUMENT_BLOCK_TYPES = new Set([
  'heading', 'paragraph', 'quote', 'list_item', 'figure', 'table', 'equation', 'code', 'reference',
]);
const EXCLUDED_CONTENT_SELECTOR = [
  'script', 'style', 'noscript', 'nav', 'form', 'aside',
  'body > header', 'body > footer', 'video', 'audio', 'iframe',
  '[aria-hidden="true"]', '[hidden]', '.advertisement', '.advert', '.ads',
  '.related-posts', '.recommended', '.comments', '#comments', '.cookie-banner',
  '.newsletter-signup', '.social-share',
].join(',');

export async function generateStructuredTranslation({
  input,
  sourceUrl: explicitSourceUrl,
  sourceRequestHeaders = {},
  workflow,
  writer,
  fetchFn,
  fetchWithRetry,
  completeArticle,
  onProgress,
  translationConfig = {},
  resumeFromCheckpoint = false,
  signal,
}) {
  throwIfTaskCancelled(signal);
  const sourceUrl = explicitSourceUrl || extractInputUrls(input)[0];
  if (!sourceUrl) throw new Error('直译任务缺少可读取的 http(s) 原文链接');
  const scope = parseTranslationScope(input);

  await report(onProgress, {
    stage: 'source',
    message: `正在提取原文结构，翻译范围：${scopeLabel(scope)}`,
    completed: 0,
    total: 1,
  });
  const acquired = await acquireSourceDocument({
    sourceUrl,
    workDir: workflow.workDir,
    fetchFn,
    fetchWithRetry,
    config: translationConfig,
    dnsLookup: translationConfig.dnsLookup,
    scope,
    onProgress,
    requestHeaders: sourceRequestHeaders,
    signal,
  });
  throwIfTaskCancelled(signal);
  let source = acquired.scope?.kind === 'sections' && acquired.scope.appliedStartHeading
    ? acquired
    : applyTranslationScope(acquired, scope);
  source.scope = source.scope || scope;
  source = removeRepeatedSourceMetadata(source);
  assertSourceDocumentComplete(source);
  const manifest = buildDocumentManifest(source);
  await report(onProgress, {
    stage: 'structure',
    message: `已提取 ${manifest.blocks} 个结构块：${manifest.headings} 个标题、${manifest.figures} 张图、${manifest.tables} 个表格`,
    completed: 1,
    total: 1,
  });

  const translated = await translateDocument({
    source,
    workDir: workflow.workDir,
    model: workflow.model || writer.model,
    writer,
    fetchFn,
    completeArticle,
    timeoutMs: workflow.timeoutMs,
    onProgress,
    resumeFromCheckpoint,
    signal,
  });
  throwIfTaskCancelled(signal);
  const article = renderTranslatedDocument(translated);
  const completeness = validateTranslationArtifact({ source, translated, article });
  if (completeness.errors.length) {
    throw new Error(`直译完整性门禁失败:${completeness.errors.join('; ')}`);
  }
  await report(onProgress, {
    stage: 'validation',
    message: `结构化直译完整性校验通过：${completeness.blocks} 个内容块`,
    completed: 1,
    total: 1,
  });

  return {
    article,
    sourceUrl: source.sourceUrl,
    manifest: {
      ...manifest,
      title: source.title,
      author: source.author,
      publishedDate: source.publishedDate,
      sourceUrl: source.sourceUrl,
      sourceType: source.sourceType,
      extractor: source.extractor,
      sha256: source.sha256,
      acquisition: source.acquisition,
      scope: source.scope,
    },
    completeness,
  };
}

export async function acquireSourceDocument({
  sourceUrl,
  workDir,
  fetchFn = globalThis.fetch,
  fetchWithRetry,
  config = {},
  dnsLookup = dns.lookup,
  scope = { kind: 'all' },
  onProgress,
  requestHeaders = {},
  signal,
}) {
  throwIfTaskCancelled(signal);
  const limits = limitsFor(config);
  await assertSafeHttpUrl(sourceUrl, { dnsLookup });
  fs.mkdirSync(workDir, { recursive: true });
  const acquisition = { attempts: [], fallbacks: [] };
  const arxiv = arxivSourceUrls(sourceUrl);
  let acquisitionUrl = arxiv
    ? scope.kind === 'pages' ? arxiv.pdf : arxiv.html
    : sourceUrl;
  if (acquisitionUrl !== sourceUrl) acquisition.attempts.push(scope.kind === 'pages' ? 'arxiv-pdf' : 'arxiv-html');

  if (isNotionUrl(acquisitionUrl) && config.notionApiToken) {
    if (scope.kind === 'pages') {
      throw new Error('Notion 网页没有可验证的 PDF 分页；请改用章节范围');
    }
    acquisition.attempts.push('notion-markdown-api');
    try {
      const notion = await fetchNotionMarkdown({
        sourceUrl: acquisitionUrl,
        token: config.notionApiToken,
        fetchFn,
        fetchWithRetry,
        timeoutMs: limits.fetchTimeoutMs,
      });
      const document = await sourceDocumentFromMarkdown({
        markdown: notion.markdown,
        sourceUrl,
        title: notion.title,
        author: notion.author,
        publishedDate: notion.publishedDate,
        extractor: 'notion-markdown-api',
        workDir,
        fetchFn,
        fetchWithRetry,
        config,
        dnsLookup,
        scope,
        signal,
      });
      document.acquisition = acquisition;
      return document;
    } catch (error) {
      throwIfTaskCancelled(signal);
      acquisition.fallbacks.push(`notion-api:${safeError(error)}`);
    }
  }

  acquisition.attempts.push('static-http');
  let fetched;
  try {
    fetched = await safeFetchResource({
      url: acquisitionUrl,
      fetchFn,
      fetchWithRetry,
      limits,
      dnsLookup,
      accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5',
      headers: requestHeaders,
    });
  } catch (error) {
    throwIfTaskCancelled(signal);
    if (arxiv && acquisitionUrl === arxiv.html) {
      acquisition.fallbacks.push(`arxiv-html:${safeError(error)}`);
      acquisitionUrl = arxiv.pdf;
      acquisition.attempts.push('arxiv-pdf-fallback');
      fetched = await safeFetchResource({
        url: acquisitionUrl,
        fetchFn,
        fetchWithRetry,
        limits,
        dnsLookup,
        accept: 'application/pdf,*/*;q=0.5',
        headers: requestHeaders,
      });
    } else {
      if (scope.kind === 'pages' && !/\.pdf(?:$|[?#])/i.test(acquisitionUrl)) {
        throw new Error('该网页没有可验证的 PDF 分页；请提供 PDF 链接或改用章节范围');
      }
      if (config.browserEnabled === false || /\.pdf(?:$|[?#])/i.test(acquisitionUrl)) throw error;
      acquisition.fallbacks.push(`browser:静态请求失败:${safeError(error)}`);
      return acquireWithBrowser({
        sourceUrl: acquisitionUrl,
        attributionUrl: sourceUrl,
        workDir,
        config,
        limits,
        dnsLookup,
        acquisition,
        fetchFn,
        fetchWithRetry,
        scope,
        signal,
      });
    }
  }

  const contentType = String(fetched.contentType || '').toLowerCase();
  const pdfHint = contentType.includes('application/pdf')
    || /\.pdf(?:$|[?#])/i.test(fetched.finalUrl)
    || /\.pdf(?:$|[?#])/i.test(acquisitionUrl);
  const isPdf = hasPdfSignature(fetched.buffer);
  if (pdfHint && !isPdf) {
    assertPdfResponse({
      buffer: fetched.buffer,
      sourceUrl,
      finalUrl: fetched.finalUrl,
      contentType: fetched.contentType,
    });
  }
  if (isPdf) {
    acquisition.attempts.push('datalab-pdf');
    const document = await sourceDocumentFromPdf({
      pdfBuffer: fetched.buffer,
      sourceUrl,
      resolvedSourceUrl: fetched.finalUrl,
      workDir,
      limits,
      config,
      fetchFn,
      scope,
      onProgress,
      signal,
    });
    throwIfTaskCancelled(signal);
    document.acquisition = acquisition;
    return document;
  }
  if (scope.kind === 'pages') {
    throw new Error('该网页没有可验证的 PDF 分页；请提供 PDF 链接或改用章节范围');
  }

  const html = decodeHtmlBuffer(fetched.buffer, fetched.contentType);
  assertUsableArticleResponse(html, fetched.finalUrl);
  try {
    const document = await sourceDocumentFromHtml({
      html,
      sourceUrl,
      documentUrl: fetched.finalUrl,
      extractor: 'readability-static',
      workDir,
      fetchFn,
      fetchWithRetry,
      config,
      dnsLookup,
      scope,
      signal,
    });
    document.acquisition = acquisition;
    if (shouldUseBrowser(document, html) && config.browserEnabled !== false) {
      acquisition.fallbacks.push('browser:静态正文过短或疑似客户端渲染');
      return acquireWithBrowser({
        sourceUrl: fetched.finalUrl,
        attributionUrl: sourceUrl,
        workDir,
        config,
        limits,
        dnsLookup,
        acquisition,
        fetchFn,
        fetchWithRetry,
        scope,
        signal,
      });
    }
    return document;
  } catch (error) {
    throwIfTaskCancelled(signal);
    if (config.browserEnabled === false) throw error;
    acquisition.fallbacks.push(`browser:${safeError(error)}`);
    return acquireWithBrowser({
      sourceUrl: fetched.finalUrl,
      attributionUrl: sourceUrl,
      workDir,
      config,
      limits,
      dnsLookup,
      acquisition,
      fetchFn,
      fetchWithRetry,
      scope,
      signal,
    });
  }
}

async function acquireWithBrowser({
  sourceUrl,
  attributionUrl = sourceUrl,
  workDir,
  config,
  limits,
  dnsLookup,
  acquisition,
  fetchFn,
  fetchWithRetry,
  scope = { kind: 'all' },
  signal,
}) {
  throwIfTaskCancelled(signal);
  acquisition.attempts.push('playwright-structure');
  const rendered = await renderWithBrowser({ sourceUrl, config, limits, dnsLookup, signal });
  throwIfTaskCancelled(signal);
  assertUsableArticleResponse(rendered.html, rendered.finalUrl);
  const document = await sourceDocumentFromHtml({
    html: rendered.html,
    sourceUrl: attributionUrl,
    documentUrl: rendered.finalUrl,
    extractor: 'readability-playwright',
    workDir,
    fetchFn,
    fetchWithRetry,
    config,
    dnsLookup,
    scope,
    signal,
  });
  document.acquisition = acquisition;
  return document;
}

export async function sourceDocumentFromHtml({
  html,
  sourceUrl,
  documentUrl = sourceUrl,
  extractor = 'readability-static',
  workDir,
  fetchFn = globalThis.fetch,
  fetchWithRetry,
  config = {},
  dnsLookup = dns.lookup,
  assetMap = {},
  scope = { kind: 'all' },
  signal,
}) {
  const sourceDom = new JSDOM(String(html || ''), { url: documentUrl });
  const sourceDocument = sourceDom.window.document;
  const title = metadata(sourceDocument, [
    'meta[property="og:title"]', 'meta[name="twitter:title"]', 'title', 'h1',
  ], 'content');
  const author = metadata(sourceDocument, [
    'meta[name="author"]', 'meta[property="article:author"]', '[rel="author"]', '.author',
  ], 'content');
  const publishedDate = metadata(sourceDocument, [
    'meta[property="article:published_time"]', 'meta[name="date"]', 'time[datetime]',
  ], 'content', 'datetime');

  discardExcludedContent(sourceDocument);
  let readable;
  const structured = sourceDocument.querySelector('article.ltx_document,.ltx_document,article');
  if (!structured) {
    try {
      readable = new Readability(sourceDocument.cloneNode(true), { charThreshold: 80, keepClasses: true }).parse();
    } catch {}
  }
  const fallback = structured || sourceDocument.querySelector('article,main,[role="main"]') || sourceDocument.body;
  const bodyHtml = structured?.outerHTML || readable?.content || fallback?.innerHTML || '';
  const bodyDom = new JSDOM(`<main>${bodyHtml}</main>`, { url: documentUrl });
  discardExcludedContent(bodyDom.window.document);
  const root = bodyDom.window.document.querySelector('main');
  const extractedBlocks = blocksFromDom(root, documentUrl);
  const scoped = scope.kind === 'sections'
    ? applyTranslationScope({ blocks: extractedBlocks }, scope)
    : { blocks: extractedBlocks, scope };
  const blocks = scoped.blocks;
  if (workDir) {
    await localizeFigureAssets(blocks, {
      workDir,
      fetchFn,
      fetchWithRetry,
      config,
      dnsLookup,
      assetMap,
    });
    await localizeTableAssets(blocks, {
      workDir,
      config,
      signal,
    });
  }
  const document = createSourceDocument({
    sourceType: 'html',
    extractor,
    sourceUrl,
    title: cleanText(readable?.title || title || new URL(sourceUrl).hostname),
    author,
    publishedDate,
    blocks,
    rawHashInput: String(html || ''),
  });
  document.scope = scoped.scope || scope;
  assertSourceDocumentComplete(document);
  return document;
}

export async function sourceDocumentFromMarkdown({
  markdown,
  sourceUrl,
  title,
  author,
  publishedDate,
  extractor = 'notion-markdown-api',
  workDir,
  fetchFn = globalThis.fetch,
  fetchWithRetry,
  config = {},
  dnsLookup = dns.lookup,
  scope = { kind: 'all' },
  signal,
}) {
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  const blocks = [];
  let paragraph = [];
  let blockIndex = 0;
  let inFence = false;
  let fenceLines = [];
  let referencesStarted = false;

  const push = (block) => {
    const hasContent = block.text?.trim()
      || (block.type === 'figure' && block.images?.length)
      || (block.type === 'table' && block.rows?.length)
      || (block.type === 'equation' && block.tex?.trim());
    if (!hasContent) return;
    blocks.push({ ...block, id: `b${String(++blockIndex).padStart(6, '0')}`, order: blocks.length });
  };
  const flushParagraph = () => {
    const text = cleanMarkdownText(paragraph.join(' '));
    paragraph = [];
    if (text) push({ type: referencesStarted ? 'reference' : 'paragraph', text });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (/^```/.test(trimmed)) {
      flushParagraph();
      if (inFence) {
        push({ type: 'code', text: fenceLines.join('\n') });
        fenceLines = [];
        inFence = false;
      } else {
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      fenceLines.push(raw);
      continue;
    }
    if (isMarkdownTableStart(lines, index)) {
      flushParagraph();
      const tableLines = [raw, lines[index + 1]];
      index += 2;
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
        tableLines.push(lines[index]);
        index += 1;
      }
      index -= 1;
      const rows = tableLines
        .filter((_, rowIndex) => rowIndex !== 1)
        .map((line) => splitMarkdownTableRow(line).map((text) => ({ text: cleanMarkdownText(text), fragments: [] })));
      push({
        type: 'table',
        caption: '',
        captionFragments: [],
        rows,
        sourceHtml: tableHtmlFromRows(rows),
      });
      continue;
    }
    if (!trimmed) {
      flushParagraph();
      continue;
    }
    const image = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/.exec(trimmed);
    if (image) {
      flushParagraph();
      push({
        type: 'figure',
        images: [{ src: resolveAssetUrl(image[2], sourceUrl), alt: cleanText(image[1]) }],
        caption: cleanText(image[3] || image[1]),
        captionFragments: [],
      });
      continue;
    }
    if (/^\$\$/.test(trimmed)) {
      flushParagraph();
      const equation = [trimmed.replace(/^\$\$/, '')];
      while (index + 1 < lines.length && !/\$\$\s*$/.test(equation.at(-1))) equation.push(lines[++index]);
      const tex = equation.join('\n').replace(/\$\$\s*$/, '').trim();
      if (tex) push({ type: 'equation', tex });
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      const text = cleanMarkdownText(heading[2]);
      if (isReferencesHeading(text)) {
        referencesStarted = true;
      }
      push({ type: 'heading', level: heading[1].length, text });
      continue;
    }
    const list = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/.exec(raw);
    if (list) {
      flushParagraph();
      push({
        type: referencesStarted ? 'reference' : 'list_item',
        ordered: /^\d/.test(list[2]),
        depth: Math.floor(list[1].length / 2),
        text: cleanMarkdownText(list[3]),
      });
      continue;
    }
    const quote = /^>\s?(.+)$/.exec(trimmed);
    if (quote) {
      flushParagraph();
      push({ type: 'quote', text: cleanMarkdownText(quote[1]) });
      continue;
    }
    paragraph.push(raw);
  }
  flushParagraph();
  if (inFence && fenceLines.length) push({ type: 'code', text: fenceLines.join('\n') });

  const scoped = scope.kind === 'sections'
    ? applyTranslationScope({ blocks }, scope)
    : { blocks, scope };
  if (workDir) {
    await localizeFigureAssets(scoped.blocks, {
      workDir,
      fetchFn,
      fetchWithRetry,
      config,
      dnsLookup,
      assetMap: {},
    });
    await localizeTableAssets(scoped.blocks, {
      workDir,
      config,
      signal,
    });
  }

  const firstHeading = scoped.blocks.find((block) => block.type === 'heading');
  const document = createSourceDocument({
    sourceType: 'notion',
    extractor,
    sourceUrl,
    title: cleanText(title || firstHeading?.text || new URL(sourceUrl).hostname),
    author,
    publishedDate,
    blocks: scoped.blocks,
    rawHashInput: String(markdown || ''),
  });
  document.scope = scoped.scope || scope;
  assertSourceDocumentComplete(document);
  return document;
}

async function sourceDocumentFromPdf({
  pdfBuffer,
  sourceUrl,
  resolvedSourceUrl,
  workDir,
  limits,
  config,
  fetchFn,
  scope,
  onProgress,
  signal,
}) {
  assertPdfResponse({
    buffer: pdfBuffer,
    sourceUrl,
    finalUrl: resolvedSourceUrl,
    contentType: 'application/pdf',
  });
  const pdfPath = path.join(workDir, 'translation-source.pdf');
  fs.writeFileSync(pdfPath, pdfBuffer);
  const pages = assertPdfPageLimit(pdfPath, limits.maxPdfPages);
  if (scope?.kind === 'pages' && scope.endPage > pages) {
    throw new Error(`指定翻译范围超过 PDF 页数:${scope.endPage}/${pages}`);
  }
  const info = runCommand('pdfinfo', [pdfPath], { timeout: 15000 });
  const title = cleanPdfMeta(/^Title:\s+(.+)$/mi.exec(info)?.[1])
    || path.basename(new URL(sourceUrl).pathname, '.pdf')
    || 'PDF 原文';
  const author = cleanPdfMeta(/^Author:\s+(.+)$/mi.exec(info)?.[1]);
  const publishedDate = cleanPdfMeta(/^CreationDate:\s+(.+)$/mi.exec(info)?.[1]);
  const converted = await convertPdfWithDatalab({
    pdfBuffer,
    filename: path.basename(new URL(resolvedSourceUrl || sourceUrl).pathname) || 'source.pdf',
    pageRange: datalabPageRange(scope),
    workDir,
    config,
    fetchFn,
    onProgress,
  });
  const document = await sourceDocumentFromHtml({
    html: converted.html,
    sourceUrl,
    documentUrl: resolvedSourceUrl || sourceUrl,
    extractor: 'datalab-marker-html',
    workDir,
    fetchFn,
    config,
    assetMap: converted.images,
    scope,
    signal,
  });
  document.sourceType = 'pdf';
  document.title = cleanText(converted.metadata?.title || document.title || title);
  document.author = cleanText(converted.metadata?.author || document.author || author);
  document.publishedDate = cleanText(converted.metadata?.date || document.publishedDate || publishedDate);
  document.sha256 = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
  document.pageCount = pages;
  document.processedPageCount = converted.pageCount;
  document.parseQualityScore = converted.parseQualityScore;
  document.parserAttempts = converted.attempts;
  document.scope = scope;
  assertSourceDocumentComplete(document);
  return document;
}

export async function translateDocument({
  source,
  workDir,
  model,
  writer,
  fetchFn,
  completeArticle,
  timeoutMs,
  onProgress,
  resumeFromCheckpoint = false,
  signal,
}) {
  throwIfTaskCancelled(signal);
  const units = translationUnits(source);
  if (!units.length) throw new Error('原文没有可翻译的结构化文本');
  const checkpointPath = path.join(workDir, 'translation-checkpoint.json');
  const checkpointKey = crypto.createHash('sha256')
    .update(JSON.stringify({ version: CHECKPOINT_VERSION, source: source.sha256, model, units }))
    .digest('hex');
  const completed = new Map();
  if (resumeFromCheckpoint) {
    try {
      const saved = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
      if (saved.key === checkpointKey) {
        for (const item of saved.translations || []) completed.set(item.id, item.text);
      }
    } catch {}
  }

  const batches = batchUnits(
    units.filter((unit) => !completed.has(unit.id)),
    TRANSLATION_BATCH_MAX_CHARS,
    TRANSLATION_BATCH_MAX_ITEMS,
  );
  await report(onProgress, {
    stage: 'translation',
    message: completed.size
      ? `从结构化断点继续翻译 ${completed.size}/${units.length}`
      : `开始翻译标题、正文及图表标题，共 ${units.length} 个文本单元`,
    completed: completed.size,
    total: units.length,
  });

  for (const batch of batches) {
    throwIfTaskCancelled(signal);
    let translations = await requestTranslationBatch({
      batch, source, model, writer, fetchFn, completeArticle, timeoutMs,
    });
    let invalid = validateBatchTranslations(batch, translations);
    if (invalid.length) {
      const repaired = [];
      for (const repairBatch of batchUnits(
        invalid,
        REPAIR_BATCH_MAX_CHARS,
        REPAIR_BATCH_MAX_ITEMS,
      )) {
        throwIfTaskCancelled(signal);
        repaired.push(...await requestTranslationBatch({
          batch: repairBatch,
          source,
          model,
          writer,
          fetchFn,
          completeArticle,
          timeoutMs,
          repair: true,
        }));
      }
      const repairedById = new Map(repaired.map((item) => [item.id, item]));
      const originalById = new Map(translations.map((item) => [item.id, item]));
      translations = batch.map((unit) => repairedById.get(unit.id) || originalById.get(unit.id)).filter(Boolean);
      // 高亮是公众号样式增强，不能在忠实译文已经完整时反向阻断整篇任务。
      // 修复请求后只保留结构、数字/链接和漏译等内容级硬门禁；不安全的
      // Markdown 高亮会在落 checkpoint 前降级为纯文本。
      invalid = validateBatchTranslations(batch, translations, { checkHighlights: false });
    }
    if (invalid.length) {
      writeJsonAtomic(path.join(workDir, 'translation-invalid.json'), {
        failedAt: new Date().toISOString(),
        units: invalid.map((unit) => ({ id: unit.id, source: unit.text })),
        received: translations.map((item) => ({ id: item.id, text: item.text })),
      });
      throw new Error(`结构化翻译校验失败:${invalid.map((unit) => unit.id).join(',')}`);
    }
    translations = normalizeBatchHighlights(batch, translations);
    for (const item of translations) completed.set(item.id, item.text.trim());
    writeJsonAtomic(checkpointPath, {
      version: CHECKPOINT_VERSION,
      key: checkpointKey,
      translations: [...completed].map(([id, text]) => ({ id, text })),
      updatedAt: new Date().toISOString(),
    });
    await report(onProgress, {
      stage: 'translation',
      message: `结构化翻译进度 ${completed.size}/${units.length}`,
      completed: completed.size,
      total: units.length,
    });
  }
  throwIfTaskCancelled(signal);
  if (completed.size !== units.length) throw new Error(`结构化翻译缺块:${completed.size}/${units.length}`);
  return applyTranslations(source, completed);
}

export function renderTranslatedDocument(document) {
  const translatedTitle = normalizeTranslatedTitle(document.translatedTitle || document.title || '原文直译');
  const lines = [
    '---',
    `title: ${JSON.stringify(translatedTitle)}`,
    '---',
    '',
    sourceAttribution(document),
    '',
  ];
  let figureNumber = 0;
  let tableNumber = 0;
  for (const block of document.blocks) {
    const text = restoreFragments(block.translatedText ?? block.text ?? '', block.fragments);
    if (block.type === 'heading') {
      if (block.level === 1 && sameLooseText(text, translatedTitle)) continue;
      lines.push(`${'#'.repeat(clamp(block.level || 2, 2, 4))} ${text}`, '');
    }
    else if (block.type === 'paragraph') lines.push(text, '');
    else if (block.type === 'quote') lines.push(...String(text).split('\n').map((line) => `> ${line}`), '');
    else if (block.type === 'list_item') {
      const marker = block.ordered ? '1.' : '-';
      lines.push(`${'  '.repeat(block.depth || 0)}${marker} ${text}`, '');
    } else if (block.type === 'figure') {
      figureNumber += 1;
      for (const image of block.images || []) {
        if (!image.localPath) continue;
        lines.push(`![${escapeMarkdownAlt(image.alt || `原文图 ${figureNumber}`)}](${image.localPath})`, '');
      }
      const caption = restoreFragments(block.translatedCaption ?? block.caption ?? '', block.captionFragments);
      if (caption) lines.push(captionLine(`图 ${figureNumber}`, caption), '');
    } else if (block.type === 'table') {
      tableNumber += 1;
      const caption = restoreFragments(block.translatedCaption ?? block.caption ?? '', block.captionFragments);
      if (caption) lines.push(`**表 ${tableNumber}：${caption}**`, '');
      if (block.localPath) {
        lines.push(`![原文表 ${tableNumber}](${block.localPath})`, '');
      }
    } else if (block.type === 'equation') {
      lines.push('$$', block.tex, '$$', '');
    } else if (block.type === 'code') {
      lines.push(`<pre><code>${escapeHtml(block.text || '')}</code></pre>`, '');
    } else if (block.type === 'reference') {
      lines.push(`- ${text}`, '');
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

export function validateTranslationArtifact({ source, translated, article }) {
  const errors = [];
  const sourceIds = source.blocks.map((block) => block.id);
  const translatedIds = translated.blocks.map((block) => block.id);
  if (sourceIds.join('|') !== translatedIds.join('|')) errors.push('结构块 ID 或顺序发生变化');
  if (source.blocks.some((block) => !DOCUMENT_BLOCK_TYPES.has(block.type))) errors.push('原文含未知结构块');
  if (translated.blocks.some((block) => !DOCUMENT_BLOCK_TYPES.has(block.type))) errors.push('译文含未知结构块');
  for (const unit of translationUnits(source)) {
    const target = translatedUnitText(translated, unit.id);
    if (!target?.trim()) errors.push(`译文为空:${unit.id}`);
    else if (!sameInvariantTokens(unit.text, target)) errors.push(`数字或链接不一致:${unit.id}`);
    else if (isClearlyUntranslated(unit.text, target)) errors.push(`疑似漏译英文正文:${unit.id}`);
  }
  const value = String(article || '');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) errors.push('译文含控制字符');
  const sourceFigures = source.blocks.filter((block) => block.type === 'figure')
    .reduce((sum, block) => sum + block.images.length, 0);
  const renderedFigures = (value.match(/^!\[[^\]]*\]\([^)]*\)$/gm) || []).length;
  const sourceTables = source.blocks.filter((block) => block.type === 'table').length;
  const renderedTableImages = (value.match(/^!\[原文表 \d+\]\([^)]*\)$/gm) || []).length;
  if (renderedTableImages !== sourceTables) {
    errors.push(`原文表格图片数量不一致:${renderedTableImages}/${sourceTables}`);
  }
  if (renderedFigures - renderedTableImages !== sourceFigures) {
    errors.push(`原文图片数量不一致:${renderedFigures - renderedTableImages}/${sourceFigures}`);
  }
  const sourceEquations = source.blocks.filter((block) => block.type === 'equation').length;
  const renderedEquations = (value.match(/^\$\$$/gm) || []).length / 2;
  if (renderedEquations !== sourceEquations) errors.push(`公式数量不一致:${renderedEquations}/${sourceEquations}`);
  for (const block of source.blocks.filter((item) => item.type === 'figure')) {
    for (const image of block.images) {
      if (!image.localPath || !fs.existsSync(image.localPath) || fs.statSync(image.localPath).size <= 0) {
        errors.push(`图片资产缺失:${block.id}`);
      }
    }
  }
  for (const block of source.blocks.filter((item) => item.type === 'table')) {
    if (!block.localPath || !fs.existsSync(block.localPath) || fs.statSync(block.localPath).size <= 0) {
      errors.push(`原文表格图片缺失:${block.id}`);
    }
  }
  return {
    errors,
    blocks: source.blocks.length,
    headings: source.blocks.filter((block) => block.type === 'heading').length,
    paragraphs: source.blocks.filter((block) => ['paragraph', 'quote', 'list_item'].includes(block.type)).length,
    figures: sourceFigures,
    tables: sourceTables,
    equations: sourceEquations,
    sourceCharacters: translationUnits(source).reduce((sum, unit) => sum + unit.text.length, 0),
    contentMode: 'structured-document',
    scope: source.scope,
  };
}

export function buildDocumentManifest(document) {
  return {
    version: document.version,
    contentMode: 'structured-document',
    blocks: document.blocks.length,
    headings: document.blocks.filter((block) => block.type === 'heading').length,
    paragraphs: document.blocks.filter((block) => ['paragraph', 'quote', 'list_item'].includes(block.type)).length,
    figures: document.blocks.filter((block) => block.type === 'figure').reduce((sum, block) => sum + block.images.length, 0),
    tables: document.blocks.filter((block) => block.type === 'table').length,
    equations: document.blocks.filter((block) => block.type === 'equation').length,
    blockOrder: document.blocks.map((block) => `${block.id}:${block.type}`),
    pageCount: document.pageCount || undefined,
    processedPageCount: document.processedPageCount || undefined,
    parseQualityScore: document.parseQualityScore,
    parserAttempts: document.parserAttempts,
    scope: document.scope,
  };
}

export function removeRepeatedSourceMetadata(document) {
  const scope = document.scope || { kind: 'all' };
  if (scope.kind === 'sections' || (scope.kind === 'pages' && scope.startPage > 1)) return document;
  const blocks = document.blocks || [];
  const boundary = blocks.findIndex((block) => block.type === 'heading' && isAcademicBodyStart(block.text));
  if (boundary <= 0) return document;

  const preamble = blocks.slice(0, boundary);
  const titleRepeated = preamble.some((block) => (
    ['heading', 'paragraph'].includes(block.type)
      && sameLooseText(block.text, document.title)
  ));
  const preambleText = normalizeComparableText(preamble.map((block) => block.text || '').join(' '));
  const authorMatches = String(document.author || '')
    .split(/[;,，；]/)
    .map((name) => normalizeComparableText(name))
    .filter((name) => name.length >= 4)
    .slice(0, 20)
    .filter((name) => preambleText.includes(name))
    .length;
  if (!titleRepeated && authorMatches < 2) return document;

  const visualTypes = new Set(['figure', 'table', 'equation']);
  const filtered = [
    ...preamble.filter((block) => visualTypes.has(block.type)),
    ...blocks.slice(boundary),
  ].map((block, index) => ({ ...block, order: index }));
  return {
    ...document,
    blocks: filtered,
    metadataBlocksRemoved: blocks.length - filtered.length,
  };
}

export async function assertSafeHttpUrl(rawUrl, { dnsLookup = dns.lookup } = {}) {
  return (await resolveSafeHttpUrl(rawUrl, { dnsLookup })).url;
}

async function resolveSafeHttpUrl(rawUrl, { dnsLookup = dns.lookup } = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('原文链接格式无效'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 http(s) 原文链接');
  if (url.username || url.password) throw new Error('原文链接不得包含用户名或密码');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('原文链接指向本机或内部地址');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('原文链接指向私网或保留地址');
    return { url, addresses: [{ address: host, family: net.isIPv4(host) ? 4 : 6 }] };
  }
  let records;
  try { records = await dnsLookup(host, { all: true, verbatim: true }); }
  catch (error) { throw new Error(`原文域名解析失败:${safeError(error)}`); }
  const addresses = (records || []).map((record) => ({
    address: String(record?.address || ''),
    family: Number(record?.family) || net.isIP(record?.address),
  }));
  if (!addresses.length || addresses.some((record) => !record.family || isPrivateIp(record.address))) {
    throw new Error('原文域名解析到私网或保留地址');
  }
  return { url, addresses };
}

export function isPrivateIp(address) {
  const value = String(address || '').toLowerCase();
  if (net.isIPv4(value)) {
    const [a, b, c] = value.split('.').map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224;
  }
  if (net.isIPv6(value)) {
    const bytes = ipv6Bytes(value);
    if (!bytes) return true;
    if (matchesIpv6Prefix(bytes, '::', 128) || matchesIpv6Prefix(bytes, '::1', 128)) return true;
    if (matchesIpv6Prefix(bytes, '::ffff:0:0', 96)) {
      return isPrivateIp(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
    }
    if (matchesIpv6Prefix(bytes, '64:ff9b:1::', 48)
      || matchesIpv6Prefix(bytes, '100::', 64)
      || matchesIpv6Prefix(bytes, '2001::', 23)
      || matchesIpv6Prefix(bytes, '2001:db8::', 32)
      || matchesIpv6Prefix(bytes, '3fff::', 20)
      || matchesIpv6Prefix(bytes, '5f00::', 16)
      || matchesIpv6Prefix(bytes, 'fc00::', 7)
      || matchesIpv6Prefix(bytes, 'fe80::', 10)
      || matchesIpv6Prefix(bytes, 'ff00::', 8)) return true;
    if (matchesIpv6Prefix(bytes, '2002::', 16)) {
      return isPrivateIp(`${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`);
    }
    return false;
  }
  return true;
}

function ipv6Bytes(address) {
  let value = String(address || '').split('%')[0].toLowerCase();
  if (!net.isIPv6(value)) return undefined;
  const dotted = value.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) {
    const octets = dotted.split('.').map(Number);
    value = value.slice(0, -dotted.length)
      + `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const sides = value.split('::');
  if (sides.length > 2) return undefined;
  const left = sides[0] ? sides[0].split(':').filter(Boolean) : [];
  const right = sides[1] ? sides[1].split(':').filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  if ((sides.length === 1 && missing !== 0) || missing < 0) return undefined;
  const groups = [...left, ...Array(sides.length === 2 ? missing : 0).fill('0'), ...right];
  if (groups.length !== 8) return undefined;
  const bytes = Buffer.alloc(16);
  for (let index = 0; index < groups.length; index += 1) {
    const group = Number.parseInt(groups[index], 16);
    if (!Number.isInteger(group) || group < 0 || group > 0xffff) return undefined;
    bytes.writeUInt16BE(group, index * 2);
  }
  return bytes;
}

function matchesIpv6Prefix(bytes, prefix, bits) {
  const prefixBytes = ipv6Bytes(prefix);
  if (!prefixBytes) return false;
  const whole = Math.floor(bits / 8);
  for (let index = 0; index < whole; index += 1) {
    if (bytes[index] !== prefixBytes[index]) return false;
  }
  const remainder = bits % 8;
  if (!remainder) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (bytes[whole] & mask) === (prefixBytes[whole] & mask);
}

export async function safeFetchResource({
  url,
  fetchFn = globalThis.fetch,
  fetchWithRetry,
  limits = DEFAULT_LIMITS,
  dnsLookup = dns.lookup,
  accept,
  headers = {},
  maxBytes = limits.maxSourceBytes,
}) {
  let current = url;
  let currentHeaders = { ...headers };
  for (let redirects = 0; redirects <= limits.maxRedirects; redirects += 1) {
    const resolved = await resolveSafeHttpUrl(current, { dnsLookup });
    const requestFetch = fetchFn === globalThis.fetch ? pinnedHttpFetch(resolved.addresses) : fetchFn;
    const response = await callFetch(fetchWithRetry, requestFetch, current, {
      redirect: 'manual',
      headers: {
        Accept: accept || '*/*',
        'User-Agent': 'Mozilla/5.0 ZenTranslationBot/3.0',
        ...currentHeaders,
      },
    }, limits.fetchTimeoutMs);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await cancelResponseBody(response);
      if (!location) throw new Error(`原文重定向缺少 Location:${response.status}`);
      const next = new URL(location, current).toString();
      if (new URL(next).origin !== new URL(current).origin) {
        currentHeaders = stripSensitiveRequestHeaders(currentHeaders);
      }
      current = next;
      continue;
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new Error(`原文获取失败:${response.status} ${response.statusText}`);
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) {
      await cancelResponseBody(response);
      throw new Error(`原文响应超过大小上限:${declared}`);
    }
    const buffer = await readResponseBufferWithLimit(response, maxBytes);
    if (!buffer.length) throw new Error('原文响应为空');
    return {
      finalUrl: current,
      contentType: response.headers.get('content-type') || '',
      buffer,
      status: response.status,
    };
  }
  throw new Error(`原文重定向超过 ${limits.maxRedirects} 次`);
}

function stripSensitiveRequestHeaders(headers) {
  const sensitive = new Set(['authorization', 'cookie', 'proxy-authorization']);
  return Object.fromEntries(
    Object.entries(headers || {}).filter(([name]) => !sensitive.has(name.toLowerCase())),
  );
}

export async function readResponseBufferWithLimit(response, maxBytes) {
  const limit = Number(maxBytes);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('响应大小上限配置无效');
  const reader = response?.body?.getReader?.();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > limit) throw new Error(`原文响应超过大小上限:${buffer.length}`);
    return buffer;
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > limit) {
        await reader.cancel('response size limit exceeded').catch(() => {});
        throw new Error(`原文响应超过大小上限:${total}`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}

async function cancelResponseBody(response) {
  try { await response?.body?.cancel?.(); } catch {}
}

async function callFetch(fetchWithRetry, fetchFn, url, options, timeoutMs) {
  if (fetchWithRetry) return fetchWithRetry(fetchFn, url, options, { timeoutMs, attempts: 2 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetchFn(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function pinnedHttpFetch(addresses) {
  const safeAddresses = addresses.map((record) => ({ address: record.address, family: record.family }));
  return async function fetchPinned(rawUrl, options = {}) {
    const target = new URL(rawUrl);
    const transport = target.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const request = transport.request(target, {
        method: 'GET',
        headers: options.headers,
        signal: options.signal,
        lookup(_hostname, lookupOptions, callback) {
          const wantedFamily = Number(lookupOptions?.family) || 0;
          const candidates = wantedFamily
            ? safeAddresses.filter((record) => record.family === wantedFamily)
            : safeAddresses;
          const selected = candidates[0] || safeAddresses[0];
          if (!selected) {
            callback(Object.assign(new Error('安全 DNS 结果为空'), { code: 'ENOTFOUND' }));
            return;
          }
          if (lookupOptions?.all) callback(null, candidates.length ? candidates : safeAddresses);
          else callback(null, selected.address, selected.family);
        },
      }, (incoming) => {
        try {
          const responseHeaders = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
          }
          resolve(new Response(Readable.toWeb(incoming), {
            status: incoming.statusCode,
            statusText: incoming.statusMessage,
            headers: responseHeaders,
          }));
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      });
      request.once('error', reject);
      request.end();
    });
  };
}

async function renderWithBrowser({ sourceUrl, config, limits, dnsLookup, signal }) {
  throwIfTaskCancelled(signal);
  const resolved = await resolveSafeHttpUrl(sourceUrl, { dnsLookup });
  const sourceHost = resolved.url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const pinnedAddress = resolved.addresses[0].address;
  const resolverTarget = net.isIPv6(pinnedAddress) ? `[${pinnedAddress}]` : pinnedAddress;
  let playwright;
  try { playwright = await import('playwright-core'); }
  catch { throw new Error('动态网页需要 playwright-core'); }
  const executablePath = config.browserExecutablePath
    || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!fs.existsSync(executablePath)) throw new Error(`找不到浏览器:${executablePath}`);
  const browser = await playwright.chromium.launch({
    executablePath,
    headless: true,
    args: [
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      `--host-resolver-rules=MAP ${sourceHost} ${resolverTarget}, MAP * ~NOTFOUND`,
    ],
  });
  const abortBrowser = () => { void browser.close().catch(() => {}); };
  signal?.addEventListener('abort', abortBrowser, { once: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(limits.browserTimeoutMs);
    await page.route('**/*', async (route) => {
      let parsed;
      try { parsed = new URL(route.request().url()); } catch { await route.abort('blockedbyclient'); return; }
      if (!['http:', 'https:'].includes(parsed.protocol)
        || parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase() !== sourceHost) {
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: limits.browserTimeoutMs });
    throwIfTaskCancelled(signal);
    try { await page.waitForLoadState('networkidle', { timeout: Math.min(15000, limits.browserTimeoutMs) }); } catch {}
    throwIfTaskCancelled(signal);
    const finalUrl = page.url();
    await assertSafeHttpUrl(finalUrl, { dnsLookup });
    return { html: await page.content(), finalUrl };
  } catch (error) {
    if (signal?.aborted) throw cancellationErrorFromSignal(signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortBrowser);
    await browser.close();
  }
}

async function fetchNotionMarkdown({ sourceUrl, token, fetchFn, fetchWithRetry, timeoutMs }) {
  const pageId = notionPageId(sourceUrl);
  if (!pageId) throw new Error('Notion 页面 ID 无法识别');
  const url = `https://api.notion.com/v1/pages/${pageId}/markdown`;
  const response = await callFetch(fetchWithRetry, fetchFn, url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': '2026-03-11',
      Accept: 'application/json',
    },
  }, timeoutMs);
  if (!response.ok) throw new Error(`Notion Markdown 获取失败:${response.status}`);
  const data = await response.json();
  if (!String(data.markdown || '').trim()) throw new Error('Notion Markdown 正文为空');
  return {
    markdown: data.markdown,
    title: data.title || '',
    author: data.author || '',
    publishedDate: data.last_edited_time || '',
  };
}

async function requestTranslationBatch({
  batch,
  source,
  model,
  writer,
  fetchFn,
  completeArticle,
  timeoutMs,
  repair = false,
}) {
  const protections = new Map();
  const units = batch.map((unit) => {
    if (!repair) return unit;
    const protectedText = protectInvariantText(unit.text);
    protections.set(unit.id, protectedText.tokens);
    return { ...unit, text: protectedText.text };
  });
  const request = {
    prompt: `将下面 JSON 中每个 text 完整、忠实、逐句翻译为简体中文。

硬性规则:
- 只返回合法 JSON，格式严格为 {"translations":[{"id":"原 ID","text":"完整译文"}]}。
- translations 必须与输入数量相同，ID 必须逐字相同且不得重复、遗漏或新增。
- 按 kind 翻译标题、正文、标题层级、图注和表题，不总结、不改写、不删减。表格正文直接保留原文截图，不进入翻译输入。
- 不添加输入中不存在的图、表、公式、引用、分析或内容概括。
- 不改变数字、单位、Ticker 和正文中原有的 URL。
- 所有 ⟦ZEN_INLINE_NNN⟧ 都是公式、链接或引用占位符，必须原样、原位置、各保留一次。
- 专有名词首次出现可保留英文，普通叙述必须翻译成中文。
- paragraph、quote、list_item 必须提高关键词和核心观点高亮密度：正文每约 200 个汉字至少 1 处，目标 2–3 处；优先高亮关键术语、核心机制、中心句或开头关键句。
- 每处使用 Markdown **加粗**，可包住 2–64 个字符的关键短语或短句，不能把整段全部加粗，也不能改动原意。
- title、heading、figure_caption、table_caption 禁止添加 **加粗**；除正文高亮外不得添加其它 Markdown 格式。
${repair ? '- 输入中的 ⟦ZEN_KEEP_N⟧ 是不可翻译占位符，必须原样、原位置、各保留一次。' : ''}

文档标题:${source.title}
来源:${source.sourceUrl}

输入 JSON:
${JSON.stringify({ units })}`,
    model,
    writer: { ...writer, temperature: 0 },
    fetchFn,
    timeoutMs,
    systemPrompt: '你是严谨的结构化文档翻译器。忠实翻译输入的标题、正文及图表标题；按要求在正文关键术语和核心观点上稳定添加 Markdown 高亮，绝不改动占位符、数字、链接或结构，只输出合法 JSON。',
  };
  const responseFormat = {
    type: 'json_schema',
    json_schema: {
      name: 'translation_blocks',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['translations'],
        properties: {
          translations: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'text'],
              properties: { id: { type: 'string' }, text: { type: 'string' } },
            },
          },
        },
      },
    },
  };
  let raw;
  try {
    raw = await completeArticle({ ...request, responseFormat });
  } catch (error) {
    if (!/(?:response[_ -]?format|json[_ -]?schema|structured output|HTTP 400|OpenRouter 400)/i.test(safeError(error))) throw error;
    raw = await completeArticle(request);
  }
  const parsed = parseJsonPayload(raw);
  if (!Array.isArray(parsed?.translations)) return [];
  return parsed.translations
    .filter((item) => item && typeof item.id === 'string' && typeof item.text === 'string')
    .map((item) => ({
      id: item.id,
      text: repair ? restoreInvariantText(item.text, protections.get(item.id) || []) : item.text,
    }));
}

function validateBatchTranslations(batch, translations, { checkHighlights = true } = {}) {
  const byId = new Map();
  for (const item of translations) {
    if (byId.has(item.id)) return batch;
    byId.set(item.id, item.text);
  }
  return batch.filter((unit) => {
    const text = byId.get(unit.id);
    return !text?.trim()
      || !sameInvariantTokens(unit.text, text)
      || isClearlyUntranslated(unit.text, text)
      || (checkHighlights && !hasValidSelectiveHighlights(unit, text));
  });
}

function hasValidSelectiveHighlights(unit, translated) {
  if (!hasSafeSelectiveHighlights(unit, translated)) return false;
  const value = String(translated || '');
  const highlights = [...value.matchAll(/\*\*([^*\n]+)\*\*/g)].map((match) => match[1].trim());
  const allowed = ['paragraph', 'quote', 'list_item'].includes(unit.kind);
  if (!allowed) return true;
  const visibleCharacters = Math.max(1, value.replace(/\*\*/g, '').length);
  const minHighlights = visibleCharacters < 30 ? 0 : Math.max(1, Math.ceil(visibleCharacters / 120));
  return highlights.length >= minHighlights;
}

function hasSafeSelectiveHighlights(unit, translated) {
  const value = String(translated || '');
  const markers = value.match(/\*\*/g) || [];
  const highlights = [...value.matchAll(/\*\*([^*\n]+)\*\*/g)].map((match) => match[1].trim());
  if (markers.length !== highlights.length * 2) return false;
  const allowed = ['paragraph', 'quote', 'list_item'].includes(unit.kind);
  if (!allowed) return highlights.length === 0;
  const visibleCharacters = Math.max(1, value.replace(/\*\*/g, '').length);
  const maxHighlights = visibleCharacters < 30 ? 1 : Math.max(1, Math.ceil(visibleCharacters / 65));
  if (highlights.length > maxHighlights) return false;
  if (highlights.some((text) => text.length < 2 || text.length > 64)) return false;
  const highlightedCharacters = highlights.reduce((sum, text) => sum + text.length, 0);
  return highlightedCharacters / visibleCharacters <= 0.45;
}

function normalizeBatchHighlights(batch, translations) {
  const unitsById = new Map(batch.map((unit) => [unit.id, unit]));
  return translations.map((item) => {
    const unit = unitsById.get(item.id);
    if (!unit || hasSafeSelectiveHighlights(unit, item.text)) return item;
    return { ...item, text: String(item.text).replaceAll('**', '') };
  });
}

function protectInvariantText(value) {
  const tokens = [];
  const text = String(value).replace(
    /⟦ZEN_INLINE_\d{3}⟧|https?:\/\/[^\s)\]}>"']+|[$€£¥]?[-+]?\d+(?:[,.]\d+)*(?:%|‰|[KMBT](?=\b))?/gi,
    (token) => `⟦ZEN_KEEP_${tokens.push(token)}⟧`,
  );
  return { text, tokens };
}

function restoreInvariantText(value, tokens) {
  let text = String(value);
  tokens.forEach((token, index) => { text = text.replaceAll(`⟦ZEN_KEEP_${index + 1}⟧`, token); });
  return text;
}

function translationUnits(document) {
  const units = [{ id: 'meta:title', text: document.title || '原文直译', kind: 'title' }];
  for (const block of document.blocks) {
    if (['heading', 'paragraph', 'quote', 'list_item'].includes(block.type) && block.text?.trim()) {
      units.push({ id: block.id, text: block.text, kind: block.type });
    }
    if (block.type === 'figure' && block.caption?.trim()) {
      units.push({ id: `${block.id}:caption`, text: block.caption, kind: 'figure_caption' });
    }
    if (block.type === 'table') {
      if (block.caption?.trim()) units.push({ id: `${block.id}:caption`, text: block.caption, kind: 'table_caption' });
    }
  }
  return units;
}

function applyTranslations(source, completed) {
  const document = structuredClone(source);
  document.translatedTitle = completed.get('meta:title') || source.title;
  for (const block of document.blocks) {
    if (completed.has(block.id)) block.translatedText = completed.get(block.id);
    if (completed.has(`${block.id}:caption`)) block.translatedCaption = completed.get(`${block.id}:caption`);
  }
  return document;
}

function translatedUnitText(document, id) {
  if (id === 'meta:title') return document.translatedTitle;
  const direct = document.blocks.find((block) => block.id === id);
  if (direct) return direct.translatedText;
  const caption = /^(b\d+):caption$/.exec(id);
  if (caption) return document.blocks.find((block) => block.id === caption[1])?.translatedCaption;
  return undefined;
}

function batchUnits(units, maxChars, maxItems) {
  const batches = [];
  let batch = [];
  let chars = 0;
  for (const unit of units) {
    if (batch.length && (batch.length >= maxItems || chars + unit.text.length > maxChars)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(unit);
    chars += unit.text.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function sameInvariantTokens(source, translated) {
  const tokens = (value) => [
    ...(String(value).match(/⟦ZEN_INLINE_\d{3}⟧/g) || []),
    ...(String(value).match(/https?:\/\/[^\s)\]}>"']+/gi) || []),
    ...(String(value).match(/\$[A-Z]{1,6}\b|\b(?:NASDAQ|NYSE|AMEX|OTC)\s*:\s*[A-Z]{1,6}\b/g) || []),
  ].sort();
  if (JSON.stringify(tokens(source)) !== JSON.stringify(tokens(translated))) return false;
  const sourceNumbers = invariantNumbers(source);
  const translatedNumbers = invariantNumbers(translated);
  if (JSON.stringify(sourceNumbers) === JSON.stringify(translatedNumbers)) return true;
  const monthNumbers = englishMonthNumbers(source);
  return monthNumbers.length > 0
    && JSON.stringify([...sourceNumbers, ...monthNumbers].sort()) === JSON.stringify(translatedNumbers);
}

function invariantNumbers(value) {
  return (String(value).match(/(?<![A-Za-z0-9])[-+]?\d+(?:[,.]\d+)*(?:%|‰)?/g) || []).sort();
}

function isClearlyUntranslated(source, translated) {
  const sourceEnglish = (String(source).match(/[A-Za-z]/g) || []).length;
  if (sourceEnglish < 40) return false;
  const sourceWords = String(source).match(/[A-Za-z][A-Za-z'-]*/g) || [];
  const capitalized = sourceWords.filter((word) => /^[A-Z]/.test(word)).length;
  if (/,/.test(source) && sourceWords.length >= 4 && capitalized / sourceWords.length >= 0.7) return false;
  const words = String(translated).match(/[A-Za-z][A-Za-z'-]*/g) || [];
  const han = (String(translated).match(/\p{Script=Han}/gu) || []).length;
  return words.length >= 10 && han < 4;
}

function englishMonthNumbers(value) {
  const months = {
    jan: '1', january: '1', feb: '2', february: '2', mar: '3', march: '3',
    apr: '4', april: '4', may: '5', jun: '6', june: '6', jul: '7', july: '7',
    aug: '8', august: '8', sep: '9', sept: '9', september: '9', oct: '10',
    october: '10', nov: '11', november: '11', dec: '12', december: '12',
  };
  const matches = String(value).matchAll(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b/gi,
  );
  return [...matches].map((match) => months[match[1].toLowerCase()]).filter(Boolean);
}

function createSourceDocument({
  sourceType,
  extractor,
  sourceUrl,
  title,
  author = '',
  publishedDate = '',
  blocks,
  rawHashInput,
  pageCount,
}) {
  return {
    version: DOCUMENT_VERSION,
    contentMode: 'structured-document',
    sourceType,
    extractor,
    sourceUrl,
    title: cleanText(title),
    author: cleanText(author),
    publishedDate: cleanText(publishedDate),
    sha256: crypto.createHash('sha256').update(rawHashInput).digest('hex'),
    blocks,
    ...(pageCount ? { pageCount } : {}),
  };
}

function blocksFromDom(root, documentUrl) {
  if (!root) return [];
  const blocks = [];
  let blockIndex = 0;
  let referencesStarted = false;
  const selector = [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'li',
    'figure', 'table', 'pre', 'img', '.ltx_equationgroup', '.ltx_equation',
    'math[display="block"]', '.ltx_bibitem',
  ].join(',');
  for (const node of root.querySelectorAll(selector)) {
    if (node.closest(EXCLUDED_CONTENT_SELECTOR)) continue;
    if (node.matches('img') && node.closest('figure')) continue;
    if (node.matches('.ltx_equation,math') && node.parentElement?.closest('.ltx_equation,.ltx_equationgroup')) continue;
    if (node.matches('.ltx_bibitem') && node.parentElement?.closest('.ltx_bibitem')) continue;
    if (!node.matches('figure,table,pre,.ltx_equationgroup,.ltx_equation,math[display="block"],.ltx_bibitem')
      && node.closest('figure,table,pre,.ltx_equationgroup,.ltx_equation,.ltx_bibitem')) continue;
    if (node.tagName === 'P' && node.closest('blockquote,li')) continue;
    if (node.tagName === 'BLOCKQUOTE' && node.closest('li')) continue;
    const id = `b${String(++blockIndex).padStart(6, '0')}`;

    if (node.matches('figure,img')) {
      const figure = figureFromNode(node, documentUrl);
      if (!figure.images.length) {
        blockIndex -= 1;
        continue;
      }
      blocks.push({ id, order: blocks.length, type: 'figure', ...figure });
      continue;
    }
    if (node.matches('table')) {
      const table = tableFromNode(node, documentUrl);
      if (!table.rows.length) {
        blockIndex -= 1;
        continue;
      }
      blocks.push({ id, order: blocks.length, type: 'table', ...table });
      continue;
    }
    if (node.matches('pre')) {
      const code = String(node.textContent || '').replace(/^\n+|\n+$/g, '');
      if (!code) {
        blockIndex -= 1;
        continue;
      }
      blocks.push({ id, order: blocks.length, type: 'code', text: code });
      continue;
    }
    if (node.matches('.ltx_equationgroup,.ltx_equation,math[display="block"]')) {
      const tex = mathTex(node);
      if (!tex) {
        blockIndex -= 1;
        continue;
      }
      blocks.push({ id, order: blocks.length, type: 'equation', tex });
      continue;
    }
    if (node.matches('.ltx_bibitem')) {
      const rich = richTextFromNode(node, documentUrl);
      if (!rich.text) {
        blockIndex -= 1;
        continue;
      }
      blocks.push({ id, order: blocks.length, type: 'reference', text: rich.text, fragments: rich.fragments });
      continue;
    }

    const rich = richTextFromNode(node, documentUrl);
    const text = rich.text;
    if (!text) {
      blockIndex -= 1;
      continue;
    }
    if (/^H[1-6]$/.test(node.tagName) && isReferencesHeading(text)) {
      referencesStarted = true;
    }
    let type = referencesStarted ? 'reference' : 'paragraph';
    const block = {};
    if (/^H[1-6]$/.test(node.tagName)) {
      type = 'heading';
      block.level = Number(node.tagName.slice(1));
    } else if (node.tagName === 'BLOCKQUOTE') type = 'quote';
    else if (node.tagName === 'LI') {
      type = 'list_item';
      block.ordered = node.parentElement?.tagName === 'OL';
      let depth = 0;
      for (let parent = node.parentElement?.closest('li'); parent; parent = parent.parentElement?.closest('li')) depth += 1;
      block.depth = depth;
    }
    blocks.push({
      id,
      order: blocks.length,
      type,
      ...block,
      text,
      fragments: rich.fragments,
    });
  }
  return blocks;
}

function richTextFromNode(node, documentUrl) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll(EXCLUDED_CONTENT_SELECTOR).forEach((child) => child.remove());
  if (node.tagName === 'LI') clone.querySelectorAll('ol,ul').forEach((child) => child.remove());
  const fragments = [];
  const protect = (value) => {
    const token = `⟦ZEN_INLINE_${String(fragments.length + 1).padStart(3, '0')}⟧`;
    fragments.push({ token, value });
    return token;
  };
  for (const math of [...clone.querySelectorAll('math,.MathJax,.katex,.ltx_Math')]) {
    const tex = mathTex(math);
    math.replaceWith(clone.ownerDocument.createTextNode(protect(tex ? `$${tex}$` : cleanText(math.textContent))));
  }
  for (const link of [...clone.querySelectorAll('a[href]')]) {
    const label = cleanText(link.textContent);
    let value = label;
    try {
      const resolved = new URL(link.getAttribute('href'), documentUrl);
      if (['http:', 'https:'].includes(resolved.protocol)) value = `[${label || resolved.href}](${resolved.href})`;
    } catch {}
    link.replaceWith(clone.ownerDocument.createTextNode(protect(value)));
  }
  for (const br of [...clone.querySelectorAll('br')]) br.replaceWith(clone.ownerDocument.createTextNode('\n'));
  return { text: cleanTextPreservingLines(clone.textContent), fragments };
}

function figureFromNode(node, documentUrl) {
  const images = node.matches('img') ? [node] : [...node.querySelectorAll('img')];
  const captionNode = node.matches('figure')
    ? node.querySelector('figcaption,.ltx_caption,[class*="caption"]')
    : undefined;
  const caption = captionNode ? richTextFromNode(captionNode, documentUrl) : { text: '', fragments: [] };
  return {
    images: images.map((image) => ({
      src: resolveAssetUrl(image.getAttribute('src') || image.getAttribute('data-src'), documentUrl),
      alt: cleanText(image.getAttribute('alt') || ''),
    })).filter((image) => image.src),
    caption: caption.text,
    captionFragments: caption.fragments,
  };
}

function tableFromNode(node, documentUrl) {
  const captionNode = node.querySelector('caption') || node.closest('figure')?.querySelector('figcaption,.ltx_caption');
  const caption = captionNode ? richTextFromNode(captionNode, documentUrl) : { text: '', fragments: [] };
  const rows = [];
  const pendingRowspans = new Map();
  for (const row of node.querySelectorAll('tr')) {
    const cells = [];
    let column = 0;
    const placePending = () => {
      while (pendingRowspans.has(column)) {
        const pending = pendingRowspans.get(column);
        cells[column] = { text: pending.text, fragments: structuredClone(pending.fragments || []) };
        pending.remaining -= 1;
        if (pending.remaining <= 0) pendingRowspans.delete(column);
        column += 1;
      }
    };
    placePending();
    for (const cell of row.querySelectorAll(':scope > th,:scope > td')) {
      placePending();
      const rich = richTextFromNode(cell, documentUrl);
      const colspan = clamp(cell.getAttribute('colspan') || 1, 1, 50);
      const rowspan = clamp(cell.getAttribute('rowspan') || 1, 1, 200);
      for (let span = 0; span < colspan; span += 1) {
        const value = span === 0 ? rich : { text: '', fragments: [] };
        cells[column] = { text: value.text, fragments: value.fragments };
        if (rowspan > 1) {
          pendingRowspans.set(column, {
            text: value.text,
            fragments: structuredClone(value.fragments || []),
            remaining: rowspan - 1,
          });
        }
        column += 1;
      }
    }
    placePending();
    if (cells.some((cell) => cell?.text)) rows.push(cells.map((cell) => cell || { text: '', fragments: [] }));
  }
  const width = Math.max(0, ...rows.map((row) => row.length));
  for (const row of rows) while (row.length < width) row.push({ text: '', fragments: [] });
  return {
    caption: caption.text,
    captionFragments: caption.fragments,
    rows,
    sourceHtml: node.outerHTML,
  };
}

function mathTex(node) {
  const math = node.matches?.('math') ? node : node.querySelector?.('math');
  return cleanMath(
    math?.getAttribute('alttext')
      || math?.querySelector?.('annotation[encoding*="tex" i]')?.textContent
      || node.getAttribute?.('data-tex')
      || node.getAttribute?.('aria-label')
      || math?.textContent
      || node.textContent,
  );
}

function cleanMath(value) {
  return String(value || '').trim()
    .replace(/^\\\(|\\\)$/g, '')
    .replace(/^\\\[|\\\]$/g, '')
    .replace(/^\$\$?|\$\$?$/g, '')
    .trim();
}

function resolveAssetUrl(value, documentUrl) {
  if (!value) return '';
  if (/^data:/i.test(value)) return value;
  try { return new URL(value, documentUrl).toString(); }
  catch { return String(value); }
}

async function localizeFigureAssets(blocks, {
  workDir,
  fetchFn,
  fetchWithRetry,
  config,
  dnsLookup,
  assetMap,
}) {
  const figures = blocks.filter((block) => block.type === 'figure');
  const images = figures.flatMap((block) => block.images || []);
  const limits = limitsFor(config);
  if (images.length > limits.maxAssetCount) {
    throw new Error(`原文图片数量超过上限:${images.length}/${limits.maxAssetCount}`);
  }
  const assetDir = path.join(workDir, 'translation-assets');
  fs.mkdirSync(assetDir, { recursive: true });
  const cache = new Map();
  let totalBytes = 0;

  for (const [index, image] of images.entries()) {
    const mapped = mappedAssetPath(image.src, assetMap);
    if (mapped) {
      const size = fs.statSync(mapped).size;
      totalBytes += size;
      if (totalBytes > limits.maxAssetBytes) {
        throw new Error(`原文图片总量超过上限:${totalBytes}/${limits.maxAssetBytes}`);
      }
      image.localPath = mapped;
      continue;
    }
    if (cache.has(image.src)) {
      image.localPath = cache.get(image.src);
      continue;
    }

    let buffer;
    let contentType = '';
    if (/^data:image\//i.test(image.src)) {
      const decoded = decodeDataImage(image.src);
      buffer = decoded.buffer;
      contentType = decoded.contentType;
    } else {
      const fetched = await safeFetchResource({
        url: image.src,
        fetchFn,
        fetchWithRetry,
        limits,
        dnsLookup,
        accept: 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml;q=0.9,*/*;q=0.1',
        maxBytes: limits.maxSingleAssetBytes,
      });
      buffer = fetched.buffer;
      contentType = fetched.contentType;
    }
    if (buffer.length > limits.maxSingleAssetBytes) {
      throw new Error(`原文单张图片超过上限:${buffer.length}/${limits.maxSingleAssetBytes}`);
    }
    totalBytes += buffer.length;
    if (totalBytes > limits.maxAssetBytes) {
      throw new Error(`原文图片总量超过上限:${totalBytes}/${limits.maxAssetBytes}`);
    }
    const kind = detectImageKind(buffer, contentType);
    if (!kind) throw new Error(`原文图片格式不受支持:${image.src}`);
    const basename = `figure-${String(index + 1).padStart(3, '0')}`;
    let target;
    if (kind.extension === '.svg') {
      target = path.join(assetDir, `${basename}.png`);
      await rasterizeSvg(buffer, target, config);
    } else {
      target = path.join(assetDir, `${basename}${kind.extension}`);
      fs.writeFileSync(target, buffer, { mode: 0o600 });
    }
    image.localPath = target;
    cache.set(image.src, target);
  }
}

async function localizeTableAssets(blocks, {
  workDir,
  config = {},
  signal,
}) {
  const tables = blocks.filter((block) => block.type === 'table');
  if (!tables.length) return;
  const figures = blocks.filter((block) => block.type === 'figure')
    .flatMap((block) => block.images || []);
  const limits = limitsFor(config);
  if (figures.length + tables.length > limits.maxAssetCount) {
    throw new Error(`原文图表数量超过上限:${figures.length + tables.length}/${limits.maxAssetCount}`);
  }
  const rasterize = config.tableRasterizer || rasterizeTableHtml;
  const assetDir = path.join(workDir, 'translation-assets');
  fs.mkdirSync(assetDir, { recursive: true });
  const uniqueFigurePaths = new Set(figures.map((image) => image.localPath).filter(Boolean));
  let totalBytes = [...uniqueFigurePaths].reduce((sum, file) => {
    try { return sum + fs.statSync(file).size; }
    catch { return sum; }
  }, 0);

  for (const [index, table] of tables.entries()) {
    throwIfTaskCancelled(signal);
    const target = path.join(assetDir, `table-${String(index + 1).padStart(3, '0')}.png`);
    await rasterize({
      html: table.sourceHtml || tableHtmlFromRows(table.rows),
      target,
      config,
      signal,
    });
    throwIfTaskCancelled(signal);
    if (!fs.existsSync(target) || fs.statSync(target).size <= 0) {
      throw new Error(`原文表格图片生成失败:${table.id}`);
    }
    const size = fs.statSync(target).size;
    if (size > limits.maxSingleAssetBytes) {
      throw new Error(`原文单个表格图片超过上限:${size}/${limits.maxSingleAssetBytes}`);
    }
    totalBytes += size;
    if (totalBytes > limits.maxAssetBytes) {
      throw new Error(`原文图表总量超过上限:${totalBytes}/${limits.maxAssetBytes}`);
    }
    const kind = detectImageKind(fs.readFileSync(target), 'image/png');
    if (!kind) throw new Error(`原文表格图片格式无效:${table.id}`);
    table.localPath = target;
  }
}

async function rasterizeTableHtml({ html, target, config = {}, signal }) {
  if (config.browserEnabled === false) {
    throw new Error('原文表格转图片需要启用 TRANSLATION_BROWSER_ENABLED');
  }
  let playwright;
  try { playwright = await import('playwright-core'); }
  catch { throw new Error('原文表格转图片需要 playwright-core'); }
  const executablePath = browserExecutable(config);
  if (!executablePath) throw new Error('找不到用于原文表格转图片的 Chrome/Chromium');
  const browser = await playwright.chromium.launch({
    executablePath,
    headless: true,
    args: ['--disable-background-networking', '--disable-default-apps', '--disable-extensions', '--disable-network-service'],
  });
  const abortBrowser = () => { void browser.close().catch(() => {}); };
  signal?.addEventListener('abort', abortBrowser, { once: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      deviceScaleFactor: 2,
      javaScriptEnabled: false,
    });
    const page = await context.newPage();
    await page.route('**/*', (route) => route.abort('blockedbyclient'));
    await page.setContent(`<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#fff}
#zen-table-shell{display:inline-block;box-sizing:border-box;max-width:1560px;padding:20px;background:#fff}
#zen-table-shell table{border-collapse:collapse;table-layout:auto;width:auto;max-width:1520px;color:#263445;background:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",Arial,sans-serif;font-size:22px;line-height:1.45}
#zen-table-shell th,#zen-table-shell td{border:1px solid #d7dce2;padding:10px 14px;vertical-align:middle;text-align:left;white-space:normal;overflow-wrap:normal;word-break:normal}
#zen-table-shell th{font-weight:650;background:#f3f6f8}
#zen-table-shell img{max-width:100%;height:auto}
</style></head><body><div id="zen-table-shell">${String(html || '')}</div></body></html>`, {
      waitUntil: 'domcontentloaded',
      timeout: positive(config.browserTimeoutMs, DEFAULT_LIMITS.browserTimeoutMs),
    });
    throwIfTaskCancelled(signal);
    const table = page.locator('#zen-table-shell table').first();
    if (await table.count() !== 1) throw new Error('原文表格 HTML 缺少 table 元素');
    await page.locator('#zen-table-shell').screenshot({
      path: target,
      type: 'png',
      animations: 'disabled',
      caret: 'hide',
      omitBackground: false,
      timeout: positive(config.browserTimeoutMs, DEFAULT_LIMITS.browserTimeoutMs),
    });
  } catch (error) {
    if (signal?.aborted) throw cancellationErrorFromSignal(signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortBrowser);
    await browser.close().catch(() => {});
  }
}

function browserExecutable(config = {}) {
  const candidates = [
    config.browserExecutablePath,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

function tableHtmlFromRows(rows = []) {
  const body = rows.map((row, rowIndex) => {
    const tag = rowIndex === 0 ? 'th' : 'td';
    return `<tr>${row.map((cell) => `<${tag}>${escapeHtml(cell?.text || '')}</${tag}>`).join('')}</tr>`;
  }).join('');
  return `<table>${body}</table>`;
}

function mappedAssetPath(rawSrc, assetMap) {
  let pathname = '';
  try { pathname = decodeURIComponent(new URL(rawSrc).pathname).replace(/^\/+/, ''); }
  catch { pathname = decodeURIComponent(String(rawSrc || '').split(/[?#]/)[0]).replace(/^\.?\//, ''); }
  const candidates = [pathname, path.basename(pathname), String(rawSrc || '')];
  for (const candidate of candidates) {
    const mapped = assetMap?.[candidate];
    if (mapped && fs.existsSync(mapped) && fs.statSync(mapped).size > 0) return mapped;
  }
  return '';
}

function decodeDataImage(value) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(String(value || ''));
  if (!match) throw new Error('原文内嵌图片不是受支持的 base64 格式');
  return { contentType: match[1].toLowerCase(), buffer: Buffer.from(match[2], 'base64') };
}

function detectImageKind(buffer, contentType) {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: '.png', contentType: 'image/png' };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { extension: '.jpg', contentType: 'image/jpeg' };
  if (['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return { extension: '.gif', contentType: 'image/gif' };
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { extension: '.webp', contentType: 'image/webp' };
  }
  const head = buffer.subarray(0, Math.min(buffer.length, 1024)).toString('utf8').trimStart();
  if (/image\/svg\+xml/i.test(contentType) || /^<\?xml[\s\S]*?<svg\b/i.test(head) || /^<svg\b/i.test(head)) {
    return { extension: '.svg', contentType: 'image/svg+xml' };
  }
  return undefined;
}

async function rasterizeSvg(buffer, target, config) {
  let playwright;
  try { playwright = await import('playwright-core'); }
  catch { throw new Error('SVG 图片转 PNG 需要 playwright-core'); }
  const executablePath = config.browserExecutablePath
    || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!fs.existsSync(executablePath)) throw new Error(`找不到 SVG 转换浏览器:${executablePath}`);
  const browser = await playwright.chromium.launch({ executablePath, headless: true, args: ['--disable-network'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
    const dataUrl = `data:image/svg+xml;base64,${buffer.toString('base64')}`;
    await page.setContent(`<style>html,body{margin:0;background:white}img{display:block;max-width:1400px;height:auto}</style><img id="asset" src="${dataUrl}">`);
    await page.locator('#asset').screenshot({ path: target, omitBackground: false });
  } finally {
    await browser.close();
  }
}

function discardExcludedContent(document) {
  document.querySelectorAll(EXCLUDED_CONTENT_SELECTOR).forEach((node) => node.remove());
}

function assertSourceDocumentComplete(document) {
  if (!document.blocks?.length) throw new Error('原文结构化提取结果为空');
  if (document.blocks.some((block) => !DOCUMENT_BLOCK_TYPES.has(block.type))) {
    throw new Error('原文提取结果含未知结构内容');
  }
  const textLength = translationUnits(document).reduce((sum, unit) => sum + unit.text.length, 0);
  const visualBlocks = document.blocks.filter((block) => ['figure', 'table', 'equation'].includes(block.type)).length;
  if (document.sourceType === 'html' && textLength < 120 && visualBlocks === 0) {
    throw new Error(`网页正文过短:${textLength} 字符`);
  }
}

function shouldUseBrowser(document, html) {
  const textLength = translationUnits(document).reduce((sum, unit) => sum + unit.text.length, 0);
  return (textLength < 500 || document.blocks.length < 3)
    && /<(?:script|div)[^>]+id=["'](?:__next|__nuxt|app|root)["']/i.test(html);
}

function isReferencesHeading(text) {
  return /^(?:references|bibliography|works cited|参考文献|引用文献)\s*[:：]?$/i.test(cleanText(text));
}

function isMarkdownTableStart(lines, index) {
  return /^\s*\|.*\|\s*$/.test(lines[index] || '')
    && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || '');
}

function splitMarkdownTableRow(line) {
  const value = String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let current = '';
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function cleanMarkdownText(value) {
  return cleanText(String(value || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`]/g, '')
    .replace(/<[^>]+>/g, ' '));
}

function sourceAttribution(document) {
  const site = (() => { try { return new URL(document.sourceUrl).hostname; } catch { return '未知'; } })();
  return [
    '> **原文信息**',
    `> 原文：《${document.title || '未知标题'}》`,
    `> 作者：${document.author || '未知'}`,
    `> 来源：[${site}](${document.sourceUrl})`,
  ].join('\n');
}

function normalizeTranslatedTitle(value) {
  return cleanText(value)
    .replace(/\s*(?:（\s*译(?:文)?\s*）|\(\s*译(?:文)?\s*\)|【\s*译(?:文)?\s*】|\[\s*译(?:文)?\s*\]|译文|翻译)\s*$/i, '')
    .trim();
}

function restoreFragments(value, fragments = []) {
  let text = String(value || '');
  for (const fragment of fragments || []) text = text.replaceAll(fragment.token, fragment.value);
  return text;
}

function captionLine(label, caption) {
  return `<p style="text-align:center;color:#7b8490;font-size:.78em;line-height:1.55;margin:.35em 0 1.2em">${escapeHtml(label)}：${escapeHtml(caption)}</p>`;
}

function escapeMarkdownAlt(value) {
  return String(value || '').replace(/[[\]\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sameLooseText(left, right) {
  const normalize = (value) => cleanText(value).replace(/[（(]译[）)]$/, '').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
  return normalize(left) === normalize(right);
}

function normalizeComparableText(value) {
  return cleanText(value).replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
}

function isAcademicBodyStart(value) {
  const normalized = normalizeComparableText(value)
    .replace(/^(?:section)?\d+(?:\d+)*/, '');
  return /^(?:abstract|摘要|introduction|引言|executivesummary|执行摘要)$/.test(normalized);
}

export function assertPdfPageLimit(pdfPath, maxPdfPages, spawn = spawnSync) {
  const result = spawn('pdfinfo', [pdfPath], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    killSignal: 'SIGKILL',
  });
  if (result.error?.code === 'ENOENT') throw new Error('PDF 页数校验缺少 Poppler 命令 pdfinfo');
  if (result.error) throw new Error(`PDF 页数检查失败:${safeError(result.error)}`);
  if (result.status !== 0) throw new Error(`PDF 页数检查失败:${String(result.stderr || '').slice(0, 300)}`);
  const pages = Number(/^Pages:\s+(\d+)/mi.exec(result.stdout || '')?.[1] || 0);
  if (!pages) throw new Error('PDF 页数识别失败');
  if (pages > maxPdfPages) throw new Error(`PDF 页数超过上限:${pages}/${maxPdfPages}`);
  return pages;
}

export function assertPdfResponse({
  buffer,
  sourceUrl = '',
  finalUrl = '',
  contentType = '',
}) {
  if (hasPdfSignature(buffer)) return true;
  const sample = Buffer.isBuffer(buffer)
    ? buffer.subarray(0, 4096).toString('utf8')
    : '';
  if (isSlackPrivateFileUrl(sourceUrl || finalUrl)
    && /<!doctype\s+html|<html\b|slack/i.test(sample)) {
    throw new Error(
      'Slack PDF 下载返回了登录页面而不是文件。Slack App 的 Bot Token 缺少 files:read 权限，'
      + '请在 OAuth & Permissions 中添加 files:read、重新安装 App 到工作区，然后重试原任务。',
    );
  }
  const type = String(contentType || '').split(';')[0].trim() || '未知';
  throw new Error(`PDF 下载响应不是有效 PDF（Content-Type: ${type}）`);
}

export function hasPdfSignature(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) return false;
  const searchWindow = buffer.subarray(0, Math.min(buffer.length, 1024));
  return searchWindow.indexOf(Buffer.from('%PDF-')) >= 0;
}

function isSlackPrivateFileUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return /(?:^|\.)slack\.com$/i.test(url.hostname)
      && /\/files-pri\//i.test(url.pathname);
  } catch {
    return false;
  }
}

function runCommand(command, args, { timeout = 30000 } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    killSignal: 'SIGKILL',
  });
  if (result.error?.code === 'ENOENT') throw new Error(`PDF 元数据校验缺少 Poppler 命令 ${command}`);
  if (result.error) throw new Error(`${command} 执行失败:${safeError(result.error)}`);
  if (result.status !== 0) throw new Error(`${command} 执行失败:${String(result.stderr || '').slice(0, 300)}`);
  return String(result.stdout || '');
}

function assertUsableArticleResponse(html, url) {
  const text = cleanText(html).slice(0, 12000);
  if (!text) throw new Error('网页响应为空');
  if (/(?:captcha|verify you are human|checking your browser|access denied|cf-chl-|请输入验证码)/i.test(html)) {
    throw new Error('网页需要验证码或反机器人验证');
  }
  if (/(?:subscribe to continue|sign in to continue|log in to continue|订阅后继续|登录后查看全文)/i.test(text)
    && text.length < 5000) {
    throw new Error('网页正文受登录或付费墙限制');
  }
  if (/\/(?:login|signin)(?:[/?#]|$)/i.test(new URL(url).pathname) && text.length < 5000) {
    throw new Error('原文链接重定向到登录页');
  }
}

function metadata(document, selectors, ...attributes) {
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    if (!node) continue;
    for (const attribute of attributes) {
      const value = node.getAttribute(attribute);
      if (value) return value;
    }
    if (node.textContent?.trim()) return node.textContent.trim();
  }
  return '';
}

function decodeHtmlBuffer(buffer, contentType) {
  const head = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('ascii');
  const declared = /charset\s*=\s*["']?\s*([A-Za-z0-9._-]+)/i.exec(String(contentType || ''))?.[1]
    || /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9._-]+)/i.exec(head)?.[1]
    || 'utf-8';
  try {
    return new TextDecoder(declared, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
}

function parseJsonPayload(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*|\s*```$/gi, '');
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return undefined;
}

function notionPageId(rawUrl) {
  const compact = `${new URL(rawUrl).pathname}${new URL(rawUrl).search}`.replace(/-/g, '');
  const match = compact.match(/[a-f0-9]{32}/i);
  if (!match) return undefined;
  const id = match[0].toLowerCase();
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

function isNotionUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'notion.so' || host.endsWith('.notion.so')
      || host === 'notion.site' || host.endsWith('.notion.site');
  } catch { return false; }
}

function extractInputUrls(text) {
  return (String(text || '').match(/https?:\/\/[^\s<>()，。；：！？】【、】【【】）》〉]+/g) || [])
    .map((url) => url.replace(/[.,;:!?)\]}>，。；：！？】【、】【【】）》〉]+$/, ''));
}

function arxivSourceUrls(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return undefined; }
  if (!['arxiv.org', 'www.arxiv.org'].includes(url.hostname.toLowerCase())) return undefined;
  const match = /^\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5}(?:v\d+)?)(?:\.pdf)?(?:\/|$)/i.exec(url.pathname);
  if (!match) return undefined;
  const id = match[1];
  return {
    id,
    html: `https://arxiv.org/html/${id}`,
    pdf: `https://arxiv.org/pdf/${id}`,
  };
}

function limitsFor(config) {
  return {
    maxSourceBytes: positive(config.maxSourceBytes, DEFAULT_LIMITS.maxSourceBytes),
    maxPdfPages: positive(config.maxPdfPages, DEFAULT_LIMITS.maxPdfPages),
    browserTimeoutMs: positive(config.browserTimeoutMs, DEFAULT_LIMITS.browserTimeoutMs),
    fetchTimeoutMs: positive(config.fetchTimeoutMs, DEFAULT_LIMITS.fetchTimeoutMs),
    maxRedirects: nonNegative(config.maxRedirects, DEFAULT_LIMITS.maxRedirects),
    maxAssetCount: positive(config.maxAssetCount, DEFAULT_LIMITS.maxAssetCount),
    maxAssetBytes: positive(config.maxAssetBytes, DEFAULT_LIMITS.maxAssetBytes),
    maxSingleAssetBytes: positive(config.maxSingleAssetBytes, DEFAULT_LIMITS.maxSingleAssetBytes),
  };
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegative(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTextPreservingLines(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanPdfMeta(value) {
  const text = cleanText(value);
  return /^(?:none|unknown|untitled)$/i.test(text) ? '' : text;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function safeError(error) {
  return String(error?.message || error || '未知错误').slice(0, 300);
}

async function report(onProgress, progress) {
  if (!onProgress) return;
  try { await onProgress(progress); }
  catch (error) { console.error(`[translate] 进度通知失败(已忽略): ${safeError(error)}`); }
}

function writeJsonAtomic(target, value) {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
    fs.renameSync(temporary, target);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}
