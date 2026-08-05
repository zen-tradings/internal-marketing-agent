#!/usr/bin/env node
// 用法: node render.mjs <data.json> [out.png]
// data.json: { "syntax": "infographic <template>\ndata\n  ...", "width"?: number }
// 用 @antv/infographic 的 SSR 在本地把信息图语法渲染成 SVG,
// 再由本机 Chromium/Chrome 截图成 PNG(微信不支持 SVG)。
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

// SSR 文本测量按精确宽度给标题/标签容器排版,浏览器实际字宽略大就会换行。
// 预留 20% 测量余量,避免中文标题被拆成两行遮挡图形。
setFontExtendFactor(1.2);
// 公众号正文内容区宽约 677px。过窄的模板(如竖向卡片)按比例放大到可读宽度,
// 过宽的保持自然尺寸,由微信端 max-width 自适应。
const MIN_DISPLAY_WIDTH = 560;
const MAX_DISPLAY_WIDTH = 900;
const SCALE = 2; // deviceScaleFactor,保证 retina 清晰度

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

  // 未知模板会被 SSR 静默回退成通用布局,容易产生误导性图片,这里硬失败,
  // 由调用方丢弃该张图并告警。
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

  // SVG 内 font-family 是呈现属性,CSS 优先级更高,这里补齐系统中文字体回退,
  // 避免字体 CDN 不可达时中文变成豆腐块。
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
    // 远程字体样式表可达时等字体就绪;不可达时 document.fonts.ready 也会正常 resolve。
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
