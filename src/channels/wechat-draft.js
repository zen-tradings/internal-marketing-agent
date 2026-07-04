import fs from 'node:fs/promises';
import path from 'node:path';
import { renderAndPublish as coreRenderAndPublish } from '@wenyan-md/core/wrapper';
import { getInputContent as defaultGetInputContent } from '../lib/getInputContent.js';
import { injectFollowCard as defaultInjectFollowCard } from '../lib/wechatApi.js';
import { generateCover as defaultGenerateCover, ensureFrontmatterCover as defaultEnsureFrontmatterCover } from '../lib/cover.js';

// 与 wenyan-mcp dist/publish.js 完全一致的渲染参数(parity 硬要求)
export const RENDER_OPTS = { theme: 'zen-trading', highlight: 'solarized-light', macStyle: true, footnote: true };

async function defaultReadArticle(articlePath) {
  const md = await fs.readFile(articlePath, 'utf-8');
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const title = m && /title:\s*(.+)/.exec(m[1]) ? /title:\s*(.+)/.exec(m[1])[1].trim() : '(未命名)';
  return { markdown: md, title };
}

async function defaultWriteArticle(articlePath, content) {
  await fs.writeFile(articlePath, content, 'utf-8');
}

// 依赖注入版,便于测试
export function makeChannel({
  renderAndPublish = coreRenderAndPublish,
  readArticle = defaultReadArticle,
  getInputContent = defaultGetInputContent,
  injectFollowCard = defaultInjectFollowCard,
  generateCover = defaultGenerateCover,
  ensureFrontmatterCover = defaultEnsureFrontmatterCover,
  writeArticle = defaultWriteArticle,
} = {}) {
  return {
    id: 'wechat-draft',
    async publish({ articlePath, config, notify, notifier }) {
      let title, markdown;
      try { ({ title, markdown } = await readArticle(articlePath)); }
      catch (e) { const err = new Error(`读取文章失败:${e.message}`); err.stage = 'render'; throw err; }

      const appId = config.wechat && config.wechat.appId;
      const appSecret = config.wechat && config.wechat.appSecret;
      if (!appId || !appSecret) {
        const err = new Error('微信凭据缺失(WECHAT_APP_ID/WECHAT_APP_SECRET)');
        err.stage = 'publish';
        throw err;
      }

      // 微信草稿要求封面图:渲染发布前必须先生成封面并写入 frontmatter
      try {
        const cover = await generateCover({ title, outDir: path.dirname(articlePath) });
        const updated = ensureFrontmatterCover(markdown, cover);
        if (updated !== markdown) await writeArticle(articlePath, updated);
      } catch (e) {
        try { if (notifier && notify) await notifier.warn(notify, `封面生成失败,需人工补图:${e.message}`); }
        catch (warnErr) { console.error('封面告警失败(不影响错误上抛):', warnErr); }
        const err = new Error('缺少封面,微信草稿要求封面图'); err.stage = 'cover'; throw err;
      }

      // 本地模式:凭据走 env(renderAndPublish 内部读 WECHAT_APP_ID/SECRET),不传 appId
      const prevAppId = process.env.WECHAT_APP_ID;
      const prevAppSecret = process.env.WECHAT_APP_SECRET;
      process.env.WECHAT_APP_ID = appId;
      process.env.WECHAT_APP_SECRET = appSecret;
      try {
        const mediaId = await renderAndPublish(undefined, { ...RENDER_OPTS, file: articlePath }, getInputContent);
        // 名片注入:失败不阻断出草稿,只告警;告警本身失败也绝不能影响已成功的发布结果
        try {
          try { await injectFollowCard({ config, mediaId }); }
          catch (e) { if (notifier && notify) await notifier.warn(notify, `名片注入失败(草稿已出):${e.message}`); }
        } catch (warnErr) { console.error('名片告警失败(不影响发布结果):', warnErr); }
        return { mediaId, title };
      } catch (e) { const err = new Error(`发布失败:${e.message}`); err.stage = 'publish'; throw err; }
      finally {
        if (prevAppId === undefined) delete process.env.WECHAT_APP_ID; else process.env.WECHAT_APP_ID = prevAppId;
        if (prevAppSecret === undefined) delete process.env.WECHAT_APP_SECRET; else process.env.WECHAT_APP_SECRET = prevAppSecret;
      }
    },
  };
}

export default makeChannel();
