import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

const DEFAULT_LIMITS = {
  maxSourceBytes: 12 * 1024 * 1024,
  maxAssetBytes: 20 * 1024 * 1024,
  maxAssets: 80,
  browserTimeoutMs: 45000,
  fetchTimeoutMs: 30000,
  maxRedirects: 5,
};

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'indented',
});

export async function generateStructuredTranslation({
  input,
  workflow,
  writer,
  fetchFn,
  fetchWithRetry,
  completeArticle,
  onProgress,
  translationConfig = {},
  pdfExtractor,
  resumeFromCheckpoint = false,
  textOnly = false,
  highlightKeyPoints = false,
}) {
  const sourceUrl = extractInputUrls(input)[0];
  if (!sourceUrl) throw new Error('直译任务缺少可读取的 http(s) 原文链接');

  await report(onProgress, { stage: 'source', message: '正在抓取并识别完整原文结构', completed: 0, total: 1 });
  let source = await acquireSourceDocument({
    sourceUrl,
    workDir: workflow.workDir,
    fetchFn,
    fetchWithRetry,
    config: translationConfig,
    pdfExtractor,
  });
  if (textOnly) source = textOnlySourceDocument(source);
  source.translationOptions = { highlightKeyPoints };
  const sourceManifest = buildDocumentManifest(source);
  await report(onProgress, {
    stage: 'structure',
    message: `已锁定 ${sourceManifest.blocks} 个内容块、${sourceManifest.assets} 个图片/图表、${sourceManifest.tables} 个表格`,
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
  });
  const article = renderTranslatedDocument(translated);
  const completeness = validateTranslationArtifact({ source, translated, article });
  if (completeness.errors.length) {
    throw new Error(`直译 V2 完整性门禁失败:${completeness.errors.join('; ')}`);
  }
  await report(onProgress, {
    stage: 'validation',
    message: `完整性校验通过：${completeness.blocks} 个内容块、${completeness.assets} 个图片/图表、${completeness.tableCells} 个表格单元格`,
    completed: 1,
    total: 1,
  });

  return {
    article,
    sourceUrl: source.sourceUrl,
    manifest: {
      ...sourceManifest,
      title: source.title,
      author: source.author,
      publishedDate: source.publishedDate,
      sourceUrl: source.sourceUrl,
      sourceType: source.sourceType,
      extractor: source.extractor,
      sha256: source.sha256,
      acquisition: source.acquisition,
    },
    assets: source.assets,
    completeness,
    sourceDocument: source,
    textOnly,
  };
}

export async function acquireSourceDocument({
  sourceUrl,
  workDir,
  fetchFn = globalThis.fetch,
  fetchWithRetry,
  config = {},
  pdfExtractor,
  dnsLookup = dns.lookup,
}) {
  const limits = limitsFor(config);
  await assertSafeHttpUrl(sourceUrl, { dnsLookup });
  fs.mkdirSync(workDir, { recursive: true });
  const assetDir = path.join(workDir, 'assets');
  fs.mkdirSync(assetDir, { recursive: true });
  cleanSourceAssets(assetDir);

  const acquisition = { attempts: [], fallbacks: [] };
  if (isNotionUrl(sourceUrl) && config.notionApiToken) {
    acquisition.attempts.push('notion-markdown-api');
    try {
      const notion = await fetchNotionMarkdown({
        sourceUrl,
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
        workDir,
        assetDir,
        fetchFn,
        fetchWithRetry,
        limits,
        dnsLookup,
        extractor: 'notion-markdown-api',
      });
      document.acquisition = acquisition;
      return document;
    } catch (error) {
      acquisition.fallbacks.push(`notion-api:${safeError(error)}`);
    }
  }

  acquisition.attempts.push('static-http');
  let fetched;
  try {
    fetched = await safeFetchResource({
      url: sourceUrl,
      fetchFn,
      fetchWithRetry,
      limits,
      dnsLookup,
      accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5',
    });
  } catch (error) {
    if (config.browserEnabled === false || /\.pdf(?:$|[?#])/i.test(sourceUrl)) throw error;
    acquisition.fallbacks.push(`browser:静态请求失败:${safeError(error)}`);
    acquisition.attempts.push('playwright');
    const rendered = await renderWithBrowser({ sourceUrl, config, limits, dnsLookup });
    assertUsableArticleResponse(rendered.html, rendered.finalUrl);
    const document = await sourceDocumentFromHtml({
      html: rendered.html,
      sourceUrl: rendered.finalUrl,
      workDir,
      assetDir,
      fetchFn,
      fetchWithRetry,
      limits,
      dnsLookup,
      extractor: 'readability-playwright',
      browserCaptures: rendered.captures,
      localizeAssets: true,
    });
    document.acquisition = acquisition;
    assertSourceDocumentComplete(document);
    return document;
  }
  const contentType = String(fetched.contentType || '').toLowerCase();
  const isPdf = contentType.includes('application/pdf')
    || /\.pdf(?:$|[?#])/i.test(fetched.finalUrl)
    || fetched.buffer.subarray(0, 4).toString() === '%PDF';

  if (isPdf) {
    acquisition.attempts.push('pdf');
    const document = await sourceDocumentFromPdf({
      pdfBuffer: fetched.buffer,
      sourceUrl: fetched.finalUrl,
      workDir,
      config,
      pdfExtractor,
      fetchFn,
      fetchWithRetry,
      limits,
      dnsLookup,
      acquisition,
    });
    document.acquisition = acquisition;
    return document;
  }

  const html = decodeHtmlBuffer(fetched.buffer, fetched.contentType);
  assertUsableArticleResponse(html, fetched.finalUrl);
  let inspection = await sourceDocumentFromHtml({
    html,
    sourceUrl: fetched.finalUrl,
    workDir,
    assetDir,
    fetchFn,
    fetchWithRetry,
    limits,
    dnsLookup,
    extractor: 'readability-static',
    localizeAssets: false,
  });
  const browserReasons = browserFallbackReasons({ html, document: inspection });
  const browserAllowed = config.browserEnabled !== false;
  if (!browserAllowed && browserReasons.some((reason) => reason.includes('图表'))) {
    throw new Error('原文含 SVG/Canvas 图表，但浏览器抓取已关闭，无法生成可验证的原位 PNG');
  }
  if (browserReasons.length && browserAllowed) {
    acquisition.fallbacks.push(...browserReasons.map((reason) => `browser:${reason}`));
    acquisition.attempts.push('playwright');
    const rendered = await renderWithBrowser({
      sourceUrl: fetched.finalUrl,
      config,
      limits,
      dnsLookup,
    });
    assertUsableArticleResponse(rendered.html, rendered.finalUrl);
    inspection = await sourceDocumentFromHtml({
      html: rendered.html,
      sourceUrl: rendered.finalUrl,
      workDir,
      assetDir,
      fetchFn,
      fetchWithRetry,
      limits,
      dnsLookup,
      extractor: 'readability-playwright',
      browserCaptures: rendered.captures,
      localizeAssets: true,
    });
  } else {
    inspection = await sourceDocumentFromHtml({
      html,
      sourceUrl: fetched.finalUrl,
      workDir,
      assetDir,
      fetchFn,
      fetchWithRetry,
      limits,
      dnsLookup,
      extractor: 'readability-static',
      localizeAssets: true,
    });
  }
  inspection.acquisition = acquisition;
  assertSourceDocumentComplete(inspection);
  return inspection;
}

export async function sourceDocumentFromHtml({
  html,
  sourceUrl,
  workDir,
  assetDir = path.join(workDir, 'assets'),
  fetchFn = globalThis.fetch,
  fetchWithRetry,
  limits = DEFAULT_LIMITS,
  dnsLookup = dns.lookup,
  extractor = 'readability-static',
  browserCaptures = new Map(),
  localizeAssets = true,
}) {
  fs.mkdirSync(assetDir, { recursive: true });
  const original = new JSDOM(html, { url: sourceUrl });
  const originalDocument = original.window.document;
  removeNoise(originalDocument);
  normalizeMath(originalDocument);
  const fallbackRoot = originalDocument.querySelector(
    '[itemprop="articleBody"],article,[role="main"],main',
  ) || originalDocument.body;
  const fallbackTextLength = cleanText(fallbackRoot?.textContent).length;

  let readable;
  try {
    const cloned = new JSDOM(original.serialize(), { url: sourceUrl });
    readable = new Readability(cloned.window.document, {
      charThreshold: 200,
      keepClasses: true,
    }).parse();
  } catch {}

  const readableLength = cleanText(readable?.textContent).length;
  // Browser pass injects stable capture IDs/currentSrc into the real article DOM. Readability
  // may sanitize those attributes, so rendered pages retain the selected article/main subtree.
  const useReadable = !browserCaptures.size && readable?.content
    && readableLength >= 300
    && readableLength >= Math.min(1200, Math.floor(fallbackTextLength * 0.35));
  const rootHtml = useReadable ? readable.content : fallbackRoot?.innerHTML;
  if (!rootHtml) throw new Error('网页正文提取为空');

  const dom = new JSDOM(`<main data-zen-source-root="true">${rootHtml}</main>`, { url: sourceUrl });
  const document = dom.window.document;
  removeNoise(document);
  const state = {
    blocks: [],
    assets: [],
    blockIndex: 0,
    assetIndex: 0,
    sourceUrl,
    assetDir,
    fetchFn,
    fetchWithRetry,
    limits,
    dnsLookup,
    browserCaptures,
    localizeAssets,
  };
  await walkContainer(document.querySelector('[data-zen-source-root]'), state, { listDepth: 0 });
  const blocks = state.blocks.filter((block) => blockHasContent(block));
  if (!blocks.length) throw new Error('网页正文结构化结果为空');

  const title = readable?.title
    || metadata(originalDocument, ['meta[property="og:title"]', 'meta[name="twitter:title"]'], 'content')
    || cleanText(originalDocument.querySelector('h1')?.textContent)
    || originalDocument.title
    || new URL(sourceUrl).hostname;
  const author = readable?.byline
    || metadata(originalDocument, ['meta[name="author"]', 'meta[property="article:author"]'], 'content');
  const publishedDate = readable?.publishedTime
    || metadata(originalDocument, [
      'meta[property="article:published_time"]',
      'meta[name="date"]',
      'time[datetime]',
    ], 'content', 'datetime');
  if (!blocks.some((block) => block.type === 'heading' && block.level === 1) && cleanText(title)) {
    blocks.unshift({ id: 'b000000', order: 0, type: 'heading', level: 1, text: cleanText(title) });
    blocks.forEach((block, index) => { block.order = index; });
  }
  const sha256 = crypto.createHash('sha256').update(html).digest('hex');
  return {
    version: 2,
    sourceType: 'html',
    extractor,
    sourceUrl,
    title: cleanText(title),
    author: cleanText(author),
    publishedDate: cleanText(publishedDate),
    sha256,
    blocks,
    assets: state.assets,
  };
}

export async function sourceDocumentFromMarkdown({
  markdown,
  sourceUrl,
  title,
  author,
  publishedDate,
  workDir,
  assetDir = path.join(workDir, 'assets'),
  fetchFn = globalThis.fetch,
  fetchWithRetry,
  limits = DEFAULT_LIMITS,
  dnsLookup = dns.lookup,
  extractor = 'notion-markdown-api',
  localAssetBase,
}) {
  fs.mkdirSync(assetDir, { recursive: true });
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  const state = {
    blocks: [],
    assets: [],
    blockIndex: 0,
    assetIndex: 0,
    sourceUrl,
    assetDir,
    fetchFn,
    fetchWithRetry,
    limits,
    dnsLookup,
    localizeAssets: true,
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      pushBlock(state, { type: 'heading', level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }
    const image = /^!\[([^\]]*)\]\((.+?)\)\s*$/.exec(line.trim());
    if (image) {
      const asset = await localizeMarkdownAsset({
        rawUrl: image[2],
        alt: image[1],
        state,
        localAssetBase,
      });
      pushBlock(state, { type: 'image', assetId: asset?.id, alt: image[1], sourceUrl: image[2] });
      index += 1;
      continue;
    }
    if (/^```/.test(line.trim())) {
      const language = line.trim().slice(3).trim();
      const code = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index].trim())) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      pushBlock(state, { type: 'code', language, text: code.join('\n') });
      continue;
    }
    if (isMarkdownTableStart(lines, index)) {
      const tableLines = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) tableLines.push(lines[index++]);
      pushBlock(state, markdownTableBlock(tableLines, nextBlockId(state)));
      continue;
    }
    const list = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (list) {
      pushBlock(state, {
        type: 'list_item',
        depth: Math.floor(list[1].replace(/\t/g, '  ').length / 2),
        ordered: /^\d/.test(list[2]),
        text: list[3].trim(),
      });
      index += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ''));
      pushBlock(state, { type: 'quote', text: quote.join('\n').trim() });
      continue;
    }
    if (/^\[\^[^\]]+\]:/.test(line)) {
      pushBlock(state, { type: 'footnote', text: line.trim() });
      index += 1;
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !markdownSpecialLine(lines, index)) {
      paragraph.push(lines[index++].trim());
    }
    pushBlock(state, { type: 'paragraph', text: paragraph.join(' ') });
  }

  const firstHeading = state.blocks.find((block) => block.type === 'heading');
  const sha256 = crypto.createHash('sha256').update(String(markdown || '')).digest('hex');
  const document = {
    version: 2,
    sourceType: extractor.startsWith('docling') ? 'pdf' : 'notion',
    extractor,
    sourceUrl,
    title: cleanText(title || firstHeading?.text || new URL(sourceUrl).hostname),
    author: cleanText(author),
    publishedDate: cleanText(publishedDate),
    sha256,
    blocks: state.blocks,
    assets: state.assets,
  };
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
}) {
  const units = translationUnits(source);
  if (!units.length) throw new Error('原文没有可翻译文本块');
  const checkpointPath = path.join(workDir, 'translation-v2-checkpoint.json');
  const checkpointKey = crypto.createHash('sha256')
    .update(JSON.stringify({
      version: 2,
      source: source.sha256,
      model,
      units,
      translationOptions: source.translationOptions || {},
    }))
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

  const batches = batchUnits(units.filter((unit) => !completed.has(unit.id)), 14000, 36);
  await report(onProgress, {
    stage: 'translation',
    message: completed.size
      ? `从结构化断点继续翻译 ${completed.size}/${units.length}`
      : `开始按内容块翻译，共 ${units.length} 个文本单元`,
    completed: completed.size,
    total: units.length,
  });
  for (const batch of batches) {
    let translations = await requestTranslationBatch({
      batch,
      source,
      model,
      writer,
      fetchFn,
      completeArticle,
      timeoutMs,
    });
    const invalid = validateBatchTranslations(batch, translations);
    if (invalid.length) {
      const repaired = [];
      for (const unit of invalid) {
        const one = await requestTranslationBatch({
          batch: [unit],
          source,
          model,
          writer,
          fetchFn,
          completeArticle,
          timeoutMs,
          repair: true,
        });
        repaired.push(...one);
      }
      const repairedById = new Map(repaired.filter(Boolean).map((item) => [item.id, item]));
      const originalById = new Map(translations.map((item) => [item.id, item]));
      translations = batch
        .map((unit) => repairedById.get(unit.id) || originalById.get(unit.id))
        .filter(Boolean);
    }
    const stillInvalid = validateBatchTranslations(batch, translations);
    if (stillInvalid.length) {
      const returned = new Map(translations.map((item) => [item.id, item.text]));
      fs.writeFileSync(path.join(workDir, 'translation-v2-invalid.json'), JSON.stringify({
        failedAt: new Date().toISOString(),
        units: stillInvalid.map((unit) => ({
          id: unit.id,
          source: unit.text,
          returned: returned.get(unit.id) || '',
          sourceNumbers: invariantNumbers(unit.text),
          returnedNumbers: invariantNumbers(returned.get(unit.id) || ''),
        })),
      }, null, 2));
      throw new Error(`结构化翻译校验失败:${stillInvalid.map((unit) => unit.id).join(',')}`);
    }
    for (const item of translations) completed.set(item.id, item.text.trim());
    fs.writeFileSync(checkpointPath, JSON.stringify({
      version: 2,
      key: checkpointKey,
      translations: [...completed].map(([id, text]) => ({ id, text })),
      updatedAt: new Date().toISOString(),
    }, null, 2));
    await report(onProgress, {
      stage: 'translation',
      message: `结构化翻译进度 ${completed.size}/${units.length}`,
      completed: completed.size,
      total: units.length,
    });
  }
  if (completed.size !== units.length) throw new Error(`结构化翻译缺块:${completed.size}/${units.length}`);
  return applyTranslations(source, completed);
}

export function renderTranslatedDocument(document) {
  const lines = [
    '---',
    `title: ${JSON.stringify(document.translatedTitle || document.title || '原文直译')}`,
    '---',
    '',
    sourceAttribution(document),
    '',
  ];
  for (const block of document.blocks) {
    const text = block.translatedText ?? block.text ?? '';
    if (block.type === 'heading') lines.push(`${'#'.repeat(clamp(block.level || 2, 1, 6))} ${text}`, '');
    else if (block.type === 'paragraph' || block.type === 'caption' || block.type === 'footnote') lines.push(text, '');
    else if (block.type === 'quote') lines.push(...String(text).split('\n').map((line) => `> ${line}`), '');
    else if (block.type === 'list_item') {
      const marker = block.ordered ? '1.' : '-';
      lines.push(`${'　'.repeat(block.depth || 0)}${marker} ${text}`, '');
    } else if (block.type === 'image') {
      const asset = document.assets.find((item) => item.id === block.assetId);
      if (asset?.relative) lines.push(`![${block.translatedAlt || block.alt || '原文图片'}](${asset.relative})`, '');
    } else if (block.type === 'table') {
      lines.push(renderTable(block), '');
    } else if (block.type === 'code') {
      lines.push(`<pre><code>${escapeHtml(block.text || '')}</code></pre>`, '');
    } else if (block.type === 'formula') {
      lines.push(block.text || '', '');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function validateTranslationArtifact({ source, translated, article }) {
  const errors = [];
  const sourceIds = source.blocks.map((block) => block.id);
  const translatedIds = translated.blocks.map((block) => block.id);
  if (sourceIds.join('|') !== translatedIds.join('|')) errors.push('内容块 ID 或顺序发生变化');
  if (source.assets.length !== translated.assets.length) errors.push('图片/图表数量发生变化');

  let tableCells = 0;
  for (const sourceBlock of source.blocks.filter((block) => block.type === 'table')) {
    const target = translated.blocks.find((block) => block.id === sourceBlock.id);
    if (!target) { errors.push(`缺少表格:${sourceBlock.id}`); continue; }
    if (sourceBlock.grid.length !== target.grid.length
      || sourceBlock.grid.some((row, index) => row.length !== target.grid[index]?.length)) {
      errors.push(`表格尺寸发生变化:${sourceBlock.id}`);
    }
    if (sourceBlock.cells.length !== target.cells.length) errors.push(`表格单元格发生变化:${sourceBlock.id}`);
    tableCells += sourceBlock.cells.length;
  }

  let lastAssetIndex = -1;
  for (const asset of translated.assets) {
    if (!asset.relative || !asset.path || !fs.existsSync(asset.path) || fs.statSync(asset.path).size <= 0) {
      errors.push(`图片素材不可用:${asset.id}`);
      continue;
    }
    const actualHash = sha256File(asset.path);
    if (asset.sha256 && actualHash !== asset.sha256) errors.push(`图片哈希不匹配:${asset.id}`);
    const markdownIndex = String(article).indexOf(`](${asset.relative})`);
    if (markdownIndex < 0) errors.push(`译文缺少图片:${asset.id}`);
    else if (markdownIndex < lastAssetIndex) errors.push(`图片顺序发生变化:${asset.id}`);
    lastAssetIndex = Math.max(lastAssetIndex, markdownIndex);
  }

  for (const unit of translationUnits(source)) {
    const targetText = translatedUnitText(translated, unit.id);
    if (!targetText?.trim()) errors.push(`译文为空:${unit.id}`);
    else if (!sameInvariantTokens(unit.text, targetText)) errors.push(`数字/链接/标记不一致:${unit.id}`);
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(article)) errors.push('译文含控制字符');
  if (/source-page-\d+\.(?:png|jpe?g|webp)/i.test(article)) errors.push('译文含禁止的 PDF 整页截图');
  return {
    errors,
    blocks: source.blocks.length,
    assets: source.assets.length,
    tables: source.blocks.filter((block) => block.type === 'table').length,
    tableCells,
    headings: source.blocks.filter((block) => block.type === 'heading').length,
    paragraphs: source.blocks.filter((block) => ['paragraph', 'quote', 'list_item'].includes(block.type)).length,
    sourceCharacters: translationUnits(source).reduce((sum, unit) => sum + unit.text.length, 0),
  };
}

export function buildDocumentManifest(document) {
  return {
    version: document.version,
    blocks: document.blocks.length,
    assets: document.assets.length,
    tables: document.blocks.filter((block) => block.type === 'table').length,
    tableCells: document.blocks
      .filter((block) => block.type === 'table')
      .reduce((sum, block) => sum + block.cells.length, 0),
    headings: document.blocks.filter((block) => block.type === 'heading').length,
    paragraphs: document.blocks.filter((block) => ['paragraph', 'quote', 'list_item'].includes(block.type)).length,
    footnotes: document.blocks.filter((block) => block.type === 'footnote').length,
    blockOrder: document.blocks.map((block) => `${block.id}:${block.type}`),
    assetOrder: document.assets.map((asset) => `${asset.id}:${asset.sha256}`),
  };
}

export async function assertSafeHttpUrl(rawUrl, { dnsLookup = dns.lookup } = {}) {
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
    return url;
  }
  let records;
  try { records = await dnsLookup(host, { all: true, verbatim: true }); }
  catch (error) { throw new Error(`原文域名解析失败:${safeError(error)}`); }
  if (!records?.length || records.some((record) => isPrivateIp(record.address))) {
    throw new Error('原文域名解析到私网或保留地址');
  }
  return url;
}

export function isPrivateIp(address) {
  const value = String(address || '').toLowerCase();
  if (net.isIPv4(value)) {
    const [a, b] = value.split('.').map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)
      || a >= 224;
  }
  if (net.isIPv6(value)) {
    if (value === '::' || value === '::1') return true;
    if (value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value)) return true;
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)?.[1];
    return mapped ? isPrivateIp(mapped) : false;
  }
  return true;
}

async function sourceDocumentFromPdf({
  pdfBuffer,
  sourceUrl,
  workDir,
  config,
  pdfExtractor,
  fetchFn,
  fetchWithRetry,
  limits,
  dnsLookup,
  acquisition,
}) {
  const pdfPath = path.join(workDir, 'translation-source.pdf');
  fs.writeFileSync(pdfPath, pdfBuffer);
  if (config.doclingPath) {
    acquisition.attempts.push('docling');
    try {
      const doclingDir = path.join(workDir, 'docling-v2');
      fs.rmSync(doclingDir, { recursive: true, force: true });
      fs.mkdirSync(doclingDir, { recursive: true });
      const result = spawnSync(config.doclingPath, [
        pdfPath,
        '--to', 'md',
        '--image-export-mode', 'referenced',
        '--output', doclingDir,
      ], { encoding: 'utf8', timeout: config.doclingTimeoutMs || 180000, maxBuffer: 8 * 1024 * 1024 });
      if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || 'Docling 执行失败').slice(0, 400));
      const markdownPath = findFirstFile(doclingDir, /\.md$/i);
      if (!markdownPath) throw new Error('Docling 未生成 Markdown');
      return await sourceDocumentFromMarkdown({
        markdown: fs.readFileSync(markdownPath, 'utf8'),
        sourceUrl,
        title: path.basename(new URL(sourceUrl).pathname, '.pdf'),
        workDir,
        fetchFn,
        fetchWithRetry,
        limits,
        dnsLookup,
        extractor: 'docling-pdf',
        localAssetBase: path.dirname(markdownPath),
      });
    } catch (error) {
      acquisition.fallbacks.push(`docling:${safeError(error)}`);
    }
  }
  if (!pdfExtractor) throw new Error('PDF V2 缺少可用的 PDF 提取器');
  acquisition.attempts.push('poppler');
  const legacy = pdfExtractor({ pdfBuffer, sourceUrl, workDir });
  if (legacy.manifest?.visualSummaries?.length) {
    throw new Error(`PDF 有 ${legacy.manifest.visualSummaries.length} 个图表无法可靠提取，拒绝发布不完整译文`);
  }
  const blocks = [];
  let blockIndex = 0;
  const assets = (legacy.pageAssets || []).map((asset, index) => ({
    id: `a${String(index + 1).padStart(4, '0')}`,
    kind: asset.kind || 'image',
    originalUrl: sourceUrl,
    relative: asset.relative,
    path: asset.path || path.join(workDir, asset.relative),
    mime: mimeFromExtension(asset.relative),
    sha256: sha256File(asset.path || path.join(workDir, asset.relative)),
    width: null,
    height: null,
    alt: `原文图 ${asset.label || index + 1}`,
  }));
  for (const raw of legacy.blocks || []) {
    const pieces = String(raw).split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
    for (const piece of pieces) {
      const marker = /<!--\s*source-asset:([^-]+)-(\d+)\s*-->/.exec(piece);
      if (marker) {
        const legacyAsset = legacy.pageAssets?.find((asset) => asset.kind === marker[1] && Number(asset.label) === Number(marker[2]));
        const assetIndex = legacyAsset ? legacy.pageAssets.indexOf(legacyAsset) : -1;
        if (assetIndex >= 0) blocks.push({
          id: `b${String(++blockIndex).padStart(6, '0')}`,
          order: blocks.length,
          type: 'image',
          assetId: assets[assetIndex].id,
          alt: assets[assetIndex].alt,
        });
        const remainder = piece.replace(marker[0], '').trim();
        if (remainder) blocks.push({
          id: `b${String(++blockIndex).padStart(6, '0')}`,
          order: blocks.length,
          type: 'paragraph',
          text: remainder,
        });
      } else {
        blocks.push({
          id: `b${String(++blockIndex).padStart(6, '0')}`,
          order: blocks.length,
          type: /<!--\s*source-page:\d+\s*-->/.test(piece) ? 'paragraph' : 'paragraph',
          text: piece,
        });
      }
    }
  }
  const document = {
    version: 2,
    sourceType: 'pdf',
    extractor: 'poppler-structured',
    sourceUrl,
    title: legacy.title,
    author: legacy.author,
    publishedDate: legacy.publishedDate,
    sha256: legacy.manifest?.sha256 || crypto.createHash('sha256').update(pdfBuffer).digest('hex'),
    blocks,
    assets,
  };
  assertSourceDocumentComplete(document);
  return document;
}

async function safeFetchResource({
  url,
  fetchFn,
  fetchWithRetry,
  limits,
  dnsLookup,
  accept,
  maxBytes = limits.maxSourceBytes,
}) {
  let current = url;
  for (let redirects = 0; redirects <= limits.maxRedirects; redirects += 1) {
    await assertSafeHttpUrl(current, { dnsLookup });
    const response = await callFetch(fetchWithRetry, fetchFn, current, {
      redirect: 'manual',
      headers: {
        Accept: accept || '*/*',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36 ZenTranslationBot/2.0',
      },
    }, limits.fetchTimeoutMs);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`原文重定向缺少 Location:${response.status}`);
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) throw new Error(`原文获取失败:${response.status} ${response.statusText}`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new Error(`原文响应超过大小上限:${declared}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('原文响应为空');
    if (buffer.length > maxBytes) throw new Error(`原文响应超过大小上限:${buffer.length}`);
    return {
      finalUrl: current,
      contentType: response.headers.get('content-type') || '',
      buffer,
      status: response.status,
    };
  }
  throw new Error(`原文重定向超过 ${limits.maxRedirects} 次`);
}

async function callFetch(fetchWithRetry, fetchFn, url, options, timeoutMs) {
  if (fetchWithRetry) return fetchWithRetry(fetchFn, url, options, { timeoutMs, retries: 1 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetchFn(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function renderWithBrowser({ sourceUrl, config, limits, dnsLookup }) {
  await assertSafeHttpUrl(sourceUrl, { dnsLookup });
  let playwright;
  try { playwright = await import('playwright-core'); }
  catch { throw new Error('动态网页需要 playwright-core'); }
  const executablePath = config.browserExecutablePath
    || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!fs.existsSync(executablePath)) throw new Error(`找不到浏览器:${executablePath}`);
  const browser = await playwright.chromium.launch({
    executablePath,
    headless: true,
    args: ['--disable-background-networking', '--disable-default-apps', '--disable-extensions'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(limits.browserTimeoutMs);
    const safeHosts = new Map();
    await page.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      let parsed;
      try { parsed = new URL(requestUrl); } catch { await route.abort('blockedbyclient'); return; }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        if (['data:', 'blob:'].includes(parsed.protocol)) await route.continue();
        else await route.abort('blockedbyclient');
        return;
      }
      const key = `${parsed.protocol}//${parsed.hostname}`;
      try {
        if (!safeHosts.has(key)) safeHosts.set(key, assertSafeHttpUrl(requestUrl, { dnsLookup }));
        await safeHosts.get(key);
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });
    await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: limits.browserTimeoutMs });
    try { await page.waitForLoadState('networkidle', { timeout: Math.min(15000, limits.browserTimeoutMs) }); } catch {}
    await page.evaluate(async () => {
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      let previous = -1;
      for (let i = 0; i < 30; i += 1) {
        const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        window.scrollTo(0, Math.min(height, i * Math.max(700, window.innerHeight * 0.8)));
        await delay(120);
        if (height === previous && window.scrollY + window.innerHeight >= height - 4) break;
        previous = height;
      }
      window.scrollTo(0, 0);
      let index = 0;
      for (const node of document.querySelectorAll('img,svg,canvas,iframe')) {
        node.setAttribute('data-zen-capture-id', `capture-${++index}`);
        if (node.tagName === 'IMG' && node.currentSrc) node.setAttribute('data-zen-current-src', node.currentSrc);
      }
    });
    const captures = new Map();
    const ids = await page.locator('[data-zen-capture-id]').evaluateAll((nodes) => nodes.map((node) => ({
      id: node.getAttribute('data-zen-capture-id'),
      tag: node.tagName.toLowerCase(),
      width: Math.round(node.getBoundingClientRect().width),
      height: Math.round(node.getBoundingClientRect().height),
    })));
    for (const item of ids.slice(0, limits.maxAssets)) {
      if (item.width < 16 || item.height < 16) continue;
      try {
        const buffer = await page.locator(`[data-zen-capture-id="${item.id}"]`).screenshot({
          type: 'png',
          animations: 'disabled',
          timeout: Math.min(12000, limits.browserTimeoutMs),
        });
        captures.set(item.id, { buffer, mime: 'image/png', width: item.width, height: item.height, tag: item.tag });
      } catch {}
    }
    const finalUrl = page.url();
    await assertSafeHttpUrl(finalUrl, { dnsLookup });
    return { html: await page.content(), finalUrl, captures };
  } finally {
    await browser.close();
  }
}

async function fetchNotionMarkdown({ sourceUrl, token, fetchFn, fetchWithRetry, timeoutMs }) {
  const pageId = notionPageId(sourceUrl);
  if (!pageId) throw new Error('无法从 Notion 链接识别 page_id');
  const response = await callFetch(fetchWithRetry, fetchFn, `https://api.notion.com/v1/pages/${pageId}/markdown`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': '2026-03-11',
      Accept: 'application/json',
    },
  }, timeoutMs);
  if (!response.ok) throw new Error(`Notion API 获取失败:${response.status} ${response.statusText}`);
  const data = await response.json();
  if (data.truncated === true || (Array.isArray(data.unknown_block_ids) && data.unknown_block_ids.length)) {
    throw new Error('Notion API 返回截断或含无法表示的内容块');
  }
  const markdown = data.markdown || data.content || data.page_markdown;
  if (!markdown) throw new Error('Notion API 未返回页面 Markdown');
  return {
    markdown,
    title: data.title,
    author: data.author,
    publishedDate: data.last_edited_time,
  };
}

async function walkContainer(container, state, context) {
  for (const node of [...(container?.childNodes || [])]) {
    if (node.nodeType === 3) {
      const text = cleanText(node.textContent);
      if (text) pushBlock(state, { type: 'paragraph', text });
      continue;
    }
    if (node.nodeType !== 1) continue;
    const tag = node.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      pushBlock(state, { type: 'heading', level: Number(tag[1]), text: inlineMarkdown(node) });
    } else if (tag === 'p') {
      await walkInlineContainer(node, state, context, 'paragraph');
    } else if (tag === 'figure') {
      for (const child of [...node.children]) {
        const childTag = child.tagName.toLowerCase();
        if (['img', 'svg', 'canvas', 'iframe'].includes(childTag)) await addMediaBlock(child, state);
        else if (childTag === 'figcaption') pushBlock(state, { type: 'caption', text: inlineMarkdown(child) });
        else await walkContainer(child, state, context);
      }
    } else if (['img', 'svg', 'canvas', 'iframe'].includes(tag)) {
      await addMediaBlock(node, state);
    } else if (tag === 'table') {
      const id = nextBlockId(state);
      state.blocks.push({ ...tableBlock(node, id), order: state.blocks.length });
    } else if (tag === 'blockquote') {
      const text = turndown.turndown(node.innerHTML).trim() || cleanText(node.textContent);
      pushBlock(state, { type: 'quote', text });
    } else if (tag === 'pre') {
      pushBlock(state, { type: 'code', language: node.querySelector('code')?.className || '', text: node.textContent || '' });
    } else if (tag === 'ul' || tag === 'ol') {
      await walkList(node, state, { ...context, ordered: tag === 'ol' });
    } else if (tag === 'li') {
      await walkListItem(node, state, context);
    } else if (tag === 'math') {
      pushBlock(state, { type: 'formula', text: cleanText(node.textContent) });
    } else if (tag === 'hr') {
      pushBlock(state, { type: 'divider', text: '' });
    } else {
      await walkContainer(node, state, context);
    }
  }
}

async function walkInlineContainer(node, state, context, type) {
  let buffer = '';
  const flush = () => {
    const text = buffer.trim();
    if (text) pushBlock(state, { type, text });
    buffer = '';
  };
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 3) buffer += child.textContent;
    else if (child.nodeType === 1 && ['img', 'svg', 'canvas', 'iframe'].includes(child.tagName.toLowerCase())) {
      flush();
      await addMediaBlock(child, state);
    } else if (child.nodeType === 1 && child.querySelector('img,svg,canvas,iframe')) {
      flush();
      for (const media of child.querySelectorAll('img,svg,canvas,iframe')) await addMediaBlock(media, state);
      const remaining = inlineMarkdown(child).trim();
      if (remaining) pushBlock(state, { type, text: remaining });
    } else if (child.nodeType === 1 && ['ul', 'ol'].includes(child.tagName.toLowerCase())) {
      flush();
      await walkList(child, state, { ...context, ordered: child.tagName.toLowerCase() === 'ol' });
    } else {
      buffer += inlineMarkdown(child);
    }
  }
  flush();
}

async function walkList(list, state, context) {
  for (const li of [...list.children].filter((child) => child.tagName === 'LI')) {
    await walkListItem(li, state, context);
  }
}

async function walkListItem(li, state, context) {
  const clone = li.cloneNode(true);
  clone.querySelectorAll(':scope > ul,:scope > ol').forEach((nested) => nested.remove());
  const text = inlineMarkdown(clone);
  if (text) pushBlock(state, {
    type: 'list_item',
    depth: context.listDepth || 0,
    ordered: Boolean(context.ordered),
    text,
  });
  for (const nested of [...li.children].filter((child) => ['UL', 'OL'].includes(child.tagName))) {
    await walkList(nested, state, {
      listDepth: (context.listDepth || 0) + 1,
      ordered: nested.tagName === 'OL',
    });
  }
}

async function addMediaBlock(node, state) {
  if (state.assets.length >= state.limits.maxAssets) throw new Error(`原文图片超过上限:${state.limits.maxAssets}`);
  const captureId = node.getAttribute('data-zen-capture-id');
  const capture = captureId ? state.browserCaptures.get(captureId) : undefined;
  const tag = node.tagName.toLowerCase();
  const alt = cleanText(node.getAttribute('alt') || node.getAttribute('aria-label') || '');
  const originalUrl = tag === 'img' ? bestImageUrl(node, state.sourceUrl) : undefined;
  let asset;
  if (state.localizeAssets) {
    if (originalUrl) {
      try {
        asset = await downloadAsset({ url: originalUrl, alt, state, kind: tag === 'img' ? 'image' : 'chart' });
      } catch {}
    }
    if (!asset && capture?.buffer) asset = saveCapturedAsset({ capture, alt, originalUrl, state, kind: tag === 'img' ? 'image' : 'chart' });
    if (!asset && tag === 'svg') {
      const serialized = node.outerHTML;
      asset = saveBufferAsset({
        buffer: Buffer.from(serialized),
        mime: 'image/svg+xml',
        alt,
        originalUrl,
        state,
        kind: 'chart',
      });
    }
    if (!asset) throw new Error(`原文图片无法下载或截图:${originalUrl || captureId || tag}`);
  }
  pushBlock(state, {
    type: 'image',
    assetId: asset?.id,
    alt,
    sourceUrl: originalUrl,
    pendingAsset: !state.localizeAssets,
    mediaTag: tag,
  });
}

async function downloadAsset({ url, alt, state, kind }) {
  const resource = await safeFetchResource({
    url,
    fetchFn: state.fetchFn,
    fetchWithRetry: state.fetchWithRetry,
    limits: state.limits,
    dnsLookup: state.dnsLookup,
    accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    maxBytes: state.limits.maxAssetBytes,
  });
  const mime = normalizedImageMime(resource.contentType, resource.buffer);
  if (!mime) throw new Error('图片响应不是受支持的图片格式');
  return saveBufferAsset({
    buffer: resource.buffer,
    mime,
    alt,
    originalUrl: resource.finalUrl,
    state,
    kind,
  });
}

function saveCapturedAsset({ capture, alt, originalUrl, state, kind }) {
  return saveBufferAsset({
    buffer: capture.buffer,
    mime: capture.mime || 'image/png',
    width: capture.width,
    height: capture.height,
    alt,
    originalUrl,
    state,
    kind,
  });
}

function saveBufferAsset({ buffer, mime, width, height, alt, originalUrl, state, kind }) {
  const id = `a${String(++state.assetIndex).padStart(4, '0')}`;
  const ext = extensionForMime(mime);
  const filename = `source-v2-${String(state.assetIndex).padStart(4, '0')}${ext}`;
  const target = path.join(state.assetDir, filename);
  fs.writeFileSync(target, buffer);
  const dimensions = imageDimensions(buffer, mime);
  const asset = {
    id,
    kind,
    originalUrl,
    relative: `assets/${filename}`,
    path: target,
    mime,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    width: width || dimensions.width || null,
    height: height || dimensions.height || null,
    alt,
  };
  state.assets.push(asset);
  return asset;
}

async function localizeMarkdownAsset({ rawUrl, alt, state, localAssetBase }) {
  const value = String(rawUrl || '').replace(/^<|>$/g, '');
  if (localAssetBase && !/^https?:\/\//i.test(value)) {
    const sourcePath = path.resolve(localAssetBase, decodeURIComponent(value.split(/\s+["']/)[0]));
    if (!sourcePath.startsWith(path.resolve(localAssetBase) + path.sep) || !fs.existsSync(sourcePath)) {
      throw new Error(`Markdown 本地图片不存在:${value}`);
    }
    const buffer = fs.readFileSync(sourcePath);
    return saveBufferAsset({
      buffer,
      mime: mimeFromExtension(sourcePath),
      alt,
      originalUrl: value,
      state,
      kind: 'image',
    });
  }
  return downloadAsset({ url: new URL(value, state.sourceUrl).toString(), alt, state, kind: 'image' });
}

function tableBlock(table, id) {
  const origins = [];
  const grid = [];
  const occupied = new Map();
  const rows = [...table.querySelectorAll(':scope > thead > tr,:scope > tbody > tr,:scope > tfoot > tr,:scope > tr')];
  rows.forEach((row, rowIndex) => {
    grid[rowIndex] ||= [];
    let column = 0;
    while (occupied.has(`${rowIndex}:${column}`)) column += 1;
    for (const cell of [...row.children].filter((node) => ['TH', 'TD'].includes(node.tagName))) {
      while (occupied.has(`${rowIndex}:${column}`)) column += 1;
      const rowSpan = Math.max(1, Number(cell.getAttribute('rowspan') || 1));
      const colSpan = Math.max(1, Number(cell.getAttribute('colspan') || 1));
      const cellId = `${id}:c${origins.length + 1}`;
      origins.push({
        id: cellId,
        text: inlineMarkdown(cell),
        header: cell.tagName === 'TH',
        rowSpan,
        colSpan,
      });
      for (let r = rowIndex; r < rowIndex + rowSpan; r += 1) {
        grid[r] ||= [];
        for (let c = column; c < column + colSpan; c += 1) {
          grid[r][c] = cellId;
          occupied.set(`${r}:${c}`, cellId);
        }
      }
      column += colSpan;
    }
  });
  const width = Math.max(0, ...grid.map((row) => row.length));
  for (const row of grid) {
    for (let index = 0; index < width; index += 1) row[index] ||= '';
  }
  return {
    id,
    type: 'table',
    caption: inlineMarkdown(table.querySelector('caption')),
    cells: origins,
    grid,
  };
}

function markdownTableBlock(lines, id) {
  const parsed = lines
    .filter((line, index) => index !== 1 || !/^\s*\|?\s*:?-+/.test(line))
    .map((line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()));
  const width = Math.max(0, ...parsed.map((row) => row.length));
  const cells = [];
  const grid = parsed.map((row, rowIndex) => Array.from({ length: width }, (_, columnIndex) => {
    const cell = {
      id: `${id}:c${cells.length + 1}`,
      text: row[columnIndex] || '',
      header: rowIndex === 0,
      rowSpan: 1,
      colSpan: 1,
    };
    cells.push(cell);
    return cell.id;
  }));
  return { id, type: 'table', caption: '', cells, grid };
}

function renderTable(block) {
  if (!block.grid?.length) return '';
  const values = new Map(block.cells.map((cell) => [cell.id, cell.translatedText ?? cell.text ?? '']));
  const rows = block.grid.map((row) => row.map((cellId) => escapeTableCell(values.get(cellId) || '')));
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => Array.from({ length: width }, (_, index) => row[index] || ''));
  const lines = [];
  if (block.translatedCaption || block.caption) lines.push(`**${block.translatedCaption || block.caption}**`, '');
  lines.push(`| ${normalized[0].join(' | ')} |`);
  lines.push(`| ${normalized[0].map(() => '---').join(' | ')} |`);
  for (const row of normalized.slice(1)) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
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
  const payload = batch.map((unit) => {
    if (!repair) return { id: unit.id, text: unit.text };
    const protectedText = protectInvariantText(unit.text);
    protections.set(unit.id, protectedText.tokens);
    return { id: unit.id, text: protectedText.text };
  });
  const prompt = `将下面 JSON 中每个 text 完整、忠实、逐句翻译为简体中文。

硬性规则:
- 只返回合法 JSON，格式严格为 {"translations":[{"id":"原 ID","text":"完整译文"}]}。
- translations 必须与输入数量相同，ID 必须逐字相同且不得重复、遗漏或新增。
- 不总结、不改写、不删减，不改变数字、单位、Ticker、URL、Markdown 链接目标、HTML 标签和 <!-- source-page:N --> 标记。
- 保留输入中的 Markdown 粗体、斜体、行内代码、链接和脚注标记。
- 专有名词首次出现可保留英文，普通叙述必须翻译成中文。
- 表格单元格只翻译单元格本身，不合并、不拆分。
${source.translationOptions?.highlightKeyPoints ? '- 在不增删或改写内容的前提下，每个主要章节只用 Markdown **粗体**高亮 1–2 个关键词或核心观点；不得整段加粗。' : ''}
${repair ? '- 上一轮结果未通过结构或数字校验。输入中的 ⟦ZEN_KEEP_N⟧ 是不可翻译占位符，必须原样、原位置、各保留一次。' : ''}

文档标题:${source.title}
来源:${source.sourceUrl}

输入 JSON:
${JSON.stringify({ units: payload })}`;
  const request = {
    prompt,
    model,
    writer: { ...writer, temperature: 0 },
    fetchFn,
    timeoutMs,
    systemPrompt: '你是严谨的专业译者和 JSON API。只翻译输入文本，不改变任何结构、ID、数字、链接或标记，只输出合法 JSON。',
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
              properties: {
                id: { type: 'string' },
                text: { type: 'string' },
              },
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

function protectInvariantText(value) {
  const tokens = [];
  const text = String(value).replace(
    /https?:\/\/[^\s)\]}>"']+|<!--\s*source-page:\d+\s*-->|[$€£¥]?[-+]?\d+(?:[,.]\d+)*(?:%|‰|[KMBT](?=\b))?/gi,
    (token) => {
      const index = tokens.push(token);
      return `⟦ZEN_KEEP_${index}⟧`;
    },
  );
  return { text, tokens };
}

function restoreInvariantText(value, tokens) {
  let text = String(value);
  for (let index = 0; index < tokens.length; index += 1) {
    const placeholder = `⟦ZEN_KEEP_${index + 1}⟧`;
    text = text.replaceAll(placeholder, tokens[index]);
  }
  return text;
}

function textOnlySourceDocument(source) {
  const allowed = new Set(['heading', 'paragraph', 'quote', 'list_item']);
  const document = structuredClone(source);
  document.blocks = document.blocks
    .filter((block) => allowed.has(block.type))
    .map((block, order) => ({ ...block, order }));
  document.assets = [];
  document.extractor = `${document.extractor}-text-only`;
  return document;
}

function validateBatchTranslations(batch, translations) {
  const byId = new Map();
  const duplicates = new Set();
  for (const item of translations || []) {
    if (byId.has(item.id)) duplicates.add(item.id);
    byId.set(item.id, item.text);
  }
  const expected = new Set(batch.map((unit) => unit.id));
  const hasExtras = [...byId.keys()].some((id) => !expected.has(id));
  return batch.filter((unit) => {
    const text = byId.get(unit.id);
    return duplicates.has(unit.id) || hasExtras || !text?.trim()
      || !sameInvariantTokens(unit.text, text)
      || isClearlyUntranslated(unit.text, text);
  });
}

function translationUnits(document) {
  const units = [{ id: 'meta:title', text: document.title || '原文直译', kind: 'title' }];
  for (const block of document.blocks) {
    if (['heading', 'paragraph', 'quote', 'list_item', 'caption', 'footnote'].includes(block.type) && block.text?.trim()) {
      units.push({ id: block.id, text: block.text, kind: block.type });
    } else if (block.type === 'image' && block.alt?.trim()) {
      units.push({ id: `${block.id}:alt`, text: block.alt, kind: 'alt' });
    } else if (block.type === 'table') {
      if (block.caption?.trim()) units.push({ id: `${block.id}:caption`, text: block.caption, kind: 'table_caption' });
      for (const cell of block.cells) {
        if (cell.text?.trim()) units.push({ id: cell.id, text: cell.text, kind: 'table_cell' });
      }
    }
  }
  return units;
}

function applyTranslations(source, completed) {
  const document = structuredClone(source);
  document.translatedTitle = completed.get('meta:title') || source.title;
  for (const block of document.blocks) {
    if (completed.has(block.id)) block.translatedText = completed.get(block.id);
    if (completed.has(`${block.id}:alt`)) block.translatedAlt = completed.get(`${block.id}:alt`);
    if (block.type === 'table') {
      if (completed.has(`${block.id}:caption`)) block.translatedCaption = completed.get(`${block.id}:caption`);
      for (const cell of block.cells) {
        if (completed.has(cell.id)) cell.translatedText = completed.get(cell.id);
      }
    }
  }
  return document;
}

function translatedUnitText(document, id) {
  if (id === 'meta:title') return document.translatedTitle;
  const [blockId] = id.split(/:(?:alt|caption|c\d+)$/);
  const block = document.blocks.find((item) => item.id === blockId);
  if (!block) return undefined;
  if (id === `${block.id}:alt`) return block.translatedAlt;
  if (id === `${block.id}:caption`) return block.translatedCaption;
  if (block.type === 'table') return block.cells.find((cell) => cell.id === id)?.translatedText;
  return block.translatedText;
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
  const stableTokens = (value) => [
    ...String(value).match(/https?:\/\/[^\s)\]}>"']+/gi) || [],
    ...String(value).match(/<!--\s*source-page:\d+\s*-->/gi) || [],
    // Only syntax that unambiguously denotes a ticker is immutable. Ordinary
    // abbreviations such as US or LTD may be translated legitimately.
    ...String(value).match(/\$[A-Z]{1,6}\b|\b(?:NASDAQ|NYSE|AMEX|OTC)\s*:\s*[A-Z]{1,6}\b/g) || [],
  ].sort();
  if (JSON.stringify(stableTokens(source)) !== JSON.stringify(stableTokens(translated))) return false;

  const sourceNumbers = invariantNumbers(source);
  const translatedNumbers = invariantNumbers(translated);
  if (JSON.stringify(sourceNumbers) === JSON.stringify(translatedNumbers)) return true;

  // Chinese date style normally turns "Jul 17, 2026" into "2026 年 7 月
  // 17 日". The extra numeric month is a faithful conversion, not a changed
  // financial figure.
  const monthNumber = englishMonthNumber(source);
  if (!monthNumber) return false;
  return JSON.stringify([...sourceNumbers, monthNumber].sort()) === JSON.stringify(translatedNumbers);
}

function invariantNumbers(value) {
  // Permit an immediately attached unit/label (32.3B, +10Connects). The
  // ASCII boundary still avoids treating the 4 in GPT4 as a figure, while
  // allowing Chinese date/unit forms such as 2026年7月17日.
  return [
    ...String(value).match(/(?<![A-Za-z0-9])[-+]?\d+(?:[,.]\d+)*(?:%|‰)?/g) || [],
  ].sort();
}

function isClearlyUntranslated(source, translated) {
  const sourceEnglish = (String(source).match(/[A-Za-z]/g) || []).length;
  if (sourceEnglish < 40) return false;
  // Byline blocks are intentionally left as names. Without this exception a
  // long author list is incorrectly treated as leaked English prose.
  const sourceWords = String(source).match(/[A-Za-z][A-Za-z'-]*/g) || [];
  const capitalized = sourceWords.filter((word) => /^[A-Z]/.test(word)).length;
  if (/,/.test(source) && sourceWords.length >= 4 && capitalized / sourceWords.length >= 0.7) return false;
  const text = String(translated);
  const words = text.match(/[A-Za-z][A-Za-z'-]*/g) || [];
  const han = (text.match(/\p{Script=Han}/gu) || []).length;
  return words.length >= 10 && han < 4 && sourceEnglish / Math.max(1, source.length) > 0.45;
}

function englishMonthNumber(value) {
  const months = {
    jan: '1', january: '1', feb: '2', february: '2', mar: '3', march: '3',
    apr: '4', april: '4', may: '5', jun: '6', june: '6', jul: '7', july: '7',
    aug: '8', august: '8', sep: '9', sept: '9', september: '9', oct: '10',
    october: '10', nov: '11', november: '11', dec: '12', december: '12',
  };
  const match = String(value).match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b/i);
  return match ? months[match[1].toLowerCase()] : '';
}

function assertSourceDocumentComplete(document) {
  if (!document.blocks?.length) throw new Error('原文结构化结果为空');
  const textLength = translationUnits(document).reduce((sum, unit) => sum + unit.text.length, 0);
  if (document.sourceType === 'html' && textLength < 300) throw new Error(`网页正文过短:${textLength} 字符`);
  const pending = document.blocks.filter((block) => block.type === 'image' && !block.assetId);
  if (pending.length) throw new Error(`有 ${pending.length} 个正文图片未能本地化`);
  const assetIds = new Set(document.assets.map((asset) => asset.id));
  for (const block of document.blocks.filter((item) => item.type === 'image')) {
    if (!assetIds.has(block.assetId)) throw new Error(`图片块缺少素材:${block.id}`);
  }
}

function browserFallbackReasons({ html, document }) {
  const reasons = [];
  const textLength = translationUnits(document).reduce((sum, unit) => sum + unit.text.length, 0);
  if (textLength < 500 || document.blocks.length < 3) reasons.push('静态正文过短');
  if (/<(?:canvas|svg|iframe)\b/i.test(html)) reasons.push('存在动态、矢量或嵌入图表');
  if (/<img\b[^>]*(?:data-src|data-lazy|loading=["']lazy)/i.test(html)) reasons.push('存在懒加载图片');
  if (/<(?:script|div)[^>]+id=["'](?:__next|__nuxt|app|root)["']/i.test(html) && textLength < 1500) reasons.push('疑似客户端渲染');
  return [...new Set(reasons)];
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

function removeNoise(document) {
  document.querySelectorAll([
    'script', 'style', 'noscript', 'nav', 'form', 'aside',
    'body > header', 'body > footer',
    '[aria-hidden="true"]', '[hidden]', '.advertisement', '.advert', '.ads',
    '.related-posts', '.recommended', '.comments', '#comments', '.cookie-banner',
    '.newsletter-signup', '.social-share',
  ].join(',')).forEach((node) => node.remove());
}

function normalizeMath(document) {
  for (const math of [...document.querySelectorAll('math')]) {
    const tex = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
    if (tex) math.textContent = `$${tex}$`;
  }
}

function inlineMarkdown(node) {
  if (!node) return '';
  if (node.nodeType === 3) return escapeMarkdownText(node.textContent || '');
  if (node.nodeType !== 1) return '';
  const tag = node.tagName.toLowerCase();
  if (['img', 'svg', 'canvas', 'iframe', 'script', 'style', 'noscript'].includes(tag)) return '';
  const content = [...node.childNodes].map(inlineMarkdown).join('');
  if (!content) return '';
  if (tag === 'strong' || tag === 'b') return `**${content}**`;
  if (tag === 'em' || tag === 'i') return `*${content}*`;
  if (tag === 'code') return `\`${content.replace(/`/g, '\\`')}\``;
  if (tag === 'a') {
    const href = node.getAttribute('href');
    if (href && !href.startsWith('#')) {
      try { return `[${content}](${new URL(href, node.ownerDocument.URL).toString()})`; } catch {}
    }
  }
  if (tag === 'br') return '\n';
  if (tag === 'sup') return `<sup>${content}</sup>`;
  if (tag === 'sub') return `<sub>${content}</sub>`;
  return content;
}

function escapeMarkdownText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/([\\`*_[\]])/g, '\\$1')
    .replace(/[ \t]+/g, ' ');
}

function pushBlock(state, block) {
  const id = block.id || nextBlockId(state);
  state.blocks.push({ ...block, id, order: state.blocks.length });
  return id;
}

function nextBlockId(state) {
  return `b${String(++state.blockIndex).padStart(6, '0')}`;
}

function blockHasContent(block) {
  if (block.type === 'image') return true;
  if (block.type === 'table') return block.cells?.length > 0;
  if (block.type === 'divider') return false;
  return Boolean(String(block.text || '').trim());
}

function bestImageUrl(node, baseUrl) {
  const raw = node.getAttribute('data-zen-current-src')
    || bestSrcsetCandidate(node.getAttribute('srcset'))
    || bestSrcsetCandidate(node.parentElement?.tagName === 'PICTURE'
      ? [...node.parentElement.querySelectorAll('source[srcset]')].map((source) => source.getAttribute('srcset')).join(',')
      : '')
    || node.getAttribute('data-src')
    || node.getAttribute('data-original')
    || node.getAttribute('data-lazy-src')
    || node.getAttribute('src');
  if (!raw || /^data:image\/(?:gif|png);base64,R0lGODlhAQABA|^data:image\/svg\+xml,<svg[^>]+(?:width|height)=["']?1/i.test(raw)) return undefined;
  try { return new URL(raw, baseUrl).toString(); } catch { return undefined; }
}

function bestSrcsetCandidate(srcset) {
  const candidates = String(srcset || '').split(',').map((item) => {
    const [url, descriptor] = item.trim().split(/\s+/);
    const score = descriptor?.endsWith('w') ? Number(descriptor.slice(0, -1))
      : descriptor?.endsWith('x') ? Number(descriptor.slice(0, -1)) * 1000 : 0;
    return { url, score: Number.isFinite(score) ? score : 0 };
  }).filter((item) => item.url);
  return candidates.sort((a, b) => b.score - a.score)[0]?.url;
}

function normalizedImageMime(contentType, buffer) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'].includes(type)) return type;
  const head = buffer.subarray(0, 12);
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (head.subarray(0, 2).equals(Buffer.from([255, 216]))) return 'image/jpeg';
  if (head.subarray(0, 6).toString().startsWith('GIF8')) return 'image/gif';
  if (head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (/^\s*<svg[\s>]/i.test(buffer.toString('utf8', 0, Math.min(buffer.length, 200)))) return 'image/svg+xml';
  return undefined;
}

function imageDimensions(buffer, mime) {
  try {
    if (mime === 'image/png' && buffer.length >= 24) return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    if (mime === 'image/gif' && buffer.length >= 10) return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  } catch {}
  return { width: null, height: null };
}

function extensionForMime(mime) {
  return ({
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
  })[mime] || '.bin';
}

function mimeFromExtension(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return ({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
  })[ext] || 'application/octet-stream';
}

function sourceAttribution(document) {
  const site = (() => { try { return new URL(document.sourceUrl).hostname; } catch { return '未知'; } })();
  return `来源：《${document.title || '未知标题'}》，作者 ${document.author || '未知'}，发布于 ${site}，原文链接 ${document.sourceUrl}，发布日期 ${document.publishedDate || '未知'}。`;
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

function extractInputUrls(text) {
  return (String(text || '').match(/https?:\/\/[^\s<>()，。；：！？】【、】【【】）》〉]+/g) || [])
    .map((url) => url.replace(/[.,;:!?)\]}>，。；：！？】【、】【【】）》〉]+$/, ''));
}

function notionPageId(rawUrl) {
  const url = new URL(rawUrl);
  const compact = `${url.pathname}${url.search}`.replace(/-/g, '');
  const match = compact.match(/[a-f0-9]{32}/i);
  if (!match) return undefined;
  const id = match[0].toLowerCase();
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

function isNotionUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'notion.so' || host.endsWith('.notion.so') || host === 'notion.site' || host.endsWith('.notion.site');
  } catch { return false; }
}

function limitsFor(config) {
  return {
    maxSourceBytes: positive(config.maxSourceBytes, DEFAULT_LIMITS.maxSourceBytes),
    maxAssetBytes: positive(config.maxAssetBytes, DEFAULT_LIMITS.maxAssetBytes),
    maxAssets: positive(config.maxAssets, DEFAULT_LIMITS.maxAssets),
    browserTimeoutMs: positive(config.browserTimeoutMs, DEFAULT_LIMITS.browserTimeoutMs),
    fetchTimeoutMs: positive(config.fetchTimeoutMs, DEFAULT_LIMITS.fetchTimeoutMs),
    maxRedirects: positive(config.maxRedirects, DEFAULT_LIMITS.maxRedirects),
  };
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
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

function isMarkdownTableStart(lines, index) {
  return /^\s*\|.*\|\s*$/.test(lines[index] || '')
    && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || '');
}

function markdownSpecialLine(lines, index) {
  const value = lines[index] || '';
  return /^(#{1,6})\s+/.test(value)
    || /^!\[/.test(value.trim())
    || /^```/.test(value.trim())
    || /^(\s*)([-*+]|\d+[.)])\s+/.test(value)
    || /^>\s?/.test(value)
    || /^\[\^[^\]]+\]:/.test(value)
    || isMarkdownTableStart(lines, index);
}

function cleanSourceAssets(assetDir) {
  for (const filename of fs.readdirSync(assetDir)) {
    if (/^source-v2-\d+\.(?:png|jpe?g|gif|webp|svg|bin)$/i.test(filename)) {
      fs.rmSync(path.join(assetDir, filename), { force: true });
    }
  }
}

function findFirstFile(root, pattern) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findFirstFile(target, pattern);
      if (nested) return nested;
    } else if (pattern.test(entry.name)) return target;
  }
  return undefined;
}

function sha256File(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function escapeTableCell(value) {
  return String(value || '').replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|').trim();
}

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cleanText(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeHtmlBuffer(buffer, contentType) {
  const head = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('ascii');
  const declared = /charset\s*=\s*["']?\s*([A-Za-z0-9._-]+)/i.exec(String(contentType || ''))?.[1]
    || /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9._-]+)/i.exec(head)?.[1]
    || /<meta[^>]+content=["'][^"']*charset\s*=\s*([A-Za-z0-9._-]+)/i.exec(head)?.[1]
    || 'utf-8';
  try {
    const decoded = new TextDecoder(declared, { fatal: false }).decode(buffer);
    if ((decoded.match(/\uFFFD/g) || []).length > Math.max(2, decoded.length * 0.002)) {
      throw new Error('replacement characters');
    }
    return decoded;
  } catch {
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    if ((decoded.match(/\uFFFD/g) || []).length > Math.max(2, decoded.length * 0.002)) {
      throw new Error(`网页字符集无法可靠解码:${declared}`);
    }
    return decoded;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function safeError(error) {
  return String(error?.message || error || '未知错误').slice(0, 300);
}

async function report(onProgress, progress) {
  if (onProgress) await onProgress(progress);
}
