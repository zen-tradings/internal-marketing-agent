import fs from 'node:fs/promises';
import path from 'node:path';
import { renderNewsletterEmail, parseNewsletterArticle } from '../src/lib/newsletter-email.js';
import { renderOpeningDigestContentHtml, CUSTOMERIO_OPENING_DIGEST_TEMPLATE_ID } from '../src/channels/customerio-opening-digest.js';
import { renderWechatOpeningDigestHtml } from '../src/channels/wechat-opening-digest.js';
import { renderDiscordOpeningDigest } from '../src/channels/discord-opening-digest.js';
import { translationUnits, prepareOpeningDigestWechatPayload } from '../src/lib/opening-digest-translation.js';
import { renderOpeningDigestWechatCover } from '../src/lib/opening-digest-wechat-cover.js';
import { auditOpeningDigestInsight } from '../src/lib/opening-digest-editorial.js';
import { chromium } from 'playwright-core';
import { browserExecutable } from '../src/lib/translation/assets.js';

// Deterministic, fictional sample: no research, model calls, or channel writes.
const dateKey = '2026-10-02';
const lead = 'The opening stance is neutral: firm long-term Treasury yields continue to constrain growth-stock valuations. Lower oil prices ease inflation pressure, but do not yet justify a more constructive view.';
const focus = [
  '**Rates still constrain growth valuations.** Firm long-term yields keep the opening read neutral; watch whether the 10Y yield retreats and QQQ strengthens relative to SPY. That combination would weaken the valuation constraint, while persistent yield pressure would leave the judgment intact.',
  '**Cheaper oil offers partial relief.** Lower energy costs may ease inflation pressure, but do not establish a broad risk-on shift; watch whether index resilience extends beyond isolated names and whether VIX confirms it.',
];
const evidence = [
  '**Policy relief remains limited.** The [Fed statement](https://example.com/sample-fed) leaves rates unchanged. Firm long-term yields are consistent with continued valuation pressure, which limits how much the policy decision alone can support growth shares.',
  '**Energy provides a counterweight.** The [oil report](https://example.com/sample-oil) records lower prices. Reduced energy costs may ease inflation pressure, but that mechanism alone does not establish a sustained improvement in equity participation.',
];
const earnings = 'No major U.S.-listed earnings events were selected for the remainder of this week.';
const markdown = `---
title: Zen Opening Digest
headline: Fed holds rates steady as inflation pressure eases
stance: neutral
confidence: medium
preheader: Firm yields limit valuation support; cheaper oil provides a partial counterweight.
edition: ${dateKey}
---
${lead}

## Today's focus

${focus.map((text) => `- ${text}`).join('\n')}

## Evidence and cross-currents

${evidence.join('\n\n')}

## Earnings ahead

${earnings}`;
const audit = auditOpeningDigestInsight(markdown);
if (audit.warnings.length) throw new Error(`Preview violates the editorial contract: ${audit.warnings.join('; ')}`);
const metrics = [
  ['SPY', 550.25, 0.15], ['QQQ', 480.30, -0.10], ['IWM', 210.40, 0.05],
  ['VIX', 18.20, -1.20], ['2Y UST', 4.10, 0.12], ['10Y UST', 4.35, 0.23],
  ['DXY', 103.50, 0.08], ['WTI', 72.40, -1.50], ['Gold', 2650.50, 0.30],
].map(([label, value, changePct]) => ({ label, value, changePct }));
const options = {
  kind: 'Opening', capturedAt: '2026-10-02T14:00:00Z',
  data: {
    asOf: 'As of 02 Oct 2026, 10:00:00 EDT', attribution: 'Data provided by IVolatility',
    headers: ['', 'Ticker', 'Name', 'Call Options Volume (%)', 'Put Options Volume (%)', 'Total Option Volume', 'IVX 30', 'IVX Change %'],
    rows: Array.from({ length: 20 }, (_, index) => [String(index + 1), `T${index + 1}`, `Company ${index + 1}`, '50.00 %', '50.00 %', String(1_000_000 - index * 1000), '20.00', '0.10']),
  },
};
const article = parseNewsletterArticle(markdown, dateKey);
const payload = {
  schemaVersion: 2, dateKey,
  article: { title: article.title, headline: article.headline, preheader: article.preheader, body: article.body },
  editorial: { stance: article.stance, confidence: article.confidence, changeSummary: 'Initial baseline.' },
  metrics, options, cover: { label: 'Opening Digest', dateLabel: 'October 2, 2026' },
};
const email = renderNewsletterEmail(article, {
  contentHtml: renderOpeningDigestContentHtml({ body: article.body, metrics, options }),
  displayTitle: article.headline,
  publicationSubtitle: 'Zen Opening Digest · October 2, 2026',
  includeUnsubscribe: false,
  templateId: CUSTOMERIO_OPENING_DIGEST_TEMPLATE_ID,
});
const fixed = new Map([
  ['headline', 'Fed利率不变，通胀缓和'], ['preheader', '收益率坚挺限制估值支撑，油价回落提供部分缓冲。'],
  ["Today's focus", '今日关注'], ['Evidence and cross-currents', '证据与分歧'], ['Earnings ahead', '财报预告'],
  [lead, '开市判断维持中性：长期美债收益率坚挺，继续压制成长股估值。油价回落缓解通胀压力，但尚不足以支持更积极的判断。'],
  [focus[0], '**利率仍制约成长股估值。** 长期收益率坚挺，令开市判断维持中性；关注 10Y 收益率是否回落，以及 QQQ 相对 SPY 是否走强。两者同时出现将削弱估值约束；若收益率压力持续，原有判断仍成立。'],
  [focus[1], '**低油价提供部分缓冲。** 能源成本下降可能缓解通胀压力，但不代表市场已全面转向风险偏好；关注指数的韧性是否扩展至个别股票之外，以及 VIX 是否予以确认。'],
  [evidence[0].replace(/\[([^\]]+)]\(https?:\/\/[^)]+\)/g, '$1'), '**政策缓冲仍有限。** Fed 声明维持利率不变。长期收益率坚挺与估值压力持续的判断一致，限制了政策决定本身对成长股的支撑。'],
  [evidence[1].replace(/\[([^\]]+)]\(https?:\/\/[^)]+\)/g, '$1'), '**能源提供反向支撑。** 油价报告显示价格回落。能源成本下降可能缓解通胀压力，但仅凭这一机制，尚不能认定股票参与度持续改善。'],
  [earnings, '本周余下时间暂无重点美股财报事件入选。'],
]);
const wechatPayload = prepareOpeningDigestWechatPayload(payload);
const translation = {
  translations: translationUnits(wechatPayload).map((unit) => {
    let text = fixed.get(unit.id) || fixed.get(unit.text);
    if (!text && unit.id === 'oic-asof') text = '截至 02 Oct 2026, 10:00:00 EDT';
    if (!text && unit.id === 'oic-attribution') text = '数据由 IVolatility 提供';
    if (!text && unit.kind === 'company_name') text = unit.text.replace('Company', '公司');
    if (!text) throw new Error(`Missing sample Chinese translation: ${unit.id}`);
    return { id: unit.id, kind: unit.kind, source: unit.text, text };
  }),
};
const wechat = renderWechatOpeningDigestHtml({ payload: wechatPayload, translation, images: {} });
const discord = renderDiscordOpeningDigest(payload);
const directory = path.resolve('output/opening-digest-preview');
await fs.mkdir(directory, { recursive: true });
await renderOpeningDigestWechatCover({
  dateKey, headline: fixed.get('headline'), cacheDir: directory,
  executablePath: browserExecutable({ browserExecutablePath: process.env.OPENING_DIGEST_BROWSER_EXECUTABLE || process.env.TRANSLATION_BROWSER_EXECUTABLE }),
});
const enNotice = '<p style="padding:10px;background:#fff3cd;color:#664d03">Illustrative sample — all events, prices and links are fictional; this is not a live market report.</p>';
const zhNotice = '<p style="padding:10px;background:#fff3cd;color:#664d03">示例预览：事件、行情和来源链接均为演示内容，不代表真实市场日报。</p>';
const emailPreview = email.replace(/(<body[^>]*>)/, `$1${enNotice}`);
const wechatPreview = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>中文日报示例预览</title></head><body style="margin:0;background:#f0edeb"><main style="max-width:620px;margin:auto;padding:12px;background:#fffdf8">${zhNotice}${wechat}</main></body></html>`;
const chineseBody = translation.translations.filter((unit) => unit.id.startsWith('body-')).map((unit) => unit.kind === 'heading' ? `## ${unit.text}` : unit.kind === 'list_item' ? `- ${unit.text}` : unit.text).join('\n\n');
await fs.writeFile(path.join(directory, 'customerio.html'), emailPreview);
await fs.writeFile(path.join(directory, 'wechat.html'), wechatPreview);
await fs.writeFile(path.join(directory, 'english.md'), `> Illustrative sample — fictional events and data.\n\n${markdown}\n`);
await fs.writeFile(path.join(directory, 'chinese.md'), `> 示例预览，事件与行情均为演示内容。\n\n# ${fixed.get('headline')}\n\n${chineseBody}\n`);
await fs.writeFile(path.join(directory, 'discord.json'), `${JSON.stringify({ sample: true, messages: discord }, null, 2)}\n`);
const browser = await chromium.launch({ executablePath: browserExecutable({ browserExecutablePath: process.env.OPENING_DIGEST_BROWSER_EXECUTABLE || process.env.TRANSLATION_BROWSER_EXECUTABLE }), headless: true });
try {
  for (const [name, html] of [['customerio', emailPreview], ['wechat', wechatPreview]]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    await page.route('**/*', (route) => route.abort());
    await page.setContent(html);
    for (const width of [320, 375, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      if (overflow) throw new Error(`${name} sample overflows at ${width}px`);
      if (width === 390) {
        await page.screenshot({ path: path.join(directory, `${name}-mobile.png`), fullPage: true });
        await page.screenshot({ path: path.join(directory, `${name}-opening.png`), fullPage: false });
      }
    }
    await page.close();
  }
} finally { await browser.close(); }
console.log(`Opening Digest sample preview: ${directory}`);
console.log(`Focus: ${audit.stats.focusCount} bullets / ${audit.stats.focusWords} visible English words`);
console.log(`Narrative: ${audit.stats.narrativeWords} visible English words`);
