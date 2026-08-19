// Metric A: contract gates. Frontmatter completeness, leak gate, rendered template marker,
// and (optionally) the full newsletter rubric — replayed via the same production gate code.

import { checkArticle, checkOutboundLeaks } from '../../lib/gate.js';
import { assertRenderedTemplateMarker } from '../../lib/draft-template.js';
import { evaluateNewsletter } from '../../lib/newsletter-eval.js';

export function checkGates(input, expect = {}, { markdown, html } = {}) {
  const errors = [];
  const warnings = [];
  const body = String(markdown ?? input.markdown ?? '');

  const article = checkArticle(body, {
    workflowMode: input.workflowMode || '',
    contentPolicy: input.contentPolicy || {},
  });
  errors.push(...article.errors);
  warnings.push(...article.warnings);

  const leaks = checkOutboundLeaks(body, { secretValues: input.secretValues || [] });
  for (const leak of leaks.errors) {
    if (!errors.includes(leak)) errors.push(leak);
  }

  const renderedHtml = html ?? input.html;
  if (input.templateId && renderedHtml !== undefined) {
    try { assertRenderedTemplateMarker(renderedHtml, input.templateId); }
    catch (error) { errors.push(String(error?.message || error)); }
  }

  if (input.newsletter) {
    const rubric = evaluateNewsletter(body, { edition: input.edition });
    for (const issue of rubric.issues) {
      const message = `newsletter/${issue.dimension}: ${issue.message}`;
      if (issue.severity === 'error') errors.push(message);
      else warnings.push(message);
    }
  }
  return { errors, warnings };
}
