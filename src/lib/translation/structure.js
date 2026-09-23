import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { convertPdfWithDatalab } from './datalab-parser.js';
import { applyTranslationScope, datalabPageRange } from './translation-scope.js';
import { DOCUMENT_VERSION, EXCLUDED_CONTENT_SELECTOR, discardExcludedContent, titleAnchoredContentRoot, richestArticle, metadata, cleanText, cleanTextPreservingLines, cleanPdfMeta, clamp } from './shared.js';
import { readPdfInfo, assertPdfResponse, runCommand } from './pdf.js';
import { assertSourceDocumentComplete } from './validation.js';
import { resolveAssetUrl, localizeFigureAssets, localizeTableAssets, tableHtmlFromRows } from './assets.js';


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
  const datalabPages = extractor === 'datalab-marker-html'
    ? [...sourceDocument.querySelectorAll('.page[data-page-id]')]
    : [];
  if (extractor === 'datalab-marker-html' && !datalabPages.length) {
    throw new Error('Datalab HTML 缺少分页容器，拒绝按普通网页正文解析');
  }
  let readable;
  const structured = sourceDocument.querySelector('article.ltx_document,.ltx_document');
  const titleRoot = structured || datalabPages.length ? undefined : titleAnchoredContentRoot(sourceDocument, title);
  const articles = [...sourceDocument.querySelectorAll('article')];
  const singleArticle = articles.length === 1 ? articles[0] : undefined;
  if (!structured && !datalabPages.length && !titleRoot && !singleArticle) {
    try {
      readable = new Readability(sourceDocument.cloneNode(true), { charThreshold: 80, keepClasses: true }).parse();
    } catch {}
  }
  const fallback = sourceDocument.querySelector('main,[role="main"]')
    || richestArticle(articles)
    || sourceDocument.body;
  const selectedRoot = structured || titleRoot || singleArticle;
  const bodyHtml = datalabPages.length
    ? datalabPages.map((page) => page.outerHTML).join('\n')
    : selectedRoot?.outerHTML || readable?.content || fallback?.innerHTML || '';
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
  if (datalabPages.length) {
    document.processedPageIds = datalabPages.map((page) => Number(page.getAttribute('data-page-id')));
    document.datalabHtmlTextCharacters = datalabPages
      .map((page) => String(page.textContent || '').replace(/\s+/g, '').length)
      .reduce((sum, length) => sum + length, 0);
    document.datalabHtmlImageCount = datalabPages
      .reduce((sum, page) => sum + page.querySelectorAll('img[src]').length, 0);
  }
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
  sourceType = 'notion',
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
      const ordered = /^\d/.test(list[2]);
      push({
        type: referencesStarted ? 'reference' : 'list_item',
        ordered,
        ...(ordered ? {
          ordinal: Number.parseInt(list[2], 10),
          delimiter: list[2].endsWith(')') ? ')' : '.',
        } : {}),
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
    sourceType,
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

export async function sourceDocumentFromPdf({
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
  await fs.promises.writeFile(pdfPath, pdfBuffer);
  const { pages, output: info } = await readPdfInfo(pdfPath, limits.maxPdfPages, { signal });
  if (scope?.kind === 'pages' && scope.endPage > pages) {
    throw new Error(`指定翻译范围超过 PDF 页数:${scope.endPage}/${pages}`);
  }
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
  const expectedPageIds = pdfPageIds(scope, pages);
  const popplerTextCharacters = await pdfTextCharacters(pdfPath, scope, pages, { signal });
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
  document.processedPageIds = converted.pageIds;
  document.parseQualityScore = converted.parseQualityScore;
  document.parserAttempts = converted.attempts;
  document.datalabHtmlTextCharacters = converted.htmlTextCharacters;
  document.datalabHtmlImageCount = converted.htmlImageCount;
  document.datalabResultImageCount = converted.resultImageCount;
  document.popplerTextCharacters = popplerTextCharacters;
  document.pageCoverage = assertPdfExtractionCoverage({
    document,
    expectedPageIds,
    popplerTextCharacters,
  });
  document.scope = scope;
  assertSourceDocumentComplete(document);
  return document;
}

export function assertPdfExtractionCoverage({
  document,
  expectedPageIds,
  popplerTextCharacters = 0,
}) {
  const expected = Array.isArray(expectedPageIds) ? expectedPageIds : [];
  const found = Array.isArray(document?.processedPageIds) ? document.processedPageIds : [];
  const datalabCharacters = Number(document?.datalabHtmlTextCharacters) || 0;
  const extractedCharacters = sourceDocumentCharacters(document);
  const errors = [];
  if (!expected.length) errors.push('没有可验证的请求页码');
  if (found.join(',') !== expected.join(',')) {
    errors.push(`页码覆盖不一致:${found.join(',') || '无'}/${expected.join(',') || '无'}`);
  }
  if (Number(document?.processedPageCount) !== expected.length) {
    errors.push(`处理页数不一致:${Number(document?.processedPageCount) || 0}/${expected.length}`);
  }
  if (datalabCharacters >= 1000 && extractedCharacters < datalabCharacters * 0.5) {
    errors.push(`结构化正文仅保留 Datalab 文本的 ${percentage(extractedCharacters, datalabCharacters)}`);
  }
  const textRichBaseline = expected.length * 200;
  if (popplerTextCharacters >= textRichBaseline
    && datalabCharacters < popplerTextCharacters * 0.35) {
    errors.push(`Datalab 文本仅覆盖 PDF 文本层的 ${percentage(datalabCharacters, popplerTextCharacters)}`);
  }
  if (popplerTextCharacters >= textRichBaseline
    && extractedCharacters < popplerTextCharacters * 0.25) {
    errors.push(`结构化正文仅覆盖 PDF 文本层的 ${percentage(extractedCharacters, popplerTextCharacters)}`);
  }
  if (errors.length) throw new Error(`PDF 页级完整性校验失败:${errors.join('; ')}`);
  return {
    requestedPages: expected.length,
    processedPages: found.length,
    expectedPageIds: expected,
    processedPageIds: found,
    pagesFound: found.map((id) => id + 1),
    popplerTextCharacters,
    datalabTextCharacters: datalabCharacters,
    extractedCharacters,
    datalabImages: Number(document?.datalabResultImageCount) || 0,
    referencedImages: Number(document?.datalabHtmlImageCount) || 0,
  };
}

export function pdfPageIds(scope, totalPages) {
  const start = scope?.kind === 'pages' ? scope.startPage - 1 : 0;
  const end = scope?.kind === 'pages' ? scope.endPage - 1 : totalPages - 1;
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

export async function pdfTextCharacters(pdfPath, scope, totalPages, { signal } = {}) {
  const firstPage = scope?.kind === 'pages' ? scope.startPage : 1;
  const lastPage = scope?.kind === 'pages' ? scope.endPage : totalPages;
  const text = await runCommand('pdftotext', [
    '-f', String(firstPage),
    '-l', String(lastPage),
    pdfPath,
    '-',
  ], { timeout: 60000, signal });
  return text.replace(/\s+/g, '').length;
}

export function sourceDocumentCharacters(document) {
  return (document?.blocks || []).reduce((total, block) => {
    const tableText = (block.rows || [])
      .flatMap((row) => row || [])
      .map((cell) => cell?.text || '')
      .join(' ');
    return total + [block.text, block.caption, block.tex, tableText]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, '').length;
  }, 0);
}

export function percentage(value, total) {
  if (!total) return '0.0%';
  return `${((value / total) * 100).toFixed(1)}%`;
}

export function createSourceDocument({
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

export function blocksFromDom(root, documentUrl) {
  if (!root) return [];
  const blocks = [];
  let blockIndex = 0;
  let referencesStarted = false;
  const selector = [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'li',
    'figure', 'table', 'pre', 'img', '.ltx_equationgroup', '.ltx_equation',
    'math[display="block"]', '.ltx_bibitem',
    // Datalab emits ComplexRegion and similar content as classless nested divs
    // carrying only data-block-id. Without this leaf-level branch, text-heavy
    // regions (e.g. per-record experience details) vanish from the structured
    // document while the raw page text remains, tripping the coverage gate.
    'div[data-block-id]',
  ].join(',');
  for (const node of root.querySelectorAll(selector)) {
    if (node.closest(EXCLUDED_CONTENT_SELECTOR)) continue;
    if (node.tagName === 'DIV') {
      if (node.closest('p,li,blockquote,h1,h2,h3,h4,h5,h6,table,figure,pre')) continue;
      // Keep residual text of Datalab regions: children matching the semantic
      // or data-block-id selector are captured by their own iteration, so the
      // region block must retain only the text they do not already cover.
      const residual = node.cloneNode(true);
      for (const child of [...residual.querySelectorAll(selector)]) child.remove();
      const region = datalabRegionRichText(residual, documentUrl);
      if (!region.text) continue;
      blocks.push({
        id: `b${String(++blockIndex).padStart(6, '0')}`,
        order: blocks.length,
        type: 'paragraph',
        text: region.text,
        fragments: region.fragments,
      });
      continue;
    }
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
      if (block.ordered) {
        block.ordinal = orderedListItemOrdinal(node);
        block.delimiter = '.';
      }
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

export function orderedListItemOrdinal(node) {
  const list = node.parentElement;
  if (list?.tagName !== 'OL') return undefined;
  const items = [...list.children].filter((child) => child.tagName === 'LI');
  const reversed = list.hasAttribute('reversed');
  const parsedStart = Number.parseInt(list.getAttribute('start') || '', 10);
  let ordinal = Number.isInteger(parsedStart) ? parsedStart : (reversed ? items.length : 1);
  for (const item of items) {
    const explicitValue = Number.parseInt(item.getAttribute('value') || '', 10);
    if (Number.isInteger(explicitValue)) ordinal = explicitValue;
    if (item === node) return ordinal;
    ordinal += reversed ? -1 : 1;
  }
  return undefined;
}

export function richTextFromNode(node, documentUrl) {
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

export function datalabRegionRichText(node, documentUrl) {
  const clone = node.cloneNode(true);
  // Nested classless divs in Datalab ComplexRegion blocks act as line
  // containers; textContent alone would concatenate neighboring fields.
  for (const div of [...clone.querySelectorAll('div')]) {
    if (!div.querySelector('div')) div.append(clone.ownerDocument.createTextNode('\n'));
  }
  return richTextFromNode(clone, documentUrl);
}

export function figureFromNode(node, documentUrl) {
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

export function tableFromNode(node, documentUrl) {
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

export function mathTex(node) {
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

export function cleanMath(value) {
  return String(value || '').trim()
    .replace(/^\\\(|\\\)$/g, '')
    .replace(/^\\\[|\\\]$/g, '')
    .replace(/^\$\$?|\$\$?$/g, '')
    .trim();
}

export function isReferencesHeading(text) {
  return /^(?:references|bibliography|works cited|参考文献|引用文献)\s*[:：]?$/i.test(cleanText(text));
}

export function isMarkdownTableStart(lines, index) {
  return /^\s*\|.*\|\s*$/.test(lines[index] || '')
    && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || '');
}

export function splitMarkdownTableRow(line) {
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

export function cleanMarkdownText(value) {
  return cleanText(String(value || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`]/g, '')
    .replace(/<[^>]+>/g, ' '));
}
