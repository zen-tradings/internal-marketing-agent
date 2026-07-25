#!/usr/bin/env node
// 用法: node render.mjs <data.json> [out.png]
// 把数据注入 template.html，再用本机 Chromium/Chrome 渲染成精确 900×383 PNG。
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const COVER_WIDTH = 900;
export const COVER_HEIGHT = 383;
export const DEFAULT_COVER_BACKGROUND = resolve(
  MODULE_DIR,
  '..',
  '..',
  'assets',
  'zen-cover-background.png'
);

const COMMON_BROWSER_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

export function resolveBrowserExecutable(env = process.env, exists = existsSync) {
  const configured = env.COVER_BROWSER_EXECUTABLE || env.TRANSLATION_BROWSER_EXECUTABLE;
  if (configured) {
    if (exists(configured)) return configured;
    throw new Error(`封面浏览器不存在: ${configured}`);
  }

  const detected = COMMON_BROWSER_PATHS.find((candidate) => exists(candidate));
  if (detected) return detected;
  throw new Error(
    '找不到 Chromium/Chrome；请设置 COVER_BROWSER_EXECUTABLE 或 TRANSLATION_BROWSER_EXECUTABLE'
  );
}

export async function renderCover({
  dataPath = join(MODULE_DIR, 'samples', 'example.json'),
  outPath = join(MODULE_DIR, 'out', 'preview.png'),
  env = process.env,
} = {}) {
  const absoluteDataPath = resolve(dataPath);
  const absoluteOutPath = resolve(outPath);
  const data = JSON.parse(readFileSync(absoluteDataPath, 'utf8'));

  if (!existsSync(DEFAULT_COVER_BACKGROUND)) {
    throw new Error(`固定封面背景不存在: ${DEFAULT_COVER_BACKGROUND}`);
  }

  const template = readFileSync(join(MODULE_DIR, 'template.html'), 'utf8');
  const serializedData = JSON.stringify(data)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  const html = template
    .replaceAll('__ZEN_COVER_BACKGROUND__', pathToFileURL(DEFAULT_COVER_BACKGROUND).href)
    .replace(
      '<script>',
      `<script>window.DATA = ${serializedData};</script>\n<script>`
    );

  const workDir = mkdtempSync(join(tmpdir(), 'zen-cover-render-'));
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
      ],
    });
    const page = await browser.newPage({ viewport: { width: COVER_WIDTH, height: COVER_HEIGHT } });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load', timeout: 30000 });
    await page.screenshot({ path: absoluteOutPath, type: 'png', omitBackground: true });
  } finally {
    if (browser) await browser.close();
    rmSync(workDir, { recursive: true, force: true });
  }

  console.log('✓ 已生成:', absoluteOutPath);
  return absoluteOutPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await renderCover({
    dataPath: process.argv[2] || undefined,
    outPath: process.argv[3] || undefined,
  });
}
