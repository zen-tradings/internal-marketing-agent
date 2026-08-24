import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { chromium } from 'playwright-core';
import { withRuntimeResource } from '../config/runtime.js';
import { DEFAULT_COVER_FONT, resolveBrowserExecutable } from '../../tools/cover-generator/render.mjs';

const RESERVED_HEADINGS = new Set([
  '引用链接',
  '引用来源',
  '资料来源',
  '参考来源',
  '来源列表',
  'Sources',
  'References',
]);

const ORDINAL_RE = /^(?:(?:0?\d{1,2}|[一二三四五六七八九十百]+)[、.．]|[（(](?:0?\d{1,2}|[一二三四五六七八九十百]+)[)）])\s*/;
export const HEADING_CARD_WIDTH = 1068;
export const HEADING_CARD_HEIGHT = 310;
export const HEADING_CARD_BACKGROUND = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'assets',
  'zen-section-heading-card.png',
);

export function isReservedHeading(text) {
  return RESERVED_HEADINGS.has(String(text || '').trim());
}

export function stripHeadingOrdinal(text) {
  return String(text || '').trim().replace(ORDINAL_RE, '').trim();
}

export function parseSectionHeading(text) {
  const raw = String(text || '').trim();
  if (!raw) return { en: '', zh: '' };
  const parts = splitHeadingParts(raw);
  if (parts.length < 2) {
    return looksEnglish(raw) && !looksChinese(raw)
      ? { en: raw, zh: '' }
      : { en: '', zh: raw };
  }
  const [left, right] = parts;
  if (looksEnglish(left) && looksChinese(right)) return { en: left, zh: right };
  if (looksChinese(left) && looksEnglish(right)) return { en: right, zh: left };
  return { en: left, zh: right };
}

export function headingCardHtml({
  index,
  en = '',
  zh = '',
  fontUrl = '',
  backgroundUrl = '',
} = {}) {
  const number = String(Math.max(1, Number(index) || 1)).padStart(2, '0');
  const english = String(en || '').trim();
  const chinese = String(zh || '').trim() || english;
  const showEnglish = Boolean(english && chinese && english !== chinese);
  const englishRow = showEnglish
    ? `<div data-zen-heading-en="true" class="en">${escapeHtml(english)}</div>`
    : '';
  const fontFace = fontUrl
    ? `@font-face{font-family:"Zen Heading CJK";src:url("${escapeAttr(fontUrl)}") format("woff2");font-style:normal;font-weight:500;font-display:block}`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFace}
html,body{margin:0;background:#FFFFFF}
.canvas{position:relative;width:${HEADING_CARD_WIDTH}px;height:${HEADING_CARD_HEIGHT}px;overflow:hidden;background:#FFFFFF}
.plate{position:absolute;inset:0;width:100%;height:100%;display:block}
.index{position:absolute;left:108px;top:74px;margin:0;font-family:Georgia,"Times New Roman",serif;font-size:72px;line-height:.86;font-weight:400;color:#C9C8C4;letter-spacing:.02em}
.copy{position:absolute;left:430px;right:56px;top:88px;text-align:right}
.en{font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;font-size:28px;line-height:1.15;font-weight:300;color:#A0A0A0;letter-spacing:.02em}
.zh{margin-top:10px;font-family:"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Noto Sans SC","Microsoft YaHei","Zen Heading CJK",sans-serif;font-size:40px;line-height:1.2;font-weight:400;color:#3E3E3E;letter-spacing:.08em}
</style></head><body><div class="canvas" data-zen-heading-card="true"><img class="plate" alt="" src="${escapeAttr(backgroundUrl)}"><div data-zen-heading-index="true" class="index">${number}</div><div class="copy">${englishRow}<div data-zen-heading-zh="true" class="zh">${escapeHtml(chinese)}</div></div></div></body></html>`;
}

export async function restyleSectionHeadings(html, {
  stripOrdinals = false,
  absoluteDirPath,
  renderCards,
  executablePath,
  signal,
} = {}) {
  const document = new JSDOM(`<body>${String(html || '')}</body>`).window.document;
  const cards = [];
  for (const heading of [...document.querySelectorAll('h2')]) {
    const raw = normalizeHeadingText(heading.textContent);
    if (!raw || isReservedHeading(raw)) continue;
    const parsed = parseSectionHeading(raw);
    cards.push({
      index: cards.length + 1,
      en: stripOrdinals ? stripHeadingOrdinal(parsed.en) : parsed.en,
      zh: stripOrdinals ? stripHeadingOrdinal(parsed.zh) : parsed.zh,
      node: heading,
    });
  }
  if (!cards.length) return document.body.innerHTML;

  const images = renderCards
    ? await renderCards(cards.map(({ index, en, zh }) => ({ index, en, zh })), { absoluteDirPath })
    : await renderHeadingCardImages(cards.map(({ index, en, zh }) => ({ index, en, zh })), {
      absoluteDirPath,
      executablePath,
      signal,
    });
  if (images.length !== cards.length) throw new Error('分区标题卡数量与标题不一致');

  cards.forEach((card, offset) => {
    const image = images[offset];
    if (!image?.src) throw new Error(`第 ${card.index} 个分区标题卡缺少图片`);
    const alt = [image.number || String(card.index).padStart(2, '0'), card.en, card.zh]
      .filter(Boolean)
      .join(' ');
    card.node.outerHTML = [
      '<section data-zen-section-heading="true" style="margin:1.8em 0 .85em;font-size:0;line-height:0;">',
      `<img data-zen-heading-card="true" data-zen-heading-index="${escapeAttr(image.number || String(card.index).padStart(2, '0'))}" src="${escapeAttr(image.src)}" alt="${escapeAttr(alt)}" style="max-width:100%;width:100%;height:auto;margin:0;display:block;border:0;">`,
      '</section>',
    ].join('');
  });
  return document.body.innerHTML;
}

export async function renderHeadingCardImages(cards, {
  absoluteDirPath,
  executablePath,
  signal,
} = {}) {
  if (!absoluteDirPath) throw new Error('分区标题卡缺少工作目录');
  const background = await fs.readFile(HEADING_CARD_BACKGROUND);
  if (background.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('分区标题卡底板不是 PNG');
  }
  const backgroundUrl = `data:image/png;base64,${background.toString('base64')}`;
  await fs.mkdir(absoluteDirPath, { recursive: true });
  const browserPath = executablePath || resolveBrowserExecutable();
  return withRuntimeResource('browser', async () => {
    let browser;
    try {
      browser = await chromium.launch({
        executablePath: browserPath,
        headless: true,
        args: ['--disable-background-networking', '--disable-component-update', '--disable-dev-shm-usage'],
      });
      const page = await browser.newPage({
        viewport: { width: HEADING_CARD_WIDTH, height: HEADING_CARD_HEIGHT },
        deviceScaleFactor: 1,
      });
      const images = [];
      for (const card of cards) {
        const number = String(Math.max(1, Number(card.index) || 1)).padStart(2, '0');
        const filename = `heading-${number}.png`;
        const outPath = path.join(absoluteDirPath, filename);
        await page.setContent(headingCardHtml({
          ...card,
          fontUrl: pathToFileURL(DEFAULT_COVER_FONT).href,
          backgroundUrl,
        }), { waitUntil: 'load' });
        await page.locator('.plate').evaluate((image) => new Promise((resolve, reject) => {
          const done = () => {
            if (image.naturalWidth === 1068 && image.naturalHeight === 310) resolve();
            else reject(new Error(`分区标题卡底板尺寸无效:${image.naturalWidth}x${image.naturalHeight}`));
          };
          if (image.complete) done();
          else {
            image.addEventListener('load', done, { once: true });
            image.addEventListener('error', () => reject(new Error('分区标题卡底板加载失败')), { once: true });
          }
        }));
        await page.evaluate(async () => {
          await document.fonts.ready;
          try { await document.fonts.load('500 36px "Zen Heading CJK"', '标题'); } catch {}
        });
        await page.screenshot({
          path: outPath,
          type: 'png',
          clip: { x: 0, y: 0, width: HEADING_CARD_WIDTH, height: HEADING_CARD_HEIGHT },
          omitBackground: false,
          animations: 'disabled',
        });
        images.push({ src: filename, number, path: outPath });
      }
      return images;
    } catch (error) {
      throw new Error(`分区标题卡渲染失败:${error.message}`);
    } finally {
      await browser?.close();
    }
  }, signal);
}

function splitHeadingParts(text) {
  const separator = text.includes('｜') ? '｜' : (text.includes('|') ? '|' : '');
  if (!separator) return [text];
  const [left, ...rest] = text.split(separator);
  const right = rest.join(separator).trim();
  const start = left.trim();
  return right ? [start, right] : [start];
}

function looksEnglish(text) {
  const letters = String(text || '').replace(/[^A-Za-z\u00C0-\u024F]/g, '');
  const cjk = String(text || '').replace(/[^\u3400-\u9FFF]/g, '');
  return letters.length >= 2 && letters.length > cjk.length;
}

function looksChinese(text) {
  return /[\u3400-\u9FFF]/.test(String(text || ''));
}

function normalizeHeadingText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '\u0026amp;',
    '<': '\u0026lt;',
    '>': '\u0026gt;',
    '"': '\u0026quot;',
    "'": '\u0026#39;',
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}
