import { openingDigestBodyParts } from './opening-digest-editorial.js';

// Deterministic attribution audit for the Opening Digest. Every finding is a warning that
// feeds the existing refine/repair round; none of them hard-fails an edition.
//
// Four checks, all grounded in data already supplied to the writer:
// 1. Snapshot consistency: a narrative statement about a snapshot variable that conflicts
//    with the injected attribution snapshot and carries no earlier-time label.
// 2. Temporal discipline (rule-based, no calendar of record): an upcoming-framed same-day
//    event time must carry a source link and must not already be in the past at asOf.
// 3. Causal strength: strong causal verbs or market-structure assertions (absent buyers,
//    flows) without a source link in the same sentence.
// 4. Comparison basis: "surpassed/outpaced X" claims without a supplied comparable basis.

const VARIABLE_RULES = [
  { key: 'WTI', match: /\b(?:oil|crude|wti|brent)\b/i },
  { key: '10Y UST', match: /\b(?:10-year|ten-year|treasury yields?|long[- ]end (?:yields?|rates?)|bond yields?)\b/i },
  { key: 'DXY', match: /\b(?:dollar|dxy)\b/i },
  { key: 'SPY', match: /\bS&P\b/i },
  { key: 'QQQ', match: /\bNasdaq\b/i },
  { key: 'VIX', match: /\b(?:VIX|volatility index)\b/i },
];

const UP_RE = /\b(?:rose|rallied|rebound(?:ed|ing)?|climbed|gained|jumped|advanced|strengthened|higher|trimmed (?:its |their )?losses|pared (?:its |their )?losses)\b/i;
const DOWN_RE = /\b(?:fell|dropped|declined|slid|slipped|retreated|weakened|tumbled|lower|pulled back|gave up|trimmed (?:its |their )?gains|pared (?:its |their )?gains)\b/i;
const EARLIER_TIME_RE = /\b(?:premarket|pre-market|overnight|in early (?:trading|dealings)|before the (?:open|bell)|at \d{1,2}(?::\d{2})?\s*(?:a\.m\.|p\.m\.)(?:\s*ET)?|by \d{1,2}(?::\d{2})?\s*(?:a\.m\.|p\.m\.)(?:\s*ET)?)\b/i;
const UPCOMING_RE = /\b(?:will|set to|due to|scheduled to|expected to|is set for|is due at)\b[^.]{0,60}\b(?:release|publish|report|announce|speak|testify|present|deliver|open|begin|offer|provide|show|give|land|arrive|drop)\b|\b(?:due|scheduled) (?:at|for|by) \d{1,2}(?::\d{2})?\s*(?:a\.m\.|p\.m\.)|\bwatch (?:for )?[^.]{0,60}\d{1,2}:\d{2}\s*(?:a\.m\.|p\.m\.)/i;
const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.m\.|p\.m\.)(?:\s*ET)?\b/gi;
const DIRECT_CAUSAL_RE = /\bdirectly\s+(?:support(?:s|ed)?|caus(?:e|es|ed|ing)|driv(?:e|es|en)|boost(?:s|ed)?|lift(?:s|ed)?)\b/i;
const BUYER_FLOW_RE = /\b(?:lacks?|lack of|absen(?:t|ce of)|exhaust(?:ed|ion)|no new|without|running out of)\s+(?:incremental\s+)?(?:buyers?|bids?|demand)|(?:buyers?|bids?)\s+(?:are|is|have been|were)\s*(?:absent|exhausted|missing)|no incremental buyers/i;
const SURPASS_RE = /\b(?:surpass(?:es|ed)?|outpac(?:es|ed)|exceed(?:s|ed)?|overtook|overtak(?:en|ing))\b/i;
const COMPARABLE_BASIS_RE = /\b(?:comparabl|same (?:initial )?(?:launch )?window|first \d+ days?|initial \d+|during its first|launch window|comparable period)\b/i;
const PERCENT_RE = /(-?\d+(?:\.\d+)?)\s*%/;
// Do not split a sentence right after a.m./p.m.; those periods are part of a timestamp.
// A lookbehind alone is defeated by backtracking (\s* can match empty), so neutralize the
// meridiem tokens before splitting and restore them afterwards.
const SENTENCE_SPLIT_RE = /\s*(?<=[.!?])\s+(?=[A-Z0-9*#-])/;

export function splitSentences(text) {
  return String(text)
    .replace(/\b([ap])\.m\./gi, (_match, letter) => letter.toLowerCase() === 'a' ? '⟦ZENAM⟧' : '⟦ZENPM⟧')
    .split(SENTENCE_SPLIT_RE)
    .map((part) => part.replaceAll('⟦ZENAM⟧', 'a.m.').replaceAll('⟦ZENPM⟧', 'p.m.'));
}

export function auditOpeningDigestAttribution({ article, snapshot = null, asOf = new Date() } = {}) {
  const warnings = [];
  const { lead, sections } = openingDigestBodyParts(article);
  const narrative = [lead, sections.get('What matters today') || '', sections.get('Evidence and cross-currents') || '', sections.get('What to watch') || '']
    .filter(Boolean).join('\n\n');
  const metrics = new Map((snapshot?.metrics || [])
    .filter((metric) => !metric.unavailable && Number.isFinite(metric.changePct))
    .map((metric) => [metric.key || metric.label, metric]));
  const asOfMinutes = easternMinutes(asOf);
  const stats = { sentenceCount: 0, snapshotConflicts: 0, temporalIssues: 0, causalStrengthIssues: 0, comparisonBasisIssues: 0 };
  if (!narrative.trim()) return { warnings, stats };
  for (const raw of narrative.split(/\n+/)) {
    for (const sentence of splitSentences(raw)) {
      const trimmed = String(sentence || '').trim();
      if (trimmed.length < 12) continue;
      stats.sentenceCount += 1;
      const hasLink = /\]\(https?:\/\//.test(sentence);
      const hasEarlierLabel = EARLIER_TIME_RE.test(sentence);
      for (const rule of VARIABLE_RULES) {
        if (!rule.match.test(sentence)) continue;
        const metric = metrics.get(rule.key);
        if (metric) {
          const direction = sentenceDirection(sentence);
          if (direction !== 'none' && !hasEarlierLabel) {
            const snapshotUp = Number(metric.changePct) >= 0;
            if ((direction === 'up') !== snapshotUp) {
              stats.snapshotConflicts += 1;
              warnings.push(`归因冲突:正文对 ${metric.label} 的方向与 ${snapshot?.capturedAt || '快照'} 时点快照(${signedPct(metric.changePct)})不一致,且未标注更早观察时点:${trimmed}`);
            }
          }
          const percent = PERCENT_RE.exec(sentence);
          if (percent && !hasEarlierLabel) {
            const value = Number(percent[1]);
            if (Number.isFinite(value) && Math.sign(value) !== 0
              && Math.sign(value) !== Math.sign(metric.changePct)) {
              stats.snapshotConflicts += 1;
              warnings.push(`归因冲突:正文引用 ${metric.label} 变动 ${value}% 与快照 ${signedPct(metric.changePct)} 相反:${trimmed}`);
            }
          }
          if (!hasLink && PERCENT_RE.test(sentence)) {
            stats.causalStrengthIssues += 1;
            warnings.push(`归因无源:正文对 ${metric.label} 引用变动数值但句内无来源链接:${trimmed}`);
          }
        }
      }
      if (UPCOMING_RE.test(sentence)) {
        for (const match of sentence.matchAll(TIME_RE)) {
          const minutes = timeToMinutes(match[1], match[2], match[3]);
          if (!Number.isFinite(minutes)) continue;
          if (!hasLink) {
            stats.temporalIssues += 1;
            warnings.push(`时间无源:正文以将来时引用当日 ${match[0]} 事件但句内无来源链接:${trimmed}`);
          } else if (Number.isFinite(asOfMinutes) && minutes <= asOfMinutes) {
            stats.temporalIssues += 1;
            warnings.push(`时态违规:正文在 ${asOfETLabel(asOfMinutes)} 之后仍以将来时描述 ${match[0]} 事件:${trimmed}`);
          }
        }
      }
      if ((DIRECT_CAUSAL_RE.test(sentence) || BUYER_FLOW_RE.test(sentence)) && !hasLink) {
        stats.causalStrengthIssues += 1;
        warnings.push(`因果强度:强因果或买盘/流动性断言缺少来源链接:${trimmed}`);
      }
      if (SURPASS_RE.test(sentence) && !hasLink && !COMPARABLE_BASIS_RE.test(sentence)) {
        stats.comparisonBasisIssues += 1;
        warnings.push(`口径缺失:超越性比较缺少可比口径限定:${trimmed}`);
      }
    }
  }
  return { warnings, stats };
}

function sentenceDirection(sentence) {
  const up = UP_RE.test(sentence);
  const down = DOWN_RE.test(sentence);
  if (up === down) return 'none';
  return up ? 'up' : 'down';
}

function timeToMinutes(hourText, minuteText, meridiem) {
  let hour = Number(hourText);
  const minute = Number(minuteText || 0);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 1 || hour > 12) return NaN;
  const suffix = String(meridiem || '').toLowerCase();
  if (suffix === 'p.m.' && hour !== 12) hour += 12;
  if (suffix === 'a.m.' && hour === 12) hour = 0;
  return hour * 60 + minute;
}

function easternMinutes(date) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
    return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : NaN;
  } catch { return NaN; }
}

function asOfETLabel(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${hour}:${String(minute).padStart(2, '0')} ET`;
}

function signedPct(value) {
  return `${value >= 0 ? '+' : ''}${Number(value).toFixed(2)}%`;
}