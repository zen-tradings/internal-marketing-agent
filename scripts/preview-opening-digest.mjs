import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderNewsletterEmail, parseNewsletterArticle } from '../src/lib/newsletter-email.js';
import { renderOpeningDigestContentHtml, CUSTOMERIO_OPENING_DIGEST_TEMPLATE_ID } from '../src/channels/customerio-opening-digest.js';
import { renderWechatOpeningDigestHtml } from '../src/channels/wechat-opening-digest.js';
import { renderDiscordOpeningDigest } from '../src/channels/discord-opening-digest.js';
import { translationUnits } from '../src/lib/opening-digest-translation.js';

const dateKey = '2026-08-10';
const markdown = `---
title: Zen Opening Digest
headline: Yields test tech conviction
stance: neutral
confidence: medium
preheader: Falling oil offsets firm yields, leaving confirmation to equity participation.
edition: ${dateKey}
---
The opening tone is Neutral because cross-asset signals do not point in one direction. Lower oil is supportive, while firm long yields constrain duration-sensitive equities. Initial baseline.

## What matters today

**Rates remain the binding constraint.** Long yields still challenge duration-sensitive equities; a retreat would weaken that reading.

**Energy supplies the counterweight.** Lower oil reduces one inflationary pressure, but does not establish a broad risk-on regime.

## Evidence and cross-currents

Rate and oil signals offset each other, while tracked-universe participation is too narrow to establish whole-market breadth.

## Scenario map

- **Base case —** Stable VIX and easing long yields would confirm a more constructive opening read.
- **Counter-case —** Renewed yield pressure with a rising VIX would invalidate that improvement.

## What to watch

- Whether the 10Y yield holds its opening range
- Whether VIX confirms index resilience
- Whether participation broadens beyond isolated tracked names

## Earnings ahead

No major U.S.-listed earnings events were selected for the remainder of this week.`;
const metrics = ['SPY', 'QQQ', 'IWM', 'VIX', '2Y UST', '10Y UST', 'DXY', 'WTI', 'Gold']
  .map((label, index) => ({ label, value: 100 + index, changePct: index % 2 ? -0.4 : 0.3 }));
const options = {
  kind: 'Opening', capturedAt: '2026-08-10T14:15:00Z',
  data: {
    asOf: 'As of 10 Aug 2026, 10:15:00 EDT', attribution: 'Data provided by IVolatility',
    headers: ['', 'Ticker', 'Name', 'Call Options Volume (%)', 'Put Options Volume (%)', 'Total Option Volume', 'IVX 30', 'IVX Change %'],
    rows: Array.from({ length: 20 }, (_, index) => [String(index + 1), `T${index + 1}`, `Company ${index + 1}`, '50.00 %', '50.00 %', String(1_000_000 - index * 1000), '20.00', '0.10']),
  },
};
const article = parseNewsletterArticle(markdown, dateKey);
const payload = {
  schemaVersion: 2, dateKey,
  article: { title: article.title, headline: article.headline, preheader: article.preheader, body: article.body },
  editorial: { stance: article.stance, confidence: article.confidence, changeSummary: 'Initial baseline.' },
  metrics, options, cover: { label: 'Opening Digest', dateLabel: 'August 10, 2026' },
};
const email = renderNewsletterEmail(article, {
  contentHtml: renderOpeningDigestContentHtml({ body: article.body, metrics, options }),
  displayTitle: article.headline,
  publicationSubtitle: 'Zen Opening Digest · August 10, 2026',
  includeUnsubscribe: false,
  templateId: CUSTOMERIO_OPENING_DIGEST_TEMPLATE_ID,
});
const fixed = new Map([
  ['headline', '利率考验科技股信心'], ['preheader', '油价回落与长端利率坚挺相互抵消。'],
  ['What matters today', '今日主线'], ['Evidence and cross-currents', '证据与分歧'],
  ['Scenario map', '情景地图'], ['What to watch', '今日观察'], ['Earnings ahead', '财报预告'],
]);
const translation = {
  translations: translationUnits(payload).map((unit) => ({
    id: unit.id, kind: unit.kind, source: unit.text,
    text: fixed.get(unit.id) || fixed.get(unit.text) || unit.text,
  })),
};
const wechat = renderWechatOpeningDigestHtml({ payload, translation, images: {} });
const discord = renderDiscordOpeningDigest(payload);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-opening-preview-'));
await Promise.all([
  fs.writeFile(path.join(directory, 'customerio.html'), email),
  fs.writeFile(path.join(directory, 'wechat.html'), wechat),
  fs.writeFile(path.join(directory, 'discord.json'), `${JSON.stringify(discord, null, 2)}\n`),
]);
console.log(`Opening Digest preview: ${directory}`);
console.log(`Headline: ${article.headline}`);
console.log(`Subject: ${article.headline} | Zen Opening Digest`);
