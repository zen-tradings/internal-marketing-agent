const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
export const OPENING_DIGEST_STANCES = Object.freeze(['constructive', 'neutral', 'defensive']);
export const OPENING_DIGEST_CONFIDENCE = Object.freeze(['high', 'medium', 'low']);
export const OPENING_DIGEST_REQUIRED_HEADINGS = Object.freeze([
  'What matters today',
  'Evidence and cross-currents',
  'Scenario map',
  'What to watch',
]);
export const OPENING_DIGEST_HEADLINE_MAX_CHARS = 36;
export const OPENING_DIGEST_NARRATIVE_MAX_WORDS = 650;

export function openingDigestSourceIds(research = []) {
  return research.map((source, index) => ({ ...source, openingDigestSourceId: `OD${index + 1}` }));
}

export function openingDigestMarketPhase(asOf = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(asOf);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  if (['Sat', 'Sun'].includes(get('weekday'))) return 'off-session';
  if (minutes < 9 * 60 + 30) return 'premarket-test';
  if (minutes < 16 * 60) return 'cash-session';
  return 'after-hours-test';
}

export function openingDigestPhaseGuidance(asOf = new Date()) {
  const phase = openingDigestMarketPhase(asOf);
  if (phase === 'cash-session') return 'This run is during the U.S. cash session. The formal edition is normally produced around 10:15 a.m. ET; describe it as the opening hour, not premarket.';
  if (phase === 'premarket-test') return 'This is an off-cycle TEST before the U.S. cash open. Use premarket only for timestamped source observations, do not claim that the cash market has opened, and do not infer an opening-hour trend.';
  if (phase === 'after-hours-test') return 'This is an off-cycle TEST after the U.S. cash close. Label observations latest available and do not present them as a live opening-hour read.';
  return 'This is an off-session TEST. Label observations latest available and do not present them as a live opening-hour read.';
}

export function buildOpeningDigestPlanningPrompt({ research = [], editorialContext = '', history = [], asOf = new Date() } = {}) {
  const sources = research.map((source) => ({
    id: source.openingDigestSourceId,
    title: String(source.title || '').slice(0, 180),
    url: source.url || '',
    published_date: source.publishedDate || null,
    kind: source.openingDigestKind || 'open',
    official: Boolean(source.official),
    excerpt: [source.summary, ...(source.highlights || []), source.text].filter(Boolean).join('\n').slice(0, 1100),
  }));
  return `Plan one evidence-bound Zen Opening Digest for ${asOf.toISOString()}. ${openingDigestPhaseGuidance(asOf)}

Return strict JSON only:
{
  "dominant_theme":"one restrained market-level theme or no-dominant-signal",
  "stance":"constructive|neutral|defensive",
  "confidence":"high|medium|low",
  "materiality":{"breadth":"","surprise":"","persistence":"","evidence_strength":""},
  "priced_expectation":{"status":"supported|not_observed","text":"","source_ids":[]},
  "incremental_information":"",
  "supporting_evidence":[{"point":"","source_ids":[]}],
  "contrary_evidence":[{"point":"","source_ids":[]}],
  "transmission_chain":[{"from":"","to":"","mechanism":"","source_ids":[]}],
  "base_case":{"condition":"","expected_read":"","indicators":[],"source_ids":[]},
  "counter_case":{"condition":"","expected_read":"","indicators":[],"source_ids":[]},
  "signposts":[{"observable":"","source_ids":[]}],
  "selected_source_ids":[],
  "change_from_prior":{"changed":false,"summary":""},
  "headline_candidates":[""]
}

Rules:
- Rank materiality by broad-market reach, genuine surprise/increment, likely persistence, source strength, and freshness. A routine 5% tracked-stock move is not automatically the theme.
- Broad U.S. market drivers outrank sector drivers; sector drivers outrank isolated company moves.
- Check at least one plausible contrary explanation. If evidence conflicts, choose neutral and say there is no dominant signal.
- Facts, causal mechanisms, expectations, scenarios, and signposts must cite existing source_ids. Never invent a number, ticker, date, time, level, cause, market expectation, or data release result.
- If the supplied material does not observe what was priced, use priced_expectation.status=not_observed and leave text empty.
- OIC Top 20 data shows only observed option volume/IVX for names appearing in that table. It does not prove direction, investor intent, market breadth, or the cause of a price move.
- The fixed 72-name universe is not the whole market. Describe it only as tracked-universe participation or dispersion.
- Previous editions are context for detecting a change or stale repetition, never evidence for today's facts.
- Headlines must be specific, non-sensational, 4-7 English words, at most ${OPENING_DIGEST_HEADLINE_MAX_CHARS} characters, and must not overstate causality.
- Select at most 10 sources, including contrary evidence when available.

Previous formal editions (newest first):
${JSON.stringify(history.slice(0, 20))}

Structured market context:
${String(editorialContext || '').slice(0, 12000)}

Candidate sources:
${JSON.stringify(sources)}`;
}

export function normalizeOpeningDigestPlan(raw, research = [], history = []) {
  const ids = new Set(research.map((source) => source.openingDigestSourceId).filter(Boolean));
  const sourceIds = (value, limit = 6) => [...new Set((Array.isArray(value) ? value : []).map(String).filter((id) => ids.has(id)))].slice(0, limit);
  const evidence = (value, limit) => (Array.isArray(value) ? value : []).map((item) => ({
    point: clean(item?.point, 500), source_ids: sourceIds(item?.source_ids),
  })).filter((item) => item.point && item.source_ids.length).slice(0, limit);
  const scenario = (value) => ({
    condition: clean(value?.condition, 400),
    expected_read: clean(value?.expected_read, 400),
    indicators: cleanArray(value?.indicators, 5, 180),
    source_ids: sourceIds(value?.source_ids),
  });
  const selected = sourceIds(raw?.selected_source_ids, 10);
  const fallbackSelected = research
    .filter((source) => source?.url)
    .sort((left, right) => sourceRank(left) - sourceRank(right))
    .slice(0, 8)
    .map((source) => source.openingDigestSourceId);
  const prior = history[0];
  const stance = OPENING_DIGEST_STANCES.includes(String(raw?.stance).toLowerCase()) ? String(raw.stance).toLowerCase() : 'neutral';
  const confidence = OPENING_DIGEST_CONFIDENCE.includes(String(raw?.confidence).toLowerCase()) ? String(raw.confidence).toLowerCase() : 'low';
  return {
    dominant_theme: clean(raw?.dominant_theme, 300) || 'no-dominant-signal',
    stance,
    confidence,
    materiality: {
      breadth: clean(raw?.materiality?.breadth, 240),
      surprise: clean(raw?.materiality?.surprise, 240),
      persistence: clean(raw?.materiality?.persistence, 240),
      evidence_strength: clean(raw?.materiality?.evidence_strength, 240),
    },
    priced_expectation: raw?.priced_expectation?.status === 'supported'
      ? { status: 'supported', text: clean(raw.priced_expectation.text, 400), source_ids: sourceIds(raw.priced_expectation.source_ids) }
      : { status: 'not_observed', text: '', source_ids: [] },
    incremental_information: clean(raw?.incremental_information, 500),
    supporting_evidence: evidence(raw?.supporting_evidence, 5),
    contrary_evidence: evidence(raw?.contrary_evidence, 3),
    transmission_chain: (Array.isArray(raw?.transmission_chain) ? raw.transmission_chain : []).map((item) => ({
      from: clean(item?.from, 120), to: clean(item?.to, 120), mechanism: clean(item?.mechanism, 300), source_ids: sourceIds(item?.source_ids),
    })).filter((item) => item.from && item.to && item.mechanism && item.source_ids.length).slice(0, 4),
    base_case: scenario(raw?.base_case),
    counter_case: scenario(raw?.counter_case),
    signposts: (Array.isArray(raw?.signposts) ? raw.signposts : []).map((item) => ({
      observable: clean(item?.observable, 240), source_ids: sourceIds(item?.source_ids),
    })).filter((item) => item.observable && item.source_ids.length).slice(0, 5),
    selected_source_ids: selected.length ? selected : fallbackSelected,
    change_from_prior: {
      changed: raw?.change_from_prior?.changed === true,
      summary: clean(raw?.change_from_prior?.summary, 300) || (prior ? 'No material change from the prior edition.' : 'Initial baseline.'),
    },
    headline_candidates: cleanArray(raw?.headline_candidates, 3, OPENING_DIGEST_HEADLINE_MAX_CHARS)
      .filter((headline) => visibleWords(headline) >= 3),
  };
}

export function openingDigestSelectedResearch(research = [], plan) {
  const selected = new Set(plan?.selected_source_ids || []);
  const output = research.filter((source) => selected.has(source.openingDigestSourceId));
  return output.length ? output : research.slice(0, 8);
}

export function openingDigestPlanPromptText(plan) {
  return `【Opening Digest editorial plan】
This JSON is an evidence-selection and reasoning plan, not an additional factual source. Use only claims supported by the selected research URLs. If a planned statement is not supported by the supplied excerpt, omit it.
${JSON.stringify(plan)}`;
}

export function parseOpeningDigestMetadata(markdown) {
  const match = String(markdown || '').match(FRONTMATTER_RE);
  const meta = {};
  if (match) for (const line of match[1].split('\n')) {
    const pair = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (pair) meta[pair[1].toLowerCase()] = stripQuotes(pair[2].trim());
  }
  return {
    title: meta.title || '', headline: meta.headline || '', stance: String(meta.stance || '').toLowerCase(),
    confidence: String(meta.confidence || '').toLowerCase(), preheader: meta.preheader || '', edition: meta.edition || '',
  };
}

export function openingDigestBodyParts(markdown) {
  const body = String(markdown || '').replace(FRONTMATTER_RE, '').trim();
  const firstHeading = body.search(/^##\s+/m);
  const lead = (firstHeading < 0 ? body : body.slice(0, firstHeading)).trim();
  const sectionText = firstHeading < 0 ? '' : body.slice(firstHeading);
  const matches = [...sectionText.matchAll(/^##\s+(.+?)\s*$/gm)];
  const sections = new Map();
  matches.forEach((match, index) => {
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? sectionText.length;
    sections.set(match[1], sectionText.slice(start, end).trim());
  });
  return { body, lead, sections };
}

export function auditOpeningDigestInsight(markdown) {
  const warnings = [];
  const meta = parseOpeningDigestMetadata(markdown);
  const parts = openingDigestBodyParts(markdown);
  const headings = [...parts.sections.keys()];
  const expected = [...OPENING_DIGEST_REQUIRED_HEADINGS, ...(headings.includes('Earnings ahead') ? ['Earnings ahead'] : [])];
  if (meta.title !== 'Zen Opening Digest') warnings.push('Opening Digest 固定内容身份必须为 Zen Opening Digest');
  if (!meta.headline || meta.headline.length > OPENING_DIGEST_HEADLINE_MAX_CHARS || visibleWords(meta.headline) < 3) warnings.push('Opening Digest 动态标题应为 4-7 个词且不超过 36 字符');
  if (!OPENING_DIGEST_STANCES.includes(meta.stance)) warnings.push('Opening Digest stance 必须为 constructive、neutral 或 defensive');
  if (!OPENING_DIGEST_CONFIDENCE.includes(meta.confidence)) warnings.push('Opening Digest confidence 必须为 high、medium 或 low');
  if (JSON.stringify(headings) !== JSON.stringify(expected)) warnings.push(`Opening Digest 栏目顺序应为 ${expected.join(' → ')}`);
  const leadSentences = sentenceCount(parts.lead);
  if (leadSentences < 2 || leadSentences > 4) warnings.push(`Opening call 应为 2-4 句，当前 ${leadSentences} 句`);
  const matters = paragraphCount(parts.sections.get('What matters today'));
  if (matters < 2 || matters > 3) warnings.push(`What matters today 应为 2-3 个短段，当前 ${matters}`);
  const scenario = parts.sections.get('Scenario map') || '';
  if (!/^[-*]\s+\*\*Base case\s*[—-]/mi.test(scenario) || !/^[-*]\s+\*\*Counter-case\s*[—-]/mi.test(scenario)) warnings.push('Scenario map 必须同时包含 Base case 与 Counter-case');
  const watchCount = (parts.sections.get('What to watch')?.match(/^[-*]\s+/gm) || []).length;
  if (watchCount < 3 || watchCount > 5) warnings.push(`What to watch 应为 3-5 条，当前 ${watchCount}`);
  if (/\bUTC\b/i.test(parts.body)) warnings.push('Opening Digest 用户可见正文不得使用 UTC，应统一显示 ET');
  if (/\b(?:because|due to)\b[^.]{0,100}\b(?:option interest|options activity|IVX|implied volatility)\b|\b(?:option interest|options activity|IVX|implied volatility)\b[^.]{0,100}\b(?:drove|caused|pushed|lifted)\b/i.test(parts.body)) warnings.push('Opening Digest 不得用 OIC/IV 共现推断价格因果');
  if (/\btracked(?:-universe)?\b[^.]{0,40}\bmarket breadth\b/i.test(parts.body)) warnings.push('固定跟踪池不得冒充全市场 breadth');
  const narrativeWords = visibleWords(parts.body.replace(/^## Earnings ahead[\s\S]*$/m, ''));
  if (narrativeWords > OPENING_DIGEST_NARRATIVE_MAX_WORDS) warnings.push(`Opening Digest 分析正文超过 ${OPENING_DIGEST_NARRATIVE_MAX_WORDS} 词:${narrativeWords}`);
  return {
    warnings,
    stats: { headlineSpecific: !warnings.some((item) => item.includes('动态标题')), stance: meta.stance, confidence: meta.confidence, leadSentences, mattersCount: matters, scenarioComplete: !warnings.some((item) => item.includes('Scenario map')), observableSignpostCount: watchCount, narrativeWords },
  };
}

export function openingDigestEditorialState(markdown, plan = {}, runId = '') {
  const meta = parseOpeningDigestMetadata(markdown);
  const parts = openingDigestBodyParts(markdown);
  return {
    runId, sessionDate: meta.edition, headline: meta.headline, stance: meta.stance, confidence: meta.confidence,
    thesis: parts.lead.slice(0, 1200), changeSummary: plan?.change_from_prior?.summary || '',
    signposts: (plan?.signposts || []).map((item) => item.observable).filter(Boolean).slice(0, 5),
  };
}

function sourceRank(source) {
  if (source.openingDigestKind === 'market-news' || source.openingDigestKind === 'macro') return 0;
  if (source.official || source.priority) return 1;
  if (source.openingDigestKind === 'universe-news') return 2;
  if (source.openingDigestKind === 'universe-price') return 3;
  if (source.openingDigestKind === 'universe-iv') return 4;
  return 5;
}
function clean(value, max) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max); }
function cleanArray(value, limit, max) { return [...new Set((Array.isArray(value) ? value : []).map((item) => clean(item, max)).filter(Boolean))].slice(0, limit); }
function stripQuotes(value) { return String(value || '').replace(/^(['"])([\s\S]*)\1$/, '$2'); }
function visibleWords(value) { return (String(value || '').match(/[A-Za-z0-9][A-Za-z0-9'’./+%-]*/g) || []).length; }
function sentenceCount(value) { return (String(value || '').match(/[^.!?]+[.!?]+(?:\s|$)/g) || []).length; }
function paragraphCount(value) { return String(value || '').trim() ? String(value).trim().split(/\n\s*\n+/).filter(Boolean).length : 0; }
