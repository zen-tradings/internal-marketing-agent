import fs from 'node:fs/promises';
import path from 'node:path';
import { renderAndPublish as coreRenderAndPublish } from '@wenyan-md/core/wrapper';
import { getInputContent as defaultGetInputContent } from '../lib/getInputContent.js';
import { generateCover as defaultGenerateCover, ensureFrontmatterCover as defaultEnsureFrontmatterCover } from '../lib/cover.js';
import { checkArticle as defaultCheckArticle } from '../lib/gate.js';
import { injectFixedImages as defaultInjectFixedImages } from '../lib/assets.js';

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

// 已失败任务重试时,article.md 可能已被上一次发布尝试写入 cover 与固定头尾图。
// 门禁的对象应始终是模型产出的内容,而不是这些由本渠道确定性注入的本地文件路径。
function markdownForGate(markdown, assets = {}) {
  let candidate = String(markdown || '').replace(
    /^---\n[\s\S]*?\n---/,
    (block) => block.replace(/^\s*cover\s*:\s*.*(?:\n|$)/gm, '')
  );
  const generatedAssetPaths = [assets.headerImage, assets.footerImage].filter(Boolean);
  for (const assetPath of generatedAssetPaths) {
    candidate = candidate.split('\n').filter((line) => !line.includes(`](${assetPath})`)).join('\n');
  }
  return candidate;
}

// 依赖注入版,便于测试
export function makeChannel({
  renderAndPublish = coreRenderAndPublish,
  readArticle = defaultReadArticle,
  getInputContent = defaultGetInputContent,
  generateCover = defaultGenerateCover,
  ensureFrontmatterCover = defaultEnsureFrontmatterCover,
  writeArticle = defaultWriteArticle,
  checkArticle = defaultCheckArticle,
  injectFixedImages = defaultInjectFixedImages,
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

      // 门禁:对模型产出原文(注入头尾图之前)做出口检查。失败后的重试会保留系统写入的
      // cover/固定图,因此先剥离这些已知资产。errors 拦截发布并直接结束流程,
      // 只有在无 errors 时才继续检查 warnings(放行但需人工关注),避免同一次发布重复告警。
      const assetsConfig = config.assets || {};
      const gate = checkArticle(markdownForGate(markdown, assetsConfig));
      if (gate.errors.length) {
        try { if (notifier && notify) await notifier.warn(notify, `门禁拦截,不予发布:\n${gate.errors.join('\n')}`); }
        catch (warnErr) { console.error('门禁拦截告警失败:', warnErr); }
        const err = new Error(`门禁拦截,不予发布:${gate.errors.join('; ')}`);
        err.stage = 'gate';
        throw err;
      }
      if (gate.warnings.length) {
        try { if (notifier && notify) await notifier.warn(notify, `门禁提醒:\n${gate.warnings.join('\n')}`); }
        catch (warnErr) { console.error('门禁提醒告警失败(不影响流程):', warnErr); }
      }

      // 注入固定头尾图(幂等)。config.assets 缺失路径时对应块静默跳过。
      const injectResult = injectFixedImages(markdown, {
        headerPath: assetsConfig.headerImage,
        footerPath: assetsConfig.footerImage,
      });
      if (injectResult.skipped.length) {
        try { if (notifier && notify) await notifier.warn(notify, `固定头尾图缺失,已跳过注入:${injectResult.skipped.join(', ')}`); }
        catch (warnErr) { console.error('固定图告警失败(不影响流程):', warnErr); }
      }
      if (injectResult.markdown !== markdown) {
        await writeArticle(articlePath, injectResult.markdown);
        markdown = injectResult.markdown;
      }

      // 微信草稿要求封面图:渲染发布前必须先生成封面并写入 frontmatter
      try {
        const cover = await generateCover({ title, outDir: path.dirname(articlePath), markdown, writer: config.writer });
        const updated = ensureFrontmatterCover(markdown, cover);
        if (updated !== markdown) { await writeArticle(articlePath, updated); markdown = updated; }
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
