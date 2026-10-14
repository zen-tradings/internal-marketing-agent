import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { browserExecutable } from '../src/lib/translation/assets.js';
import { installResourceGovernor } from '../src/config/runtime.js';
import { loadOpeningDigestCoverAssets, openingDigestCoverHtml } from '../src/lib/opening-digest-canvas-cover.js';
import {
  EMAIL_OPENING_COVER_HEIGHT,
  EMAIL_OPENING_COVER_WIDTH,
  OPENING_DIGEST_EN_SAFE_HEADLINE,
  normalizeOpeningDigestEmailHeadline,
  openingDigestEmailCoverData,
  renderOpeningDigestEmailCover,
} from '../src/lib/opening-digest-email-cover.js';

const input = { dateKey: '2026-10-02', headline: 'Fed decision looms over narrow equity participation', executablePath: '/fixture/chrome' };
const png = Buffer.alloc(24);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
png.writeUInt32BE(EMAIL_OPENING_COVER_WIDTH, 16);
png.writeUInt32BE(EMAIL_OPENING_COVER_HEIGHT, 20);
const fixtureAssets = { 'logo.png': Buffer.alloc(24), 'Montserrat.woff2': Buffer.from('font'), 'NotoSansSC.ttf': Buffer.from('font'), 'render.js': Buffer.from('') };
const loadAssets = async () => ({ assets: fixtureAssets, assetVersion: 'fixture-v1' });

function fakeBrowser({ launchError = false, blocked = false, brokenPng = false, evaluate } = {}) {
  const calls = { launched: 0, closed: 0, contexts: [] };
  return { calls, browserType: { launch: async () => {
    calls.launched++;
    if (launchError) throw new Error('browser unavailable');
    return {
      close: async () => { calls.closed++; },
      newContext: async (options) => {
        calls.contexts.push(options);
        return { route: async () => {}, newPage: async () => ({
          setDefaultTimeout() {}, goto: async () => {},
          evaluate: evaluate || (blocked ? () => new Promise(() => {}) : (async () => {})),
          locator: () => ({ screenshot: async () => brokenPng ? Buffer.from('broken') : png }),
        }) };
      },
    };
  } } };
}

test('邮件封面数据：英文标题、DAILY BRIEF 栏目、2x 输出与安全兜底', () => {
  assert.equal(EMAIL_OPENING_COVER_WIDTH, 1800);
  assert.equal(EMAIL_OPENING_COVER_HEIGHT, 766);
  assert.deepEqual(openingDigestEmailCoverData(input), {
    publish_date: '2026-10-02', section: 'DAILY BRIEF',
    cover_keywords: ['Fed decision looms over narrow equity participation'],
    english_tags: ['TREASURY YIELDS', 'SOFTWARE', 'MARKET SIGNALS'],
    scale: 2,
  });
  const max = 'a'.repeat(90);
  assert.equal(normalizeOpeningDigestEmailHeadline(max), max);
  assert.equal(normalizeOpeningDigestEmailHeadline(`${max}b`), OPENING_DIGEST_EN_SAFE_HEADLINE);
  assert.equal(normalizeOpeningDigestEmailHeadline(''), OPENING_DIGEST_EN_SAFE_HEADLINE);
  assert.equal(normalizeOpeningDigestEmailHeadline('标题\n第二行'), OPENING_DIGEST_EN_SAFE_HEADLINE);
  for (const dateKey of ['2026-02-30', '2025-02-29', '2026-13-01', 'invalid', '']) {
    assert.throws(() => openingDigestEmailCoverData({ ...input, dateKey }), /日期无效/);
  }
  assert.equal(openingDigestEmailCoverData({ ...input, dateKey: '2028-02-29' }).publish_date, '2028-02-29');
});

test('邮件封面 HTML 复用同一画布设计：scale 注入、转义与单个脚本结束标记', () => {
  const html = openingDigestCoverHtml(openingDigestEmailCoverData({ ...input, headline: '</script>&headline' }), fixtureAssets);
  assert.ok(html.includes('"scale":2'));
  assert.ok(html.includes('\\u003c/script>'));
  assert.ok(html.includes('2026.10.02'));
  assert.ok(html.includes('DAILY BRIEF'));
  assert.ok(html.includes('TREASURY YIELDS · SOFTWARE · MARKET SIGNALS'));
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  assert.ok(html.includes('canvas width="900" height="383"'));
  assert.ok(!html.includes('zen-opening-digest-background'));
});

test('邮件封面缓存独立于微信缓存：命中免浏览器，标题/日期/素材变化重新渲染', async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-email-cover-test-'));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const fake = fakeBrowser();
  const dependencies = { browserType: fake.browserType, loadAssets };
  await renderOpeningDigestEmailCover({ ...input, cacheDir }, dependencies);
  const metadata = JSON.parse(await fs.readFile(path.join(cacheDir, 'opening-digest-email-cover.json')));
  assert.equal(metadata.templateId, 'zen-customerio/zen-research@12');
  assert.deepEqual(metadata.cover_keywords, [input.headline]);
  assert.equal(metadata.scale, 2);
  await renderOpeningDigestEmailCover({ ...input, cacheDir, executablePath: '' }, dependencies);
  assert.equal(fake.calls.launched, 1);
  await fs.writeFile(path.join(cacheDir, 'opening-digest-email-cover.png'), 'broken');
  await renderOpeningDigestEmailCover({ ...input, cacheDir }, dependencies);
  assert.equal(fake.calls.launched, 2);
  await renderOpeningDigestEmailCover({ ...input, cacheDir, headline: 'CPI surprise reshapes rate path' }, dependencies);
  await renderOpeningDigestEmailCover({ ...input, cacheDir, dateKey: '2026-10-03' }, dependencies);
  await renderOpeningDigestEmailCover({ ...input, cacheDir, dateKey: '2026-10-03' }, {
    ...dependencies, loadAssets: async () => ({ assets: fixtureAssets, assetVersion: 'fixture-v2' }),
  });
  assert.equal(fake.calls.launched, 5);
  assert.equal(fake.calls.closed, 5);
  for (const context of fake.calls.contexts) {
    assert.equal(context.offline, true);
    assert.equal(context.deviceScaleFactor, 2);
  }
});

test('英文标题超出安全宽度时用固定英文兜底标题重渲一次并按兜底标题写缓存', async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-email-cover-fallback-'));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  let renders = 0;
  const evaluate = async () => {
    renders++;
    if (renders === 1) throw new Error('封面标题超出安全宽度');
    return {};
  };
  const fake = fakeBrowser({ evaluate });
  await renderOpeningDigestEmailCover({ ...input, cacheDir }, { browserType: fake.browserType, loadAssets });
  assert.equal(fake.calls.launched, 2);
  const metadata = JSON.parse(await fs.readFile(path.join(cacheDir, 'opening-digest-email-cover.json')));
  assert.deepEqual(metadata.cover_keywords, [OPENING_DIGEST_EN_SAFE_HEADLINE]);
  assert.deepEqual(await fs.readFile(path.join(cacheDir, 'opening-digest-email-cover.png')), png);

  // 兜底标题本身无法渲染时不进入第二次渲染,错误原样向上抛出。
  let alwaysRenders = 0;
  const alwaysOverflow = fakeBrowser({ evaluate: async () => { alwaysRenders++; throw new Error('封面标题超出安全宽度'); } });
  await assert.rejects(
    renderOpeningDigestEmailCover({ ...input, headline: 'a'.repeat(200), cacheDir: undefined }, { browserType: alwaysOverflow.browserType, loadAssets }),
    /邮件封面渲染失败:封面标题超出安全宽度/,
  );
  assert.equal(alwaysRenders, 1);
  assert.equal(alwaysOverflow.calls.launched, 1);
});

test('渲染超时、浏览器启动失败和错误 PNG 都释放资源且不缓存失败结果', async (t) => {
  let acquired = 0, released = 0;
  installResourceGovernor({ acquire: async (name) => { assert.equal(name, 'browser'); acquired++; return () => { released++; }; } });
  t.after(() => installResourceGovernor(undefined));
  for (const options of [{ blocked: true }, { launchError: true }, { brokenPng: true }]) {
    const fake = fakeBrowser(options);
    await assert.rejects(renderOpeningDigestEmailCover({ ...input, timeoutMs: 20, cacheDir: undefined }, { browserType: fake.browserType, loadAssets }), (error) => {
      assert.equal(error.stage, 'cover'); assert.equal(error.retryable, true); return true;
    });
    assert.equal(fake.calls.closed, options.launchError ? 0 : 1);
  }
  assert.equal(acquired, 3); assert.equal(released, 3);
});

test('真实浏览器断网渲染：英文标题 2x 输出 1800×766，超宽标题回落安全标题，零外联', { timeout: 90000 }, async (t) => {
  const executablePath = browserExecutable({ browserExecutablePath: process.env.TRANSLATION_BROWSER_EXECUTABLE || chromium.executablePath() });
  if (!executablePath) { t.skip('Chrome/Chromium unavailable'); return; }
  const { assets } = await loadOpeningDigestCoverAssets();
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ offline: true, viewport: { width: 900, height: 383 }, deviceScaleFactor: 2 });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-email-cover-layout-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const htmlPath = path.join(temporary, 'cover.html');
  const localFiles = new Set([pathToFileURL(htmlPath).href, new URL('../assets/opening-digest-wechat-cover/NotoSansSC.ttf', import.meta.url).href]);
  const requests = [];
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (localFiles.has(url)) return route.continue();
    requests.push(url); return route.abort();
  });
  const page = await context.newPage();
  const cases = [
    { headline: 'Fed decision looms over narrow equity participation', expect: 'Fed decision looms over narrow equity participation' },
    { headline: 'M'.repeat(90), overflow: true },
    { headline: OPENING_DIGEST_EN_SAFE_HEADLINE, expect: OPENING_DIGEST_EN_SAFE_HEADLINE, reproducible: true },
    { headline: OPENING_DIGEST_EN_SAFE_HEADLINE, expect: OPENING_DIGEST_EN_SAFE_HEADLINE },
  ];
  let reference;
  for (const item of cases) {
    await fs.writeFile(htmlPath, openingDigestCoverHtml(openingDigestEmailCoverData({ ...input, headline: item.headline }), assets));
    await page.goto(pathToFileURL(htmlPath).href);
    if (item.overflow) {
      await assert.rejects(page.evaluate(() => Promise.race([window.zenCoverReady, new Promise((_, reject) => setTimeout(() => reject(new Error('font readiness timeout')), 15000))])), /封面标题超出安全宽度/);
      continue;
    }
    const layout = await page.evaluate(() => Promise.race([window.zenCoverReady, new Promise((_, reject) => setTimeout(() => reject(new Error('font readiness timeout')), 15000))]));
    assert.equal(layout.headline, item.expect);
    assert.equal(layout.scale, 2);
    assert.ok(layout.headlineWidth <= layout.maxWidth);
    const image = await page.locator('canvas').screenshot({ type: 'png' });
    assert.equal(image.readUInt32BE(16), 1800); assert.equal(image.readUInt32BE(20), 766);
    assert.ok(image.length > 10000);
    if (item.reproducible) reference = image;
    else if (item.expect === OPENING_DIGEST_EN_SAFE_HEADLINE) assert.deepEqual(image, reference);
  }
  assert.deepEqual(requests, []);
});
