import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config/index.js';
import { parseNewsletterArticle, renderNewsletterEmail } from '../src/lib/newsletter-email.js';

// 本地预览:用当前模板 + .env 里的品牌图/联系邮件渲染一篇示例邮件,写到临时 HTML 供审核。
// 不调用任何外部 API,不在 Customer.io 创建草稿。
const SAMPLE = `---
title: Nvidia's capex signal is still pointing up
subject: Zen Research from Zen Trading · ${process.env.NEWSLETTER_EDITION || 'Vol. 2'} | Capex signal
preheader: Three signals we are watching after the print.
edition: ${process.env.NEWSLETTER_EDITION || 'Vol. 2'}
---
## The takeaway
Hyperscaler capex guidance keeps moving **higher**, not lower. That is the one falsifiable read from this week's numbers.

## Why it matters
Demand commentary is easy to hand-wave. Capital budgets are not. When the biggest buyers raise spend, the supply chain re-rates with them. See the [official filing](https://example.com/filing) for the exact language.

## What we're watching
- Lead times on advanced packaging
- Any downward revision to 2026 capex
- Whether power availability becomes the new bottleneck`;

const config = loadConfig();
const article = parseNewsletterArticle(SAMPLE, config.customerio.edition);
const html = renderNewsletterEmail(article, config.customerio);

const outPath = path.join(os.tmpdir(), 'zen-newsletter-preview.html');
await fs.writeFile(outPath, html, 'utf8');
console.log(`预览已生成:${outPath}`);
console.log(`版号:${article.edition}`);
console.log(`品牌图:${config.customerio.headerImageUrl || '(未配置)'}`);
console.log(`联系邮件:${config.customerio.contactEmail || '(未配置)'}`);
