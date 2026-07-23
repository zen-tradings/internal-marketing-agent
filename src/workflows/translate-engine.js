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
      contentMode: 'body-text-only',
      extractor: result.manifest.extractor,
      sourceType: result.manifest.sourceType,
      acquisition: result.manifest.acquisition,
      structure: {
        blocks: result.manifest.blocks,
        headings: result.manifest.headings,
        paragraphs: result.manifest.paragraphs,
        blockOrder: result.manifest.blockOrder,
        pageCount: result.manifest.pageCount,
      },
      completeness: result.completeness,
    };
  }
  return result;
}
