import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COVER_HEIGHT,
  COVER_WIDTH,
  DEFAULT_COVER_BACKGROUND,
  DEFAULT_COVER_FONT,
  resolveBrowserExecutable,
} from '../tools/cover-generator/render.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('封面固定使用原始白底图尺寸与背景资产', () => {
  assert.equal(COVER_WIDTH, 900);
  assert.equal(COVER_HEIGHT, 383);
  assert.match(DEFAULT_COVER_BACKGROUND, /assets\/zen-cover-background\.png$/);
});

test('封面内嵌资源圆体中文标题字体', () => {
  assert.match(DEFAULT_COVER_FONT, /fonts\/ResourceHanRoundedCN-Medium\.woff2$/);
  assert.ok(fs.statSync(DEFAULT_COVER_FONT).size > 1_000_000);
  assert.ok(fs.existsSync(path.join(path.dirname(DEFAULT_COVER_FONT), 'OFL-Resource-Han-Rounded.txt')));

  const template = fs.readFileSync(path.join(REPO_ROOT, 'tools', 'cover-generator', 'template.html'), 'utf8');
  assert.match(template, /@font-face\s*{/);
  assert.match(template, /src:url\("__ZEN_COVER_FONT__"\) format\("woff2"\)/);
  assert.match(template, /h1[^}]+font-family:"Zen Rounded CJK"/s);
  assert.match(template, /\.subtitle[^}]+font-family:"Zen Rounded CJK"/s);
});

test('封面生成器优先使用显式 COVER_BROWSER_EXECUTABLE', () => {
  const exists = (candidate) => candidate === '/custom/chromium';
  assert.equal(
    resolveBrowserExecutable({
      COVER_BROWSER_EXECUTABLE: '/custom/chromium',
      TRANSLATION_BROWSER_EXECUTABLE: '/other/chrome',
    }, exists),
    '/custom/chromium'
  );
});

test('封面生成器可复用 TRANSLATION_BROWSER_EXECUTABLE', () => {
  const exists = (candidate) => candidate === '/shared/chromium';
  assert.equal(
    resolveBrowserExecutable({ TRANSLATION_BROWSER_EXECUTABLE: '/shared/chromium' }, exists),
    '/shared/chromium'
  );
});

test('显式配置的浏览器不存在时立即报错', () => {
  assert.throws(
    () => resolveBrowserExecutable({ COVER_BROWSER_EXECUTABLE: '/missing/chrome' }, () => false),
    /封面浏览器不存在/
  );
});

test('未配置浏览器时自动发现 Linux Chromium', () => {
  const exists = (candidate) => candidate === '/usr/bin/chromium';
  assert.equal(resolveBrowserExecutable({}, exists), '/usr/bin/chromium');
});
