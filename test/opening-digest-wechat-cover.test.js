import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { browserExecutable } from '../src/lib/translation/assets.js';
import { installResourceGovernor } from '../src/config/runtime.js';
import {
  loadOpeningDigestWechatCoverAssets,
  normalizeOpeningDigestWechatHeadline,
  openingDigestWechatCoverData,
  openingDigestWechatCoverHtml,
  renderOpeningDigestWechatCover,
} from '../src/lib/opening-digest-wechat-cover.js';

const input = { dateKey: '2026-10-02', headline: '利率考验科技股信心', executablePath: '/fixture/chrome' };
const png = Buffer.alloc(24);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
png.writeUInt32BE(900, 16); png.writeUInt32BE(383, 20);
const fixtureAssets = { 'logo.png': png, 'Montserrat.woff2': Buffer.from('font'), 'NotoSansSC.ttf': Buffer.from('font'), 'render.js': Buffer.from('') };
const loadAssets = async () => ({ assets: fixtureAssets, assetVersion: 'fixture-v1' });

function fakeBrowser({ blocked = false, brokenPng = false, launchError = false } = {}) {
  const calls = { launched: 0, closed: 0, screenshots: 0 };
  return { calls, browserType: { launch: async () => {
    calls.launched++;
    if (launchError) throw new Error('browser unavailable');
    return {
      close: async () => { calls.closed++; },
      newContext: async (options) => {
        assert.equal(options.offline, true);
        return { route: async () => {}, newPage: async () => ({
          setDefaultTimeout() {}, goto: async () => {},
          evaluate: async () => blocked ? new Promise(() => {}) : {},
          locator: () => ({ screenshot: async () => { calls.screenshots++; return brokenPng ? Buffer.from('broken') : png; } }),
        }) };
      },
    };
  } } };
}

test('封面只复用完整中文标题，保留网页导入字段、固定栏目与英文标签', () => {
  assert.deepEqual(openingDigestWechatCoverData(input), {
    publish_date: '2026-10-02', section: '开市日报 · DAILY BRIEF',
    cover_keywords: ['利率考验科技股信心'], english_tags: ['TREASURY YIELDS', 'SOFTWARE', 'MARKET SIGNALS'],
  });
  const full = '一二三四五六七八九十一二三四五六';
  assert.equal([...full].length, 16);
  assert.equal(normalizeOpeningDigestWechatHeadline(full), full);
  assert.equal(normalizeOpeningDigestWechatHeadline(`${full}七`), '今日开市要点');
  assert.equal(normalizeOpeningDigestWechatHeadline(''), '今日开市要点');
  assert.equal(normalizeOpeningDigestWechatHeadline('标题\n第二行'), '今日开市要点');
  for (const dateKey of ['2026-02-30', '2025-02-29', '2026-13-01', 'invalid', '']) {
    assert.throws(() => openingDigestWechatCoverData({ ...input, dateKey }), /日期无效/);
  }
  assert.equal(openingDigestWechatCoverData({ ...input, dateKey: '2028-02-29' }).publish_date, '2028-02-29');
});

test('本地素材通过来源校验；字体缺失或损坏不回退到宿主字体', async () => {
  const { assets, assetVersion } = await loadOpeningDigestWechatCoverAssets();
  assert.equal(assets['NotoSansSC.ttf'].subarray(0, 4).toString('hex'), '00010000');
  assert.equal(assets['Montserrat.woff2'].subarray(0, 4).toString(), 'wOF2');
  assert.match(assetVersion, /^[a-f0-9]{64}$/);
  await assert.rejects(loadOpeningDigestWechatCoverAssets({ readFile: async (url, ...args) => {
    if (url.pathname.endsWith('NotoSansSC.ttf')) throw Object.assign(new Error('missing font'), { code: 'ENOENT' });
    return fs.readFile(url, ...args);
  } }), /素材不可读.*missing font/);
  await assert.rejects(loadOpeningDigestWechatCoverAssets({ readFile: async (url, ...args) => {
    if (url.pathname.endsWith('Montserrat.woff2')) return Buffer.from('damaged');
    return fs.readFile(url, ...args);
  } }), /素材校验失败:Montserrat/);
});

test('封面注入转义脚本结束标记，日期不依赖当前时间', () => {
  const html = openingDigestWechatCoverHtml(openingDigestWechatCoverData({ ...input, headline: '</script>&标题' }), fixtureAssets);
  assert.ok(html.includes('\\u003c/script>'));
  assert.ok(html.includes('2026.10.02'));
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  assert.ok(Buffer.byteLength(html) < 200000);
  assert.ok(!html.includes('data:font/ttf;base64,'));
});

test('同任务缓存命中免启动浏览器；损坏缓存和日期/标题/素材变化重新生成', async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-wechat-cover-test-'));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const fake = fakeBrowser();
  const dependencies = { browserType: fake.browserType, loadAssets };
  await renderOpeningDigestWechatCover({ ...input, cacheDir }, dependencies);
  const metadata = JSON.parse(await fs.readFile(path.join(cacheDir, 'opening-digest-wechat-cover.json')));
  assert.equal(metadata.templateId, 'zen-wechat/zen-trading@11');
  assert.deepEqual(metadata.cover_keywords, [input.headline]);
  await renderOpeningDigestWechatCover({ ...input, cacheDir, executablePath: '' }, dependencies);
  assert.equal(fake.calls.launched, 1);
  await fs.writeFile(path.join(cacheDir, 'opening-digest-wechat-cover.png'), 'broken');
  await renderOpeningDigestWechatCover({ ...input, cacheDir }, dependencies);
  assert.equal(fake.calls.launched, 2);
  await fs.writeFile(path.join(cacheDir, 'opening-digest-wechat-cover.json'), '{broken');
  await renderOpeningDigestWechatCover({ ...input, cacheDir }, dependencies);
  await renderOpeningDigestWechatCover({ ...input, cacheDir, headline: 'CPI 影响美股' }, dependencies);
  await renderOpeningDigestWechatCover({ ...input, cacheDir, dateKey: '2026-10-03' }, dependencies);
  await renderOpeningDigestWechatCover({ ...input, cacheDir, dateKey: '2026-10-03' }, {
    ...dependencies, loadAssets: async () => ({ assets: fixtureAssets, assetVersion: 'fixture-v2' }),
  });
  assert.equal(fake.calls.launched, 6);
  assert.equal(fake.calls.closed, 6);
});

test('渲染超时、浏览器启动失败和错误 PNG 都释放资源且不缓存失败结果', async (t) => {
  let acquired = 0, released = 0;
  installResourceGovernor({ acquire: async (name) => { assert.equal(name, 'browser'); acquired++; return () => { released++; }; } });
  t.after(() => installResourceGovernor(undefined));
  for (const options of [{ blocked: true }, { launchError: true }, { brokenPng: true }]) {
    const fake = fakeBrowser(options);
    await assert.rejects(renderOpeningDigestWechatCover({ ...input, timeoutMs: 20 }, { browserType: fake.browserType, loadAssets }), (error) => {
      assert.equal(error.stage, 'cover'); assert.equal(error.retryable, true); return true;
    });
    assert.equal(fake.calls.closed, options.launchError ? 0 : 1);
  }
  assert.equal(acquired, 3); assert.equal(released, 3);
});

test('真实浏览器断网渲染：完整中文、16字、中英混排和特殊字符不溢出，PNG可复现', { timeout: 90000 }, async (t) => {
  const executablePath = browserExecutable({ browserExecutablePath: process.env.TRANSLATION_BROWSER_EXECUTABLE || chromium.executablePath() });
  if (!executablePath) { t.skip('Chrome/Chromium unavailable'); return; }
  const { assets } = await loadOpeningDigestWechatCoverAssets();
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ offline: true, viewport: { width: 900, height: 383 }, deviceScaleFactor: 1 });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-wechat-cover-layout-'));
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
  let reference;
  for (const headline of ['利率考验科技股信心', '一二三四五六七八九十一二三四五六', 'NVDA上涨10.25%', '美债&科技<拐点>', '利率考验科技股信心']) {
    await fs.writeFile(htmlPath, openingDigestWechatCoverHtml(openingDigestWechatCoverData({ ...input, headline }), assets));
    await page.goto(pathToFileURL(htmlPath).href);
    const layout = await page.evaluate(() => Promise.race([window.zenCoverReady, new Promise((_, reject) => setTimeout(() => reject(new Error('font readiness timeout')), 15000))]));
    assert.equal(layout.headline, headline);
    assert.ok(layout.headlineWidth <= layout.maxWidth);
    assert.ok(layout.tagsWidth <= layout.maxWidth);
    const image = await page.locator('canvas').screenshot({ type: 'png' });
    assert.equal(image.readUInt32BE(16), 900); assert.equal(image.readUInt32BE(20), 383);
    assert.ok(image.length > 10000);
    if (!reference) reference = image;
    else if (headline === '利率考验科技股信心') assert.deepEqual(image, reference);
  }
  assert.deepEqual(requests, []);
});
