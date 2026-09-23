import { callFetch, assertSafeHttpUrl, safeFetchResource } from '../safe-fetch.js';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { throwIfTaskCancelled } from '../task-cancellation.js';
import { isGoogleDocUrl, resolveGoogleDocsSource } from '../google-docs.js';
import { isLinearAppUrl, isLinearIssueUrl, resolveLinearIssueSource } from '../linear.js';
import { translationUnits, limitsFor, cleanText, safeError } from './shared.js';
import { assertPdfResponse, hasPdfSignature } from './pdf.js';
import { sourceDocumentFromHtml, sourceDocumentFromMarkdown, sourceDocumentFromPdf } from './structure.js';
import { renderWithBrowser, inspectEmbeddedChartFrames } from './browser.js';


export async function acquireSourceDocument({
  sourceUrl,
  workDir,
  fetchFn = globalThis.fetch,
  fetchWithRetry,
  config = {},
  documentConfig = {},
  dnsLookup = dns.lookup,
  scope = { kind: 'all' },
  onProgress,
  requestHeaders = {},
  signal,
}) {
  throwIfTaskCancelled(signal);
  const limits = limitsFor(config);
  const notionApiSource = isNotionUrl(sourceUrl) && Boolean(config.notionApiToken);
  const linearApiSource = isLinearIssueUrl(sourceUrl);
  // Authenticated Notion/Linear reads only parse an allowlisted URL, then call
  // the fixed official API. Do not resolve or fetch the browser URL first:
  // managed DNS/proxy clients may map it to a synthetic reserved address even
  // though the official API remains reachable.
  if (!notionApiSource && !linearApiSource) await assertSafeHttpUrl(sourceUrl, { dnsLookup });
  if (isLinearAppUrl(sourceUrl) && !linearApiSource) {
    throw new Error('Linear 链接不是 Issue；第一期只支持 https://linear.app/zen-trading/issue/TEAM-数字/...');
  }
  fs.mkdirSync(workDir, { recursive: true });
  const acquisition = { attempts: [], fallbacks: [] };
  const googleDocs = isGoogleDocUrl(sourceUrl)
    ? await resolveGoogleDocsSource({
        sourceUrl,
        config: documentConfig,
        fetchFn,
        timeoutMs: limits.fetchTimeoutMs,
      })
    : null;
  const arxiv = arxivSourceUrls(sourceUrl);
  let acquisitionUrl = googleDocs?.acquisitionUrl || (arxiv
    ? scope.kind === 'pages' ? arxiv.pdf : arxiv.html
    : sourceUrl);
  if (googleDocs) {
    acquisition.attempts.push(googleDocs.authenticated
      ? 'google-drive-oauth-export'
      : 'google-docs-public-export');
  } else if (acquisitionUrl !== sourceUrl) {
    acquisition.attempts.push(scope.kind === 'pages' ? 'arxiv-pdf' : 'arxiv-html');
  }
  const acquisitionHeaders = googleDocs
    ? { ...requestHeaders, ...googleDocs.requestHeaders }
    : requestHeaders;

  if (linearApiSource) {
    if (scope.kind === 'pages') {
      throw new Error('Linear Issue 没有可验证的 PDF 分页；请改用章节范围');
    }
    acquisition.attempts.push('linear-graphql-api');
    let linear;
    try {
      linear = await resolveLinearIssueSource({
        sourceUrl,
        config,
        fetchFn,
        fetchWithRetry,
        timeoutMs: limits.fetchTimeoutMs,
      });
    } catch (error) {
      throwIfTaskCancelled(signal);
      throw error;
    }
    const document = await sourceDocumentFromMarkdown({
      markdown: linear.markdown,
      sourceUrl,
      title: linear.title,
      author: linear.author,
      publishedDate: linear.publishedDate,
      extractor: 'linear-graphql-api',
      sourceType: 'linear',
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

  if (notionApiSource) {
    if (scope.kind === 'pages') {
      throw new Error('Notion 网页没有可验证的 PDF 分页；请改用章节范围');
    }
    acquisition.attempts.push('notion-markdown-api');
    let notion;
    try {
      notion = await fetchNotionMarkdown({
        sourceUrl: acquisitionUrl,
        token: config.notionApiToken,
        fetchFn,
        fetchWithRetry,
        timeoutMs: limits.fetchTimeoutMs,
      });
    } catch (error) {
      throwIfTaskCancelled(signal);
      throw actionableNotionError(error);
    }
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
      headers: acquisitionHeaders,
    });
  } catch (error) {
    throwIfTaskCancelled(signal);
    if (googleDocs) {
      throw actionableGoogleDocsError(error, googleDocs.authenticated);
    }
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
        headers: acquisitionHeaders,
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
  if (googleDocs) {
    assertGoogleDocsExportResponse(html, fetched.finalUrl, googleDocs.authenticated);
  }
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
    const embeddedCharts = inspectEmbeddedChartFrames(html);
    const browserReason = embeddedCharts.detected > 0
      ? `静态 HTML 含 ${embeddedCharts.detected} 个需截图的嵌入图表`
      : '静态正文过短或疑似客户端渲染';
    if ((embeddedCharts.detected > 0 || shouldUseBrowser(document, html))
      && config.browserEnabled === false) {
      throw new Error(`网页含动态内容但浏览器抓取已关闭:${browserReason}`);
    }
    if ((embeddedCharts.detected > 0 || shouldUseBrowser(document, html))
      && config.browserEnabled !== false) {
      acquisition.fallbacks.push(`browser:${browserReason}`);
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

export async function acquireWithBrowser({
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
  const rendered = await renderWithBrowser({
    sourceUrl,
    workDir,
    config,
    limits,
    dnsLookup,
    signal,
  });
  throwIfTaskCancelled(signal);
  assertUsableArticleResponse(rendered.html, rendered.finalUrl);
  acquisition.embeddedCharts = rendered.embeddedCharts;
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
    assetMap: rendered.assetMap,
    scope,
    signal,
  });
  document.acquisition = acquisition;
  return document;
}

export async function fetchNotionMarkdown({ sourceUrl, token, fetchFn, fetchWithRetry, timeoutMs }) {
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

export function actionableNotionError(error) {
  const message = safeError(error);
  if (/Notion Markdown 获取失败:401/.test(message)) {
    return new Error('私有 Notion 读取失败：NOTION_API_TOKEN 无效或已失效');
  }
  if (/Notion Markdown 获取失败:403/.test(message)) {
    return new Error('私有 Notion 读取失败：integration 缺少 Read content 权限');
  }
  if (/Notion Markdown 获取失败:404/.test(message)) {
    return new Error('私有 Notion 读取失败：请在页面右上角 Add connections，将页面共享给该 integration');
  }
  return new Error(`Notion API 读取失败:${message}`);
}

export function actionableGoogleDocsError(error, authenticated) {
  const message = safeError(error);
  if (authenticated && /原文获取失败:401/.test(message)) {
    return new Error('私有 Google Docs 读取失败：OAuth access token 无效，请检查 refresh token 配置');
  }
  if (authenticated && /原文获取失败:(?:403|404)/.test(message)) {
    return new Error('私有 Google Docs 读取失败：授权账号无权查看该文档，或文档禁止下载/导出');
  }
  if (!authenticated) {
    return new Error(`Google Docs 无法公开读取；若为私有文档，请配置 Google OAuth refresh token。原错误:${message}`);
  }
  return new Error(`Google Docs 导出失败:${message}`);
}

export function assertGoogleDocsExportResponse(html, finalUrl, authenticated) {
  const text = String(html || '');
  const finalHost = (() => {
    try { return new URL(finalUrl).hostname.toLowerCase(); } catch { return ''; }
  })();
  const loginPage = finalHost === 'accounts.google.com'
    || /(?:accounts\.google\.com|ServiceLogin|<title>\s*Sign in(?:\s*-\s*Google Accounts)?\s*<\/title>)/i
      .test(text.slice(0, 20000));
  if (!loginPage) return;
  if (authenticated) {
    throw new Error('私有 Google Docs 读取失败：授权账号无权查看该文档');
  }
  throw new Error('Google Docs 不是公开可读文档；请配置 Google OAuth refresh token');
}

export function shouldUseBrowser(document, html) {
  const textLength = translationUnits(document).reduce((sum, unit) => sum + unit.text.length, 0);
  return (textLength < 500 || document.blocks.length < 3)
    && /<(?:script|div)[^>]+id=["'](?:__next|__nuxt|app|root)["']/i.test(html);
}

export function assertUsableArticleResponse(html, url) {
  const text = cleanText(html).slice(0, 12000);
  if (!text) throw new Error('网页响应为空');
  if (looksLikeAntiBotPage(html)) {
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

export function looksLikeAntiBotPage(html) {
  const raw = String(html || '');
  const challengeWords = /(?:captcha|verify (?:you are|that you are) human|checking your browser|access denied|just a moment|attention required|security check|请输入验证码)/i;
  const challengeInfrastructureHint = /(?:challenges\.cloudflare\.com|google\.com\/recaptcha|recaptcha\.net|hcaptcha\.com\/1\/api\.js|cf-chl-[a-z_-]+|__cf_chl_)/i;
  if (!challengeWords.test(raw) && !challengeInfrastructureHint.test(raw)) return false;
  let document;
  try { document = new JSDOM(raw).window.document; } catch {}
  const title = cleanText(document?.title || '');
  const visibleText = cleanText(document?.body?.textContent || raw);
  const articleText = cleanText(document?.querySelector(
    'article,main,[role="main"],.ltx_document',
  )?.textContent || '');
  const challengeInfrastructure = Boolean(document?.querySelector([
    'script[src*="challenges.cloudflare.com"]',
    'script[src*="recaptcha"]',
    'script[src*="hcaptcha.com"]',
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha.com"]',
    '[id^="cf-chl-"]',
    'form[action*="challenge"]',
  ].join(','))) || /__cf_chl_/i.test(raw);
  const challengeTitle = /^(?:just a moment(?:\.{1,3})?|attention required!?|access denied!?|verify (?:you are|that you are) human!?|security check|captcha)$/i
    .test(title);
  const shortChallengePrompt = challengeWords.test(`${title} ${visibleText}`)
    && visibleText.length < 1500
    && articleText.length < 500;
  return challengeInfrastructure || challengeTitle || shortChallengePrompt;
}

export function decodeHtmlBuffer(buffer, contentType) {
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

export function notionPageId(rawUrl) {
  const url = new URL(rawUrl);
  const pathId = notionIdFromText(decodeURIComponent(url.pathname));
  if (pathId) return pathId;

  // A copied database-page link can include both the page ID in its path and
  // an unrelated database view ID in `?v=`. Never let that view ID override
  // the page ID. Query parameters are only a fallback for link shapes that do
  // not carry an ID in the path, and `v` is deliberately excluded.
  const queryValues = [];
  for (const [key, value] of url.searchParams) {
    if (['v', 'source'].includes(key.toLowerCase())) continue;
    queryValues.push(value);
  }
  return notionIdFromText(decodeURIComponent(queryValues.join(' ')));
}

export function notionIdFromText(value) {
  const compactMatches = [...value.matchAll(/(?<![a-f0-9])([a-f0-9]{32})(?![a-f0-9])/ig)];
  const dashedMatches = [...value.matchAll(
    /(?<![a-f0-9])([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?![a-f0-9])/ig,
  )];
  const rawId = [...compactMatches, ...dashedMatches]
    .sort((left, right) => left.index - right.index)
    .at(-1)?.[1];
  if (!rawId) return undefined;
  const id = rawId.replace(/-/g, '').toLowerCase();
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

export function isNotionUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'app.notion.com'
      || host === 'notion.so' || host.endsWith('.notion.so')
      || host === 'notion.site' || host.endsWith('.notion.site');
  } catch { return false; }
}

export function extractInputUrls(text) {
  return (String(text || '').match(/https?:\/\/[^\s<>()，。；：！？】【、】【【】）》〉]+/g) || [])
    .map((url) => url.replace(/[.,;:!?)\]}>，。；：！？】【、】【【】）》〉]+$/, ''));
}

export function arxivSourceUrls(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return undefined; }
  if (![
    'arxiv.org',
    'www.arxiv.org',
    'alphaxiv.org',
    'www.alphaxiv.org',
  ].includes(url.hostname.toLowerCase())) return undefined;
  const match = /^\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5}(?:v\d+)?)(?:\.pdf)?(?:\/|$)/i.exec(url.pathname);
  if (!match) return undefined;
  const id = match[1];
  return {
    id,
    html: `https://arxiv.org/html/${id}`,
    pdf: `https://arxiv.org/pdf/${id}`,
  };
}
