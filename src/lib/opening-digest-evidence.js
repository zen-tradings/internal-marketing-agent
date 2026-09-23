import { openingDigestBodyParts } from './opening-digest-editorial.js';

// Deterministic evidence ledger for the Opening Digest. Extracts, for every narrative
// sentence, the supplied sources it links to, the evidence grade of those sources, and any
// attribution-snapshot values it references. No model calls; pure sentence-to-evidence mapping
// for manual review alongside the frozen editorial plan.

// Do not split a sentence right after a.m./p.m.; those periods are part of a timestamp.
// A lookbehind alone is defeated by backtracking (\s* can match empty), so neutralize the
// meridiem tokens before splitting and restore them afterwards.
const SENTENCE_SPLIT_RE = /\s*(?<=[.!?])\s+(?=[A-Z0-9*#-])/;

function splitSentences(text) {
  return String(text)
    .replace(/\b([ap])\.m\./gi, (_match, letter) => letter.toLowerCase() === 'a' ? '⟦ZENAM⟧' : '⟦ZENPM⟧')
    .split(SENTENCE_SPLIT_RE)
    .map((part) => part.replaceAll('⟦ZENAM⟧', 'a.m.').replaceAll('⟦ZENPM⟧', 'p.m.'));
}
const CLAIM_MAX_CHARS = 320;

export function buildOpeningDigestEvidenceLedger({ article, research = [], snapshot = null, plan = null } = {}) {
  const { lead, sections } = openingDigestBodyParts(article);
  const blocks = [
    ['lead', lead],
    ['What matters today', sections.get('What matters today') || ''],
    ['Evidence and cross-currents', sections.get('Evidence and cross-currents') || ''],
    ['What to watch', sections.get('What to watch') || ''],
  ];
  const byUrl = new Map(research
    .filter((source) => source?.url)
    .map((source) => [normalizeEvidenceUrl(source.url), source]));
  const snapshotByLabel = new Map((snapshot?.metrics || [])
    .filter((metric) => !metric.unavailable && Number.isFinite(metric.value))
    .map((metric) => [metric.label, metric]));
  const claims = [];
  const snapshotLabels = new Set();
  for (const [section, text] of blocks) {
    if (!text) continue;
    for (const raw of String(text).split(/\n+/)) {
      for (const sentence of splitSentences(raw)) {
        const trimmed = String(sentence || '').trim();
        if (trimmed.length < 12) continue;
        const urls = [...String(sentence).matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)]
          .map((match) => match[1]);
        const matchedSources = [...new Set(urls.map((url) => normalizeEvidenceUrl(url)))]
          .filter((key) => byUrl.has(key))
          .map((key) => byUrl.get(key));
        const snapshotRefs = [];
        for (const [label, metric] of snapshotByLabel) {
          if (String(sentence).includes(formatValue(metric.value))
            || (Number.isFinite(metric.changePct) && String(sentence).includes(formatPct(metric.changePct)))) {
            snapshotRefs.push({ label, value: metric.value, changePct: Number.isFinite(metric.changePct) ? metric.changePct : null, asOf: metric.asOf || null });
          }
        }
        snapshotRefs.forEach((ref) => snapshotLabels.add(ref.label));
        claims.push({
          section,
          claim: trimmed.slice(0, CLAIM_MAX_CHARS),
          source_urls: [...new Set(urls)],
          evidence_grade: evidenceGradeFor(matchedSources),
          snapshot_refs: snapshotRefs,
        });
      }
    }
  }
  return {
    plan: plan ? {
      dominant_theme: plan.dominant_theme || null,
      stance: plan.stance || null,
      confidence: plan.confidence || null,
      transmission_chain: plan.transmission_chain || [],
      supporting_evidence: plan.supporting_evidence || [],
      contrary_evidence: plan.contrary_evidence || [],
      signposts: plan.signposts || [],
    } : null,
    snapshot_captured_at: snapshot?.capturedAt || null,
    claims,
    summary: {
      claimCount: claims.length,
      linkedClaimCount: claims.filter((claim) => claim.source_urls.length).length,
      unlinkedClaimCount: claims.filter((claim) => !claim.source_urls.length).length,
      snapshotRefLabels: [...snapshotLabels].sort(),
    },
  };
}

export function openingDigestEvidenceSources(research = [], { excerptChars, writer = {} } = {}) {
  const regularMaxChars = Number.isFinite(excerptChars) && excerptChars >= 0
    ? Math.floor(excerptChars)
    : 2400;
  const userMaxChars = writer.exaUserContentMaxChars || 24000;
  return research.filter((source) => source?.url).map((source, index) => {
    const excerpt = [source.summary, source.text, ...(Array.isArray(source.highlights) ? source.highlights : [])]
      .filter(Boolean).join('\n');
    const maxChars = source.userSpecified ? userMaxChars : regularMaxChars;
    return {
      id: source.openingDigestSourceId || `OD${index + 1}`,
      title: String(source.title || '').slice(0, 200),
      url: source.url,
      publishedDate: source.publishedDate || null,
      kind: source.openingDigestKind || (source.official ? 'official' : source.priority ? 'priority' : 'open'),
      evidence_grade: evidenceGradeFor([source]),
      excerpt: excerpt.length > maxChars ? `${excerpt.slice(0, maxChars)}\n(原文过长已截断)` : excerpt,
    };
  });
}

export function evidenceGradeFor(sources = []) {
  if (!sources.length) return 'unlinked';
  if (sources.some((source) => source.official)) return 'official-data';
  if (sources.some((source) => source.openingDigestKind === 'universe-price')) return 'price-observation-only';
  if (sources.some((source) => source.priority || source.specialist || source.financialReport)) return 'wire-report';
  return 'market-commentary';
}

function normalizeEvidenceUrl(value) {
  try {
    const url = new URL(String(value));
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch { return String(value || '').trim(); }
}

function formatValue(value) {
  const digits = Number(value) >= 1000 ? 0 : 2;
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function formatPct(value) {
  return `${value >= 0 ? '+' : ''}${Number(value).toFixed(2)}%`;
}