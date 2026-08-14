import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getInputContent as defaultGetInputContent } from '../lib/getInputContent.js';
import { generateCover as defaultGenerateCover, ensureFrontmatterCover as defaultEnsureFrontmatterCover } from '../lib/cover.js';
import {
  generateArticleInfographics as defaultGenerateArticleInfographics,
  stripGeneratedInfographics,
} from '../lib/infographic.js';
import { checkArticle as defaultCheckArticle, configuredSecretValues } from '../lib/gate.js';
import { injectFixedImages as defaultInjectFixedImages } from '../lib/assets.js';
import { recoverWechatDraft, renderAndPublishWithFinalFooter, stripFinalTailMarkdown } from '../lib/wechat-render.js';
import { normalizeWideTables as defaultNormalizeWideTables } from '../lib/mobile-tables.js';
import { normalizeIndentedCodeBlocks as defaultNormalizeIndentedCodeBlocks } from '../lib/code-blocks.js';
import { FIXED_DRAFT_TEMPLATE_IDS } from '../lib/draft-template.js';

// Rendering options must exactly match wenyan-mcp dist/publish.js.
// Body copy always uses the standard WeChat layout. Authorized or source-native code uses light highlighting.
// Keep macStyle disabled so the yellow Mac card cannot alter the fixed template.
export const WECHAT_TEMPLATE_ID = FIXED_DRAFT_TEMPLATE_IDS['wechat-draft'];
export const WECHAT_THEME_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'assets',
  'zen-trading.css'
);
export const RENDER_OPTS = Object.freeze({
  theme: 'zen-trading',
  customTheme: WECHAT_THEME_PATH,
  highlight: 'solarized-light',
  macStyle: false,
  footnote: false,
});

async function defaultReadArticle(articlePath) {
  const md = await fs.readFile(articlePath, 'utf-8');
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const title = m && /title:\s*(.+)/.exec(m[1]) ? /title:\s*(.+)/.exec(m[1])[1].trim() : '(未命名)';
  return { markdown: md, title };
}

async function defaultWriteArticle(articlePath, content) {
  await fs.writeFile(articlePath, content, 'utf-8');
}

// A retry may find cover and fixed images written by the previous publish attempt in article.md.
// Gate only model-produced content, never deterministic local paths injected by this channel.
function markdownForGate(markdown, assets = {}) {
  let candidate = stripGeneratedInfographics(String(markdown || '')).replace(
    /^---\n[\s\S]*?\n---/,
    (block) => block.replace(/^\s*cover\s*:\s*.*(?:\n|$)/gm, '')
  );
  const generatedAssetPaths = [assets.headerImage, assets.surveyImage, assets.footerImage].filter(Boolean);
  for (const assetPath of generatedAssetPaths) {
    candidate = candidate.split('\n').filter((line) => !line.includes(`](${assetPath})`)).join('\n');
  }
  return candidate;
}

// Dependency-injected form for testing.
export function makeChannel({
  renderAndPublish = renderAndPublishWithFinalFooter,
  readArticle = defaultReadArticle,
  getInputContent = defaultGetInputContent,
  generateCover = defaultGenerateCover,
  generateArticleInfographics = defaultGenerateArticleInfographics,
  ensureFrontmatterCover = defaultEnsureFrontmatterCover,
  writeArticle = defaultWriteArticle,
  checkArticle = defaultCheckArticle,
  injectFixedImages = defaultInjectFixedImages,
  normalizeWideTables = defaultNormalizeWideTables,
  normalizeIndentedCodeBlocks = defaultNormalizeIndentedCodeBlocks,
  recoverDraft = recoverWechatDraft,
} = {}) {
  return {
    id: 'wechat-draft',
    templateId: WECHAT_TEMPLATE_ID,
    templateLocked: true,
    async publish({
      articlePath,
      config,
      workflow,
      notify,
      notifier,
      runId,
      signal,
      existingRemoteId,
      onCreated,
      resumeFromCheckpoint = false,
      contentPolicy = {},
    }) {
      let title, markdown;
      try { ({ title, markdown } = await readArticle(articlePath)); }
      catch (e) { const err = new Error(`读取文章失败:${e.message}`); err.stage = 'render'; throw err; }

      // A failed retry can include a previously injected infographic. Remove it deterministically first
      // so normalization and gating see model output only and regeneration cannot accumulate images.
      const withoutStaleInfographics = stripGeneratedInfographics(markdown);
      if (withoutStaleInfographics !== markdown) {
        try { await writeArticle(articlePath, withoutStaleInfographics); markdown = withoutStaleInfographics; }
        catch (e) { const err = new Error(`生成图清理写入失败:${e.message}`); err.stage = 'render'; throw err; }
      }

      const appId = config.wechat && config.wechat.appId;
      const appSecret = config.wechat && config.wechat.appSecret;
      if (!appId || !appSecret) {
        const err = new Error('微信凭据缺失(WECHAT_APP_ID/WECHAT_APP_SECRET)');
        err.stage = 'publish';
        throw err;
      }

      if (existingRemoteId) {
        try {
          const recovered = await recoverDraft({
            appId, appSecret, mediaId: existingRemoteId,
            timeoutMs: config.wechat.timeoutMs, signal,
          });
          const recoveredTitle = recovered?.news_item?.[0]?.title
            || recovered?.content?.news_item?.[0]?.title
            || '';
          if (!recoveredTitle || recoveredTitle !== title) {
            throw new Error(`远端标题不匹配:${recoveredTitle || '无标题'}`);
          }
          return { mediaId: String(existingRemoteId), title };
        } catch (error) {
          const wrapped = new Error(`微信既有草稿恢复失败:${error.message}`);
          wrapped.stage = 'publish';
          throw wrapped;
        }
      }

      // Deterministically normalize standalone four-space Markdown code to text fences. User authorization
      // controls only the Slack reminder, not safe rendering; keep existing fences, HTML pre, and nested lists.
      const codeResult = normalizeIndentedCodeBlocks(markdown);
      if (codeResult.changed) {
        try {
          await writeArticle(articlePath, codeResult.markdown);
          markdown = codeResult.markdown;
        } catch (e) {
          const err = new Error(`代码块规范化写入失败:${e.message}`); err.stage = 'render'; throw err;
        }
        try {
          if (notifier && notify) await notifier.warn(
            notify,
            `已将 ${codeResult.transformedBlocks} 个四空格缩进代码块规范为公众号浅色代码块。`,
          );
        } catch (warnErr) { console.error('代码块规范化提醒失败(不影响流程):', warnErr); }
      }

      // Deterministically split mobile-unreadable wide tables into narrow tables. Preserve compact five-column
      // tables; otherwise retain the first column and group three metrics at a time before the final gate.
      const tableResult = normalizeWideTables(markdown);
      if (tableResult.changed) {
        try {
          await writeArticle(articlePath, tableResult.markdown);
          markdown = tableResult.markdown;
        } catch (e) {
          const err = new Error(`移动端表格转换写入失败:${e.message}`); err.stage = 'render'; throw err;
        }
        try {
          if (notifier && notify) await notifier.warn(
            notify,
            `已自动将 ${tableResult.transformedTables} 个宽表拆为 ${tableResult.outputTables} 个移动端窄表,内容未删减。`,
          );
        } catch (warnErr) { console.error('宽表转换提醒失败(不影响流程):', warnErr); }
      }

      // Gate model output before fixed images are injected. Retries retain system-written cover/fixed images,
      // so remove known assets first. Errors block publication; evaluate warnings only without errors to avoid duplicates.
      const assetsConfig = config.assets || {};
      const gate = checkArticle(markdownForGate(markdown, assetsConfig), {
        workflowMode: workflow?.mode || '',
        contentPolicy,
        secretValues: configuredSecretValues(config),
      });
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

      // Historical retries can have fixed footer images in Markdown. Remove them all; final HTML appends the
      // research and community images after footnotes/references so they remain the final two body nodes.
      const withoutLegacyTail = stripFinalTailMarkdown(markdown, [
        assetsConfig.surveyImage,
        assetsConfig.footerImage,
      ]);
      if (withoutLegacyTail !== markdown) {
        await writeArticle(articlePath, withoutLegacyTail);
        markdown = withoutLegacyTail;
      }

      // Inject only the header image into Markdown; append both fixed footer images after body and footnote rendering.
      const injectResult = injectFixedImages(markdown, {
        headerPath: assetsConfig.headerImage,
        footerPath: undefined,
      });
      if (injectResult.skipped.length) {
        try { if (notifier && notify) await notifier.warn(notify, `固定头图缺失,已跳过注入:${injectResult.skipped.join(', ')}`); }
        catch (warnErr) { console.error('固定图告警失败(不影响流程):', warnErr); }
      }
      if (injectResult.markdown !== markdown) {
        await writeArticle(articlePath, injectResult.markdown);
        markdown = injectResult.markdown;
      }

      // Writing tasks generate and insert infographics; faithful translations do not. Planning, rendering, or
      // anchor failures only warn and skip that image; they never block publication.
      if ((workflow?.mode || '') !== 'translation' && config.infographic?.enabled === true) {
        let infographicResult;
        try {
          infographicResult = await generateArticleInfographics({
            title,
            markdown,
            outDir: path.dirname(articlePath),
            writer: config.writer,
            infographic: config.infographic || {},
            generatorDir: config.infographic?.generatorDir || undefined,
          });
        } catch (e) {
          infographicResult = { markdown, images: [], warnings: [`信息图生成异常,已跳过:${e.message}`] };
        }
        if (infographicResult.markdown !== markdown) {
          try { await writeArticle(articlePath, infographicResult.markdown); markdown = infographicResult.markdown; }
          catch (e) { const err = new Error(`信息图写入失败:${e.message}`); err.stage = 'render'; throw err; }
        }
        for (const warning of infographicResult.warnings || []) {
          try { if (notifier && notify) await notifier.warn(notify, warning); }
          catch (warnErr) { console.error('信息图告警失败(不影响流程):', warnErr); }
        }
        if (infographicResult.images?.length) {
          try {
            if (notifier && notify) await notifier.warn(
              notify,
              `已根据文章内容生成 ${infographicResult.images.length} 张信息图插入文中,图中文字由模型提取,请人工复核。`,
            );
          } catch (warnErr) { console.error('信息图提醒失败(不影响流程):', warnErr); }
        }
      }

      // WeChat drafts require a cover image before rendering and publishing; write it into frontmatter first.
      try {
        const outDir = path.dirname(articlePath);
        const coverPath = path.join(outDir, 'cover.png');
        const coverOwnerPath = path.join(outDir, '.cover-run-id');
        let cover;
        if (resumeFromCheckpoint && runId) {
          try {
            const [owner] = await Promise.all([
              fs.readFile(coverOwnerPath, 'utf8'),
              fs.access(coverPath),
            ]);
            if (owner.trim() === runId) cover = coverPath;
          } catch {}
        }
        if (!cover) {
          cover = await generateCover({
            title,
            outDir,
            markdown,
            writer: config.writer,
            generatorDir: config.cover?.generatorDir || undefined,
          });
          if (runId) await fs.writeFile(coverOwnerPath, runId, 'utf8');
        }
        const updated = ensureFrontmatterCover(markdown, cover);
        if (updated !== markdown) { await writeArticle(articlePath, updated); markdown = updated; }
      } catch (e) {
        try { if (notifier && notify) await notifier.warn(notify, `封面生成失败,需人工补图:${e.message}`); }
        catch (warnErr) { console.error('封面告警失败(不影响错误上抛):', warnErr); }
        const err = new Error('缺少封面,微信草稿要求封面图'); err.stage = 'cover'; throw err;
      }

      try {
        const mediaId = await renderAndPublish(undefined, {
          ...RENDER_OPTS,
          file: articlePath,
          appId,
          appSecret,
          timeoutMs: config.wechat.timeoutMs,
          signal,
          finalSurveyPath: assetsConfig.surveyImage,
          finalFooterPath: assetsConfig.footerImage,
        }, getInputContent);
        await onCreated?.({ remoteId: String(mediaId), title });
        return { mediaId, title };
      } catch (e) { const err = new Error(`发布失败:${e.message}`); err.stage = 'publish'; throw err; }
    },
  };
}

export default makeChannel();
