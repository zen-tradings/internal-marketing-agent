import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { acquireRuntimeResource } from '../config/runtime.js';
import { assertPng, pngError } from './png-image.js';

// Shared Canvas cover machinery for the Opening Digest family: one verified
// asset set (logo, fonts, render.js), one offline browser render pipeline and
// one per-variant PNG/JSON cache. Variants only supply their data shape,
// cache marker, cache file names and output dimensions.
const ASSET_DIR = new URL('../../assets/opening-digest-wechat-cover/', import.meta.url);
const ASSET_NAMES = ['logo.png', 'Montserrat.woff2', 'NotoSansSC.ttf', 'render.js'];
const LOGICAL_WIDTH = 900;
const LOGICAL_HEIGHT = 383;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export async function loadOpeningDigestCoverAssets({ readFile = fs.readFile } = {}) {
  try {
    const manifest = JSON.parse(await readFile(new URL('sources.json', ASSET_DIR), 'utf8'));
    const assets = {};
    for (const name of ASSET_NAMES) {
      const buffer = Buffer.from(await readFile(new URL(name, ASSET_DIR)));
      if (!manifest.assets?.[name]?.sha256 || sha256(buffer) !== manifest.assets[name].sha256) {
        throw coverError(`封面素材校验失败:${name}`);
      }
      assets[name] = buffer;
    }
    assertPng(assets['logo.png'], { width: 512, height: 512, label: '封面 Logo' });
    return { assets, assetVersion: sha256(JSON.stringify(ASSET_NAMES.map((name) => [name, manifest.assets[name].sha256]))) };
  } catch (error) {
    if (error.stage === 'cover') { error.retryable ??= true; throw error; }
    throw coverError(`封面素材不可读:${error.message}`);
  }
}

export function openingDigestCoverHtml(data, assets) {
  const input = JSON.stringify({
    dateLabel: data.publish_date.replaceAll('-', '.'),
    headline: data.cover_keywords[0], section: data.section,
    englishTags: data.english_tags.join(' · '),
    scale: data.scale,
    logoDataUrl: `data:image/png;base64,${assets['logo.png'].toString('base64')}`,
  }).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face{font-family:'Zen Montserrat';src:url(data:font/woff2;base64,${assets['Montserrat.woff2'].toString('base64')}) format('woff2');font-weight:100 900;font-style:normal;font-display:block}
    @font-face{font-family:'Zen Noto Sans SC';src:url(${JSON.stringify(new URL('NotoSansSC.ttf', ASSET_DIR).href)}) format('truetype');font-weight:100 900;font-style:normal;font-display:block}
    html,body{margin:0;width:900px;height:383px;overflow:hidden;background:#0E1932}canvas{display:block;width:900px;height:383px}
  </style></head><body><canvas width="900" height="383"></canvas><script>${assets['render.js'].toString('utf8')}
    window.zenCoverReady = renderZenOpeningCover(${input});
  </script></body></html>`;
}

export async function renderCanvasCover({
  data, marker, cacheNames, dims, errorLabel,
  executablePath, timeoutMs = 30000, cacheDir,
}, { browserType = chromium, loadAssets = loadOpeningDigestCoverAssets } = {}) {
  const { assets, assetVersion } = await loadAssets();
  const identity = { schemaVersion: 2, templateId: marker, assetVersion, ...data };
  const cacheKey = sha256(JSON.stringify(identity));
  const cacheJson = path.join(cacheDir || '', cacheNames.json);
  const cachePng = path.join(cacheDir || '', cacheNames.png);
  if (cacheDir) {
    try {
      const metadata = JSON.parse(await fs.readFile(cacheJson, 'utf8'));
      const cover = await fs.readFile(cachePng);
      if (metadata.cacheKey === cacheKey && metadata.pngSha256 === sha256(cover)) {
        return assertPng(cover, dims);
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError) && error.stage !== 'cover') throw coverError(`${errorLabel}缓存读取失败:${error.message}`);
    }
  }
  if (!executablePath) throw coverError('缺少 OPENING_DIGEST_BROWSER_EXECUTABLE');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw coverError(`${errorLabel}超时配置无效`);
  const releaseBrowser = await acquireRuntimeResource('browser');
  let browser, timer, temporaryDir;
  const deadline = Date.now() + timeoutMs;
  try {
    browser = await browserType.launch({ executablePath, timeout: timeoutMs, headless: true,
      args: ['--disable-background-networking', '--disable-component-update', '--disable-dev-shm-usage'] });
    const capture = async () => {
      if (cacheDir) await fs.mkdir(cacheDir, { recursive: true });
      temporaryDir = await fs.mkdtemp(path.join(cacheDir || os.tmpdir(), '.zen-opening-cover-render-'));
      const htmlPath = path.join(temporaryDir, 'cover.html');
      await fs.writeFile(htmlPath, openingDigestCoverHtml(data, assets));
      const context = await browser.newContext({ offline: true, viewport: { width: LOGICAL_WIDTH, height: LOGICAL_HEIGHT }, deviceScaleFactor: renderScale(data) });
      // Let Chromium read the verified CJK font directly. Embedding its 17 MB
      // bytes in every CDP HTML message multiplies memory on the 2 GB host.
      const localFiles = new Set([pathToFileURL(htmlPath).href, new URL('NotoSansSC.ttf', ASSET_DIR).href]);
      await context.route('**/*', (route) => localFiles.has(route.request().url()) ? route.continue() : route.abort());
      const page = await context.newPage();
      page.setDefaultTimeout(Math.max(1, deadline - Date.now()));
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
      await page.evaluate(() => window.zenCoverReady);
      return assertPng(Buffer.from(await page.locator('canvas').screenshot({ type: 'png', animations: 'disabled' })), dims);
    };
    const cover = await Promise.race([capture(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(coverError(`${errorLabel}渲染超时`)), Math.max(1, deadline - Date.now()));
    })]);
    clearTimeout(timer);
    if (cacheDir) {
      await fs.mkdir(cacheDir, { recursive: true });
      await atomicWrite(cachePng, cover);
      await atomicWrite(cacheJson, `${JSON.stringify({ ...identity, cacheKey, pngSha256: sha256(cover) }, null, 2)}\n`);
    }
    return cover;
  } catch (error) {
    if (error.stage === 'cover') { error.retryable ??= true; throw error; }
    throw coverError(`${errorLabel}渲染失败:${error.message}`);
  } finally {
    clearTimeout(timer);
    try { await browser?.close(); }
    finally {
      try { if (temporaryDir) await fs.rm(temporaryDir, { recursive: true, force: true }); }
      finally { releaseBrowser(); }
    }
  }
}

export function renderScale(data) {
  const scale = Number(data?.scale);
  return Number.isFinite(scale) && scale > 0 ? Math.min(4, Math.floor(scale)) : 1;
}

export function assertDateKey(dateKey, message) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))
      || !Number.isFinite(Date.parse(`${dateKey}T12:00:00Z`))
      || new Date(`${dateKey}T12:00:00Z`).toISOString().slice(0, 10) !== dateKey) {
    throw pngError(message);
  }
  return dateKey;
}



async function atomicWrite(filename, data) {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, data); await fs.rename(temporary, filename); }
  finally { await fs.rm(temporary, { force: true }); }
}

function coverError(message) {
  return Object.assign(new Error(message), { stage: 'cover', retryable: true });
}
