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

// 单一现役直译源：只抽取正文文字，不生成或下载正文视觉素材。
const DOCUMENT_VERSION = 3;
const CHECKPOINT_VERSION = 3;
const DEFAULT_LIMITS = {
  maxSourceBytes: 12 * 1024 * 1024,
  maxPdfPages: 120,
  browserTimeoutMs: 45000,
  fetchTimeoutMs: 30000,
  maxRedirects: 5,
};
const BODY_BLOCK_TYPES = new Set(['heading', 'paragraph', 'quote', 'list_item']);
const EXCLUDED_CONTENT_SELECTOR = [
  'script', 'style', 'noscript', 'nav', 'form', 'aside',
  'body > header', 'body > footer', 'table', 'figure', 'figcaption',
  'picture', 'img', 'svg', 'canvas', 'video', 'audio', 'iframe', 'pre',
  '[aria-hidden="true"]', '[hidden]', '.advertisement', '.advert', '.ads',
  '.related-posts', '.recommended', '.comments', '#comments', '.cookie-banner',
  '.newsletter-signup', '.social-share',
].join(',');

export async function generateStructuredTranslation({
  input,
  workflow,
  writer,
  fetchFn,
  fetchWithRetry,
  completeArticle,
  onProgress,
  translationConfig = {},
  resumeFromCheckpoint = false,
}) {
  const sourceUrl = extractInputUrls(input)[0];
  if (!sourceUrl) throw new Error('直译任务缺少可读取的 http(s) 原文链接');

  await report(onProgress, {
    stage: 'source',
    message: '正在提取链接中的正文文字',
    completed: 0,
    total: 1,
  });
  const source = await acquireSourceDocument({
    sourceUrl,
    workDir: workflow.workDir,
    fetchFn,
    fetchWithRetry,
    config: translationConfig,
    dnsLookup: translationConfig.dnsLookup,
  });
  const manifest = buildDocumentManifest(source);
  await report(onProgress, {
    stage: 'structure',
    message: `已提取 ${manifest.blocks} 个正文文字块`,
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
    throw new Error(`直译完整性门禁失败:${completeness.errors.join('; ')}`);
  }
  await report(onProgress, {
    stage: 'validation',
    message: `正文文字完整性校验通过：${completeness.blocks} 个内容块`,
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
}) {
  const limits = limitsFor(config);
  await assertSafeHttpUrl(sourceUrl, { dnsLookup });
  fs.mkdirSync(workDir, { recursive: true });
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
    return acquireWithBrowser({ sourceUrl, workDir, config, limits, dnsLookup, acquisition });
  }

  const contentType = String(fetched.contentType || '').toLowerCase();
  const isPdf = contentType.includes('application/pdf')
    || /\.pdf(?:$|[?#])/i.test(fetched.finalUrl)
    || fetched.buffer.subarray(0, 4).toString() === '%PDF';
  if (isPdf) {
    acquisition.attempts.push('pdf-text');
    const document = sourceDocumentFromPdf({
      pdfBuffer: fetched.buffer,
      sourceUrl: fetched.finalUrl,
      workDir,
      limits,
    });
    document.acquisition = acquisition;
    return document;
  }

  const html = decodeHtmlBuffer(fetched.buffer, fetched.contentType);
  assertUsableArticleResponse(html, fetched.finalUrl);
  try {
    const document = await sourceDocumentFromHtml({
      html,
      sourceUrl: fetched.finalUrl,
      extractor: 'readability-static',
    });
    document.acquisition = acquisition;
    if (shouldUseBrowser(document, html) && config.browserEnabled !== false) {
      acquisition.fallbacks.push('browser:静态正文过短或疑似客户端渲染');
      return acquireWithBrowser({
        sourceUrl: fetched.finalUrl,
        workDir,
        config,
        limits,
        dnsLookup,
        acquisition,
      });
    }
    return document;
  } catch (error) {
    if (config.browserEnabled === false) throw error;
    acquisition.fallbacks.push(`browser:${safeError(error)}`);
    return acquireWithBrowser({
      sourceUrl: fetched.finalUrl,
      workDir,
      config,
      limits,
      dnsLookup,
      acquisition,
    });
  }
}

async function acquireWithBrowser({ sourceUrl, config, limits, dnsLookup, acquisition }) {
  acquisition.attempts.push('playwright-text');
  const rendered = await renderWithBrowser({ sourceUrl, config, limits, dnsLookup });
  assertUsableArticleResponse(rendered.html, rendered.finalUrl);
  const document = await sourceDocumentFromHtml({
    html: rendered.html,
    sourceUrl: rendered.finalUrl,
    extractor: 'readability-playwright',
  });
  document.acquisition = acquisition;
  return document;
}

export async function sourceDocumentFromHtml({
  html,
  sourceUrl,
  extractor = 'readability-static',
}) {
  const sourceDom = new JSDOM(String(html || ''), { url: sourceUrl });
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
  try {
    readable = new Readability(sourceDocument, { charThreshold: 80, keepClasses: false }).parse();
  } catch {}
  const fallback = sourceDocument.querySelector('article,main,[role="main"]') || sourceDocument.body;
  const bodyHtml = readable?.content || fallback?.innerHTML || '';
  const bodyDom = new JSDOM(`<main>${bodyHtml}</main>`, { url: sourceUrl });
  discardExcludedContent(bodyDom.window.document);
  const root = bodyDom.window.document.querySelector('main');
  const blocks = blocksFromDom(root);
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
}) {
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  const blocks = [];
  let paragraph = [];
  let blockIndex = 0;
  let inFence = false;
  let skippingTable = false;
  let referencesStarted = false;

  const push = (block) => {
    if (!block.text?.trim()) return;
    blocks.push({ ...block, id: `b${String(++blockIndex).padStart(6, '0')}`, order: blocks.length });
  };
  const flushParagraph = () => {
    const text = cleanMarkdownText(paragraph.join(' '));
    paragraph = [];
    if (text) push({ type: 'paragraph', text });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (/^```/.test(trimmed)) {
      flushParagraph();
      inFence = !inFence;
      continue;
    }
    if (inFence || referencesStarted) continue;
    if (isMarkdownTableStart(lines, index)) {
      flushParagraph();
      skippingTable = true;
      continue;
    }
    if (skippingTable) {
      if (/^\s*\|.*\|\s*$/.test(raw)) continue;
      skippingTable = false;
    }
    if (!trimmed) {
      flushParagraph();
      continue;
    }
    if (/^!\[/.test(trimmed) || /^<(?:table|figure|img|picture|svg|canvas)\b/i.test(trimmed)) {
      flushParagraph();
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      const text = cleanMarkdownText(heading[2]);
      if (isReferencesHeading(text)) {
        referencesStarted = true;
        continue;
      }
      push({ type: 'heading', level: heading[1].length, text });
      continue;
    }
    const list = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/.exec(raw);
    if (list) {
      flushParagraph();
      push({
        type: 'list_item',
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

  const firstHeading = blocks.find((block) => block.type === 'heading');
  const document = createSourceDocument({
    sourceType: 'notion',
    extractor,
    sourceUrl,
    title: cleanText(title || firstHeading?.text || new URL(sourceUrl).hostname),
    author,
    publishedDate,
    blocks,
    rawHashInput: String(markdown || ''),
  });
  assertSourceDocumentComplete(document);
  return document;
}

function sourceDocumentFromPdf({ pdfBuffer, sourceUrl, workDir, limits }) {
  const pdfPath = path.join(workDir, 'translation-source.pdf');
  fs.writeFileSync(pdfPath, pdfBuffer);
  const pages = assertPdfPageLimit(pdfPath, limits.maxPdfPages);
  const info = runCommand('pdfinfo', [pdfPath], { timeout: 15000 });
  const title = cleanPdfMeta(/^Title:\s+(.+)$/mi.exec(info)?.[1])
    || path.basename(new URL(sourceUrl).pathname, '.pdf')
    || 'PDF 原文';
  const author = cleanPdfMeta(/^Author:\s+(.+)$/mi.exec(info)?.[1]);
  const publishedDate = cleanPdfMeta(/^CreationDate:\s+(.+)$/mi.exec(info)?.[1]);
  const blocks = [];
  let blockIndex = 0;
  let referencesStarted = false;

  for (let page = 1; page <= pages && !referencesStarted; page += 1) {
    const text = runCommand('pdftotext', [
      '-f', String(page), '-l', String(page), '-raw', '-nopgbrk', pdfPath, '-',
    ], { timeout: 30000 });
    for (const paragraph of pdfParagraphs(text)) {
      const cleaned = cleanText(paragraph);
      if (!cleaned || isPdfNonBodyBlock(cleaned, page, pages)) continue;
      if (isReferencesHeading(cleaned)) {
        referencesStarted = true;
        break;
      }
      const heading = looksLikeHeading(cleaned);
      blocks.push({
        id: `b${String(++blockIndex).padStart(6, '0')}`,
        order: blocks.length,
        type: heading ? 'heading' : 'paragraph',
        ...(heading ? { level: 2 } : {}),
        text: cleaned,
        sourcePage: page,
      });
    }
  }
  const document = createSourceDocument({
    sourceType: 'pdf',
    extractor: 'poppler-text',
    sourceUrl,
    title,
    author,
    publishedDate,
    blocks,
    rawHashInput: pdfBuffer,
    pageCount: pages,
  });
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
  if (!units.length) throw new Error('原文没有可翻译的正文文字');
  const checkpointPath = path.join(workDir, 'translation-text-checkpoint.json');
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

  const batches = batchUnits(units.filter((unit) => !completed.has(unit.id)), 14000, 36);
  await report(onProgress, {
    stage: 'translation',
    message: completed.size
      ? `从纯文字断点继续翻译 ${completed.size}/${units.length}`
      : `开始翻译正文文字，共 ${units.length} 个文本单元`,
    completed: completed.size,
    total: units.length,
  });

  for (const batch of batches) {
    let translations = await requestTranslationBatch({
      batch, source, model, writer, fetchFn, completeArticle, timeoutMs,
    });
    let invalid = validateBatchTranslations(batch, translations);
    if (invalid.length) {
      const repaired = [];
      for (const unit of invalid) {
        repaired.push(...await requestTranslationBatch({
          batch: [unit],
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
      invalid = validateBatchTranslations(batch, translations);
    }
    if (invalid.length) {
      writeJsonAtomic(path.join(workDir, 'translation-text-invalid.json'), {
        failedAt: new Date().toISOString(),
        units: invalid.map((unit) => ({ id: unit.id, source: unit.text })),
      });
      throw new Error(`正文文字翻译校验失败:${invalid.map((unit) => unit.id).join(',')}`);
    }
    for (const item of translations) completed.set(item.id, item.text.trim());
    writeJsonAtomic(checkpointPath, {
      version: CHECKPOINT_VERSION,
      key: checkpointKey,
      translations: [...completed].map(([id, text]) => ({ id, text })),
      updatedAt: new Date().toISOString(),
    });
    await report(onProgress, {
      stage: 'translation',
      message: `正文文字翻译进度 ${completed.size}/${units.length}`,
      completed: completed.size,
      total: units.length,
    });
  }
  if (completed.size !== units.length) throw new Error(`正文文字翻译缺块:${completed.size}/${units.length}`);
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
    else if (block.type === 'paragraph') lines.push(text, '');
    else if (block.type === 'quote') lines.push(...String(text).split('\n').map((line) => `> ${line}`), '');
    else if (block.type === 'list_item') {
      const marker = block.ordered ? '1.' : '-';
      lines.push(`${'  '.repeat(block.depth || 0)}${marker} ${text}`, '');
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

export function validateTranslationArtifact({ source, translated, article }) {
  const errors = [];
  const sourceIds = source.blocks.map((block) => block.id);
  const translatedIds = translated.blocks.map((block) => block.id);
  if (sourceIds.join('|') !== translatedIds.join('|')) errors.push('正文文字块 ID 或顺序发生变化');
  if (source.blocks.some((block) => !BODY_BLOCK_TYPES.has(block.type))) errors.push('原文含非正文文字块');
  if (translated.blocks.some((block) => !BODY_BLOCK_TYPES.has(block.type))) errors.push('译文含非正文文字块');
  for (const unit of translationUnits(source)) {
    const target = translatedUnitText(translated, unit.id);
    if (!target?.trim()) errors.push(`译文为空:${unit.id}`);
    else if (!sameInvariantTokens(unit.text, target)) errors.push(`数字或链接不一致:${unit.id}`);
    else if (isClearlyUntranslated(unit.text, target)) errors.push(`疑似漏译英文正文:${unit.id}`);
  }
  const value = String(article || '');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) errors.push('译文含控制字符');
  if (/!\[[^\]]*\]\([^)]*\)|<(?:img|picture|svg|canvas|figure)\b/i.test(value)) errors.push('译文含图片内容');
  if (/^\s*\|.*\|\s*$/m.test(value) || /<table\b/i.test(value)) errors.push('译文含表格内容');
  return {
    errors,
    blocks: source.blocks.length,
    headings: source.blocks.filter((block) => block.type === 'heading').length,
    paragraphs: source.blocks.filter((block) => ['paragraph', 'quote', 'list_item'].includes(block.type)).length,
    sourceCharacters: translationUnits(source).reduce((sum, unit) => sum + unit.text.length, 0),
    contentMode: 'body-text-only',
  };
}

export function buildDocumentManifest(document) {
  return {
    version: document.version,
    contentMode: 'body-text-only',
    blocks: document.blocks.length,
    headings: document.blocks.filter((block) => block.type === 'heading').length,
    paragraphs: document.blocks.filter((block) => ['paragraph', 'quote', 'list_item'].includes(block.type)).length,
    blockOrder: document.blocks.map((block) => `${block.id}:${block.type}`),
    pageCount: document.pageCount || undefined,
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
  for (let redirects = 0; redirects <= limits.maxRedirects; redirects += 1) {
    const resolved = await resolveSafeHttpUrl(current, { dnsLookup });
    const requestFetch = fetchFn === globalThis.fetch ? pinnedHttpFetch(resolved.addresses) : fetchFn;
    const response = await callFetch(fetchWithRetry, requestFetch, current, {
      redirect: 'manual',
      headers: {
        Accept: accept || '*/*',
        'User-Agent': 'Mozilla/5.0 ZenTranslationBot/3.0',
        ...headers,
      },
    }, limits.fetchTimeoutMs);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await cancelResponseBody(response);
      if (!location) throw new Error(`原文重定向缺少 Location:${response.status}`);
      current = new URL(location, current).toString();
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

async function renderWithBrowser({ sourceUrl, config, limits, dnsLookup }) {
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
    try { await page.waitForLoadState('networkidle', { timeout: Math.min(15000, limits.browserTimeoutMs) }); } catch {}
    const finalUrl = page.url();
    await assertSafeHttpUrl(finalUrl, { dnsLookup });
    return { html: await page.content(), finalUrl };
  } finally {
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
      'Notion-Version': '2025-09-03',
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
- 只翻译正文文字，不总结、不改写、不删减，也不要补充任何图、图题、表、表题、表格数据或内容概括。
- 不改变数字、单位、Ticker 和正文中原有的 URL。
- 专有名词首次出现可保留英文，普通叙述必须翻译成中文。
${repair ? '- 输入中的 ⟦ZEN_KEEP_N⟧ 是不可翻译占位符，必须原样、原位置、各保留一次。' : ''}

文档标题:${source.title}
来源:${source.sourceUrl}

输入 JSON:
${JSON.stringify({ units })}`,
    model,
    writer: { ...writer, temperature: 0 },
    fetchFn,
    timeoutMs,
    systemPrompt: '你是严谨的正文文字翻译器。只翻译输入的正文文字，不处理或补充图片、图表、表格及其说明，只输出合法 JSON。',
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

function validateBatchTranslations(batch, translations) {
  const byId = new Map();
  for (const item of translations) {
    if (byId.has(item.id)) return batch;
    byId.set(item.id, item.text);
  }
  return batch.filter((unit) => {
    const text = byId.get(unit.id);
    return !text?.trim() || !sameInvariantTokens(unit.text, text) || isClearlyUntranslated(unit.text, text);
  });
}

function protectInvariantText(value) {
  const tokens = [];
  const text = String(value).replace(
    /https?:\/\/[^\s)\]}>"']+|[$€£¥]?[-+]?\d+(?:[,.]\d+)*(?:%|‰|[KMBT](?=\b))?/gi,
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
  return [
    { id: 'meta:title', text: document.title || '原文直译', kind: 'title' },
    ...document.blocks
      .filter((block) => BODY_BLOCK_TYPES.has(block.type) && block.text?.trim())
      .map((block) => ({ id: block.id, text: block.text, kind: block.type })),
  ];
}

function applyTranslations(source, completed) {
  const document = structuredClone(source);
  document.translatedTitle = completed.get('meta:title') || source.title;
  for (const block of document.blocks) block.translatedText = completed.get(block.id);
  return document;
}

function translatedUnitText(document, id) {
  if (id === 'meta:title') return document.translatedTitle;
  return document.blocks.find((block) => block.id === id)?.translatedText;
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
    ...(String(value).match(/https?:\/\/[^\s)\]}>"']+/gi) || []),
    ...(String(value).match(/\$[A-Z]{1,6}\b|\b(?:NASDAQ|NYSE|AMEX|OTC)\s*:\s*[A-Z]{1,6}\b/g) || []),
  ].sort();
  if (JSON.stringify(tokens(source)) !== JSON.stringify(tokens(translated))) return false;
  const sourceNumbers = invariantNumbers(source);
  const translatedNumbers = invariantNumbers(translated);
  if (JSON.stringify(sourceNumbers) === JSON.stringify(translatedNumbers)) return true;
  const monthNumber = englishMonthNumber(source);
  return Boolean(monthNumber)
    && JSON.stringify([...sourceNumbers, monthNumber].sort()) === JSON.stringify(translatedNumbers);
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
    contentMode: 'body-text-only',
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

function blocksFromDom(root) {
  if (!root) return [];
  const blocks = [];
  let blockIndex = 0;
  let referencesStarted = false;
  for (const node of root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,blockquote,li')) {
    if (referencesStarted) break;
    if (node.closest(EXCLUDED_CONTENT_SELECTOR)) continue;
    if (node.tagName === 'P' && node.closest('blockquote,li')) continue;
    if (node.tagName === 'BLOCKQUOTE' && node.closest('li')) continue;
    const text = textFromBodyNode(node);
    if (!text) continue;
    if (/^H[1-6]$/.test(node.tagName) && isReferencesHeading(text)) {
      referencesStarted = true;
      continue;
    }
    let type = 'paragraph';
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
      id: `b${String(++blockIndex).padStart(6, '0')}`,
      order: blocks.length,
      type,
      ...block,
      text,
    });
  }
  return blocks;
}

function textFromBodyNode(node) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll(EXCLUDED_CONTENT_SELECTOR).forEach((child) => child.remove());
  if (node.tagName === 'LI') clone.querySelectorAll('ol,ul').forEach((child) => child.remove());
  return cleanText(clone.textContent);
}

function discardExcludedContent(document) {
  document.querySelectorAll(EXCLUDED_CONTENT_SELECTOR).forEach((node) => node.remove());
}

function assertSourceDocumentComplete(document) {
  if (!document.blocks?.length) throw new Error('原文正文文字提取结果为空');
  if (document.blocks.some((block) => !BODY_BLOCK_TYPES.has(block.type))) {
    throw new Error('原文提取结果含非正文文字内容');
  }
  const textLength = translationUnits(document).reduce((sum, unit) => sum + unit.text.length, 0);
  if (document.sourceType === 'html' && textLength < 300) throw new Error(`网页正文过短:${textLength} 字符`);
}

function shouldUseBrowser(document, html) {
  const textLength = translationUnits(document).reduce((sum, unit) => sum + unit.text.length, 0);
  return (textLength < 500 || document.blocks.length < 3)
    && /<(?:script|div)[^>]+id=["'](?:__next|__nuxt|app|root)["']/i.test(html);
}

function pdfParagraphs(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (!line.trim()) {
      if (current.length) blocks.push(current.join(' '));
      current = [];
      continue;
    }
    if (isPdfTableLikeLine(line)) {
      if (current.length) blocks.push(current.join(' '));
      current = [];
      continue;
    }
    current.push(line.trim());
  }
  if (current.length) blocks.push(current.join(' '));
  return blocks;
}

function isPdfTableLikeLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return false;
  if (/^(?:Table|Figure|Fig\.)\s*\d+\b/i.test(trimmed)) return true;
  if (/^\|.*\|$/.test(trimmed)) return true;
  const columns = trimmed.split(/\s{2,}/).filter(Boolean);
  if (columns.length >= 3) return true;
  if (columns.length >= 2 && columns.filter((value) => /\d/.test(value)).length >= 2) return true;
  return false;
}

function isPdfNonBodyBlock(text, page, pages) {
  if (/^\d{1,4}$/.test(text) && Number(text) >= 1 && Number(text) <= pages) return true;
  if (new RegExp(`^${page}$`).test(text)) return true;
  return /^(?:Table|Figure|Fig\.)\s*\d+\b/i.test(text);
}

function looksLikeHeading(text) {
  const words = String(text).split(/\s+/);
  return text.length <= 100 && words.length <= 12 && !/[.!?。！？]$/.test(text);
}

function isReferencesHeading(text) {
  return /^(?:references|bibliography|works cited|参考文献|引用文献)\s*[:：]?$/i.test(cleanText(text));
}

function isMarkdownTableStart(lines, index) {
  return /^\s*\|.*\|\s*$/.test(lines[index] || '')
    && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || '');
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
  return `来源：《${document.title || '未知标题'}》，作者 ${document.author || '未知'}，发布于 ${site}，原文链接 ${document.sourceUrl}，发布日期 ${document.publishedDate || '未知'}。`;
}

export function assertPdfPageLimit(pdfPath, maxPdfPages, spawn = spawnSync) {
  const result = spawn('pdfinfo', [pdfPath], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    killSignal: 'SIGKILL',
  });
  if (result.error?.code === 'ENOENT') throw new Error('PDF 文字提取缺少 Poppler 命令 pdfinfo');
  if (result.error) throw new Error(`PDF 页数检查失败:${safeError(result.error)}`);
  if (result.status !== 0) throw new Error(`PDF 页数检查失败:${String(result.stderr || '').slice(0, 300)}`);
  const pages = Number(/^Pages:\s+(\d+)/mi.exec(result.stdout || '')?.[1] || 0);
  if (!pages) throw new Error('PDF 页数识别失败');
  if (pages > maxPdfPages) throw new Error(`PDF 页数超过上限:${pages}/${maxPdfPages}`);
  return pages;
}

function runCommand(command, args, { timeout = 30000 } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    killSignal: 'SIGKILL',
  });
  if (result.error?.code === 'ENOENT') throw new Error(`PDF 文字提取缺少 Poppler 命令 ${command}`);
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

function limitsFor(config) {
  return {
    maxSourceBytes: positive(config.maxSourceBytes, DEFAULT_LIMITS.maxSourceBytes),
    maxPdfPages: positive(config.maxPdfPages, DEFAULT_LIMITS.maxPdfPages),
    browserTimeoutMs: positive(config.browserTimeoutMs, DEFAULT_LIMITS.browserTimeoutMs),
    fetchTimeoutMs: positive(config.fetchTimeoutMs, DEFAULT_LIMITS.fetchTimeoutMs),
    maxRedirects: nonNegative(config.maxRedirects, DEFAULT_LIMITS.maxRedirects),
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
