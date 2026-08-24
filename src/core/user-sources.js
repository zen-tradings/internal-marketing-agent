import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isGoogleDocUrl } from '../lib/google-docs.js';
import { isLinearIssueUrl } from '../lib/linear.js';
import {
  acquireSourceDocument,
  assertPdfPageLimit,
  assertPdfResponse,
  safeFetchResource,
} from '../workflows/translation-source-text.js';

const MAX_SLACK_ATTACHMENTS = 4;
const MAX_GITHUB_FILES = 10;
const MAX_GITHUB_FILE_BYTES = 512 * 1024;
const MAX_GITHUB_TOTAL_CHARS = 60000;
const MAX_OFFICIAL_MIRROR_BYTES = 4 * 1024 * 1024;
const MAX_OFFICIAL_MIRROR_CANDIDATES = 4;
const TEXT_FILE_RE = /\.(?:md|mdx|txt|json|ya?ml|toml|ini|js|mjs|cjs|jsx|ts|tsx|py|go|rs|java|kt|kts|swift|rb|php|c|cc|cpp|h|hpp|cs|sh|sql|html|css|scss|vue|svelte)$/i;
const execFileAsync = promisify(execFile);

export function normalizeSlackAttachments(files, maxFiles = MAX_SLACK_ATTACHMENTS) {
  if (!Array.isArray(files)) return [];
  const seen = new Set();
  return files.map((file) => {
    const url = String(file?.url_private_download || file?.url_private || file?.url || '').trim();
    if (!url || seen.has(url)) return null;
    seen.add(url);
    return {
      id: String(file?.id || '').trim(),
      name: String(file?.name || file?.title || 'Slack attachment').trim().slice(0, 240),
      mimetype: String(file?.mimetype || '').trim().toLowerCase(),
      filetype: String(file?.filetype || '').trim().toLowerCase(),
      size: Number(file?.size || 0),
      url,
      permalink: String(file?.permalink || '').trim(),
    };
  }).filter(Boolean).slice(0, maxFiles);
}

export function attachmentsFromSlackMessages(messages, maxFiles = MAX_SLACK_ATTACHMENTS) {
  const merged = [];
  const seen = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const attachment of normalizeSlackAttachments(message?.attachments, maxFiles)) {
      if (seen.has(attachment.url)) continue;
      seen.add(attachment.url);
      merged.push(attachment);
      if (merged.length >= maxFiles) return merged;
    }
  }
  return merged;
}

export function translationAttachment(attachments) {
  return (Array.isArray(attachments) ? attachments : []).find(isPdfAttachment);
}

export function isDirectUserUrl(rawUrl) {
  return Boolean(directUrlKind(rawUrl));
}

export function sourceRequestHeadersForAttachment(attachment, slackBotToken) {
  if (!attachment?.url || !isSlackPrivateUrl(attachment.url) || !slackBotToken) return {};
  return { Authorization: `Bearer ${slackBotToken}` };
}

export async function loadDirectUserSources({
  userUrls = [],
  attachments = [],
  workDir,
  config,
  fetchFn = globalThis.fetch,
  fetchWithRetry,
  signal,
  trace,
}) {
  const descriptors = directDescriptors(userUrls, attachments);
  if (!descriptors.length) return { sources: [], handledUrls: [], errors: [] };
  const settled = await Promise.allSettled(descriptors.map((descriptor, index) =>
    loadDescriptor({
      descriptor,
      index,
      workDir,
      config,
      fetchFn,
      fetchWithRetry,
      signal,
      trace,
    })));
  const sources = [];
  const errors = [];
  settled.forEach((result, index) => {
    const descriptor = descriptors[index];
    if (result.status === 'fulfilled') sources.push(result.value);
    else errors.push({
      kind: descriptor.kind,
      url: descriptor.originalUrl,
      name: descriptor.name,
      error: safeError(result.reason),
    });
  });
  return {
    sources,
    handledUrls: descriptors.filter((descriptor) => descriptor.kind !== 'slack').map((descriptor) => descriptor.originalUrl),
    errors,
  };
}

// Some regulator download hosts reject normal server traffic while publishing the
// same filing inside an official, machine-readable attachment. Recovery is kept
// deliberately narrow: a document number must first be discovered in the search
// material, the replacement must stay on the regulator's official domain, and
// the fetched text must match both the agency and the original filename topic.
export async function recoverOfficialDocumentMirrors({
  userUrls = [],
  discoverySources = [],
  config,
  fetchFn = globalThis.fetch,
  fetchWithRetry,
}) {
  const sources = [];
  const attempts = [];
  for (const originalUrl of Array.isArray(userUrls) ? userUrls : []) {
    const descriptor = fccMirrorDescriptor(originalUrl, discoverySources);
    if (!descriptor) continue;
    let recovered = false;
    for (const documentId of descriptor.documentIds.slice(0, MAX_OFFICIAL_MIRROR_CANDIDATES)) {
      const mirrorUrl = `https://docs.fcc.gov/public/attachments/${documentId}A1.txt`;
      const attempt = { originalUrl, mirrorUrl, documentId, status: 'running' };
      attempts.push(attempt);
      try {
        const fetched = await safeFetchResource({
          url: mirrorUrl,
          fetchFn,
          fetchWithRetry,
          dnsLookup: config?.translation?.dnsLookup,
          accept: 'text/plain;charset=UTF-8,*/*;q=0.2',
          maxBytes: MAX_OFFICIAL_MIRROR_BYTES,
        });
        const text = fetched.buffer.toString('utf8').replace(/\u0000/g, '').trim();
        if (!isMatchingFccMirror(text, descriptor, documentId)) {
          attempt.status = 'rejected-mismatch';
          continue;
        }
        attempt.status = 'ok';
        attempt.textLength = text.length;
        sources.push({
          title: `${documentId} | Federal Communications Commission`,
          url: mirrorUrl,
          text,
          publishedDate: null,
          userSpecified: true,
          official: true,
          retrievalLane: 'user-recovery',
          sourceType: 'official-document-mirror',
          extractor: 'fcc-docs-text',
          recoveredForUserUrl: originalUrl,
        });
        recovered = true;
        break;
      } catch (error) {
        attempt.status = 'failed';
        attempt.error = safeError(error).slice(0, 240);
      }
    }
    if (!recovered && !descriptor.documentIds.length) {
      attempts.push({ originalUrl, status: 'no-document-id' });
    }
  }
  return { sources, attempts };
}

function directDescriptors(userUrls, attachments) {
  const descriptors = [];
  const seen = new Set();
  for (const rawUrl of Array.isArray(userUrls) ? userUrls : []) {
    const originalUrl = String(rawUrl || '').trim();
    if (!originalUrl || seen.has(originalUrl)) continue;
    const kind = directUrlKind(originalUrl);
    if (!kind) continue;
    seen.add(originalUrl);
    descriptors.push({ kind, originalUrl, acquisitionUrl: originalUrl, name: '' });
  }
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (!isReadableAttachment(attachment)) continue;
    const originalUrl = String(attachment.url || '').trim();
    if (!originalUrl || seen.has(originalUrl)) continue;
    seen.add(originalUrl);
    descriptors.push({
      kind: 'slack',
      originalUrl,
      acquisitionUrl: originalUrl,
      name: attachment.name || 'Slack attachment',
      attachment,
    });
  }
  return descriptors;
}

async function loadDescriptor({
  descriptor,
  index,
  workDir,
  config,
  fetchFn,
  fetchWithRetry,
  signal,
  trace,
}) {
  const event = startUserSourceTrace(trace, descriptor);
  try {
    if (descriptor.kind === 'github') {
      const source = await loadGithubSource({
        descriptor,
        config,
        fetchFn,
        fetchWithRetry,
      });
      finishUserSourceTrace(event, source);
      return source;
    }

    const translationConfig = config?.translation || {};
    const documentConfig = config?.documents || {};
    const sourceDir = path.join(workDir, 'user-sources', `source-${index + 1}`);
    const acquisitionUrl = descriptor.acquisitionUrl;
    let requestHeaders = {};
    if (descriptor.kind === 'slack') {
      requestHeaders = sourceRequestHeadersForAttachment(descriptor.attachment, config?.slack?.botToken);
      if (!isPdfAttachment(descriptor.attachment)) {
        const fetched = await safeFetchResource({
          url: acquisitionUrl,
          fetchFn,
          fetchWithRetry,
          headers: requestHeaders,
          accept: 'text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5',
          maxBytes: Math.min(
            Number(config?.translation?.maxSourceBytes || 50 * 1024 * 1024),
            4 * 1024 * 1024,
          ),
        });
        const text = fetched.buffer.toString('utf8').replace(/\u0000/g, '').trim();
        if (!text) throw new Error('Slack 文本附件为空');
        const source = {
          title: descriptor.name || sourceTitleFromUrl(descriptor.originalUrl),
          url: descriptor.originalUrl,
          text,
          publishedDate: null,
          userSpecified: true,
          retrievalLane: 'user-file',
          sourceType: 'text',
          extractor: 'slack-private-file',
          attachment: {
            id: descriptor.attachment.id,
            name: descriptor.attachment.name,
            mimetype: descriptor.attachment.mimetype,
            size: descriptor.attachment.size,
          },
        };
        finishUserSourceTrace(event, source);
        return source;
      }
    }
    if (isPdfDescriptor(descriptor) && !translationConfig.datalabApiKey) {
      const source = await loadPdfTextFallback({
        descriptor,
        acquisitionUrl,
        requestHeaders,
        sourceDir,
        config: translationConfig,
        fetchFn,
        fetchWithRetry,
      });
      finishUserSourceTrace(event, source);
      return source;
    }
    const document = await acquireSourceDocument({
      sourceUrl: acquisitionUrl,
      workDir: sourceDir,
      fetchFn,
      fetchWithRetry,
      config: translationConfig,
      documentConfig,
      dnsLookup: translationConfig.dnsLookup,
      requestHeaders,
      scope: { kind: 'all' },
      signal,
    });
    const source = documentToResearchSource(document, descriptor);
    finishUserSourceTrace(event, source);
    return source;
  } catch (error) {
    failUserSourceTrace(event, error);
    throw error;
  }
}

async function loadPdfTextFallback({
  descriptor,
  acquisitionUrl,
  requestHeaders,
  sourceDir,
  config,
  fetchFn,
  fetchWithRetry,
}) {
  const fetched = await safeFetchResource({
    url: acquisitionUrl,
    fetchFn,
    fetchWithRetry,
    dnsLookup: config.dnsLookup,
    headers: requestHeaders,
    accept: 'application/pdf,*/*;q=0.5',
    maxBytes: Number(config.maxSourceBytes || 50 * 1024 * 1024),
  });
  assertPdfResponse({
    buffer: fetched.buffer,
    sourceUrl: descriptor.originalUrl,
    finalUrl: fetched.finalUrl,
    contentType: fetched.contentType,
  });
  await fs.mkdir(sourceDir, { recursive: true });
  const pdfPath = path.join(sourceDir, 'source.pdf');
  await fs.writeFile(pdfPath, fetched.buffer);
  await assertPdfPageLimit(pdfPath, Number(config.maxPdfPages || 120));
  let stdout;
  try {
    ({ stdout } = await execFileAsync('pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, '-'], {
      encoding: 'utf8',
      timeout: Number(config.fetchTimeoutMs || 30000) * 2,
      maxBuffer: 12 * 1024 * 1024,
    }));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('分析型 PDF 文字提取缺少 Poppler pdftotext；请安装 Poppler 或配置 DATALAB_API_KEY');
    }
    throw new Error(`分析型 PDF 文字提取失败:${safeError(error)}`);
  }
  const text = String(stdout || '').replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').trim();
  if (text.length < 40) throw new Error('PDF 未提取到足够文字；扫描件请配置 DATALAB_API_KEY 启用 OCR');
  return {
    title: descriptor.name || sourceTitleFromUrl(descriptor.originalUrl),
    url: descriptor.originalUrl,
    text,
    publishedDate: null,
    userSpecified: true,
    retrievalLane: descriptor.kind === 'slack' ? 'user-file' : 'user-document',
    sourceType: 'pdf',
    extractor: 'poppler-pdftotext',
    ...(descriptor.attachment ? {
      attachment: {
        id: descriptor.attachment.id,
        name: descriptor.attachment.name,
        mimetype: descriptor.attachment.mimetype,
        size: descriptor.attachment.size,
      },
    } : {}),
  };
}

function documentToResearchSource(document, descriptor) {
  const text = document.blocks.map(blockText).filter(Boolean).join('\n\n').trim();
  if (!text) throw new Error('文档解析后没有可用正文');
  return {
    title: document.title || descriptor.name || sourceTitleFromUrl(descriptor.originalUrl),
    url: descriptor.originalUrl,
    text,
    publishedDate: document.publishedDate || null,
    userSpecified: true,
    retrievalLane: descriptor.kind === 'slack' ? 'user-file' : 'user-document',
    sourceType: document.sourceType,
    extractor: document.extractor,
    contentHash: document.sha256,
    ...(descriptor.attachment ? {
      attachment: {
        id: descriptor.attachment.id,
        name: descriptor.attachment.name,
        mimetype: descriptor.attachment.mimetype,
        size: descriptor.attachment.size,
      },
    } : {}),
  };
}

function blockText(block) {
  if (!block || typeof block !== 'object') return '';
  if (block.type === 'table' && Array.isArray(block.rows)) {
    return block.rows.map((row) => Array.isArray(row) ? row.join(' | ') : String(row || '')).join('\n');
  }
  if (block.type === 'figure') {
    return [block.caption, block.alt, block.title].filter(Boolean).join(' ');
  }
  if (block.type === 'equation') return block.tex || block.text || '';
  return String(block.text || block.markdown || block.caption || '').trim();
}

async function loadGithubSource({ descriptor, config, fetchFn, fetchWithRetry }) {
  const parsed = parseGithubUrl(descriptor.originalUrl);
  if (!parsed) throw new Error('无法识别 GitHub 仓库或文件链接');
  const token = config?.documents?.githubToken;
  const dnsLookup = config?.translation?.dnsLookup;
  const headers = {
    Accept: 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const metadata = await fetchJsonResource({
    url: `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
    headers,
    fetchFn,
    fetchWithRetry,
    dnsLookup,
    maxBytes: 2 * 1024 * 1024,
  });
  const ref = parsed.ref || metadata.default_branch || 'main';
  const paths = parsed.filePath
    ? [parsed.filePath]
    : await selectGithubPaths({ parsed, ref, headers, fetchFn, fetchWithRetry, dnsLookup });
  const fileResults = await Promise.allSettled(paths.map(async (filePath) => {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const fetched = await safeFetchResource({
      url: `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      fetchFn,
      fetchWithRetry,
      dnsLookup,
      headers: { ...headers, Accept: 'application/vnd.github.raw+json' },
      accept: 'application/vnd.github.raw+json,text/plain;q=0.9,*/*;q=0.5',
      maxBytes: MAX_GITHUB_FILE_BYTES,
    });
    return {
      path: filePath,
      text: fetched.buffer.toString('utf8').replace(/\u0000/g, '').trim(),
    };
  }));
  let chars = 0;
  const sections = [];
  for (const result of fileResults) {
    if (result.status !== 'fulfilled' || !result.value.text) continue;
    const remaining = MAX_GITHUB_TOTAL_CHARS - chars;
    if (remaining <= 0) break;
    const text = result.value.text.slice(0, remaining);
    sections.push(`FILE: ${result.value.path}\n${text}`);
    chars += text.length;
  }
  if (!sections.length) throw new Error('GitHub 仓库没有读取到可分析的文本文件');
  const description = [
    `Repository: ${metadata.full_name || `${parsed.owner}/${parsed.repo}`}`,
    `Description: ${metadata.description || ''}`,
    `Default branch: ${metadata.default_branch || ref}`,
    `Primary language: ${metadata.language || 'unknown'}`,
  ].join('\n');
  return {
    title: metadata.full_name || `${parsed.owner}/${parsed.repo}`,
    url: descriptor.originalUrl,
    text: `${description}\n\n${sections.join('\n\n')}`,
    publishedDate: metadata.pushed_at || metadata.updated_at || null,
    userSpecified: true,
    retrievalLane: 'user-code',
    sourceType: 'code-repository',
    extractor: 'github-rest-parallel',
  };
}

async function selectGithubPaths({ parsed, ref, headers, fetchFn, fetchWithRetry, dnsLookup }) {
  const tree = await fetchJsonResource({
    url: `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    headers,
    fetchFn,
    fetchWithRetry,
    dnsLookup,
    maxBytes: 8 * 1024 * 1024,
  });
  return (Array.isArray(tree.tree) ? tree.tree : [])
    .filter((entry) => entry?.type === 'blob' && Number(entry.size || 0) <= MAX_GITHUB_FILE_BYTES)
    .filter((entry) => TEXT_FILE_RE.test(entry.path || '') || isImportantCodeFile(entry.path))
    .filter((entry) => !/(?:^|\/)(?:node_modules|vendor|dist|build|coverage|fixtures?|snapshots?|generated)(?:\/|$)/i.test(entry.path))
    .map((entry) => ({ path: entry.path, score: githubPathScore(entry.path) }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, MAX_GITHUB_FILES)
    .map((entry) => entry.path);
}

function githubPathScore(filePath) {
  const base = path.posix.basename(filePath).toLowerCase();
  if (/^readme(?:\.|$)/i.test(base)) return 120;
  if (/^(?:agents|claude)\.md$/i.test(base)) return 115;
  if (/^(?:package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|build\.gradle|gemfile)$/i.test(base)) return 105;
  if (/(?:^|\/)(?:src|app|lib)\/(?:index|main|app)\.[^.]+$/i.test(filePath)) return 100;
  if (/(?:^|\/)(?:src|app|lib)\//i.test(filePath)) return 80;
  if (/(?:^|\/)(?:test|tests|spec)\//i.test(filePath)) return 45;
  return 30;
}

function isImportantCodeFile(filePath) {
  return /(?:^|\/)(?:README(?:\.[^/]+)?|AGENTS\.md|CLAUDE\.md|Gemfile|Dockerfile|Makefile|pom\.xml|package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/i.test(filePath || '');
}

async function fetchJsonResource({ url, headers, fetchFn, fetchWithRetry, dnsLookup, maxBytes }) {
  const fetched = await safeFetchResource({
    url,
    fetchFn,
    fetchWithRetry,
    dnsLookup,
    headers,
    accept: 'application/vnd.github+json,application/json',
    maxBytes,
  });
  try { return JSON.parse(fetched.buffer.toString('utf8')); }
  catch { throw new Error('GitHub API 返回了无效 JSON'); }
}

function parseGithubUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return undefined; }
  if (!['github.com', 'www.github.com'].includes(url.hostname.toLowerCase())) return undefined;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return undefined;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!owner || !repo) return undefined;
  if (parts[2] === 'blob' && parts.length >= 5) {
    return { owner, repo, ref: parts[3], filePath: parts.slice(4).join('/') };
  }
  return { owner, repo };
}

function fccMirrorDescriptor(rawUrl, discoverySources) {
  let url;
  try { url = new URL(rawUrl); } catch { return undefined; }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'fcc.gov' || !/\.pdf$/i.test(url.pathname)) return undefined;
  const topicTokens = documentTopicTokens(path.posix.basename(url.pathname));
  if (!topicTokens.length) return undefined;
  const documentIds = [];
  const seen = new Set();
  for (const source of Array.isArray(discoverySources) ? discoverySources : []) {
    const searchable = [
      source?.title,
      source?.text,
      source?.summary,
      ...(Array.isArray(source?.highlights) ? source.highlights : []),
    ].filter(Boolean).join('\n');
    const matches = searchable.matchAll(/\bDA[\s-]*(\d{2})[\s-]*(\d{3,4})\b/gi);
    for (const match of matches) {
      const id = `DA-${match[1]}-${match[2]}`;
      if (seen.has(id)) continue;
      seen.add(id);
      documentIds.push(id);
    }
  }
  return { originalUrl: rawUrl, topicTokens, documentIds };
}

function documentTopicTokens(filename) {
  const stop = new Set([
    'document', 'draft', 'fcc', 'file', 'final', 'national', 'nsd', 'pdf', 'report',
    'security', 'the', 'determination',
  ]);
  return [...new Set(safeDecodeFilename(filename)
    .toLowerCase()
    .replace(/\.pdf$/i, '')
    .split(/[^a-z0-9]+/)
    .map((token) => token.length > 5 && token.endsWith('s') ? token.slice(0, -1) : token)
    .filter((token) => token.length >= 4 && !stop.has(token)))];
}

function safeDecodeFilename(value) {
  try { return decodeURIComponent(String(value || '')); }
  catch { return String(value || ''); }
}

function isMatchingFccMirror(text, descriptor, documentId) {
  if (String(text || '').length < 400) return false;
  const normalized = String(text).toLowerCase();
  if (!/federal\s+communications\s+commission/i.test(text)) return false;
  const idPattern = new RegExp(documentId.replace(/-/g, '[\\s-]*'), 'i');
  if (!idPattern.test(text)) return false;
  return descriptor.topicTokens.some((token) => normalized.includes(token));
}

function directUrlKind(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return ''; }
  const host = url.hostname.toLowerCase();
  if (host === 'github.com' || host === 'www.github.com') return 'github';
  if (isGoogleDocUrl(rawUrl)) return 'google-doc';
  if (isLinearIssueUrl(rawUrl)) return 'linear';
  if (host === 'app.notion.com'
    || host === 'notion.so'
    || host.endsWith('.notion.so')
    || host === 'notion.site'
    || host.endsWith('.notion.site')) return 'notion';
  if (/\.pdf(?:$|[?#])/i.test(rawUrl)) return 'pdf';
  return '';
}

function isReadableAttachment(attachment) {
  const mime = String(attachment?.mimetype || '').toLowerCase();
  const type = String(attachment?.filetype || '').toLowerCase();
  const name = String(attachment?.name || '');
  return mime === 'application/pdf'
    || mime.startsWith('text/')
    || type === 'pdf'
    || TEXT_FILE_RE.test(name);
}

function isPdfAttachment(attachment) {
  return String(attachment?.mimetype || '').toLowerCase() === 'application/pdf'
    || String(attachment?.filetype || '').toLowerCase() === 'pdf'
    || /\.pdf$/i.test(String(attachment?.name || ''));
}

function isPdfDescriptor(descriptor) {
  return descriptor?.kind === 'pdf'
    || (descriptor?.kind === 'slack' && isPdfAttachment(descriptor.attachment));
}

function isSlackPrivateUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'files.slack.com' || host.endsWith('.slack.com') || host.endsWith('.slack-edge.com');
  } catch { return false; }
}

function sourceTitleFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return decodeURIComponent(path.posix.basename(url.pathname)) || url.hostname;
  } catch { return '用户文档'; }
}

function startUserSourceTrace(trace, descriptor) {
  if (!trace?.requests) return undefined;
  const event = {
    kind: `direct-${descriptor.kind}`,
    endpoint: descriptor.originalUrl,
    startedAt: new Date().toISOString(),
    status: 'running',
  };
  trace.requests.push(event);
  return event;
}

function finishUserSourceTrace(event, source) {
  if (!event) return;
  event.status = 'done';
  event.finishedAt = new Date().toISOString();
  event.resultCount = 1;
  event.extractor = source.extractor;
  event.title = source.title;
}

function failUserSourceTrace(event, error) {
  if (!event) return;
  event.status = 'failed';
  event.finishedAt = new Date().toISOString();
  event.error = safeError(error);
}

function safeError(error) {
  return String(error?.message || error || '未知错误').slice(0, 500);
}
