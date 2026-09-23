import { assertSafeHttpUrl, resolveSafeHttpUrl } from '../safe-fetch.js';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { acquireRuntimeResource } from '../../config/runtime.js';
import { JSDOM } from 'jsdom';
import { cancellationErrorFromSignal, throwIfTaskCancelled } from '../task-cancellation.js';
import { EMBEDDED_CHART_MIN_WIDTH, EMBEDDED_CHART_MIN_HEIGHT, EMBEDDED_CHART_MAX_WIDTH, EMBEDDED_CHART_MAX_HEIGHT, EMBEDDED_CHART_MAX_PIXELS, EMBEDDED_CHART_MIN_PNG_BYTES, DEFAULT_LIMITS, titleAnchoredContentRoot, richestArticle, normalizedHeading, metadata, cleanText } from './shared.js';


export async function renderWithBrowser({
  sourceUrl,
  workDir,
  config,
  limits,
  dnsLookup,
  signal,
}) {
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
  const releaseBrowser = await acquireRuntimeResource('browser', signal);
  let browser;
  try {
    browser = await playwright.chromium.launch({
    executablePath,
    headless: true,
    args: [
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      `--host-resolver-rules=MAP ${sourceHost} ${resolverTarget}, MAP * ~NOTFOUND`,
    ],
    });
  } catch (error) {
    releaseBrowser();
    throw error;
  }
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
    await progressivelyRevealPage(page, { signal });
    await page.locator('iframe').evaluateAll((frames) => {
      frames.forEach((frame, index) => {
        frame.setAttribute('data-zen-source-frame', String(index + 1));
      });
    });
    const hydratedHtml = await page.content();
    if (Buffer.byteLength(hydratedHtml) > limits.maxSourceBytes) {
      throw new Error(`动态网页渲染结果超过上限:${Buffer.byteLength(hydratedHtml)}/${limits.maxSourceBytes}`);
    }
    const captured = await captureEmbeddedChartFrames({
      page,
      html: hydratedHtml,
      workDir,
      config,
      limits,
      signal,
    });
    throwIfTaskCancelled(signal);
    const finalUrl = page.url();
    await assertSafeHttpUrl(finalUrl, { dnsLookup });
    const html = await page.content();
    if (Buffer.byteLength(html) > limits.maxSourceBytes) {
      throw new Error(`动态网页结构化结果超过上限:${Buffer.byteLength(html)}/${limits.maxSourceBytes}`);
    }
    return {
      html,
      finalUrl,
      assetMap: captured.assetMap,
      embeddedCharts: captured.embeddedCharts,
    };
  } catch (error) {
    if (signal?.aborted) throw cancellationErrorFromSignal(signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortBrowser);
    try { await browser.close(); }
    finally { releaseBrowser(); }
  }
}

export function inspectEmbeddedChartFrames(html, { documentUrl = 'https://example.com/' } = {}) {
  const dom = new JSDOM(String(html || ''), { url: documentUrl });
  const document = dom.window.document;
  const title = metadata(document, [
    'meta[property="og:title"]', 'meta[name="twitter:title"]', 'title', 'h1',
  ], 'content');
  const structured = document.querySelector('article.ltx_document,.ltx_document');
  const titleRoot = structured ? undefined : titleAnchoredContentRoot(document, title);
  const articles = [...document.querySelectorAll('article')];
  const singleArticle = articles.length === 1 ? articles[0] : undefined;
  const root = structured
    || titleRoot
    || singleArticle
    || document.querySelector('main,[role="main"]')
    || richestArticle(articles)
    || document.body;
  const frames = [...(root?.querySelectorAll('iframe') || [])];
  const candidates = frames
    .map((frame, index) => {
      const srcdoc = String(frame.getAttribute('srcdoc') || '');
      const src = cleanText(frame.getAttribute('src') || '');
      const frameTitle = cleanText(frame.getAttribute('title') || '');
      if (!srcdoc.trim() || src || !frame.hasAttribute('sandbox') || !frameTitle) return undefined;
      return {
        marker: frame.getAttribute('data-zen-source-frame') || String(index + 1),
        title: frameTitle,
        caption: embeddedChartCaption(srcdoc, frameTitle),
        srcdocChars: srcdoc.length,
      };
    })
    .filter(Boolean);
  return {
    detected: candidates.length,
    excludedExternalFrames: frames.filter((frame) => cleanText(frame.getAttribute('src') || '')).length,
    candidates,
  };
}

export async function captureEmbeddedChartFrames({
  page,
  html,
  workDir,
  config = {},
  limits = DEFAULT_LIMITS,
  signal,
}) {
  const inspection = inspectEmbeddedChartFrames(html);
  if (!inspection.detected) {
    return {
      assetMap: {},
      embeddedCharts: {
        detected: 0,
        captured: 0,
        excludedExternalFrames: inspection.excludedExternalFrames,
      },
    };
  }
  if (!workDir) throw new Error('嵌入图表截图缺少任务工作目录');
  if (inspection.detected > limits.maxAssetCount) {
    throw new Error(`原文嵌入图表数量超过上限:${inspection.detected}/${limits.maxAssetCount}`);
  }

  const assetDir = path.join(workDir, 'translation-assets');
  fs.mkdirSync(assetDir, { recursive: true });
  const assetMap = {};
  const captureScreenshot = config.embeddedChartScreenshot
    || (async ({ locator, options }) => locator.screenshot(options));
  let totalBytes = 0;
  let captured = 0;

  for (const [index, descriptor] of inspection.candidates.entries()) {
    throwIfTaskCancelled(signal);
    const locator = page.locator(`[data-zen-source-frame="${descriptor.marker}"]`);
    if (await locator.count() !== 1) {
      throw new Error(`原文嵌入图表定位失败:${descriptor.title}`);
    }

    let buffer;
    let box;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await locator.scrollIntoViewIfNeeded();
      await page.waitForTimeout(250 * (attempt + 1));
      throwIfTaskCancelled(signal);
      box = await locator.boundingBox();
      buffer = Buffer.from(await captureScreenshot({
        locator,
        descriptor,
        attempt,
        options: {
          type: 'png',
          animations: 'disabled',
          caret: 'hide',
          omitBackground: false,
          timeout: limits.browserTimeoutMs,
        },
      }));
      if (buffer.length >= EMBEDDED_CHART_MIN_PNG_BYTES) break;
    }

    validateEmbeddedChartScreenshot({
      title: descriptor.title,
      buffer,
      width: box?.width || 0,
      height: box?.height || 0,
      limits,
    });
    totalBytes += buffer.length;
    if (totalBytes > limits.maxAssetBytes) {
      throw new Error(`原文嵌入图表总量超过上限:${totalBytes}/${limits.maxAssetBytes}`);
    }

    const basename = `embedded-chart-${String(index + 1).padStart(3, '0')}.png`;
    const target = path.join(assetDir, basename);
    fs.writeFileSync(target, buffer, { mode: 0o600 });
    const placeholder = `asset:${basename}`;
    assetMap[placeholder] = target;
    assetMap[basename] = target;
    await locator.evaluate((frame, payload) => {
      const document = frame.ownerDocument;
      const figure = document.createElement('figure');
      figure.setAttribute('data-zen-embedded-chart', payload.index);
      const image = document.createElement('img');
      image.setAttribute('src', payload.placeholder);
      image.setAttribute('alt', payload.title);
      figure.appendChild(image);
      if (payload.caption) {
        const caption = document.createElement('figcaption');
        caption.textContent = payload.caption;
        figure.appendChild(caption);
      }
      frame.replaceWith(figure);
    }, {
      index: String(index + 1),
      placeholder,
      title: descriptor.title,
      caption: descriptor.caption,
    });
    captured += 1;
  }

  return {
    assetMap,
    embeddedCharts: {
      detected: inspection.detected,
      captured,
      excludedExternalFrames: inspection.excludedExternalFrames,
    },
  };
}

export function validateEmbeddedChartScreenshot({
  title,
  buffer,
  width,
  height,
  limits = DEFAULT_LIMITS,
}) {
  const label = cleanText(title || '未命名图表');
  if (width < EMBEDDED_CHART_MIN_WIDTH || height < EMBEDDED_CHART_MIN_HEIGHT
    || width > EMBEDDED_CHART_MAX_WIDTH || height > EMBEDDED_CHART_MAX_HEIGHT
    || width * height > EMBEDDED_CHART_MAX_PIXELS) {
    throw new Error(`原文嵌入图表尺寸异常:${label} ${Math.round(width)}x${Math.round(height)}`);
  }
  if (!Buffer.isBuffer(buffer) || buffer.length < EMBEDDED_CHART_MIN_PNG_BYTES) {
    throw new Error(`原文嵌入图表截图疑似空白:${label}`);
  }
  if (buffer.length > limits.maxSingleAssetBytes) {
    throw new Error(`原文嵌入图表超过单文件上限:${label} ${buffer.length}/${limits.maxSingleAssetBytes}`);
  }
  if (!buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error(`原文嵌入图表不是有效 PNG:${label}`);
  }
}

export async function progressivelyRevealPage(page, { signal } = {}) {
  for (let step = 0; step < 60; step += 1) {
    throwIfTaskCancelled(signal);
    const complete = await page.evaluate(() => {
      const before = window.scrollY;
      window.scrollBy(0, Math.max(600, window.innerHeight * 0.85));
      return window.scrollY === before
        || window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
    });
    await page.waitForTimeout(75);
    if (complete) break;
  }
  await page.waitForTimeout(1200);
  throwIfTaskCancelled(signal);
}

export function embeddedChartCaption(srcdoc, title) {
  let document;
  try { document = new JSDOM(String(srcdoc || '')).window.document; }
  catch { return cleanText(title); }
  const values = [
    title,
    document.querySelector('.table-title,h1,h2')?.textContent,
    document.querySelector('.table-subtitle,[class*="subtitle"]')?.textContent,
    document.querySelector('.table-footer,figcaption,[class*="caption"]')?.textContent,
  ].map(cleanText).filter(Boolean);
  const seen = new Set();
  return values.filter((value) => {
    const key = normalizedHeading(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join('\n').slice(0, 4000);
}
