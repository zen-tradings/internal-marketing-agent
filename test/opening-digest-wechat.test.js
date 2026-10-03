import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { JSDOM } from 'jsdom';
import { chromium } from 'playwright-core';
import {
  makeWechatOpeningDigestChannel,
  openingDigestWechatTitle,
  renderWechatOpeningDigestHtml,
  validateWechatOpeningDigestDraft,
  WECHAT_DRAFT_MAX_CHARS,
  WECHAT_OPENING_DIGEST_TEMPLATE_ID,
} from '../src/channels/wechat-opening-digest.js';
import {
  OPENING_DIGEST_SAFE_HEADLINE,
  OPENING_DIGEST_TRANSLATION_VERSION,
  prepareOpeningDigestWechatPayload,
  protectTranslationUnit,
  restoreTranslationUnit,
  stripOpeningDigestReferences,
  translateOpeningDigestPayload,
  translationUnits,
} from '../src/lib/opening-digest-translation.js';
import { OPENING_DIGEST_DISCORD_INVITE_URL } from '../src/lib/draft-template.js';

const BODY = `## Earnings ahead
**Mon, Aug 10:** [NVDA](https://finance.yahoo.com/calendar/earnings) after close (expected)

## Today's catalysts
- [NVIDIA Corporation update](https://example.com/a) moved SPY 10.25% at 10:15 EDT.
- OCC reported a second catalyst for QQQ ([CNBC](https://example.com/b)).

## Market read
NVIDIA Corporation remains the central condition; 2026 guidance is unchanged.`;

function payload() {
  return {
    schemaVersion: 2, dateKey: '2026-08-10',
    article: { title: 'Zen Opening Digest', headline: 'Rates test market conviction', preheader: 'Morning market signals.', body: BODY },
    editorial: { stance: 'neutral', confidence: 'medium', changeSummary: 'Initial baseline.' },
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
  source = prepareOpeningDigestWechatPayload(source);
  return {
    schemaVersion: 1, payloadHash: 'test', model: 'test', repairs: [],
    translations: translationUnits(source).map((unit) => ({
      id: unit.id, kind: unit.kind, source: unit.text,
      text: ({
        headline: '利率考验市场信心',
        preheader: '早盘市场信号。',
        'body-1': '财报预告',
        'body-2': '**8月10日 周一：** NVDA 盘后（预计）',
        'body-3': '今日催化',
        'body-4': 'NVIDIA 公司动态使 SPY 在 10:15 EDT 变动 10.25%。',
        'body-5': 'OCC 报告了影响 QQQ 的第二项催化。',
        'body-6': '市场解读',
        'body-7': 'NVIDIA 公司仍是核心条件；2026 年指引保持不变。',
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
  assert.deepEqual(result.translations.map((item) => item.id), translationUnits(prepareOpeningDigestWechatPayload(payload())).map((item) => item.id));
  assert.match(result.translations.find((item) => item.id === 'body-4').text, /SPY.*10:15 EDT.*10\.25%/);
  assert.equal(result.translations.find((item) => item.id === 'oic-company-1').text, 'NVIDIA 公司');
  assert.equal(result.translations.find((item) => item.id === 'oic-company-2').text, 'Company 2');
  const callsBeforeCacheRead = calls;
  assert.ok(callsBeforeCacheRead > 1, '动态文本应逐块翻译以隔离模型漏块');
  await translateOpeningDigestPayload(payload(), { cacheDir: directory, writer: { model: 'test' }, complete: async () => { throw new Error('cache miss'); } });
  assert.equal(calls, callsBeforeCacheRead, '同一英文 payload 的测试稿和正式稿必须复用中文译文');
});

test('人工核对译句可恢复单块翻译，同时仍拒绝新增数字', async () => {
  const source = payload();
  source.article.preheader = "Long yields at multi-decade highs and a renewed oil rally frame a defensive open, with today's Trump-Xi summit the main offset.";
  const mapping = new Map(translated(source).translations.map((item) => [item.id, item.text]));
  const verified = '长端收益率处于多个年代以来的高位，油价再度上涨，令开盘偏防御；今日 Trump-Xi 峰会是主要缓冲。';
  const options = {
    writer: { model: 'test' }, verifiedTranslations: { preheader: verified },
    complete: async ({ units }) => ({ translations: units.map((unit) => ({ id: unit.id, text: mapping.get(unit.id) })) }),
  };
  const result = await translateOpeningDigestPayload(source, options);
  assert.equal(result.translations.find((unit) => unit.id === 'preheader').text, verified);
  assert.deepEqual(result.verifiedTranslationIds, ['preheader']);
  await assert.rejects(translateOpeningDigestPayload(source, {
    ...options, verifiedTranslations: { preheader: '10年期收益率处于高位，今日 Trump-Xi 峰会是缓冲。' },
  }), /人工核对译文未通过硬校验/);
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

test('OpenRouter 返回损坏 JSON 时按局部修复预算重试而不立即放弃微信稿', async () => {
  const source = { article: { preheader: 'Market signals.', body: '' }, metrics: [] };
  let calls = 0;
  const result = await translateOpeningDigestPayload(source, {
    writer: { model: 'test', openrouterApiKey: 'test-key', baseUrl: 'https://openrouter.test' },
    fetchFn: async () => {
      calls += 1;
      const content = calls < 3
        ? '{"translations":[{"id":"preheader","text":"市场信号。"}'
        : JSON.stringify({ translations: [{ id: 'preheader', text: '市场信号。' }] });
      return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content } }] }); } };
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.translations[0].text, '市场信号。');
  assert.equal(result.repairs.length, 2);
  assert.ok(result.repairs.every((repair) => repair.issues.some((issue) => /JSON 无效/.test(issue))));
});

test('Opening Digest 逐块翻译使用有界输出预算，避免余额预授权误拒绝', async () => {
  let requestBody;
  const result = await translateOpeningDigestPayload({
    article: { preheader: 'Market signals.', body: '' }, metrics: [],
  }, {
    writer: {
      model: 'test', openrouterApiKey: 'test-key', baseUrl: 'https://openrouter.test', maxTokens: 12000,
    },
    fetchFn: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true, status: 200,
        async text() {
          return JSON.stringify({ choices: [{ message: { content: JSON.stringify({
            translations: [{ id: 'preheader', text: '市场信号。' }],
          }) } }] });
        },
      };
    },
  });
  assert.equal(requestBody.max_tokens, 4096);
  assert.equal(result.translations[0].text, '市场信号。');
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
    ['body-2', '**OIC IV 信号：SPCX** — OIC 前 20 名扫描显示 SPCX 为 68.54%。'],
    ['body-3', '**宏观：7 月 CPI** — 7 月 CPI 报告定于周三上午 8:30 ET 发布。'],
  ]);
  let calls = 0;
  const result = await translateOpeningDigestPayload(source, {
    writer: { model: 'test' },
    complete: async ({ units }) => {
      calls += 1;
      return { translations: units.map((unit) => ({ id: unit.id, text: mapping.get(unit.id) })) };
    },
  });
  assert.equal(calls, 3);
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

test('证据引用整体保护，避免 URL token 吞入引用闭合符和句末标点', () => {
  const firstCitation = `【${10}†${'https://example.com/oil'}】`;
  const secondCitation = `【${3}†${'https://example.com/index'}】`;
  const source = `**Oil risk** – WTI reached $94.60${firstCitation}, while the S&P 500 fell${secondCitation}.`;
  const unit = { id: 'body-3', kind: 'paragraph', text: source };
  const protectedUnit = protectTranslationUnit(unit);
  assert.ok(protectedUnit.tokens.some((token) => token.value === firstCitation));
  assert.ok(protectedUnit.tokens.some((token) => token.value === secondCitation));
  assert.equal(protectedUnit.tokens.some((token) => /】[,．。.]?$/.test(token.value) && token.value.startsWith('https://')), false);
  assert.doesNotMatch(protectedUnit.unit.text, /【⟦ZEN_KEEP_[A-Z]{3}⟧†/);
  const translated = protectedUnit.unit.text
    .replace('reached', '升至')
    .replace('while the', '而')
    .replace('fell', '下跌');
  assert.equal(restoreTranslationUnit(translated, protectedUnit.tokens),
    `**Oil risk** – WTI 升至 $94.60${firstCitation}, 而 S&P 500 下跌${secondCitation}.`);
});

test('9 月故障型证据引用在模型调用前已删除，不再参与 token 校验', async () => {
  const firstCitation = `【${10}†${'https://example.com/oil'}】`;
  const secondCitation = `【${3}†${'https://example.com/index'}】`;
  const source = {
    article: {
      body: `WTI reached $94.60${firstCitation}, while the S&P 500 fell${secondCitation}.`,
    },
    metrics: [],
  };
  let modelInput = '';
  const result = await translateOpeningDigestPayload(source, {
    writer: { model: 'test' },
    complete: async ({ units }) => ({ translations: units.map((unit) => {
      modelInput += unit.text;
      return {
        id: unit.id,
        text: unit.text.replace('reached', '升至').replace('while the', '而').replace('fell', '下跌'),
      };
    }) }),
  });
  assert.doesNotMatch(modelInput, /https?:\/\/|【|†/);
  assert.doesNotMatch(result.translations[0].text, /https?:\/\/|【|†/);
  assert.match(result.translations[0].text, /94\.60.*S&P 500/);
});

test('带 source 前缀和多个链接的括号来源整体删除', () => {
  const prepared = prepareOpeningDigestWechatPayload({
    article: { body: 'Demand held (source: [TradingKey](https://example.com/a); [Citi/Dell](https://example.com/b)).' },
    metrics: [],
  });
  assert.equal(prepared.article.body, 'Demand held.');
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

test('英文引语边界在严格 JSON 翻译前被占位符保护并无损还原', () => {
  const unit = {
    id: 'body-6', kind: 'paragraph',
    text: 'Bloom called the fuel cells "an on-site power solution delivering reliable power quietly and ultra-low emissions." NBIS closed at $259.20.',
  };
  const protectedUnit = protectTranslationUnit(unit);
  assert.doesNotMatch(protectedUnit.unit.text, /["“”]/);
  assert.equal(protectedUnit.tokens.filter((token) => token.value === '"').length, 2);
  const translated = protectedUnit.unit.text
    .replace('Bloom called the fuel cells', 'Bloom 将这些燃料电池称为')
    .replace(' closed at ', ' 收盘于 ');
  assert.equal(restoreTranslationUnit(translated, protectedUnit.tokens),
    'Bloom 将这些燃料电池称为 "an on-site power solution delivering reliable power quietly and ultra-low emissions." NBIS 收盘于 $259.20.');
});

test('模型输入不泄露未保护原文且重叠缩写 token 可无损还原', () => {
  const unit = {
    id: 'body-4', kind: 'paragraph',
    text: '**July CPI due 8:30 AM ET; consensus 0.1% MoM, 3.4% YoY.** AI revenue rose 25% YoY without EPS dilution.',
    markdown: '- **July CPI due 8:30 AM ET; consensus 0.1% MoM, 3.4% YoY.** AI revenue rose 25% YoY without EPS dilution.',
  };
  const protectedUnit = protectTranslationUnit(unit);
  assert.equal('markdown' in protectedUnit.unit, false);
  assert.doesNotMatch(protectedUnit.unit.text, /8:30 AM ET|MoM|YoY|EPS|25%/);
  assert.equal(protectedUnit.unit.text.includes(' AI '), false);
  assert.equal((protectedUnit.unit.text.match(/⟦ZEN_KEEP_[A-Z]{3}⟧/g) || []).length, protectedUnit.tokens.length);
  assert.doesNotMatch(protectedUnit.unit.text, /⟦ZEN_KEEP_[A-Z]*⟦/);
  assert.equal(restoreTranslationUnit(protectedUnit.unit.text, protectedUnit.tokens), unit.text);
});

test('超过 26 个不可变 token 时占位符仍唯一且可无损还原', () => {
  const unit = {
    id: 'body-1', kind: 'paragraph',
    text: Array.from({ length: 30 }, (_, index) => `${index + 1}.1%`).join(', '),
  };
  const protectedUnit = protectTranslationUnit(unit);
  const markers = protectedUnit.unit.text.match(/⟦ZEN_KEEP_[A-Z]{3}⟧/g) || [];
  assert.equal(markers.length, 30);
  assert.equal(new Set(markers).size, 30);
  assert.ok(markers.includes('⟦ZEN_KEEP_AAZ⟧'));
  assert.ok(markers.includes('⟦ZEN_KEEP_ABA⟧'));
  assert.equal(restoreTranslationUnit(protectedUnit.unit.text, protectedUnit.tokens), unit.text);
});

test('超过 26 个来源引用在中文模型输入前全部净化，不再形成占位符碰撞', async () => {
  const source = {
    article: {
      preheader: 'Signals.',
      body: Array.from({ length: 30 }, (_, index) => `Fact ${index + 1}.0%【${index + 1}†https://example.com/${index + 1}】`).join('\n'),
    },
    metrics: [],
  };
  const seen = [];
  await translateOpeningDigestPayload(source, {
    writer: { model: 'test' },
    complete: async ({ units }) => ({ translations: units.map((unit) => {
      seen.push(unit.text);
      return { id: unit.id, text: unit.id === 'preheader' ? '信号。' : unit.text.replace('Fact', '事实') };
    }) }),
  });
  assert.doesNotMatch(seen.join('\n'), /https?:\/\/|【|†/);
});

test('财务季度与机构 Markdown 来源链接作为完整 token 保护', () => {
  const unit = {
    id: 'body-2', kind: 'paragraph',
    text: 'CoreWeave Q2 revenue rose ([CNBC](https://www.cnbc.com/q2-report.html)); guidance for FY2026 held.',
  };
  const protectedUnit = protectTranslationUnit(unit);
  assert.doesNotMatch(protectedUnit.unit.text, /Q2|CNBC|cnbc\.com|FY2026/);
  assert.ok(protectedUnit.tokens.some((token) => token.value === '[CNBC](https://www.cnbc.com/q2-report.html)'));
  assert.equal(restoreTranslationUnit(protectedUnit.unit.text, protectedUnit.tokens), unit.text);
});

test('中文直译在两轮局部修复后仍拒绝缺块、重复和乱序', async () => {
  await assert.rejects(translateOpeningDigestPayload(payload(), {
    writer: { model: 'test' },
    complete: async ({ units }) => ({ translations: [
      { id: units[0].id, text: units[0].text },
      { id: units[0].id, text: units[0].text },
    ] }),
  }), /块 ID 重复、乱序或含未知项/);
});

test('局部修复漏一块时保留已合格块，下一轮只重试缺失块', async () => {
  const source = payload();
  const mapping = new Map(translated(source).translations.map((item) => [item.id, item.text]));
  const calls = new Map();
  const retryId = 'body-4';
  const result = await translateOpeningDigestPayload(source, {
    writer: { model: 'test' },
    complete: async ({ units }) => {
      const id = units[0].id;
      calls.set(id, (calls.get(id) || 0) + 1);
      const items = units.map((unit) => ({ id: unit.id, text: mapping.get(unit.id) }));
      return { translations: id === retryId && calls.get(id) === 1 ? [] : items };
    },
  });
  assert.equal(calls.get(retryId), 2);
  assert.ok([...calls.entries()].filter(([id]) => id !== retryId).every(([, count]) => count === 1));
  assert.deepEqual(result.translations.map((item) => item.id), translationUnits(source).map((item) => item.id));
});

test('模型翻译前移除来源 URL，并继续保护 Ticker、时间和数字', async () => {
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
  assert.match(translatedBody, /SPCX.*68\.54%.*8:30 a\.m\. ET/);
  assert.doesNotMatch(translatedBody, /https?:\/\//);
});

test('Opening Digest 将金融缩写 bn 作为一个不可变金额 token 保护', () => {
  const protectedUnit = protectTranslationUnit({
    id: 'body-1', kind: 'list_item',
    text: 'Nvidia invested $1.5 bn in SB Energy for an Ohio AI data center.',
  });
  assert.doesNotMatch(protectedUnit.unit.text, /\$1\.5 bn/);
  assert.ok(protectedUnit.tokens.some((token) => token.value === '$1.5 bn'));
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

test('30 字内中文标题原样保留，超限只移除必要分隔符，不截断判断或不可变 token', async () => {
  const source = {
    article: { headline: 'Core CPI Hotter, Hike Odds Jump to 88%', body: '' },
    metrics: [],
  };
  const translateWith = (headline) => translateOpeningDigestPayload(source, {
    writer: { model: 'test' },
    complete: async ({ units }) => ({
      translations: units.map((unit) => ({ id: unit.id, text: headline })),
    }),
  });
  const kept = await translateWith('核心CPI偏热，加息概率升至88%');
  assert.equal(kept.translations.find((unit) => unit.id === 'headline').text, '核心CPI偏热，加息概率升至88%');
  const compacted = await translateWith('核心CPI偏热，市场加息概率升至88%，重新定价秋季政策利率路径');
  const headline = compacted.translations.find((unit) => unit.id === 'headline').text;
  assert.equal(headline, '核心CPI偏热市场加息概率升至88%重新定价秋季政策利率路径');
  assert.equal([...headline].length, 30);
  assert.match(headline, /CPI.*88%/);
});

test('标题三轮仍损坏时使用固定安全标题，正文事实硬门禁仍保留', async () => {
  const source = { article: { headline: 'Rates Test Conviction', body: 'SPY closed at 650.25.' }, metrics: [] };
  const result = await translateOpeningDigestPayload(source, {
    writer: { model: 'test' },
    complete: async ({ units }) => ({ translations: units.flatMap((unit) => unit.id === 'headline' ? [] : [{ id: unit.id, text: unit.text.replace('closed at', '收于') }]) }),
  });
  assert.equal(result.translations.find((unit) => unit.id === 'headline').text, OPENING_DIGEST_SAFE_HEADLINE);
  assert.equal(result.fallbacks.length, 1);
  await assert.rejects(translateOpeningDigestPayload(source, {
    writer: { model: 'test' },
    complete: async ({ units }) => ({ translations: units.map((unit) => ({ id: unit.id, text: unit.id === 'headline' ? '利率考验信心' : 'SPY 收于 651.25。' })) }),
  }), /650\.25/);
});

test('微信草稿标题使用“标题（日报·日期）”且测试身份保持在 46 字内', () => {
  assert.equal(openingDigestWechatTitle('AI硬件下滑，收益率回落', '2026-09-03'), 'AI硬件下滑，收益率回落（日报· 2026-09-03）');
  assert.equal(openingDigestWechatTitle('利率考验市场信心', '2026-08-10', { acceptance: true }), '[测试] 利率考验市场信心（日报· 08-10）');
  assert.equal([...openingDigestWechatTitle('123456789012345678901234567890', '2026-08-10', { acceptance: true })].length, 46);
  assert.equal(openingDigestWechatTitle('1234567890123456789012345678901', '2026-08-10'), `${OPENING_DIGEST_SAFE_HEADLINE}（日报· 2026-08-10）`);
});

test('中文微信 HTML 锁定新版模板、动态副标题、9 格行情与 OIC 20×8', () => {
  const source = payload(); const translation = translated(source);
  const html = renderWechatOpeningDigestHtml({ source, payload: source, translation, images: { header: 'https://img/h', survey: 'https://img/s', footer: 'https://img/f' } });
  assert.match(html, new RegExp(`data-zen-draft-template="${WECHAT_OPENING_DIGEST_TEMPLATE_ID.replace('/', '\\/')}"`));
  assert.equal((html.match(/data-metric=/g) || []).length, 9);
  assert.equal((html.match(/data-oic-rank=/g) || []).length, 20);
  assert.ok(html.length < WECHAT_DRAFT_MAX_CHARS, `${html.length} chars`);
  assert.ok(Buffer.byteLength(html) < 1024 * 1024);
  assert.doesNotMatch(html, /href=/i, '微信正文不得保留站外 href');
  assert.doesNotMatch(html, /【|\u2020|CNBC|example\.com|finance\.yahoo\.com/i, '微信正文不得保留原文来源引用或 URL');
  assert.match(html, /NVIDIA 公司动态/, '承担正文语义的链接文字应保留为纯文本');
  assert.match(html, /NVDA/, '财报预告中的 Ticker 应保留为纯文本');
  const document = new JSDOM(`<body>${html}</body>`).window.document;
  const discord = document.querySelector('[data-zen-section="discord"]');
  assert.ok(discord, '正文底部必须包含 Discord 社群链接');
  assert.ok(discord.textContent.includes(`加入 Zen Discord 社区：${OPENING_DIGEST_DISCORD_INVITE_URL}`));
  assert.equal(discord.querySelector('a'), null, '微信 Discord 链接必须为纯文本');
  const survey = document.querySelector('[data-zen-role="survey"]');
  assert.ok(discord.compareDocumentPosition(survey) & 4, 'Discord 链接必须位于问卷图与二维码封底之前');
  assert.ok(discord.compareDocumentPosition(document.querySelector('[data-zen-oic]')) & 2, 'Discord 链接必须位于 OIC 区块之后');
  const validation = validateWechatOpeningDigestDraft({ content: { news_item: [{ title: '利率考验市场信心', digest: '早盘市场信号。', content: html }] } }, {
    title: '利率考验市场信心', payload: source, translation,
  });
  assert.deepEqual(validation.errors, []);
});

test('中文微信剥离证据引用和所有正文链接但保留有语义 label', () => {
  const citation = `【${10}†${'https://example.com/oil'}】`;
  const source = payload();
  source.article.body = `The market opened neutral as WTI reached $94.60${citation}【5】【8, 9】【10-12】.\n\n## Earnings ahead\n**Mon, Aug 10:** [NVDA](https://finance.yahoo.com/calendar/earnings) after close (expected)\n\n## What matters today\n[NVIDIA Corporation update](https://example.com/a) moved SPY 10.25% at 10:15 EDT.`;
  const translation = translated(source);
  translation.translations.find((unit) => unit.id === 'body-1').text = `市场开盘中性，WTI 达到 $94.60${citation}【5】【8, 9】【10-12】。`;
  const html = renderWechatOpeningDigestHtml({ payload: source, translation, images: { header: 'https://img/h', survey: 'https://img/s', footer: 'https://img/f' } });
  assert.doesNotMatch(html, /【|†|example\.com|finance\.yahoo\.com/i);
  assert.doesNotMatch(html, /href=/i);
  assert.match(html, /NVDA/);
  assert.match(html, /NVIDIA 公司动态/);
  const validation = validateWechatOpeningDigestDraft({ content: { news_item: [{ title: '利率考验市场信心', digest: '早盘市场信号。', content: html }] } }, {
    title: '利率考验市场信心', payload: source, translation,
  });
  assert.deepEqual(validation.errors, []);
});

test('中文微信净化覆盖全角数字、嵌套、†非URL与 ASCII 脚注引用变体', () => {
  const stripped = stripOpeningDigestReferences('数据显示【２】上涨【【3】】，随后回落【4 †Data】与[5]，另见[6,7]与[8-10]。');
  assert.equal(stripped, '数据显示上涨，随后回落与，另见与。');
  assert.equal(stripOpeningDigestReferences('keep [NVDA](https://example.com/a) label'), 'keep NVDA label');
  const prepared = prepareOpeningDigestWechatPayload({
    article: { headline: 'Rates test conviction', preheader: 'Morning signals.', body: 'Fact one【4 †Data】 and【３】 plus [4] 。' },
    metrics: [],
  });
  assert.doesNotMatch(prepared.article.body, /【|†|\[\s*[0-9]/);
  assert.equal(prepared.article.body, 'Fact one and plus。');
});

test('微信回读拒绝残留的纯编号证据标记', () => {
  const source = prepareOpeningDigestWechatPayload(payload());
  const translation = translated(source);
  const html = renderWechatOpeningDigestHtml({
    payload: source,
    translation,
    images: { header: 'https://img/h', survey: 'https://img/s', footer: 'https://img/f' },
  }).replace('NVIDIA 公司动态', 'NVIDIA 公司动态【5】');
  const validation = validateWechatOpeningDigestDraft({ news_item: [{
    title: '利率考验市场信心', digest: '早盘市场信号。', content: html,
  }] }, { title: '利率考验市场信心', payload: source, translation });
  assert.match(validation.errors.join('；'), /正文仍含来源链接、脚注或引用标记/);
});

test('微信财报预告将同一天的每个 ticker 拆为独立视觉行，邮件源文本不变', () => {
  const source = payload();
  source.article.body = source.article.body.replace(
    '[NVDA](https://finance.yahoo.com/calendar/earnings) after close (expected)',
    '[NVDA](https://finance.yahoo.com/calendar/earnings) after close (expected); [AMD](https://finance.yahoo.com/calendar/earnings) before open (expected)',
  );
  const translation = translated(source);
  const entry = translation.translations.find((unit) => unit.id === 'body-2');
  entry.text = '**8月10日 周一：** [NVDA](https://finance.yahoo.com/calendar/earnings) 盘后（预计）； [AMD](https://finance.yahoo.com/calendar/earnings) 盘前（预计）';
  const html = renderWechatOpeningDigestHtml({
    payload: source, translation,
    images: { header: 'https://img/h', survey: 'https://img/s', footer: 'https://img/f' },
  });
  const document = new JSDOM(`<body>${html}</body>`).window.document;
  const rows = document.querySelectorAll('[data-block-id="body-2"] > p');
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /NVDA/);
  assert.match(rows[1].textContent, /AMD/);
  assert.equal(document.querySelector('[data-block-id="body-2"]').textContent, stripMarkdownForTest(entry.text));
  const readback = validateWechatOpeningDigestDraft({ content: { news_item: [{
    title: '利率考验市场信心', digest: '早盘市场信号。',
    content: html.replace(/<\/p> <p/g, '</p><p'),
  }] } }, { title: '利率考验市场信心', payload: source, translation });
  assert.deepEqual(readback.errors, []);
});

test('微信回读不一致时两次更新同一草稿，第三次回读通过', async () => {
  const source = prepareOpeningDigestWechatPayload(payload()); const translation = translated(source);
  let createCount = 0; let readCount = 0; const updated = []; const drafts = new Map();
  const channel = makeWechatOpeningDigestChannel({
    renderCover: async () => Buffer.from('cover'),
    api: {
      getAccessToken: async () => 'token',
      uploadMaterial: async () => ({ media_id: 'cover-id', url: 'https://img/header.gif' }),
      uploadContentImage: async (_token, _buffer, filename) => `https://img/${filename}`,
      addDraft: async (_token, input) => { const mediaId = `m${++createCount}`; drafts.set(mediaId, input); return { media_id: mediaId }; },
      getDraft: async (_token, mediaId) => ({ content: { news_item: [{ title: drafts.get(mediaId).title, digest: drafts.get(mediaId).digest, content: ++readCount === 3 ? drafts.get(mediaId).content : drafts.get(mediaId).content.replaceAll('SPY', 'BAD') }] } }),
      updateDraft: async (_token, mediaId) => { updated.push(mediaId); },
    },
  });
  const result = await channel.publish({ payload: source, translation, acceptance: true, config: config() });
  assert.equal(result.status, 'verified');
  assert.equal(result.mediaId, 'm1');
  assert.equal(createCount, 1);
  assert.deepEqual(updated, ['m1', 'm1']);
  assert.equal(result.title, '[测试] 利率考验市场信心（日报· 08-10）');
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
  await assert.rejects(channel.publish({ payload: prepareOpeningDigestWechatPayload(payload()), translation: translated(), config: config() }), /draft\/get 暂不可用/);
  assert.equal(created, 1);
  assert.equal(deleted, 0);
});

test('坏稿更新失败时不再次创建，交给持久 outbox 重试', async () => {
  let created = 0;
  const channel = makeWechatOpeningDigestChannel({
    renderCover: async () => Buffer.from('cover'),
    api: {
      getAccessToken: async () => 'token', uploadMaterial: async () => ({ media_id: 'cover-id', url: 'https://img/header.gif' }),
      uploadContentImage: async () => 'https://img/fixed',
      addDraft: async () => ({ media_id: `m${++created}` }),
      getDraft: async () => ({ content: { news_item: [{ title: '错误标题', content: '<p>broken</p>' }] } }),
      updateDraft: async () => { throw new Error('update unavailable'); },
    },
  });
  await assert.rejects(channel.publish({ payload: prepareOpeningDigestWechatPayload(payload()), translation: translated(), config: config() }), /draft\/update.*update unavailable/);
  assert.equal(created, 1);
});

test('第三次回读仍不一致时保留同一稿并返回精确字段差异', async () => {
  let created = 0; const updated = [];
  const channel = makeWechatOpeningDigestChannel({
    renderCover: async () => Buffer.from('cover'),
    api: {
      getAccessToken: async () => 'token', uploadMaterial: async () => ({ media_id: 'cover-id', url: 'https://img/header.gif' }),
      uploadContentImage: async () => 'https://img/fixed',
      addDraft: async () => ({ media_id: `m${++created}` }),
      getDraft: async () => ({ content: { news_item: [{ title: '错误标题', content: '<p>broken</p>' }] } }),
      updateDraft: async (_token, mediaId) => { updated.push(mediaId); },
    },
  });
  const result = await channel.publish({ payload: prepareOpeningDigestWechatPayload(payload()), translation: translated(), config: config() });
  assert.equal(result.status, 'invalid');
  assert.equal(result.mediaId, 'm1');
  assert.equal(created, 1);
  assert.deepEqual(updated, ['m1', 'm1']);
  assert.ok(result.errors.some((error) => /标题/.test(error)));
  assert.ok(result.errors.some((error) => /行情格/.test(error)));
  assert.ok(result.errors.some((error) => /OIC/.test(error)));
});

test('创建响应不明时按快照唯一恢复 media_id，不发第二次 draft/add', async () => {
  const source = prepareOpeningDigestWechatPayload(payload());
  const operations = memoryRemoteOperations();
  let input; let listCalls = 0; let creates = 0; const created = [];
  const channel = makeWechatOpeningDigestChannel({
    renderCover: async () => Buffer.from('cover'), sleep: async () => {},
    api: {
      getAccessToken: async () => 'token', uploadMaterial: async () => ({ media_id: 'cover-id', url: 'https://img/header.gif' }),
      uploadContentImage: async () => 'https://img/fixed',
      listDrafts: async () => ({ item: ++listCalls === 1 ? [] : [{ media_id: 'wx-recovered', content: { news_item: [{ title: input.title }] } }] }),
      addDraft: async (_token, value) => { creates += 1; input = value; throw new Error('socket closed after request'); },
      getDraft: async () => ({ content: { news_item: [{ title: input.title, digest: input.digest, content: input.content }] } }),
      updateDraft: async () => {},
    },
  });
  const result = await channel.publish({
    payload: source, translation: translated(source), config: config(), runId: 'run-recover',
    remoteOperations: operations, onCreated: (value) => created.push(value),
  });
  assert.equal(result.mediaId, 'wx-recovered');
  assert.equal(result.status, 'verified');
  assert.equal(creates, 1);
  assert.deepEqual(created.map((item) => item.remoteId), ['wx-recovered']);
});

test('创建响应不明出现多个新候选时停止，不继续新增草稿', async () => {
  const source = prepareOpeningDigestWechatPayload(payload());
  const operations = memoryRemoteOperations();
  let input; let listCalls = 0; let creates = 0;
  const channel = makeWechatOpeningDigestChannel({
    renderCover: async () => Buffer.from('cover'), sleep: async () => {},
    api: {
      getAccessToken: async () => 'token', uploadMaterial: async () => ({ media_id: 'cover-id' }),
      uploadContentImage: async () => 'https://img/fixed',
      listDrafts: async () => ({ item: ++listCalls === 1 ? [] : ['a', 'b'].map((media_id) => ({ media_id, content: { news_item: [{ title: input.title }] } })) }),
      addDraft: async (_token, value) => { creates += 1; input = value; throw new Error('timeout'); },
      getDraft: async () => { throw new Error('不应回读'); }, updateDraft: async () => {},
    },
  });
  await assert.rejects(channel.publish({
    payload: source, translation: translated(source), config: config(), runId: 'run-ambiguous', remoteOperations: operations,
  }), /2 个同日同标题新草稿/);
  assert.equal(creates, 1);
});

test('封面和草稿共用归一化标题，缓存位于该任务的隔离目录', async () => {
  const source = prepareOpeningDigestWechatPayload(payload());
  const translation = translated(source);
  translation.translations.find((unit) => unit.id === 'headline').text = '这是一句明显超过三十个字符新上限因此必须回退安全标题的日报测试';
  let coverInput, draftInput;
  const channel = makeWechatOpeningDigestChannel({
    renderCover: async (value) => { coverInput = value; return Buffer.from('cover'); },
    api: {
      getAccessToken: async () => 'token', uploadMaterial: async () => ({ media_id: 'cover-id', url: 'https://img/header.gif' }),
      uploadContentImage: async () => 'https://img/fixed',
      listDrafts: async () => ({ item: [] }),
      addDraft: async (_token, value) => { draftInput = value; return { media_id: 'draft' }; },
      getDraft: async () => ({ content: { news_item: [{ title: draftInput.title, digest: draftInput.digest, content: draftInput.content }] } }),
    },
  });
  const result = await channel.publish({
    payload: source, translation, runId: 'cover/input', remoteOperations: memoryRemoteOperations(),
    config: { ...config(), workDir: '/tmp/zen-fixture' },
  });
  assert.equal(result.status, 'verified');
  assert.equal(coverInput.headline, OPENING_DIGEST_SAFE_HEADLINE);
  assert.equal(coverInput.dateKey, source.dateKey);
  assert.match(coverInput.cacheDir, /^\/tmp\/zen-fixture\/opening-digest\/runs\/cover_input-[a-f0-9]{12}$/);
  assert.equal(draftInput.title, `${OPENING_DIGEST_SAFE_HEADLINE}（日报· 2026-08-10）`);
});

function legacyRecord(source, translation, { remoteId = '', attempts = 1, templateId = 'zen-wechat/zen-trading@9' } = {}) {
  const title = openingDigestWechatTitle(translation.translations.find((unit) => unit.id === 'headline').text, source.dateKey);
  const sort = (value) => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])])) : value;
  const payloadSha256 = crypto.createHash('sha256').update(JSON.stringify(sort({
    templateId, title, digest: translation.translations.find((unit) => unit.id === 'preheader').text,
    payload: source, translations: translation.translations,
  }))).digest('hex');
  const operations = memoryRemoteOperations();
  operations.prepare({ operation: 'create-opening-digest-wechat', payloadSha256, beforeIds: ['prior-draft'] });
  for (let i = 0; i < attempts; i++) operations.increment('create-opening-digest-wechat');
  if (remoteId) operations.update('create-opening-digest-wechat', { remoteId, state: 'confirmed' });
  return { operations, title, payloadSha256 };
}

function savedWechatDraft(source, translation, title, templateId = 'zen-wechat/zen-trading@9') {
  return { content: { news_item: [{
    title, digest: translation.translations.find((unit) => unit.id === 'preheader').text,
    content: renderWechatOpeningDigestHtml({ payload: source, translation,
      images: { header: 'https://img/header', survey: 'https://img/survey', footer: 'https://img/footer' },
    }).replaceAll(WECHAT_OPENING_DIGEST_TEMPLATE_ID, templateId),
    thumb_media_id: 'original-cover',
  }] } };
}

test('旧版请求指纹匹配时只读恢复已知或唯一候选草稿，不渲染/上传/更新', async () => {
  const source = prepareOpeningDigestWechatPayload(payload()); const translation = translated(source);
  for (const templateId of ['zen-wechat/zen-trading@9', 'zen-wechat/zen-trading@10']) for (const remoteId of ['legacy-draft', '']) {
    const { operations, title, payloadSha256 } = legacyRecord(source, translation, { remoteId, templateId });
    const channel = makeWechatOpeningDigestChannel({
      renderCover: async () => { throw new Error('不应生成新封面'); }, sleep: async () => {},
      api: {
        getAccessToken: async () => 'token',
        listDrafts: async () => ({ item: [{ media_id: 'legacy-draft', content: { news_item: [{ title }] } }] }),
        getDraft: async () => savedWechatDraft(source, translation, title, templateId),
      },
    });
    const result = await channel.publish({ payload: source, translation, config: config(), runId: 'legacy-run', remoteOperations: operations });
    assert.equal(result.mediaId, 'legacy-draft'); assert.equal(result.status, 'verified');
    assert.equal(operations.get('create-opening-digest-wechat').payload_sha256, payloadSha256);
    assert.equal(operations.get('create-opening-digest-wechat').attempt_count, 1);
    assert.ok(result.attempts.every((item) => !item.updated));
  }
});

test('旧版未能唯一核对、未尝试的旧版准备记录和错误指纹均进入 needs_review', async () => {
  const source = prepareOpeningDigestWechatPayload(payload()); const translation = translated(source);
  for (const kind of ['missing', 'multiple', 'prepared', 'hash']) {
    const { operations, title } = legacyRecord(source, translation, { attempts: kind === 'prepared' ? 0 : 1 });
    if (kind === 'hash') operations.get('create-opening-digest-wechat').payload_sha256 = 'unknown';
    const channel = makeWechatOpeningDigestChannel({
      renderCover: async () => { throw new Error('不应生成新封面'); }, sleep: async () => {},
      api: { getAccessToken: async () => 'token', listDrafts: async () => ({ item: kind === 'multiple'
        ? ['a', 'b'].map((media_id) => ({ media_id, content: { news_item: [{ title }] } })) : [] }) },
    });
    await assert.rejects(channel.publish({ payload: source, translation, config: config(), runId: 'legacy-review', remoteOperations: operations }), (error) => error.stage === 'needs_review');
    assert.equal(operations.get('create-opening-digest-wechat').attempt_count, kind === 'prepared' ? 0 : 1);
  }
});

test('已有 media_id 回读不一致只标记待复核，不改写草稿', async () => {
  const source = prepareOpeningDigestWechatPayload(payload()); const translation = translated(source);
  const title = openingDigestWechatTitle('利率考验市场信心', source.dateKey);
  let reads = 0;
  const channel = makeWechatOpeningDigestChannel({
    renderCover: async () => { throw new Error('不应生成新封面'); },
    api: { getAccessToken: async () => 'token', getDraft: async () => {
      reads++; const saved = savedWechatDraft(source, translation, title);
      saved.content.news_item[0].title = '错误标题'; return saved;
    } },
  });
  await assert.rejects(channel.publish({ payload: source, translation, config: config(), existingRemoteId: 'known-draft' }), (error) => {
    assert.equal(error.stage, 'needs_review'); assert.equal(error.remoteId, 'known-draft'); return true;
  });
  assert.equal(reads, 3);
});

test('新版草稿创建后回读失败，重启从持久操作恢复而不再次生成封面或创建', async () => {
  const source = prepareOpeningDigestWechatPayload(payload()); const translation = translated(source);
  const operations = memoryRemoteOperations();
  let input, creates = 0, renders = 0;
  const api = {
    getAccessToken: async () => 'token', uploadMaterial: async () => ({ media_id: 'cover-id', url: 'https://img/header.gif' }),
    uploadContentImage: async () => 'https://img/fixed', listDrafts: async () => ({ item: [] }),
    addDraft: async (_token, value) => { input = value; creates++; return { media_id: 'new-draft' }; },
    getDraft: async () => { throw new Error('read unavailable'); },
  };
  const request = { payload: source, translation, config: config(), runId: 'new-run', remoteOperations: operations };
  const first = makeWechatOpeningDigestChannel({ api, renderCover: async () => { renders++; return Buffer.from('cover'); } });
  await assert.rejects(first.publish(request), /draft\/get 暂不可用/);
  const restarted = makeWechatOpeningDigestChannel({
    api: { getAccessToken: api.getAccessToken, getDraft: async () => ({ content: { news_item: [{ title: input.title, digest: input.digest, content: input.content }] } }) },
    renderCover: async () => { throw new Error('不能再次渲染'); },
  });
  const result = await restarted.publish(request);
  assert.equal(result.status, 'verified'); assert.equal(result.mediaId, 'new-draft');
  assert.equal(creates, 1); assert.equal(renders, 1);
  assert.equal(operations.get('create-opening-digest-wechat').attempt_count, 1);
});

test('显式正文纠错使用原封面，更新同一草稿而不生成新的日报封面', async () => {
  const source = prepareOpeningDigestWechatPayload(payload()); const translation = translated(source);
  const title = openingDigestWechatTitle('利率考验市场信心', source.dateKey);
  let updated, reads = 0;
  const uploads = [];
  const channel = makeWechatOpeningDigestChannel({
    renderCover: async () => { throw new Error('不应生成新封面'); },
    api: {
      getAccessToken: async () => 'token',
      uploadMaterial: async (_token, _buffer, filename) => { uploads.push(filename); return { url: 'https://img/header' }; },
      uploadContentImage: async () => 'https://img/fixed',
      getDraft: async () => {
        reads++; const saved = savedWechatDraft(source, translation, title);
        if (reads === 2) saved.content.news_item[0].title = '旧标题'; return saved;
      },
      updateDraft: async (_token, mediaId, value) => { assert.equal(mediaId, 'known-draft'); updated = value; },
    },
  });
  const result = await channel.publish({ payload: source, translation, config: config(), existingRemoteId: 'known-draft', repairExisting: true });
  assert.equal(result.status, 'verified');
  assert.equal(updated.thumbMediaId, 'original-cover');
  assert.deepEqual(uploads, ['zen-header-banner.gif']);
});

test('320/375/390/430px Chromium 无横向溢出、裁切，长公司名可换行', async (t) => {
  const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!fs.existsSync(executablePath)) { t.skip('Chrome unavailable'); return; }
  const html = renderWechatOpeningDigestHtml({ payload: payload(), translation: translated(), images: {} });
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
      surveyImage: path.resolve('assets/zen-community-banner.png'),
      footerImage: path.resolve('assets/zen-footer-qr.png'),
    },
  };
}

function stripMarkdownForTest(value) {
  return String(value).replace(/\*\*/g, '').replace(/\[([^\]]+)]\(https?:\/\/[^)]+\)/g, '$1');
}

function memoryRemoteOperations() {
  const records = new Map();
  return {
    get: (operation) => records.get(operation),
    prepare: (entry) => {
      const record = { ...entry, payload_sha256: entry.payloadSha256, before_ids_json: JSON.stringify(entry.beforeIds), attempt_count: 0, remote_id: null, state: 'prepared' };
      records.set(entry.operation, record); return record;
    },
    increment: (operation) => {
      const record = records.get(operation); record.attempt_count += 1; record.state = 'attempting'; return record;
    },
    update: (operation, patch) => {
      const record = records.get(operation);
      if (patch.remoteId !== undefined) record.remote_id = patch.remoteId;
      if (patch.lastError !== undefined) record.last_error = patch.lastError;
      if (patch.state !== undefined) record.state = patch.state;
      return record;
    },
  };
}


test('new focus translation preserves conditions, negation, tokens and renders one merged section', async () => {
  const source = payload();
  source.metrics = []; source.options = null;
  source.article.body = `The opening stance is neutral as Treasury yields remain firm. Lower oil prices do not yet justify a more constructive view.

## Today's focus
- **Rates remain the constraint.** QQQ is down 0.25% at 10:00 ET ([report](https://example.com/a)); if 10Y yields retreat, valuation pressure may ease.
- **Oil is a partial counterweight.** Lower WTI does not establish broad risk-on; watch whether VIX confirms SPY resilience.

## Evidence and cross-currents
**Rates limit valuation support.** Firm yields constrain growth shares.

**Energy offers relief.** Cheaper oil may ease inflation pressure.

## Earnings ahead
No major U.S.-listed earnings events were selected for the remainder of this week.`;
  const expected = new Map([
    ['headline', '利率考验市场信心'], ['preheader', '早盘市场信号。'],
    ['body-1', 'Treasury 收益率坚挺，开市判断维持中性。油价回落尚不足以支持更积极的判断。'],
    ['body-3', '**利率仍是约束。** QQQ 在 10:00 ET 下跌 0.25%；若 10Y 收益率回落，估值压力可能缓解。'],
    ['body-4', '**油价提供部分缓冲。** WTI 回落并不代表全面转向风险偏好；关注 VIX 是否确认 SPY 的韧性。'],
    ['body-6', '**利率限制估值支撑。** 收益率坚挺制约成长股。'],
    ['body-7', '**能源带来缓冲。** 低油价可能缓解通胀压力。'],
  ]);
  const prompts = [];
  const result = await translateOpeningDigestPayload(source, {
    writer: { model: 'test', openrouterApiKey: 'test-key' },
    fetchFn: async (_url, options) => {
      const request = JSON.parse(options.body); const prompt = request.messages.at(-1).content;
      prompts.push(prompt);
      const units = JSON.parse(prompt.slice(prompt.indexOf('\n\n') + 2));
      return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: units.map((unit) => ({ id: unit.id, text: expected.get(unit.id) })) }) } }] }); } };
    },
  });
  assert.equal(result.schemaVersion, OPENING_DIGEST_TRANSLATION_VERSION);
  assert.equal(result.repairs.length, 0);
  assert.ok(prompts.every((prompt) => /自然调整中文语序/.test(prompt) && /严格保留否定、条件/.test(prompt)));
  assert.match(result.translations.find((unit) => unit.id === 'body-3').text, /0\.25%.*若.*可能/);
  assert.match(result.translations.find((unit) => unit.id === 'body-4').text, /并不.*是否/);
  const html = renderWechatOpeningDigestHtml({ payload: prepareOpeningDigestWechatPayload(source), translation: result, images: {} });
  const document = new JSDOM(html).window.document;
  assert.deepEqual([...document.querySelectorAll('h2')].map((node) => node.textContent), ['开市判断', '市场快照', '今日关注', '证据与分歧', '财报预告']);
  assert.equal(document.querySelectorAll('[data-zen-section="focus"]').length, 1);
  assert.equal(document.querySelectorAll('a[href]').length, 0);
  assert.doesNotMatch(html, /今日主线|今日观察/);
});

test('valid previous translation cache is reused for frozen old content without rewriting it', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-opening-legacy-cache-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = payload(); const prepared = prepareOpeningDigestWechatPayload(source);
  const cached = {
    ...translated(source), schemaVersion: 21,
    payloadHash: crypto.createHash('sha256').update(JSON.stringify({ version: 21, model: 'test', payload: prepared })).digest('hex'),
  };
  const cachePath = path.join(directory, 'opening-digest-zh-CN.json');
  const saved = JSON.stringify(cached);
  fs.writeFileSync(cachePath, saved);
  const options = { cacheDir: directory, writer: { model: 'test' }, complete: () => { throw new Error('must reuse frozen translation'); } };
  assert.deepEqual(await translateOpeningDigestPayload(source, options), cached);
  assert.equal(fs.readFileSync(cachePath, 'utf8'), saved);
  // A current-contract payload cannot use a preceding-version cache even when its hash is valid.
  source.article.body = "## Today's focus\n- **Rates constrain valuations.** Watch yields.";
  const current = prepareOpeningDigestWechatPayload(source);
  const units = translationUnits(current).map((unit) => ({ id: unit.id, kind: unit.kind, source: unit.text, text: unit.text }));
  const oldCacheForNewBody = { ...cached, translations: units, payloadHash: crypto.createHash('sha256').update(JSON.stringify({ version: 21, model: 'test', payload: current })).digest('hex') };
  fs.writeFileSync(cachePath, JSON.stringify(oldCacheForNewBody));
  await assert.rejects(translateOpeningDigestPayload(source, options), /must reuse frozen translation/);
});
