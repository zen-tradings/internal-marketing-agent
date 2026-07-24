import { generateStructuredTranslation } from './translation-source-text.js';

export async function generateStrictTranslation({
  input,
  workflow,
  writer,
  fetchFn,
  trace,
  completeArticle,
  fetchWithRetry,
  onProgress,
  resumeFromCheckpoint = false,
  translationConfig = {},
}) {
  const result = await generateStructuredTranslation({
    input,
    workflow,
    writer,
    fetchFn,
    fetchWithRetry,
    completeArticle,
    onProgress,
    translationConfig,
    resumeFromCheckpoint,
  });
  if (trace) {
    trace.translationText = {
      enabled: true,
      contentMode: 'structured-document',
      extractor: result.manifest.extractor,
      sourceType: result.manifest.sourceType,
      acquisition: result.manifest.acquisition,
      scope: result.manifest.scope,
      structure: {
        blocks: result.manifest.blocks,
        headings: result.manifest.headings,
        paragraphs: result.manifest.paragraphs,
        figures: result.manifest.figures,
        tables: result.manifest.tables,
        equations: result.manifest.equations,
        blockOrder: result.manifest.blockOrder,
        pageCount: result.manifest.pageCount,
        processedPageCount: result.manifest.processedPageCount,
        parseQualityScore: result.manifest.parseQualityScore,
        parserAttempts: result.manifest.parserAttempts,
      },
      completeness: result.completeness,
    };
  }
  return result;
}
