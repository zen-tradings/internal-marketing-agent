// Metric A: citation grounding. Every URL cited in the article must exist in the allowed source set
// (research-trace selectedSources or an explicit allowlist). A URL outside the set is a fabricated
// link — the highest-severity silent failure.

import { extractArticleUrls } from '../../core/runner.js';

export function normalizeUrlKey(url) {
  let value = String(url || '').trim().toLowerCase();
  value = value.replace(/^https?:\/\//, '').replace(/^www\./, '');
  value = value.replace(/[#?].*$/, '');
  value = value.replace(/\/+$/, '');
  return value;
}

export function checkCitations(input, expect = {}, { article, allowedUrls } = {}) {
  const errors = [];
  const warnings = [];
  const body = String(article ?? input.article ?? '');
  const allowed = new Set((allowedUrls ?? input.allowedUrls ?? []).map(normalizeUrlKey).filter(Boolean));
  const articleUrls = extractArticleUrls(body);
  const unmatched = [];
  const matched = [];
  for (const url of articleUrls) {
    const key = normalizeUrlKey(url);
    if (allowed.has(key)) matched.push(url);
    else unmatched.push(url);
  }
  for (const url of unmatched) {
    errors.push(`cited URL is not in the allowed source set (possible fabrication): ${url}`);
  }
  if (!articleUrls.length && expect.minCitations !== 0) {
    warnings.push('article contains no citations');
  }
  if (expect.minCitations !== undefined && matched.length < expect.minCitations) {
    errors.push(`only ${matched.length} grounded citation(s), expected at least ${expect.minCitations}`);
  }
  return {
    errors,
    warnings,
    details: { articleUrlCount: articleUrls.length, matchedCount: matched.length, unmatched },
  };
}
