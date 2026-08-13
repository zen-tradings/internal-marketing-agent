import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';

export const OPENING_COVER_WIDTH = 1240;
export const OPENING_COVER_HEIGHT = 620;
export const OPENING_COVER_BACKGROUND_WIDTH = 1774;
export const OPENING_COVER_BACKGROUND_HEIGHT = 887;
export const OPENING_COVER_BACKGROUND_SHA256 = '44436cfdf3e7b9dc17aba36fe61c5c8a891cf08885c8887722a907225866e300';
export const OPENING_COVER_BACKGROUND_URL = new URL('../../assets/zen-opening-digest-background.png', import.meta.url);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export async function renderOpeningDigestCover({ dateLabel, label = 'Opening Digest', executablePath, timeoutMs = 30000 }) {
  if (!executablePath) throw coverError('缺少 OPENING_DIGEST_BROWSER_EXECUTABLE');
  let browser;
  try {
    const background = await loadOpeningCoverBackground();
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ['--disable-background-networking', '--disable-component-update', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage({
      viewport: { width: OPENING_COVER_WIDTH, height: OPENING_COVER_HEIGHT },
      deviceScaleFactor: 1,
    });
    page.setDefaultTimeout(timeoutMs);
    await page.setContent(coverHtml(dateLabel, {
      label,
      backgroundDataUrl: `data:image/png;base64,${background.toString('base64')}`,
    }), { waitUntil: 'load' });
    await page.locator('[data-cover-background]').evaluate((image) => {
      if (!image.complete || image.naturalWidth !== 1774 || image.naturalHeight !== 887) {
        throw new Error('Opening Digest background did not decode at its locked dimensions');
      }
    });
    await page.evaluate(() => document.fonts.ready);
    const cover = Buffer.from(await page.screenshot({
      type: 'png',
      omitBackground: false,
      animations: 'disabled',
    }));
    assertPng(cover, { width: OPENING_COVER_WIDTH, height: OPENING_COVER_HEIGHT, label: '封面输出' });
    return cover;
  } catch (error) {
    if (error?.stage === 'cover') throw error;
    throw coverError(`Opening Digest 封面渲染失败:${error.message}`);
  } finally {
    await browser?.close();
  }
}

export async function loadOpeningCoverBackground({ readFile = fs.readFile } = {}) {
  let background;
  try {
    background = Buffer.from(await readFile(OPENING_COVER_BACKGROUND_URL));
  } catch (error) {
    throw coverError(`Opening Digest 固定底图不可读:${error.message}`);
  }
  assertPng(background, {
    width: OPENING_COVER_BACKGROUND_WIDTH,
    height: OPENING_COVER_BACKGROUND_HEIGHT,
    sha256: OPENING_COVER_BACKGROUND_SHA256,
    label: 'Opening Digest 固定底图',
  });
  return background;
}

export function coverHtml(dateLabel, { backgroundDataUrl, label = 'Opening Digest' } = {}) {
  const normalizedDate = String(dateLabel || '').trim();
  if (!normalizedDate || normalizedDate.length > 40 || /[\r\n]/.test(normalizedDate)) {
    throw coverError('Opening Digest 封面日期无效');
  }
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(String(backgroundDataUrl || ''))) {
    throw coverError('Opening Digest 封面底图必须是内联 PNG');
  }
  const safeDate = escapeHtml(normalizedDate);
  const normalizedLabel = String(label || '').trim();
  if (!normalizedLabel || normalizedLabel.length > 40 || /[\r\n]/.test(normalizedLabel)) throw coverError('Opening Digest 封面标签无效');
  const safeLabel = escapeHtml(normalizedLabel);
  const safeBackground = escapeHtml(backgroundDataUrl);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}
    html,body{width:1240px;height:620px;margin:0;overflow:hidden;background:#031226}
    body{position:relative;color:#f7f4ec;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased}
    .background{position:absolute;inset:0;display:block;width:1240px;height:620px;object-fit:fill}
    .edition{position:absolute;top:198px;left:0;right:0;display:flex;align-items:center;justify-content:center;gap:19px;white-space:nowrap;text-transform:uppercase;color:#f7f4ec;text-shadow:0 1px 8px rgba(0,12,28,.9);font-size:17px;font-weight:400;line-height:24px;letter-spacing:.31em}
    .signal{width:5px;height:5px;flex:0 0 5px;border-radius:50%;background:#bcecff;box-shadow:0 0 9px rgba(137,219,255,.95)}
  </style></head><body><img class="background" data-cover-background src="${safeBackground}" alt=""><div class="edition"><span>${safeLabel}</span><i class="signal"></i><span>${safeDate}</span></div></body></html>`;
}

export function assertPng(buffer, { width, height, sha256 = '', label = 'PNG' }) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw coverError(`${label}签名无效`);
  }
  const actualWidth = buffer.readUInt32BE(16);
  const actualHeight = buffer.readUInt32BE(20);
  if (actualWidth !== width || actualHeight !== height) {
    throw coverError(`${label}尺寸无效:${actualWidth}×${actualHeight}，期望 ${width}×${height}`);
  }
  if (sha256) {
    const actualSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    if (actualSha256 !== sha256) throw coverError(`${label} SHA-256 不匹配`);
  }
  return buffer;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function coverError(message) {
  const error = new Error(message);
  error.stage = 'cover';
  return error;
}
