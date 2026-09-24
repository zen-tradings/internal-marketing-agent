import { openingDigestBodyParts } from './opening-digest-editorial.js';
import { splitSentences } from './opening-digest-attribution.js';

// Deterministic numeric provenance and period-consistency audits for the Opening Digest.
// Both are pure functions over the article + already-supplied research excerpts; no model
// calls. They feed the severe-fact repair round as soft (repairable) findings and are always
// recorded in research-trace.json for manual review.
//
// 1. Number provenance: every precise decimal figure in a sentence with an inline link must
//    appear (with rounding tolerance) in a linked source excerpt or match a measured
//    attribution-snapshot value. Precise figures beyond a truncated excerpt are unverifiable
//    and skipped rather than flagged.
// 2. Period consistency: a "Month YYYY" dateline earlier than the current year must sit in an
//    explicit comparison context (since/highest/versus/from/...); otherwise it is likely a
//    prior-year release quoted as current-period data (the 2026-09-23 wrong-year PMI failure).

export const OPENING_DIGEST_PROVENANCE_MAX_EXCERPT_CHARS = 1100;
const SENTENCE_MIN_CHARS = 12;
const COMPARISON_WINDOW_CHARS = 90;

const MONTH_YEAR_RE = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b/g;
const COMPARISON_CONTEXT_RE = /(?:\b(?:since|highest|lowest|best|worst|strongest|weakest|from|versus|vs\.?|compared|earlier|prior|previous|ago|through|dating|back\s+to)\b[^.!?]{0,60})$/i;
const DECIMAL_NUMBER_RE = /-?\d+(?:\.\d+)?/g;

export function auditOpeningDigestNumberProvenance({
  article,
  research = [],
  snapshot = null,
  excerptBound = OPENING_DIGEST_PROVENANCE_MAX_EXCERPT_CHARS,
} = {}) {
  const warnings = [];
  const byUrl = new Map((Array.isArray(research) ? research : [])
    .filter((source) => source?.url)
    .map((source) => [normalizeProvenanceUrl(source.url), source]));
  const snapshotValues = snapshotNumbers(snapshot);
  const { lead, sections } = openingDigestBodyParts(article);
  const blocks = [
    ['lead', lead],
    ['What matters today', sections.get('What matters today') || ''],
    ['Evidence and cross-currents', sections.get('Evidence and cross-currents') || ''],
    ['What to watch', sections.get('What to watch') || ''],
  ];
  const stats = { checkedSentences: 0, unverifiableSentences: 0, unverifiedNumbers: 0 };
  for (const [, text] of blocks) {
    if (!text) continue;
    for (const raw of String(text).split(/\n+/)) {
      for (const sentence of splitSentences(raw)) {
        const trimmed = String(sentence || '').trim();
        if (trimmed.length < SENTENCE_MIN_CHARS) continue;
        const links = [...trimmed.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((match) => match[1]);
        if (!links.length) continue;
        const visible = visibleSentenceText(trimmed);
        const tokens = [...visible.matchAll(/\d+\.\d+/g)].map((match) => match[0])
          .filter((token) => !matchesSnapshotNumber(token, snapshotValues));
        if (!tokens.length) continue;
        stats.checkedSentences += 1;
        const excerpts = [...new Set(links)]
          .map((link) => byUrl.get(normalizeProvenanceUrl(link)))
          .filter(Boolean)
          .map((source) => [source.summary, source.text, ...(Array.isArray(source.highlights) ? source.highlights : [])]
            .filter(Boolean).join('\n'));
        if (!excerpts.length) continue;
        if (excerpts.some((excerpt) => excerpt.length > excerptBound)) {
          stats.unverifiableSentences += 1;
          continue;
        }
        const excerptNumberList = excerpts.flatMap(excerptNumbers);
        const missing = tokens.filter((token) => !matchesExcerptNumber(token, excerptNumberList));
        if (missing.length) {
          stats.unverifiedNumbers += missing.length;
          warnings.push(`数字无源:句内精确数字 ${missing.join('、')} 未出现在其链接来源摘录或归因快照中:${trimmed.slice(0, 200)}`);
        }
      }
    }
  }
  return { warnings, stats };
}

export function auditOpeningDigestPeriodConsistency({ article, asOf = new Date() } = {}) {
  const warnings = [];
  let currentYear;
  try {
    currentYear = Number(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric',
    }).format(asOf));
  } catch { currentYear = asOf.getUTCFullYear(); }
  if (!Number.isFinite(currentYear)) return { warnings, stats: { priorPeriodMentions: 0 } };
  const { lead, sections } = openingDigestBodyParts(article);
  const text = [lead, sections.get('What matters today') || '', sections.get('Evidence and cross-currents') || '', sections.get('What to watch') || '']
    .filter(Boolean).join('\n\n');
  let priorPeriodMentions = 0;
  for (const match of text.matchAll(MONTH_YEAR_RE)) {
    const year = Number(match[2]);
    if (!Number.isFinite(year) || year >= currentYear) continue;
    priorPeriodMentions += 1;
    const before = text.slice(Math.max(0, match.index - COMPARISON_WINDOW_CHARS, 0), match.index);
    if (COMPARISON_CONTEXT_RE.test(before)) continue;
    const context = text.slice(Math.max(0, match.index - 70), Math.min(text.length, match.index + match[0].length + 70))
      .replace(/\s+/g, ' ').trim();
    warnings.push(`疑似往年同期数据:正文引用 ${match[0]}，早于当前年份 ${currentYear}；若非明确的同期对比（from/versus/since），必须核对来源自身的发布年份:${context}`);
  }
  return { warnings, stats: { priorPeriodMentions, currentYear } };
}

function snapshotNumbers(snapshot) {
  const values = [];
  for (const metric of snapshot?.metrics || []) {
    if (Number.isFinite(metric.value)) values.push(Number(metric.value));
    if (Number.isFinite(metric.changePct)) values.push(Math.abs(Number(metric.changePct)));
  }
  return values;
}

// A sentence decimal matches the snapshot either as a level (|value - token| small) or as the
// magnitude of a snapshot day change.
function matchesSnapshotNumber(token, snapshotValues) {
  const value = Number(token.replaceAll(',', ''));
  if (!Number.isFinite(value)) return true;
  return snapshotValues.some((candidate) => Math.abs(candidate - value) <= 0.01);
}

function matchesExcerptNumber(token, excerptNumberList) {
  const value = Number(token.replaceAll(',', ''));
  if (!Number.isFinite(value)) return true;
  const decimals = (token.split('.')[1] || '').length;
  const tolerance = decimals > 0 ? Math.pow(10, -decimals) / 2 : 0.5;
  return excerptNumberList.some((candidate) => Math.abs(candidate - value) <= Math.max(tolerance, 0.001));
}

function excerptNumbers(excerpt) {
  return [...String(excerpt).replaceAll(',', '').matchAll(DECIMAL_NUMBER_RE)]
    .map((match) => Number(match[0]))
    .filter((value) => Number.isFinite(value));
}

function visibleSentenceText(sentence) {
  return String(sentence)
    .replace(/\]\((https?:\/\/[^)\s]+)\)/g, ' ')
    .replace(/https?:\/\/[^\s)>"']+/g, ' ');
}

function normalizeProvenanceUrl(value) {
  try {
    const url = new URL(String(value));
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch { return String(value || '').trim(); }
}