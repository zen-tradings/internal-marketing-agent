import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import {
  makeWechatOpeningDigestChannel,
  renderWechatOpeningDigestHtml,
  validateWechatOpeningDigestDraft,
  WECHAT_DRAFT_MAX_CHARS,
  WECHAT_OPENING_DIGEST_TEMPLATE_ID,
} from '../src/channels/wechat-opening-digest.js';
import {
  protectTranslationUnit,
  restoreTranslationUnit,
  translateOpeningDigestPayload,
  translationUnits,
} from '../src/lib/opening-digest-translation.js';

const BODY = `## Today's catalysts
- [NVIDIA Corporation update](https://example.com/a) moved SPY 10.25% at 10:15 EDT.
- OCC reported a second catalyst for QQQ.

## Market read
NVIDIA Corporation remains the central condition; 2026 guidance is unchanged.`;

function payload() {
  return {
    schemaVersion: 1, dateKey: '2026-08-10',
    article: { title: 'Zen Opening Digest', preheader: 'Morning market signals.', body: BODY },
    metrics: ['SPY', 'QQQ', 'IWM', 'VIX', '2Y UST', '10Y UST', 'DXY', 'WTI', 'Gold'].map((label, index) => ({
      label, symbol: label, value: 100 + index, changePct: index % 2 ? -1.25 : 1.25,
      ...(label === '2Y UST' ? { sourceNote: '2Y UST is the latest available U.S. Treasury daily par yield.' } : {}),
    })),
    options: {
      capturedAt: '2026-08-10T14:15:00.000Z', kind: 'Opening',
      data: {
        asOf: 'As of 10 Aug 2026, 10:15:00 EDT',
        attribution: 'Data provided by IVolatility',
        rows: Array.from({ length: 20 }, (_, index) => [
          String(index + 1), `T${index + 1}`, index === 0 ? 'NVIDIA Corporation' : `Company ${index + 1}`,
          '50.00 %', '50.00 %', (1_000_000 - index * 10_000).toLocaleString('en-US'),
          (20 + index / 10).toFixed(2), index % 2 ? '0.10' : '-0.10',
        ]),
      },
    },
  };
}

function translated(source = payload()) {
  return {
    schemaVersion: 1, payloadHash: 'test', model: 'test', repairs: [],
    translations: translationUnits(source).map((unit) => ({
      id: unit.id, kind: unit.kind, source: unit.text,
      text: ({
        preheader: '早盘市场信号。',
        'body-1': '今日催化',
        'body-2': '[NVIDIA 公司动态](https://example.com/a) 使 SPY 在 10:15 EDT 变动 10.25%。',
        'body-3': 'OCC 报告了影响 QQQ 的第二项催化。',
        'body-4': '市场解读',
        'body-5': 'NVIDIA 公司仍是核心条件；2026 年指引保持不变。',
        'metric-note-1': '2Y UST 是最新可用的 U.S. Treasury 每日票面收益率。',
        'oic-asof': '截至 10 Aug 2026, 10:15:00 EDT',
        'oic-attribution': '数据由 IVolatility 提供',
        'oic-company-1': 'NVIDIA 公司',
      })[unit.id] || (unit.id.startsWith('oic-company-') ? `公司 ${unit.id.split('-').at(-1)}` : unit.text),
    })),
  };
}

test('Opening Digest 专用直译保持块 ID、顺序、数字、Ticker、时间和机构品牌', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-opening-zh-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  const result = await translateOpeningDigestPayload(payload(), {
    cacheDir: directory, writer: { model: 'test' },
    complete: async ({ units }) => {
      calls += 1;
      const mapping = new Map(translated().translations.map((item) => [item.id, item.text]));
      return { translations: units.map((unit) => ({ id: unit.id, text: mapping.get(unit.id) })) };
    },
  });
  assert.deepEqual(result.translations.map((item) => item.id), translationUnits(payload()).map((item) => item.id));
  assert.match(result.translations.find((item) => item.id === 'body-2').text, /SPY.*10:15 EDT.*10\.25%/);
  assert.equal(result.translations.find((item) => item.id === 'oic-company-1').text, 'NVIDIA 公司');
  assert.equal(result.translations.find((item) => item.id === 'oic-company-2').text, 'Company 2');
  await translateOpeningDigestPayload(payload(), { cacheDir: directory, writer: { model: 'test' }, complete: async () => { throw new Error('cache miss'); } });
  assert.equal(calls, 1, '同一英文 payload 的测试稿和正式稿必须复用中文译文');
});

test('Opening Digest 专用翻译把可配置长超时传给模型调用', async () => {
  let observedTimeout;
  await translateOpeningDigestPayload(payload(), {
    writer: { model: 'test' }, timeoutMs: 420000,
    complete: async ({ units, timeoutMs }) => {
      observedTimeout = timeoutMs;
      const mapping = new Map(translated().translations.map((item) => [item.id, item.text]));
      return { translations: units.map((unit) => ({ id: unit.id, text: mapping.get(unit.id) })) };
    },
  });
  assert.equal(observedTimeout, 420000);
});

test('Opening Digest 品牌门禁不把英文标题短语误判为机构名', async () => {
  const source = {
    article: {
      preheader: 'Market signals and catalysts.',
      body: `## Today's catalysts
- **OIC IV signals: SPCX** — The OIC Top 20 scan shows SPCX at 68.54% ([Options Education](https://example.com/oic)).
- **Macro: July CPI** — The July CPI report is scheduled for release at 8:30 a.m. ET Wednesday ([Barron’s](https://example.com/cpi)).`,
    },
    metrics: [],
  };
  const mapping = new Map([
    ['preheader', '市场信号与催化因素。'],
    ['body-1', '今日催化'],
    ['body-2', '**OIC IV 信号：SPCX** — OIC 前 20 名扫描显示 SPCX 为 68.54%（[Options Education](https://example.com/oic)）。'],
    ['body-3', '**宏观：7 月 CPI** — 7 月 CPI 报告定于周三上午 8:30 ET 发布（[Barron’s](https://example.com/cpi)）。'],
  ]);
  let calls = 0;
  const result = await translateOpeningDigestPayload(source, {
    writer: { model: 'test' },
    complete: async ({ units }) => {
      calls += 1;
      return { translations: units.map((unit) => ({ id: unit.id, text: mapping.get(unit.id) })) };
    },
  });
  assert.equal(calls, 1);
  assert.match(result.translations.find((unit) => unit.id === 'body-2').text, /OIC 前 20 名/);
  assert.match(result.translations.find((unit) => unit.id === 'body-3').text, /7 月 CPI.*8:30 ET/);
});

test('标准 Markdown 来源链接标签在模型翻译前被原样保护', async () => {
  const unit = {
    id: 'body-2', kind: 'list_item',
    text: '**July CPI** — [Barron’s](https://example.com/cpi) reports the release.',
  };
  const protectedUnit = protectTranslationUnit(unit);
  assert.doesNotMatch(protectedUnit.unit.text, /Barron’s|https:\/\/example\.com\/cpi/);
  const restored = restoreTranslationUnit(protectedUnit.unit.text.replace('reports the release', '报道了该数据发布'), protectedUnit.tokens);
  assert.match(restored, /\[Barron’s]\(https:\/\/example\.com\/cpi\)/);
});

test('英文金额的数字与量级作为一个不可变 token 保护', () => {
  const unit = {
    id: 'body-2', kind: 'list_item',
    text: 'Revenue doubled to $2.58 billion and backlog reached $104 billion.',
  };
  const protectedUnit = protectTranslationUnit(unit);
  assert.doesNotMatch(protectedUnit.unit.text, /\$2\.58 billion|\$104 billion/);
  assert.ok(protectedUnit.tokens.some((token) => token.value === '$2.58 billion'));
  assert.ok(protectedUnit.tokens.some((token) => token.value === '$104 billion'));
  const restored = restoreTranslationUnit('收入增长至 ⟦ZEN_KEEP_AAA⟧，积压订单达 ⟦ZEN_KEEP_AAB⟧。', protectedUnit.tokens);
  assert.match(restored, /\$2\.58 billion/);
  assert.match(restored, /\$104 billion/);
});

test('中文直译在两轮局部修复后仍拒绝缺块、重复和乱序', async () => {
  await assert.rejects(translateOpeningDigestPayload(payload(), {
    writer: { model: 'test' },
    complete: async ({ units }) => ({ translations: [...units].reverse().map((unit) => ({ id: unit.id, text: unit.text })) }),
  }), /块 ID 重复、乱序或含未知项/);
});

test('局部修复漏一块时保留已合格块，下一轮只重试缺失块', async () => {
  const source = payload();
  const mapping = new Map(translated(source).translations.map((item) => [item.id, item.text]));
  const calls = [];
  const result = await translateOpeningDigestPayload(source, {
    writer: { model: 'test' },
    complete: async ({ units, round }) => {
      calls.push(units.map((unit) => unit.id));
      const items = units.map((unit) => ({ id: unit.id, text: mapping.get(unit.id) }));
      return { translations: round === 0 ? items.slice(0, -1) : items };
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], [calls[0].at(-1)]);
  assert.deepEqual(result.translations.map((item) => item.id), translationUnits(source).map((item) => item.id));
});

test('模型翻译前用占位符保护 URL、Ticker、时间和数字并无损还原', async () => {
  const source = {
    article: {
      preheader: 'Market signals.',
      body: `## Today's catalysts
- **July CPI** — SPCX was 68.54% at 8:30 a.m. ET ([Barron’s](https://example.com/cpi-2026)).`,
    },
    metrics: [],
  };
  let protectedText = '';
  const result = await translateOpeningDigestPayload(source, {
    writer: { model: 'test' },
    complete: async ({ units }) => ({ translations: units.map((unit) => {
      if (unit.id === 'body-2') {
        protectedText = unit.text;
        return { id: unit.id, text: unit.text.replace(' was ', ' 为 ').replace(' at ', ' 于 ') };
      }
      return { id: unit.id, text: unit.id === 'preheader' ? '市场信号。' : unit.text };
    }) }),
  });
  assert.doesNotMatch(protectedText, /SPCX|68\.54%|8:30 a\.m\. ET|https:\/\/example\.com/);
  assert.match(protectedText, /⟦ZEN_KEEP_[A-Z]{3}⟧/);
  const translatedBody = result.translations.find((unit) => unit.id === 'body-2').text;
  assert.match(translatedBody, /SPCX.*68\.54%.*8:30 a\.m\. ET.*https:\/\/example\.com\/cpi-2026/);
});

test('OIC 时点与归属用确定性中文前缀保留原始数字、时区和机构', async () => {
  const source = payload();
  const seen = [];
  const mapping = new Map(translated(source).translations.map((item) => [item.id, item.text]));
  const result = await translateOpeningDigestPayload(source, {
    writer: { model: 'test' },
    complete: async ({ units }) => {
      seen.push(...units.map((unit) => unit.id));
      return { translations: units.map((unit) => ({ id: unit.id, text: mapping.get(unit.id) })) };
    },
  });
  assert.ok(!seen.includes('oic-asof'));
  assert.ok(!seen.includes('oic-attribution'));
  assert.equal(result.translations.find((unit) => unit.id === 'oic-asof').text, '截至 10 Aug 2026, 10:15:00 EDT');
  assert.equal(result.translations.find((unit) => unit.id === 'oic-attribution').text, '数据由 IVolatility 提供');
});

test('中文微信 HTML 锁定 @4、9 格行情、OIC 20×8 且低于官方大小限制', () => {
  const source = payload(); const translation = translated(source);
  const html = renderWechatOpeningDigestHtml({ source, payload: source, translation, images: { header: 'https://img/h', survey: 'https://img/s', footer: 'https://img/f' } });
  assert.match(html, new RegExp(`data-zen-draft-template="${WECHAT_OPENING_DIGEST_TEMPLATE_ID.replace('/', '\\/')}"`));
  assert.equal((html.match(/data-metric=/g) || []).length, 9);
  assert.equal((html.match(/data-oic-rank=/g) || []).length, 20);
  assert.ok(html.length < WECHAT_DRAFT_MAX_CHARS, `${html.length} chars`);
  assert.ok(Buffer.byteLength(html) < 1024 * 1024);
  assert.doesNotMatch(html, /href=/i, '微信正文不得保留站外 href');
  const validation = validateWechatOpeningDigestDraft({ content: { news_item: [{ title: 'Zen 开市日报 · 2026-08-10', digest: '早盘市场信号。', content: html }] } }, {
    title: 'Zen 开市日报 · 2026-08-10', payload: source, translation,
  });
  assert.deepEqual(validation.errors, []);
});

test('微信回读前两次坏稿删除重建，第三次合格稿保留', async () => {
  const source = payload(); const translation = translated(source);
  let createCount = 0; const deleted = []; const drafts = new Map();
  const channel = makeWechatOpeningDigestChannel({
    renderCover: async () => Buffer.from('cover'),
    api: {
      getAccessToken: async () => 'token',
      uploadMaterial: async () => ({ media_id: 'cover-id', url: 'https://img/header.gif' }),
      uploadContentImage: async (_token, _buffer, filename) => `https://img/${filename}`,
      addDraft: async (_token, input) => { const mediaId = `m${++createCount}`; drafts.set(mediaId, input); return { media_id: mediaId }; },
      getDraft: async (_token, mediaId) => ({ content: { news_item: [{ title: drafts.get(mediaId).title, digest: drafts.get(mediaId).digest, content: mediaId === 'm3' ? drafts.get(mediaId).content : drafts.get(mediaId).content.replaceAll('SPY', 'BAD') }] } }),
      deleteDraft: async (_token, mediaId) => { deleted.push(mediaId); },
    },
  });
  const result = await channel.publish({ payload: source, translation, acceptance: true, config: config() });
  assert.equal(result.status, 'verified');
  assert.equal(result.mediaId, 'm3');
  assert.deepEqual(deleted, ['m1', 'm2']);
  assert.equal(result.title, '[测试] Zen 开市日报 · 08-10');
});

test('draft/get 暂不可用时保留唯一稿并标记 unverified', async () => {
  let created = 0; let deleted = 0;
  const channel = makeWechatOpeningDigestChannel({
    renderCover: async () => Buffer.from('cover'),
    api: {
      getAccessToken: async () => 'token', uploadMaterial: async () => ({ media_id: 'cover-id', url: 'https://img/header.gif' }),
      uploadContentImage: async () => 'https://img/fixed',
      addDraft: async () => ({ media_id: `m${++created}` }),
      getDraft: async () => { throw new Error('temporary unavailable'); },
      deleteDraft: async () => { deleted += 1; },
    },
  });
  const result = await channel.publish({ payload: payload(), translation: translated(), config: config() });
  assert.equal(result.status, 'unverified');
  assert.equal(created, 1);
  assert.equal(deleted, 0);
});

test('坏稿删除失败时不盲目重建，保留唯一稿并标记 unverified', async () => {
  let created = 0;
  const channel = makeWechatOpeningDigestChannel({
    renderCover: async () => Buffer.from('cover'),
    api: {
      getAccessToken: async () => 'token', uploadMaterial: async () => ({ media_id: 'cover-id', url: 'https://img/header.gif' }),
      uploadContentImage: async () => 'https://img/fixed',
      addDraft: async () => ({ media_id: `m${++created}` }),
      getDraft: async () => ({ content: { news_item: [{ title: '错误标题', content: '<p>broken</p>' }] } }),
      deleteDraft: async () => { throw new Error('delete unavailable'); },
    },
  });
  const result = await channel.publish({ payload: payload(), translation: translated(), config: config() });
  assert.equal(result.status, 'unverified');
  assert.equal(result.mediaId, 'm1');
  assert.equal(created, 1);
  assert.ok(result.errors.some((error) => /draft\/delete.*delete unavailable/.test(error)));
});

test('第三次回读仍不一致时保留最新稿并返回精确字段差异', async () => {
  let created = 0; const deleted = [];
  const channel = makeWechatOpeningDigestChannel({
    renderCover: async () => Buffer.from('cover'),
    api: {
      getAccessToken: async () => 'token', uploadMaterial: async () => ({ media_id: 'cover-id', url: 'https://img/header.gif' }),
      uploadContentImage: async () => 'https://img/fixed',
      addDraft: async () => ({ media_id: `m${++created}` }),
      getDraft: async () => ({ content: { news_item: [{ title: '错误标题', content: '<p>broken</p>' }] } }),
      deleteDraft: async (_token, mediaId) => { deleted.push(mediaId); },
    },
  });
  const result = await channel.publish({ payload: payload(), translation: translated(), config: config() });
  assert.equal(result.status, 'invalid');
  assert.equal(result.mediaId, 'm3');
  assert.deepEqual(deleted, ['m1', 'm2']);
  assert.ok(result.errors.some((error) => /标题/.test(error)));
  assert.ok(result.errors.some((error) => /行情格/.test(error)));
  assert.ok(result.errors.some((error) => /OIC/.test(error)));
});

test('320/375/390/430px Chromium 无横向溢出、裁切，长公司名可换行', async (t) => {
  const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!fs.existsSync(executablePath)) { t.skip('Chrome unavailable'); return; }
  const html = renderWechatOpeningDigestHtml({ payload: payload(), translation: translated(), images: { header: 'https://img/h', survey: 'https://img/s', footer: 'https://img/f' } });
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  for (const width of [320, 375, 390, 430]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;overflow-x:hidden}img{max-width:100%}</style>${html}`);
    const result = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      clipped: [...document.querySelectorAll('td,th')].filter((node) => node.scrollWidth > node.clientWidth + 1).length,
      minFont: Math.min(...[...document.querySelectorAll('[data-zen-oic] td,[data-zen-oic] th')].map((node) => parseFloat(getComputedStyle(node).fontSize))),
    }));
    assert.ok(result.overflow <= 1, `${width}px overflow ${result.overflow}`);
    assert.equal(result.clipped, 0, `${width}px clipped cells`);
    assert.ok(result.minFont >= 10, `${width}px min font ${result.minFont}`);
    await page.close();
  }
});

function config() {
  return {
    wechat: { appId: 'wx', appSecret: 'secret' },
    openingDigest: { browserExecutablePath: '/tmp/chrome', captureTimeoutMs: 1000 },
    assets: {
      headerImage: path.resolve('assets/zen-header-banner.gif'),
      surveyImage: path.resolve('assets/zen-survey-qr.jpg'),
      footerImage: path.resolve('assets/zen-footer-qr.png'),
    },
  };
}
