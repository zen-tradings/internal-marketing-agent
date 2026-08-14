#!/usr/bin/env node
// Usage: node render.mjs <data.json> [out.png]
// data.json: { "syntax": "infographic <template>\ndata\n  ...", "width"?: number }
// Render infographic syntax locally to SVG with @antv/infographic SSR, then capture PNG with local Chromium/Chrome
// because WeChat does not support SVG.
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { getTemplates, setFontExtendFactor } from '@antv/infographic';
import { renderToString } from '@antv/infographic/ssr';
import { resolveBrowserExecutable } from '../cover-generator/render.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

// SSR text measurement lays out title/label containers at exact widths, while browser glyphs can be slightly wider.
// Reserve 20% measurement headroom so Han titles do not wrap and obscure graphics.
setFontExtendFactor(1.2);
// The WeChat body content area is about 677px wide. Scale overly narrow templates, such as vertical cards, to a
// readable width; keep wide templates at natural size for WeChat max-width adaptation.
const MIN_DISPLAY_WIDTH = 560;
const MAX_DISPLAY_WIDTH = 900;
const SCALE = 2; // deviceScaleFactor for Retina clarity.

export function parseTemplateName(syntax) {
  const firstLine = String(syntax || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
  const match = /^infographic\s+(\S+)$/.exec(firstLine);
  return match ? match[1] : '';
}

export async function renderInfographic({
  dataPath,
  outPath,
  env = process.env,
} = {}) {
  const absoluteDataPath = resolve(dataPath);
  const absoluteOutPath = resolve(outPath);
  const data = JSON.parse(readFileSync(absoluteDataPath, 'utf8'));
  const syntax = String(data.syntax || '').trim();
  if (!syntax) throw new Error('data.json 缺少 syntax 字段');

  // SSR silently falls back to a generic layout for unknown templates, which can be misleading; hard-fail so the
  // caller discards and warns about the image.
  const template = parseTemplateName(syntax);
  if (!template) throw new Error('信息图语法首行必须是: infographic <template>');
  if (!getTemplates().includes(template)) {
    throw new Error(`未知信息图模板: ${template}`);
  }

  const svg = (await renderToString(syntax)).trim();
  const svgTag = /<svg\b[^>]*>/.exec(svg)?.[0] || '';
  const naturalWidth = Number(/\bwidth="([0-9.]+)"/.exec(svgTag)?.[1]);
  const naturalHeight = Number(/\bheight="([0-9.]+)"/.exec(svgTag)?.[1]);
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) throw new Error('SSR 输出的 SVG 宽高非法');

  const requestedWidth = Number(data.width);
  const displayWidth = requestedWidth > 0
    ? Math.min(requestedWidth, MAX_DISPLAY_WIDTH)
    : Math.min(Math.max(naturalWidth, MIN_DISPLAY_WIDTH), MAX_DISPLAY_WIDTH);
  const displayHeight = Math.ceil((naturalHeight * displayWidth) / naturalWidth);

  // SVG font-family is a presentation attribute and CSS has higher precedence. Add system Han-font fallback so
  // unavailable font CDNs do not render Han characters as tofu glyphs.
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
html,body{margin:0;padding:0;background:#ffffff;}
svg{display:block;width:${Math.ceil(displayWidth)}px;height:${displayHeight}px;}
svg,svg *{font-family:'Alibaba PuHuiTi','PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans CJK SC',sans-serif !important;}
</style>
</head>
<body>
${svg}
</body>
</html>`;

  const workDir = mkdtempSync(join(tmpdir(), 'zen-infographic-render-'));
  const htmlPath = join(workDir, 'render.html');
  writeFileSync(htmlPath, html);

  let browser;
  try {
    browser = await chromium.launch({
      executablePath: resolveBrowserExecutable(env),
      headless: true,
      args: [
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-dev-shm-usage',
        '--force-color-profile=srgb',
      ],
    });
    const page = await browser.newPage({
      viewport: { width: Math.ceil(displayWidth), height: displayHeight },
      deviceScaleFactor: SCALE,
    });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load', timeout: 30000 });
    // Wait for fonts when the remote stylesheet is available; document.fonts.ready also resolves when it is not.
    await page.evaluate(() => (document.fonts ? document.fonts.ready : undefined)).catch(() => {});
    await page.screenshot({ path: absoluteOutPath, type: 'png' });
  } finally {
    if (browser) await browser.close();
    rmSync(workDir, { recursive: true, force: true });
  }

  console.log('✓ 已生成:', absoluteOutPath);
  return absoluteOutPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await renderInfographic({
    dataPath: process.argv[2] || join(MODULE_DIR, 'samples', 'example.json'),
    outPath: process.argv[3] || join(MODULE_DIR, 'out', 'preview.png'),
  });
}
