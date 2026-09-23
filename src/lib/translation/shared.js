import fs from 'node:fs';


// Single active translation source: retain document structure and visual assets while replacing only translatable units.
export const DOCUMENT_VERSION = 5;
export const CHECKPOINT_VERSION = 6;
export const TRANSLATION_BATCH_MAX_CHARS = 8000;
export const TRANSLATION_BATCH_MAX_ITEMS = 24;
export const TRANSLATION_SHORT_UNIT_MAX_ITEMS = 48;
export const TRANSLATION_SHORT_UNIT_AVERAGE_CHARS = 120;
export const REPAIR_BATCH_MAX_CHARS = 4000;
export const REPAIR_BATCH_MAX_ITEMS = 6;
// Checkpoint files are rewritten whole on every save; throttle per-unit saves so a large
// document does not reserialize the checkpoint after every accepted block.
export const CHECKPOINT_WRITE_THROTTLE_MS = 3000;
export const EMBEDDED_CHART_MIN_WIDTH = 200;
export const EMBEDDED_CHART_MIN_HEIGHT = 120;
export const EMBEDDED_CHART_MAX_WIDTH = 2400;
export const EMBEDDED_CHART_MAX_HEIGHT = 5000;
export const EMBEDDED_CHART_MAX_PIXELS = 8_000_000;
export const EMBEDDED_CHART_MIN_PNG_BYTES = 4096;
export const DEFAULT_LIMITS = {
  maxSourceBytes: 50 * 1024 * 1024,
  maxPdfPages: 120,
  browserTimeoutMs: 45000,
  fetchTimeoutMs: 30000,
  maxRedirects: 5,
  maxAssetCount: 80,
  maxAssetBytes: 40 * 1024 * 1024,
  maxSingleAssetBytes: 10 * 1024 * 1024,
};
export const DOCUMENT_BLOCK_TYPES = new Set([
  'heading', 'paragraph', 'quote', 'list_item', 'figure', 'table', 'equation', 'code', 'reference',
]);
export const EXCLUDED_CONTENT_SELECTOR = [
  'script', 'style', 'noscript', 'nav', 'form', 'aside',
  'body > header', 'body > footer', 'video', 'audio', 'iframe',
  '[aria-hidden="true"]', '[hidden]', '.advertisement', '.advert', '.ads',
  '.related-posts', '.recommended', '.comments', '#comments', '.cookie-banner',
  '.newsletter-signup', '.social-share',
].join(',');

export function translationUnits(document) {
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

export function applyTranslations(source, completed) {
  const document = structuredClone(source);
  document.translatedTitle = completed.get('meta:title') || source.title;
  for (const block of document.blocks) {
    if (completed.has(block.id)) {
      block.translatedText = normalizeKnownFinancialTerms(block.text, completed.get(block.id));
    }
    if (completed.has(`${block.id}:caption`)) {
      block.translatedCaption = normalizeKnownFinancialTerms(
        block.caption,
        completed.get(`${block.id}:caption`),
      );
    }
  }
  return document;
}

export function normalizeKnownFinancialTerms(source, translated) {
  let value = String(translated || '');
  if (/\bpre-fee\b/i.test(String(source || ''))) {
    value = value.replace(/税前(?=(?:回报|收益))/g, '费用前');
  }
  return value;
}

export function translatedUnitText(document, id) {
  if (id === 'meta:title') return document.translatedTitle;
  const direct = document.blocks.find((block) => block.id === id);
  if (direct) return direct.translatedText;
  const caption = /^(b\d+):caption$/.exec(id);
  if (caption) return document.blocks.find((block) => block.id === caption[1])?.translatedCaption;
  return undefined;
}

export function discardExcludedContent(document) {
  for (const frame of [...document.querySelectorAll('iframe[src]')]) {
    const rawSrc = cleanText(frame.getAttribute('src') || '');
    let url;
    try { url = new URL(rawSrc, document.URL); } catch { continue; }
    const hostname = url.hostname.replace(/^www\./, '').toLowerCase();
    if (!['youtube.com', 'youtu.be', 'vimeo.com', 'player.vimeo.com'].includes(hostname)) continue;
    const paragraph = document.createElement('p');
    const link = document.createElement('a');
    link.setAttribute('href', url.href);
    link.textContent = cleanText(frame.getAttribute('title') || '') || '原文视频';
    paragraph.appendChild(link);
    frame.replaceWith(paragraph);
  }
  for (const heading of document.querySelectorAll('h1[aria-label],h2[aria-label],h3[aria-label],h4[aria-label],h5[aria-label],h6[aria-label]')) {
    if (!heading.querySelector('[aria-hidden="true"]')) continue;
    const accessibleText = cleanText(heading.getAttribute('aria-label') || '');
    if (accessibleText) heading.textContent = accessibleText;
  }
  document.querySelectorAll(EXCLUDED_CONTENT_SELECTOR).forEach((node) => node.remove());
}

export function titleAnchoredContentRoot(document, title) {
  const normalizedTitle = normalizedHeading(title);
  const headings = [...document.querySelectorAll('h1')];
  const heading = headings.find((candidate) => {
    const value = normalizedHeading(candidate.textContent);
    return value && normalizedTitle
      && (normalizedTitle.includes(value) || value.includes(normalizedTitle));
  }) || (headings.length === 1 ? headings[0] : undefined);
  if (!heading) return undefined;

  for (let candidate = heading.parentElement;
    candidate && !['BODY', 'HTML'].includes(candidate.tagName);
    candidate = candidate.parentElement) {
    const textLength = cleanText(candidate.textContent).length;
    const paragraphs = candidate.querySelectorAll('p').length;
    const headingsCount = candidate.querySelectorAll('h1,h2,h3,h4,h5,h6').length;
    if (textLength >= 800 && paragraphs >= 3 && (headingsCount >= 2 || paragraphs >= 6)) {
      return candidate;
    }
  }
  return undefined;
}

export function richestArticle(articles = []) {
  return [...articles].sort((left, right) => {
    const score = (node) => cleanText(node.textContent).length
      + node.querySelectorAll('h1,h2,h3,h4,h5,h6,p,figure,table,pre').length * 80;
    return score(right) - score(left);
  })[0];
}

export function normalizedHeading(value) {
  return cleanText(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function metadata(document, selectors, ...attributes) {
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

export function parseJsonPayload(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*|\s*```$/gi, '');
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return undefined;
}

export function limitsFor(config) {
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

export function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function nonNegative(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

export function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanTextPreservingLines(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function cleanPdfMeta(value) {
  const text = cleanText(value);
  return /^(?:none|unknown|untitled)$/i.test(text) ? '' : text;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

export function safeError(error) {
  return String(error?.message || error || '未知错误').slice(0, 300);
}

export async function report(onProgress, progress) {
  if (!onProgress) return;
  try { await onProgress(progress); }
  catch (error) { console.error(`[translate] 进度通知失败(已忽略): ${safeError(error)}`); }
}

export function writeJsonAtomic(target, value) {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
    fs.renameSync(temporary, target);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}
