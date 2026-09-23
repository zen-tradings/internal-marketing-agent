import { safeFetchResource } from '../safe-fetch.js';
import fs from 'node:fs';
import path from 'node:path';
import { acquireRuntimeResource } from '../../config/runtime.js';
import { cancellationErrorFromSignal, throwIfTaskCancelled } from '../task-cancellation.js';
import { linearUploadAuthHeaders } from '../linear.js';
import { DEFAULT_LIMITS, escapeHtml, limitsFor, positive } from './shared.js';


export function resolveAssetUrl(value, documentUrl) {
  if (!value) return '';
  if (/^data:/i.test(value)) return value;
  try { return new URL(value, documentUrl).toString(); }
  catch { return String(value); }
}

export async function localizeFigureAssets(blocks, {
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
    if (cache.has(image.src)) {
      image.localPath = cache.get(image.src);
      continue;
    }

    let buffer;
    let contentType = '';
    if (mapped) {
      const mappedSize = fs.statSync(mapped).size;
      if (mappedSize > limits.maxSingleAssetBytes) {
        throw new Error(`原文单张图片超过上限:${mappedSize}/${limits.maxSingleAssetBytes}`);
      }
      buffer = fs.readFileSync(mapped);
    } else if (/^data:image\//i.test(image.src)) {
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
        headers: linearUploadAuthHeaders(image.src, config.linearApiKey),
        accept: 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml;q=0.9,*/*;q=0.1',
        maxBytes: limits.maxSingleAssetBytes,
      });
      buffer = fetched.buffer;
      contentType = fetched.contentType;
    }
    if (buffer.length > limits.maxSingleAssetBytes) {
      throw new Error(`原文单张图片超过上限:${buffer.length}/${limits.maxSingleAssetBytes}`);
    }
    const kind = detectImageKind(buffer, contentType);
    if (!kind) throw new Error(`原文图片格式不受支持:${image.src}`);
    const basename = `figure-${String(index + 1).padStart(3, '0')}`;
    let target;
    if (['.svg', '.webp'].includes(kind.extension)) {
      target = path.join(assetDir, `${basename}.png`);
      const rasterize = config.imageRasterizer || rasterizeImageToPng;
      await rasterize({
        buffer,
        contentType: kind.contentType,
        target,
        config,
      });
      if (!fs.existsSync(target) || fs.statSync(target).size <= 0) {
        throw new Error(`原文图片转 PNG 失败:${image.src}`);
      }
      const rasterized = fs.readFileSync(target);
      if (detectImageKind(rasterized, '')?.extension !== '.png') {
        throw new Error(`原文图片转 PNG 结果格式无效:${image.src}`);
      }
    } else if (mapped) {
      target = mapped;
    } else {
      target = path.join(assetDir, `${basename}${kind.extension}`);
      fs.writeFileSync(target, buffer, { mode: 0o600 });
    }
    const finalSize = fs.statSync(target).size;
    if (finalSize > limits.maxSingleAssetBytes) {
      throw new Error(`原文图片处理后超过上限:${finalSize}/${limits.maxSingleAssetBytes}`);
    }
    totalBytes += finalSize;
    if (totalBytes > limits.maxAssetBytes) {
      throw new Error(`原文图片总量超过上限:${totalBytes}/${limits.maxAssetBytes}`);
    }
    image.localPath = target;
    cache.set(image.src, target);
  }
}

export async function localizeTableAssets(blocks, {
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
    const kind = detectImageKind(fs.readFileSync(target), '');
    if (kind?.extension !== '.png') throw new Error(`原文表格图片不是有效 PNG:${table.id}`);
    table.localPath = target;
  }
}

export async function rasterizeTableHtml({ html, target, config = {}, signal }) {
  if (config.browserEnabled === false) {
    throw new Error('原文表格转图片需要启用 TRANSLATION_BROWSER_ENABLED');
  }
  let playwright;
  try { playwright = await import('playwright-core'); }
  catch { throw new Error('原文表格转图片需要 playwright-core'); }
  const executablePath = browserExecutable(config);
  if (!executablePath) throw new Error('找不到用于原文表格转图片的 Chrome/Chromium');
  const releaseBrowser = await acquireRuntimeResource('browser', signal);
  let browser;
  try {
    browser = await playwright.chromium.launch({
    executablePath,
    headless: true,
    args: ['--disable-background-networking', '--disable-default-apps', '--disable-extensions', '--disable-network-service'],
    });
  } catch (error) {
    releaseBrowser();
    throw error;
  }
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
    releaseBrowser();
  }
}

export function browserExecutable(config = {}) {
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

export function tableHtmlFromRows(rows = []) {
  const body = rows.map((row, rowIndex) => {
    const tag = rowIndex === 0 ? 'th' : 'td';
    return `<tr>${row.map((cell) => `<${tag}>${escapeHtml(cell?.text || '')}</${tag}>`).join('')}</tr>`;
  }).join('');
  return `<table>${body}</table>`;
}

export function mappedAssetPath(rawSrc, assetMap) {
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

export function decodeDataImage(value) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(String(value || ''));
  if (!match) throw new Error('原文内嵌图片不是受支持的 base64 格式');
  return { contentType: match[1].toLowerCase(), buffer: Buffer.from(match[2], 'base64') };
}

export function detectImageKind(buffer, contentType) {
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

export async function rasterizeImageToPng({ buffer, contentType, target, config }) {
  let playwright;
  try { playwright = await import('playwright-core'); }
  catch { throw new Error('原文图片转 PNG 需要 playwright-core'); }
  const executablePath = browserExecutable(config);
  if (!executablePath) throw new Error('找不到原文图片转换浏览器');
  const releaseBrowser = await acquireRuntimeResource('browser');
  let browser;
  try {
    browser = await playwright.chromium.launch({ executablePath, headless: true, args: ['--disable-network'] });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
    const dataUrl = `data:${contentType};base64,${buffer.toString('base64')}`;
    await page.setContent(`<style>html,body{margin:0;background:white}img{display:block;max-width:1400px;height:auto}</style><img id="asset" src="${dataUrl}">`);
    await page.locator('#asset').evaluate((image) => {
      if (image.complete && image.naturalWidth > 0) return;
      return new Promise((resolve, reject) => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', () => reject(new Error('图片解码失败')), { once: true });
      });
    });
    await page.locator('#asset').screenshot({ path: target, type: 'png', omitBackground: false });
  } finally {
    try { await browser?.close(); }
    finally { releaseBrowser(); }
  }
}
