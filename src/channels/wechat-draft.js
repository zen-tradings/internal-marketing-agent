import fs from 'node:fs/promises';
import { renderAndPublish as coreRenderAndPublish } from '@wenyan-md/core/wrapper';
import { getInputContent as defaultGetInputContent } from '../lib/getInputContent.js';

// 与 wenyan-mcp dist/publish.js 完全一致的渲染参数(parity 硬要求)
export const RENDER_OPTS = { theme: 'zen-trading', highlight: 'solarized-light', macStyle: true, footnote: true };

async function defaultReadArticle(articlePath) {
  const md = await fs.readFile(articlePath, 'utf-8');
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const title = m && /title:\s*(.+)/.exec(m[1]) ? /title:\s*(.+)/.exec(m[1])[1].trim() : '(未命名)';
  return { markdown: md, title };
}

// 依赖注入版,便于测试
export function makeChannel({ renderAndPublish = coreRenderAndPublish, readArticle = defaultReadArticle, getInputContent = defaultGetInputContent } = {}) {
  return {
    id: 'wechat-draft',
    async publish({ articlePath, config }) {
      let title;
      try { ({ title } = await readArticle(articlePath)); }
      catch (e) { const err = new Error(`读取文章失败:${e.message}`); err.stage = 'render'; throw err; }
      // 本地模式:凭据走 env(renderAndPublish 内部读 WECHAT_APP_ID/SECRET),不传 appId
      process.env.WECHAT_APP_ID = config.wechat.appId;
      process.env.WECHAT_APP_SECRET = config.wechat.appSecret;
      try {
        const mediaId = await renderAndPublish(undefined, { ...RENDER_OPTS, file: articlePath }, getInputContent);
        return { mediaId, title };
      } catch (e) { const err = new Error(`发布失败:${e.message}`); err.stage = 'publish'; throw err; }
    },
  };
}

export default makeChannel();
