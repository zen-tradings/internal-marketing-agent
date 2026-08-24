import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
const HEADING_CARD_WIDTH = 1080;
const HEADING_CARD_SCALE = 2;

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

export function headingCardHtml({ index, en = '', zh = '', fontUrl = '' } = {}) {
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
html,body{margin:0;background:#E9E5DC}
.canvas{width:${HEADING_CARD_WIDTH}px;padding:28px 28px 36px;box-sizing:border-box}
.card{position:relative;display:inline-block;max-width:720px;background:#FFFFFF;border:1px solid #C9C4BB;border-radius:34px;box-shadow:0 14px 28px rgba(40,36,30,.13);padding:26px 40px 52px 28px;box-sizing:border-box}
.bar{position:absolute;top:-6px;left:48px;width:62px;height:16px;background:#C9C4BB;border-radius:3px}
.row{display:flex;align-items:flex-start;gap:18px}
.index{flex:0 0 auto;font-family:Georgia,"Times New Roman",serif;font-size:68px;line-height:.86;font-weight:400;color:#C9C4BB;padding-top:2px;letter-spacing:.02em}
.copy{max-width:28em;padding-top:10px;text-align:right}
.en{font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;font-size:24px;line-height:1.25;font-weight:300;color:#C9C4BB;letter-spacing:.01em}
.zh{margin-top:6px;font-family:"Zen Heading CJK","PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif;font-size:30px;line-height:1.35;font-weight:500;color:#2A2A2A;letter-spacing:.04em}
</style></head><body><div class="canvas"><div class="card" data-zen-heading-card="true"><div class="bar" data-zen-heading-bar="true"></div><div class="row"><div class="index" data-zen-heading-index="true">${number}</div><div class="copy">${englishRow}<div data-zen-heading-zh="true" class="zh">${escapeHtml(chinese)}</div></div></div></div></div></body></html>`;
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
    const card = {
      index: cards.length + 1,
      en: stripOrdinals ? stripHeadingOrdinal(parsed.en) : parsed.en,
      zh: stripOrdinals ? stripHeadingOrdinal(parsed.zh) : parsed.zh,
      node: heading,
    };
    cards.push(card);
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
        viewport: { width: HEADING_CARD_WIDTH, height: 420 },
        deviceScaleFactor: HEADING_CARD_SCALE,
      });
      const images = [];
      for (const card of cards) {
        const number = String(Math.max(1, Number(card.index) || 1)).padStart(2, '0');
        const filename = `heading-${number}.png`;
        const outPath = path.join(absoluteDirPath, filename);
        await page.setContent(headingCardHtml({
          ...card,
          fontUrl: pathToFileURL(DEFAULT_COVER_FONT).href,
        }), { waitUntil: 'load' });
        await page.evaluate(async () => {
          await document.fonts.ready;
          try { await document.fonts.load('500 32px "Zen Heading CJK"', '标题');
          } catch {}
        });
        const box = await page.locator('.canvas').evaluate((node) => {
          const card = node.querySelector('[data-zen-heading-card="true"]');
          const cardBox = card.getBoundingClientRect();
          const frameBox = node.getBoundingClientRect();
          return {
            x: frameBox.x,
            y: frameBox.y,
            width: Math.min(frameBox.width, Math.ceil(cardBox.right - frameBox.left + 28)),
            height: Math.ceil(cardBox.bottom - frameBox.top + 24),
          };
        });
        await page.setViewportSize({
          width: Math.ceil(box.width),
          height: Math.max(220, Math.ceil(box.height)),
        });
        await page.screenshot({
          path: outPath,
          type: 'png',
          clip: {
            x: Math.max(0, box.x),
            y: Math.max(0, box.y),
            width: box.width,
            height: box.height,
          },
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
