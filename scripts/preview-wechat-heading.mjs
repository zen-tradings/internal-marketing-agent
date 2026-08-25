import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { assertFixedDraftTemplate } from '../src/lib/draft-template.js';
import wechatDraft from '../src/channels/wechat-draft.js';

dotenv.config({ override: true });

const config = loadConfig({
  ...process.env,
  INFOGRAPHIC_ENABLED: 'false',
});
if (!config.wechat?.appId || !config.wechat?.appSecret) {
  throw new Error('真实标题卡验收缺少 WECHAT_APP_ID/WECHAT_APP_SECRET');
}

const runId = `heading-preview-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-heading-preview-'));
const articlePath = path.join(workDir, 'article.md');
await fs.writeFile(articlePath, `---
title: 分区标题卡样式验收
---

这是一篇只用于验收微信分区标题卡的短稿，不构成投资建议。

## Why Must the Mother Die?｜母亲为什么必须死

正文第一段。标题卡应使用原图底板，数字在短条下方，英文和中文靠右。

## Price Action and Catalysts｜价格背景：深跌后急涨

正文第二段。引用链接必须保持普通标题，不能变成卡片。

## 引用链接

- [示例来源](https://example.com/heading-preview)
`, 'utf8');

assertFixedDraftTemplate('wechat-draft', wechatDraft);
const published = await wechatDraft.publish({
  articlePath,
  config,
  workflow: { mode: 'analysis' },
  runId,
  resumeFromCheckpoint: false,
  contentPolicy: {},
});
if (!published?.mediaId) throw new Error('标题卡验收没有返回 media_id');

console.log(JSON.stringify({
  ok: true,
  runId,
  mediaId: published.mediaId,
  title: published.title,
  articlePath,
}, null, 2));
