import { throwIfTaskCancelled } from '../task-cancellation.js';
import { applyTranslationScope, parseTranslationScope, scopeLabel } from './translation-scope.js';
import { report } from './shared.js';
import { acquireSourceDocument, extractInputUrls } from './acquisition.js';
import { translateDocument } from './engine.js';
import { renderTranslatedDocument, buildDocumentManifest, removeRepeatedSourceMetadata } from './render.js';
import { validateTranslationArtifact, assertSourceDocumentComplete } from './validation.js';

export async function generateStructuredTranslation({
  input,
  sourceUrl: explicitSourceUrl,
  sourceRequestHeaders = {},
  workflow,
  writer,
  fetchFn,
  fetchWithRetry,
  completeArticle,
  onProgress,
  onInferenceTelemetry,
  translationConfig = {},
  documentConfig = {},
  resumeFromCheckpoint = false,
  signal,
}) {
  throwIfTaskCancelled(signal);
  const sourceUrl = explicitSourceUrl || extractInputUrls(input)[0];
  if (!sourceUrl) throw new Error('直译任务缺少可读取的 http(s) 原文链接');
  const scope = parseTranslationScope(input);

  await report(onProgress, {
    stage: 'source',
    message: `正在提取原文结构，翻译范围：${scopeLabel(scope)}`,
    completed: 0,
    total: 1,
  });
  const acquired = await acquireSourceDocument({
    sourceUrl,
    workDir: workflow.workDir,
    fetchFn,
    fetchWithRetry,
    config: translationConfig,
    documentConfig,
    dnsLookup: translationConfig.dnsLookup,
    scope,
    onProgress,
    requestHeaders: sourceRequestHeaders,
    signal,
  });
  throwIfTaskCancelled(signal);
  let source = acquired.scope?.kind === 'sections' && acquired.scope.appliedStartHeading
    ? acquired
    : applyTranslationScope(acquired, scope);
  source.scope = source.scope || scope;
  source = removeRepeatedSourceMetadata(source);
  assertSourceDocumentComplete(source);
  const manifest = buildDocumentManifest(source);
  await report(onProgress, {
    stage: 'structure',
    message: `已提取 ${manifest.blocks} 个结构块：${manifest.headings} 个标题、${manifest.figures} 张图、${manifest.tables} 个表格${manifest.pageCoverage
      ? `，页级覆盖 ${manifest.pageCoverage.processedPages}/${manifest.pageCoverage.requestedPages}`
      : ''}`,
    completed: 1,
    total: 1,
  });

  const translated = await translateDocument({
    source,
    workDir: workflow.workDir,
    model: workflow.model || writer.model,
    writer,
    fetchFn,
    completeArticle,
    timeoutMs: workflow.timeoutMs,
    onProgress,
    onInferenceTelemetry,
    batchConcurrency: translationConfig.batchConcurrency,
    resumeFromCheckpoint,
    signal,
  });
  throwIfTaskCancelled(signal);
  const article = renderTranslatedDocument(translated);
  const completeness = validateTranslationArtifact({ source, translated, article });
  if (completeness.errors.length) {
    throw new Error(`直译完整性门禁失败:${completeness.errors.join('; ')}`);
  }
  await report(onProgress, {
    stage: 'validation',
    message: completeness.reviewRequiredCount
      ? `结构完整性通过：${completeness.blocks} 个内容块，${completeness.reviewRequiredCount} 个译块需人工复核`
      : `结构化直译严格等价校验通过：${completeness.blocks} 个内容块`,
    completed: 1,
    total: 1,
  });

  return {
    article,
    sourceUrl: source.sourceUrl,
    manifest: {
      ...manifest,
      title: source.title,
      author: source.author,
      publishedDate: source.publishedDate,
      sourceUrl: source.sourceUrl,
      sourceType: source.sourceType,
      extractor: source.extractor,
      sha256: source.sha256,
      acquisition: source.acquisition,
      scope: source.scope,
    },
    completeness,
    warnings: completeness.warnings,
    contentPolicy: {
      allow_code_blocks: source.blocks.some((block) => block.type === 'code'),
      source: source.blocks.some((block) => block.type === 'code')
        ? 'translation-source-code'
        : 'translation-source-no-code',
    },
  };
}
