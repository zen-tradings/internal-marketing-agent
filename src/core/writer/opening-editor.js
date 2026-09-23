import { referenceUrlKey } from '../analysis-v2.js';
import { auditOpeningDigestInsight, buildOpeningDigestPlanningPrompt, normalizeOpeningDigestPlan } from '../../lib/opening-digest-editorial.js';
import { compactOpeningDigestArticle, OPENING_DIGEST_CATALYST_MAX_WORDS, OPENING_DIGEST_MARKET_READ_MAX_SENTENCES, OPENING_DIGEST_MARKET_READ_MAX_WORDS, OPENING_DIGEST_MARKET_READ_MIN_SENTENCES } from '../../lib/opening-digest-content.js';
import { completeReviewJson } from './model-client.js';
import { extractArticleUrls, sourceExcerptLimitFor, normalizeArticle, hasTitleFrontmatter } from './shared.js';
import { describeFetchError } from '../../lib/fetch-retry.js';

export const OPENING_SEVERE_CATEGORIES = new Set([
  'core_fact_contradiction', 'fabricated_number_or_date', 'wrong_link',
  'unsupported_core_causality', 'wrong_entity_classification', 'release_status_error',
]);

export async function refineOpeningDigestDraft({ article, research, workflow, writer, fetchFn, extraWarnings = [], attributionRepair = false }) {
  const before = auditOpeningDigestInsight(article);
  const warnings = [...new Set([...before.warnings, ...extraWarnings])];
  if (!warnings.length) return { article, trace: { attempted: false, before, after: before, applied: false, extraWarnings: [] } };
  try {
    const selected = openingCompactionSources(research, article);
    const response = await completeReviewJson({
      prompt: `Repair only the structural and analytical-quality issues in this Zen Opening Digest. Keep the same evidence-bound viewpoint and causal strength. Do not add facts, causes, numbers, tickers, dates, times, URLs, expectations, market levels, or advice. Preserve every existing URL and immutable token. You may delete an unsupported or conflicting assertion instead of rewriting it. Return strict JSON {"revised_markdown":"complete Markdown with frontmatter"}.\n\nIssues:${JSON.stringify(warnings)}\n\nAllowed sources:${JSON.stringify(selected)}\n\nDraft:\n${article}`,
      model: writer.reviewModel || writer.model,
      writer: { ...writer, temperature: 0 },
      fetchFn,
      timeoutMs: workflow.timeoutMs,
      systemPrompt: 'You are a conservative financial structure editor. Preserve evidence and uncertainty. Return valid JSON only.',
      retryInstruction: 'Return one valid JSON object containing revised_markdown only.',
    });
    const candidate = normalizeArticle(response.revised_markdown || '');
    if (!hasTitleFrontmatter(candidate)) throw new Error('refinement omitted frontmatter');
    const evidenceBoundaryRepair = before.warnings.some((warning) => /OIC\/IV|期权方向/.test(warning));
    const truncatedRecovery = before.stats.narrativeWords < 150
      && (before.stats.mattersCount < 2 || before.stats.observableSignpostCount < 3);
    if (attributionRepair) {
      // Attribution repair may delete flagged assertions (and their numbers/times) but must
      // never add a token and must keep every remaining URL exactly.
      const attributionIssues = attributionInvariantIssues(article, candidate);
      if (attributionIssues.length) throw new Error(attributionIssues.join('; '));
      if (candidate === article) throw new Error('refinement did not change the draft');
    } else if (!truncatedRecovery && !evidenceBoundaryRepair
      && JSON.stringify(openingDraftInvariantSignature(article)) !== JSON.stringify(openingDraftInvariantSignature(candidate))) {
      throw new Error('refinement changed URLs, numbers, tickers, dates, or times');
    }
    const allowedUrls = new Set(research.filter((source) => source?.url).map((source) => referenceUrlKey(source.url)));
    const candidateUrlKeys = new Set(extractArticleUrls(candidate).map(referenceUrlKey));
    const missingUrls = extractArticleUrls(article).filter((url) => !candidateUrlKeys.has(referenceUrlKey(url)));
    const unfamiliarUrls = extractArticleUrls(candidate).filter((url) => !allowedUrls.has(referenceUrlKey(url)));
    if (missingUrls.length && !attributionRepair) throw new Error(`refinement removed existing URLs:${missingUrls.join(', ')}`);
    if (unfamiliarUrls.length) throw new Error(`refinement added unapproved URLs:${unfamiliarUrls.join(', ')}`);
    const after = auditOpeningDigestInsight(candidate);
    if (after.warnings.length > before.warnings.length) throw new Error('refinement introduced new structural issues');
    if (!attributionRepair && after.warnings.length === before.warnings.length) {
      throw new Error('refinement did not reduce quality issues');
    }
    return { article: candidate, trace: { attempted: true, applied: true, before, after, extraWarnings } };
  } catch (error) {
    return { article, trace: { attempted: true, applied: false, before, after: before, diagnostic: describeFetchError(error).slice(0, 500), extraWarnings } };
  }
}

// Attribution repair relaxes the strict invariant: it may delete flagged assertions together
// with their numbers, tickers, and times, but may never add a token not present in the draft.
export function attributionInvariantIssues(original, candidate) {
  const issues = [];
  const count = (items) => items.reduce((map, item) => {
    map.set(item, (map.get(item) || 0) + 1);
    return map;
  }, new Map());
  const assertSubset = (originalItems, candidateItems, label) => {
    const counts = count(originalItems);
    for (const item of candidateItems) {
      const remaining = counts.get(item) || 0;
      if (remaining <= 0) issues.push(`attribution refinement added ${label}:${item}`);
      else counts.set(item, remaining - 1);
    }
  };
  const before = openingDraftInvariantSignature(original);
  const after = openingDraftInvariantSignature(candidate);
  assertSubset(before.urls, after.urls, 'URLs');
  assertSubset(before.numbers, after.numbers, 'numbers');
  assertSubset(before.tickers, after.tickers, 'tickers');
  assertSubset(before.times, after.times, 'times');
  return issues;
}

export function openingDraftInvariantSignature(value) {
  const text = String(value || '');
  return {
    urls: extractArticleUrls(text),
    numbers: text.match(/(?<![A-Za-z0-9])(?:[$€£¥]\s*)?[-+]?\d+(?:[,.]\d+)*(?:%|‰)?/g) || [],
    tickers: text.match(/\b[A-Z]{2,6}\b/g) || [],
    times: text.match(/\b\d{1,2}:\d{2}(?:\s*(?:a\.m\.|p\.m\.|AM|PM))?(?:\s+(?:ET|EST|EDT|PT|PST|PDT|UTC|GMT))?\b/gi) || [],
  };
}

export function normalizeOpeningDigestCitations(article, research = []) {
  const byUrl = new Map(research.filter((source) => source?.url).map((source) => [referenceUrlKey(source.url), source]));
  const linked = String(article || '').replace(/【(https?:\/\/[^】\s]+)】/g, (_match, url) => {
    const source = byUrl.get(referenceUrlKey(url));
    let label = 'Source';
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      if (host === 'finance.yahoo.com') label = 'Yahoo Finance';
      else if (host.includes('cnbc.com')) label = 'CNBC';
      else if (host.includes('reuters.com')) label = 'Reuters';
      else label = String(source?.title || host).replace(/[\[\]]/g, '').slice(0, 50) || 'Source';
    } catch {}
    return `([${label}](${url}))`;
  });
  return linked
    .replace(/^## Evidence and cross[‐‑‒–—−]currents\s*$/gmi, '## Evidence and cross-currents');
}

export async function planOpeningDigestEditorial({ research, editorialContext, history, asOf, model, writer, workflow, fetchFn }) {
  const raw = await completeReviewJson({
    prompt: buildOpeningDigestPlanningPrompt({
      research, editorialContext: editorialContext?.promptText || '', history, asOf,
    }),
    model,
    writer: { ...writer, temperature: 0 },
    fetchFn,
    timeoutMs: workflow.timeoutMs,
    systemPrompt: 'You are the planning editor of a concise institutional U.S. equity opening brief. Separate facts from judgments, test a contrary case, and return valid JSON only.',
    retryInstruction: 'Return one valid JSON object only. Use only the supplied source IDs and do not add commentary.',
  });
  return normalizeOpeningDigestPlan(raw, research, history);
}

export async function compactOpeningDigestEditorial({ article, research, workflow, writer, fetchFn }) {
  return compactOpeningDigestArticle({
    article,
    compactBlock: async ({ block, metrics, reasons }) => {
      const allowedSources = openingCompactionSources(research, block.text);
      const instruction = block.kind === 'catalyst'
        ? `Rewrite this single Markdown list item in no more than ${OPENING_DIGEST_CATALYST_MAX_WORDS} visible English words. Keep exactly one direct source link. Retain only the essential fact and its concise market implication; if it is a price-only item, retain only the timestamped price fact.`
        : `Rewrite this Market read as one paragraph of ${OPENING_DIGEST_MARKET_READ_MIN_SENTENCES} to ${OPENING_DIGEST_MARKET_READ_MAX_SENTENCES} sentences and no more than ${OPENING_DIGEST_MARKET_READ_MAX_WORDS} visible English words. Use an overview-details-optional synthesis structure: start with the overall interpretation, use the middle sentences for drivers, divergences, or validation conditions, and optionally end with a synthesis or invalidation condition.`;
      return completeReviewJson({
        prompt: `Compact exactly one Zen Opening Digest editorial block. ${instruction}

Do not add facts, causes, advice, emphasis, or certainty. Do not change or remove any URL, number, percentage, ticker, date, or time. Preserve the original causal strength. Return strict JSON only: {"revised_text":"the complete revised block"}.

Block kind: ${block.kind}
Current metrics: ${JSON.stringify(metrics)}
Repair reasons: ${JSON.stringify(reasons)}
Allowed sources: ${JSON.stringify(allowedSources)}
Original block:
${block.text}`,
        model: writer.reviewModel || writer.model,
        writer: { ...writer, temperature: 0 },
        fetchFn,
        timeoutMs: workflow.timeoutMs,
        systemPrompt: 'You are a concise financial copy editor. Preserve evidence, meaning, causal strength, and immutable tokens. Return valid JSON only.',
        retryInstruction: 'The previous response was not valid JSON. Return one syntactically valid JSON object only, with escaped newlines inside strings and no code fence or explanation.',
      });
    },
    verifyBlock: async ({ block, candidate, before, after }) => {
      const allowedSources = openingCompactionSources(research, block.text);
      const verification = await completeReviewJson({
        prompt: `Verify a compacted Zen Opening Digest block against the original and supplied sources. Approve only if the revision preserves every supported fact, qualification, and causal strength; adds no fact, cause, advice, emphasis, or certainty; and satisfies the requested editorial structure. For Market read, structure_valid requires one overview sentence followed by supporting detail sentences and an optional final synthesis or invalidation sentence. For a catalyst, structure_valid requires one concise Markdown list item with one direct source link.

Return strict JSON only:
{"approved":true,"preserves_meaning":true,"preserves_causal_strength":true,"structure_valid":true,"issues":[]}

Block kind: ${block.kind}
Before metrics: ${JSON.stringify(before)}
After metrics: ${JSON.stringify(after)}
Allowed sources: ${JSON.stringify(allowedSources)}
Original block:
${block.text}

Candidate block:
${candidate}`,
        model: writer.reviewModel || writer.model,
        writer: { ...writer, temperature: 0 },
        fetchFn,
        timeoutMs: workflow.timeoutMs,
        systemPrompt: 'You are a conservative financial copy verifier. Use only the original and supplied evidence. Return valid JSON only.',
        retryInstruction: 'The previous response was not valid JSON. Return one syntactically valid JSON object only, with escaped newlines inside strings and no code fence or explanation.',
      });
      const issues = Array.isArray(verification.issues)
        ? verification.issues.map((issue) => String(issue)).filter(Boolean)
        : [];
      const approved = verification.approved === true
        && verification.preserves_meaning === true
        && verification.preserves_causal_strength === true
        && verification.structure_valid === true;
      if (!approved && !issues.length) issues.push('semantic verification requirements were not all satisfied');
      return { approved, issues, summary: approved ? 'meaning, causal strength, and structure verified' : 'rejected' };
    },
  });
}

export function openingCompactionSources(research, blockText) {
  const linked = new Set(extractArticleUrls(blockText).map(referenceUrlKey));
  const sources = (Array.isArray(research) ? research : []).filter((source) => source?.url);
  const selected = linked.size
    ? sources.filter((source) => linked.has(referenceUrlKey(source.url)))
    : sources.slice(0, 12);
  return selected.slice(0, 12).map((source) => ({
    title: String(source.title || '').slice(0, 200),
    url: source.url,
    excerpt: [source.summary, source.text, ...(source.highlights || [])]
      .filter(Boolean).join('\n').slice(0, 700),
  }));
}

export async function reviewAndRepairOpeningDigest({ article, input, research, workflow, writer, fetchFn }) {
  const excerptLimit = sourceExcerptLimitFor(workflow);
  const allowed = research.filter((source) => source?.url).map((source) => ({
    title: source.title || '',
    url: source.url,
    publishedDate: source.publishedDate || '',
    excerpt: [source.summary, source.text, ...(source.highlights || [])]
      .filter(Boolean)
      .join('\n')
      .slice(0, excerptLimit),
  }));
  const auditPrompt = `Audit this Zen Opening Digest only against the supplied sources. Report ordinary weaknesses, but reserve a severe issue for a high-confidence error that changes a core conclusion and has specific source evidence. Severe categories are only core_fact_contradiction, fabricated_number_or_date, wrong_link, unsupported_core_causality, wrong_entity_classification, and release_status_error. Do not treat structure, catalyst count, freshness, duplicate links, missing publication dates, style, or weak sourcing as severe.\n\nReturn strict JSON:\n{"issues":[{"category":"...","confidence":"high|medium|low","core":true|false,"claim":"exact problematic text","evidence":"specific source evidence","source_url":"allowed source URL","message":"short explanation"}],"revised_markdown":"complete repaired Markdown when severe issues exist, otherwise empty"}\n\nTask:${input}\n\nAllowed sources:${JSON.stringify(allowed)}\n\nDraft:\n${article}`;
  let initial;
  try {
    initial = await completeReviewJson({
      prompt: auditPrompt,
      model: writer.reviewModel || writer.model,
      writer: { ...writer, temperature: 0 },
      fetchFn,
      timeoutMs: workflow.timeoutMs,
      systemPrompt: 'You are a financial fact auditor. Use only supplied evidence and return valid JSON.',
    });
  } catch (error) {
    return {
      article,
      review: { approved: true, policy: 'severe-only', skipped: true, diagnostic: error.message },
    };
  }

  let issues = normalizeOpeningReviewIssues(initial.issues);
  let severe = severeOpeningIssues(issues, allowed);
  if (!severe.length) {
    return { article, review: { approved: true, policy: 'severe-only', issues, severeIssues: [] } };
  }

  const initialIssues = issues;
  const initialSevere = severe;
  let current = normalizeArticle(initial.revised_markdown || '');
  const verificationHistory = [];
  const hardFailure = (errorOrMessage) => {
    const error = errorOrMessage?.openingDigestHardFailure
      ? errorOrMessage
      : openingDigestHardError(String(errorOrMessage?.message || errorOrMessage));
    error.openingDigestFactReview = {
      approved: false,
      policy: 'severe-only',
      issues: initialIssues,
      severeIssues: initialSevere,
      repaired: current !== article,
      verificationHistory,
      unresolvedSevereIssues: severe,
    };
    return error;
  };
  for (let round = 0; round < 2; round++) {
    if (!hasTitleFrontmatter(current)) {
      try {
        current = await repairOpeningDigestSevereIssues({
          article: round === 0 ? article : current,
          severe,
          allowed,
          workflow,
          writer,
          fetchFn,
        });
      } catch (error) {
        throw hardFailure(error);
      }
    }
    if (!hasTitleFrontmatter(current)) {
      throw hardFailure('严重事实修复稿缺少 title frontmatter');
    }
    let verification;
    try {
      verification = await completeReviewJson({
        prompt: `Verify whether every previously severe issue is fixed. Only report an issue as severe when it remains high-confidence, affects a core conclusion, quotes the problematic claim, and cites specific evidence from an allowed source. Return strict JSON {"issues":[{"category":"core_fact_contradiction|fabricated_number_or_date|wrong_link|unsupported_core_causality|wrong_entity_classification|release_status_error","confidence":"high|medium|low","core":true|false,"claim":"...","evidence":"...","source_url":"...","message":"..."}]}.\n\nPrevious severe issues:${JSON.stringify(severe)}\n\nAllowed sources:${JSON.stringify(allowed)}\n\nRevised draft:\n${current}`,
        model: writer.reviewModel || writer.model,
        writer: { ...writer, temperature: 0 },
        fetchFn,
        timeoutMs: workflow.timeoutMs,
        systemPrompt: 'You are a financial fact verifier. Use only supplied evidence and return valid JSON.',
      });
    } catch (error) {
      throw hardFailure(`已发现严重事实问题，但修复复核失败:${error.message}`);
    }
    issues = normalizeOpeningReviewIssues(verification.issues);
    const dismissedStaleIssues = staleSupportedOpeningIssues(issues, severe);
    const dismissed = new Set(dismissedStaleIssues);
    severe = severeOpeningIssues(issues.filter((issue) => !dismissed.has(issue)), allowed);
    verificationHistory.push({ round: round + 1, issues, dismissedStaleIssues, severeIssues: severe });
    if (!severe.length) {
      return {
        article: current,
        review: {
          approved: true,
          policy: 'severe-only',
          issues: initialIssues,
          severeIssues: initialSevere,
          repaired: true,
          verificationHistory,
        },
      };
    }
    if (round === 0) {
      try {
        current = await repairOpeningDigestSevereIssues({
          article: current,
          severe,
          allowed,
          workflow,
          writer,
          fetchFn,
        });
      } catch (error) {
        throw hardFailure(error);
      }
    }
  }
  throw hardFailure(`Opening Digest 严重事实问题修复后仍未通过:${severe.map((issue) => issue.message || issue.claim).join('; ')}`);
}

export async function repairOpeningDigestSevereIssues({ article, severe, allowed, workflow, writer, fetchFn }) {
  let repair;
  try {
    repair = await completeReviewJson({
      prompt: `Repair only the listed severe issues. Do not change unrelated structure or viewpoints and do not add facts. Return strict JSON {"revised_markdown":"complete Markdown with the original frontmatter"}.\n\nSevere issues:${JSON.stringify(severe)}\n\nAllowed sources:${JSON.stringify(allowed)}\n\nDraft:\n${article}`,
      model: writer.reviewModel || writer.model,
      writer: { ...writer, temperature: 0 },
      fetchFn,
      timeoutMs: workflow.timeoutMs,
      systemPrompt: 'You are a financial fact repair editor. Use only supplied evidence and return valid JSON.',
    });
  } catch (error) {
    throw openingDigestHardError(`已发现严重事实问题，但自动修复失败:${error.message}`);
  }
  return normalizeArticle(repair.revised_markdown || '');
}

export function normalizeOpeningReviewIssues(value) {
  return (Array.isArray(value) ? value : []).map((issue) => typeof issue === 'object' && issue
    ? {
        category: String(issue.category || '').trim().toLowerCase(),
        confidence: String(issue.confidence || '').trim().toLowerCase(),
        core: issue.core === true,
        claim: String(issue.claim || '').trim(),
        evidence: String(issue.evidence || '').trim(),
        sourceUrl: String(issue.source_url || issue.sourceUrl || '').trim(),
        message: String(issue.message || '').trim(),
      }
    : { category: '', confidence: '', core: false, claim: '', evidence: '', sourceUrl: '', message: String(issue || '') });
}

export function severeOpeningIssues(issues, allowed) {
  const allowedUrls = new Set(allowed.map((source) => referenceUrlKey(source.url)));
  return issues.filter((issue) => OPENING_SEVERE_CATEGORIES.has(issue.category)
    && issue.confidence === 'high'
    && issue.core === true
    && issue.claim.length >= 4
    && issue.evidence.length >= 4
    && allowedUrls.has(referenceUrlKey(issue.sourceUrl)));
}

export function staleSupportedOpeningIssues(issues, previousSevere) {
  return issues.filter((issue) => (previousSevere || []).some((previous) => {
    if (!issue.claim || !previous.claim || issue.claim === previous.claim
      || referenceUrlKey(issue.sourceUrl) !== referenceUrlKey(previous.sourceUrl)
      || !previous.claim.includes(issue.claim)) return false;
    const explanation = [issue.message, issue.evidence].find((value) => /\b(?:but|however)\b/i.test(value || '')) || '';
    const [supported = '', unsupported = ''] = explanation.split(/\b(?:but|however)\b/i, 2);
    if (!/\b(?:supported|sourced|reasonable rounding)\b/i.test(supported)
      || /\b(?:not supported|not sourced|not found|unsupported|no source)\b/i.test(supported)
      || !/\b(?:not supported|not sourced|not found|unsupported|no source|does not|doesn't)\b/i.test(unsupported)) return false;
    const claimNumbers = reviewNumericTokens(issue.claim);
    if (!claimNumbers.length) return false;
    const supportedNumbers = new Set(reviewNumericTokens(supported));
    const unsupportedNumbers = new Set(reviewNumericTokens(unsupported));
    return claimNumbers.every((token) => supportedNumbers.has(token) && !unsupportedNumbers.has(token));
  }));
}

export function reviewNumericTokens(value) {
  return (String(value || '').match(/(?<![A-Za-z0-9])[-+]?[$€£¥]?\d+(?:[,.]\d+)*(?:%|‰)?/g) || [])
    .map((token) => token.replace(/[$€£¥,%‰]/g, '').replace(/^\+/, ''));
}

export function openingDigestHardError(message) {
  const error = new Error(message);
  error.stage = 'gate';
  error.openingDigestHardFailure = true;
  return error;
}
