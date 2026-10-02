import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { acquireRuntimeResource } from '../config/runtime.js';
import { FIXED_DRAFT_TEMPLATE_IDS } from './draft-template.js';
import { assertPng } from './opening-digest-cover.js';
import { OPENING_DIGEST_SAFE_HEADLINE } from './opening-digest-translation.js';

export const WECHAT_OPENING_COVER_WIDTH = 900;
export const WECHAT_OPENING_COVER_HEIGHT = 383;
export const WECHAT_OPENING_COVER_SECTION = '开市日报 · DAILY BRIEF';
export const WECHAT_OPENING_COVER_TAGS = 'TREASURY YIELDS · SOFTWARE · MARKET SIGNALS';
const ASSET_DIR = new URL('../../assets/opening-digest-wechat-cover/', import.meta.url);
const ASSET_NAMES = ['logo.png', 'Montserrat.woff2', 'NotoSansSC.ttf', 'render.js'];
const CACHE_PNG = 'opening-digest-wechat-cover.png';
const CACHE_JSON = 'opening-digest-wechat-cover.json';
const dimensions = { width: WECHAT_OPENING_COVER_WIDTH, height: WECHAT_OPENING_COVER_HEIGHT, label: '微信日报封面' };
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function normalizeOpeningDigestWechatHeadline(headline) {
  const candidate = String(headline || '').trim();
  return candidate && [...candidate].length <= 16 && !/[\r\n\u0000-\u001f]/.test(candidate)
    ? candidate : OPENING_DIGEST_SAFE_HEADLINE;
}

export function openingDigestWechatCoverData({ dateKey, headline }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))
      || !Number.isFinite(Date.parse(`${dateKey}T12:00:00Z`))
      || new Date(`${dateKey}T12:00:00Z`).toISOString().slice(0, 10) !== dateKey) {
    throw coverError('微信日报封面日期无效');
  }
  return {
    publish_date: dateKey,
    section: WECHAT_OPENING_COVER_SECTION,
    cover_keywords: [normalizeOpeningDigestWechatHeadline(headline)],
    english_tags: WECHAT_OPENING_COVER_TAGS.split(' · '),
  };
}

export async function loadOpeningDigestWechatCoverAssets({ readFile = fs.readFile } = {}) {
  try {
    const manifest = JSON.parse(await readFile(new URL('sources.json', ASSET_DIR), 'utf8'));
    const assets = {};
    for (const name of ASSET_NAMES) {
      const buffer = Buffer.from(await readFile(new URL(name, ASSET_DIR)));
      if (!manifest.assets?.[name]?.sha256 || sha256(buffer) !== manifest.assets[name].sha256) {
        throw coverError(`微信日报封面素材校验失败:${name}`);
      }
      assets[name] = buffer;
    }
    assertPng(assets['logo.png'], { width: 512, height: 512, label: '微信日报 Logo' });
    return { assets, assetVersion: sha256(JSON.stringify(ASSET_NAMES.map((name) => [name, manifest.assets[name].sha256]))) };
  } catch (error) {
    if (error.stage === 'cover') { error.retryable ??= true; throw error; }
    throw coverError(`微信日报封面素材不可读:${error.message}`);
  }
}

export function openingDigestWechatCoverHtml(data, assets) {
  const input = JSON.stringify({
    dateLabel: data.publish_date.replaceAll('-', '.'),
    headline: data.cover_keywords[0], section: data.section,
    englishTags: data.english_tags.join(' · '),
    logoDataUrl: `data:image/png;base64,${assets['logo.png'].toString('base64')}`,
  }).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face{font-family:'Zen Montserrat';src:url(data:font/woff2;base64,${assets['Montserrat.woff2'].toString('base64')}) format('woff2');font-weight:100 900;font-style:normal;font-display:block}
    @font-face{font-family:'Zen Noto Sans SC';src:url(${JSON.stringify(new URL('NotoSansSC.ttf', ASSET_DIR).href)}) format('truetype');font-weight:100 900;font-style:normal;font-display:block}
    html,body{margin:0;width:900px;height:383px;overflow:hidden;background:#0E1932}canvas{display:block}
  </style></head><body><canvas width="900" height="383"></canvas><script>${assets['render.js'].toString('utf8')}
    window.zenCoverReady = renderZenOpeningCover(${input});
  </script></body></html>`;
}

export async function renderOpeningDigestWechatCover({
  dateKey, headline, executablePath, timeoutMs = 30000, cacheDir,
}, { browserType = chromium, loadAssets = loadOpeningDigestWechatCoverAssets } = {}) {
  const data = openingDigestWechatCoverData({ dateKey, headline });
  const { assets, assetVersion } = await loadAssets();
  const identity = { schemaVersion: 2, templateId: FIXED_DRAFT_TEMPLATE_IDS['wechat-opening-digest'], assetVersion, ...data };
  const cacheKey = sha256(JSON.stringify(identity));
  if (cacheDir) {
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(cacheDir, CACHE_JSON), 'utf8'));
      const cover = await fs.readFile(path.join(cacheDir, CACHE_PNG));
      if (metadata.cacheKey === cacheKey && metadata.pngSha256 === sha256(cover)) {
        return assertPng(cover, dimensions);
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError) && error.stage !== 'cover') throw coverError(`微信日报封面缓存读取失败:${error.message}`);
    }
  }
  if (!executablePath) throw coverError('缺少 OPENING_DIGEST_BROWSER_EXECUTABLE');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw coverError('微信日报封面超时配置无效');
  const releaseBrowser = await acquireRuntimeResource('browser');
  let browser, timer, temporaryDir;
  const deadline = Date.now() + timeoutMs;
  try {
    browser = await browserType.launch({ executablePath, timeout: timeoutMs, headless: true,
      args: ['--disable-background-networking', '--disable-component-update', '--disable-dev-shm-usage'] });
    const capture = async () => {
      if (cacheDir) await fs.mkdir(cacheDir, { recursive: true });
      temporaryDir = await fs.mkdtemp(path.join(cacheDir || os.tmpdir(), '.zen-wechat-cover-render-'));
      const htmlPath = path.join(temporaryDir, 'cover.html');
      await fs.writeFile(htmlPath, openingDigestWechatCoverHtml(data, assets));
      const context = await browser.newContext({ offline: true, viewport: { width: 900, height: 383 }, deviceScaleFactor: 1 });
      // Let Chromium read the verified CJK font directly. Embedding its 17 MB
      // bytes in every CDP HTML message multiplies memory on the 2 GB host.
      const localFiles = new Set([pathToFileURL(htmlPath).href, new URL('NotoSansSC.ttf', ASSET_DIR).href]);
      await context.route('**/*', (route) => localFiles.has(route.request().url()) ? route.continue() : route.abort());
      const page = await context.newPage();
      page.setDefaultTimeout(Math.max(1, deadline - Date.now()));
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
      await page.evaluate(() => window.zenCoverReady);
      return assertPng(Buffer.from(await page.locator('canvas').screenshot({ type: 'png', animations: 'disabled' })), dimensions);
    };
    const cover = await Promise.race([capture(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(coverError('微信日报封面渲染超时')), Math.max(1, deadline - Date.now()));
    })]);
    clearTimeout(timer);
    if (cacheDir) {
      await fs.mkdir(cacheDir, { recursive: true });
      await atomicWrite(path.join(cacheDir, CACHE_PNG), cover);
      await atomicWrite(path.join(cacheDir, CACHE_JSON), `${JSON.stringify({ ...identity, cacheKey, pngSha256: sha256(cover) }, null, 2)}\n`);
    }
    return cover;
  } catch (error) {
    if (error.stage === 'cover') { error.retryable ??= true; throw error; }
    throw coverError(`微信日报封面渲染失败:${error.message}`);
  } finally {
    clearTimeout(timer);
    try { await browser?.close(); }
    finally {
      try { if (temporaryDir) await fs.rm(temporaryDir, { recursive: true, force: true }); }
      finally { releaseBrowser(); }
    }
  }
}

async function atomicWrite(filename, data) {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, data); await fs.rename(temporary, filename); }
  finally { await fs.rm(temporary, { force: true }); }
}

function coverError(message) {
  return Object.assign(new Error(message), { stage: 'cover', retryable: true });
}
