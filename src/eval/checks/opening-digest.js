// Metric A: Opening Digest sentence/word/structure limits, replayed via the production auditor.
// Audit warnings are treated as eval errors because each one is a limit violation.

import { auditOpeningDigestArticle } from '../../lib/opening-digest-content.js';

export function checkOpeningDigestLimits(input, expect = {}, { article } = {}) {
  const body = String(article ?? input.article ?? '');
  const audit = auditOpeningDigestArticle({
    article: body,
    research: input.research || [],
    asOf: input.asOf ? new Date(input.asOf) : new Date(),
    requireFreshSources: Boolean(input.requireFreshSources),
  });
  return {
    errors: [...audit.warnings],
    warnings: [],
    details: {
      catalystCount: audit.catalystCount,
      catalystWordCounts: audit.catalystWordCounts,
      marketReadWordCount: audit.marketReadWordCount,
      marketReadSentenceCount: audit.marketReadSentenceCount,
      earningsPresent: audit.earningsPresent,
    },
  };
}
