import { escapeHtml, cleanText, clamp } from './shared.js';


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
      const ordinal = Number.isInteger(block.ordinal) ? block.ordinal : 1;
      const marker = block.ordered ? `${ordinal}${block.delimiter === ')' ? ')' : '.'}` : '-';
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
    pageCoverage: document.pageCoverage,
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

export function sourceAttribution(document) {
  const site = (() => { try { return new URL(document.sourceUrl).hostname; } catch { return '未知'; } })();
  return [
    '> **原文信息**',
    `> 原文：《${document.title || '未知标题'}》`,
    `> 作者：${document.author || '未知'}`,
    `> 来源：[${site}](${document.sourceUrl})`,
  ].join('\n');
}

export function normalizeTranslatedTitle(value) {
  return cleanText(value)
    .replace(/\s*(?:（\s*译(?:文)?\s*）|\(\s*译(?:文)?\s*\)|【\s*译(?:文)?\s*】|\[\s*译(?:文)?\s*\]|译文|翻译)\s*$/i, '')
    .trim();
}

export function restoreFragments(value, fragments = []) {
  let text = String(value || '');
  for (const fragment of fragments || []) text = text.replaceAll(fragment.token, fragment.value);
  return text;
}

export function captionLine(label, caption) {
  return `<p style="text-align:center;color:#7b8490;font-size:.78em;line-height:1.55;margin:.35em 0 1.2em">${escapeHtml(label)}：${escapeHtml(caption)}</p>`;
}

export function escapeMarkdownAlt(value) {
  return String(value || '').replace(/[[\]\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function sameLooseText(left, right) {
  const normalize = (value) => cleanText(value).replace(/[（(]译[）)]$/, '').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
  return normalize(left) === normalize(right);
}

export function normalizeComparableText(value) {
  return cleanText(value).replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
}

export function isAcademicBodyStart(value) {
  const normalized = normalizeComparableText(value)
    .replace(/^(?:section)?\d+(?:\d+)*/, '');
  return /^(?:abstract|摘要|introduction|引言|executivesummary|执行摘要)$/.test(normalized);
}
