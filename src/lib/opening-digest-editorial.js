const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
export const OPENING_DIGEST_STANCES = Object.freeze(['constructive', 'neutral', 'defensive']);
export const OPENING_DIGEST_CONFIDENCE = Object.freeze(['high', 'medium', 'low']);
export const OPENING_DIGEST_REQUIRED_HEADINGS = Object.freeze([
  "Today's focus",
  'Evidence and cross-currents',
]);
export const OPENING_DIGEST_HEADLINE_MAX_CHARS = 70;
export const OPENING_DIGEST_HEADLINE_MIN_WORDS = 5;
export const OPENING_DIGEST_HEADLINE_MAX_WORDS = 12;
export const OPENING_DIGEST_EVIDENCE_MAX_WORDS = 85;
export const OPENING_DIGEST_FOCUS_MAX_WORDS = 100;
const ROUTINE_HEADLINE_RE = new RegExp([
  '\\b(?:oil|crude|wti|brent)\\b[^,;.]{0,24}\\b(?:rises?|falls?|gains?|drops?|jumps?|slides?|climbs?|slips?|edges?|extends?|steadies?)\\b',
  '\\byields?\\b[^,;.]{0,24}\\b(?:rises?|falls?|edges?|climbs?|slips?|drifts?|steadies?|holds?|little changed)\\b',
  '\\bstocks?(?:\\s+(?:index|futures))?\\b[^,;.]{0,24}\\b(?:rises?|falls?|gains?|drops?|slips?|climbs?|edges?)\\b',
].join('|'), 'i');
export const OPENING_DIGEST_NARRATIVE_MAX_WORDS = 650;

export function openingDigestWritingGuidance() {
  return `Keep the institutional research tone, necessary financial terminology, evidence qualifications, and uncertainty. Make the Opening call readable in one pass: at most two sentences in one paragraph, with an explicit subject and one main causal relationship per sentence. The first sentence states Constructive, Neutral, or Defensive and the primary support or constraint; the optional second states the most important counterweight or limitation. Avoid abstract noun stacks, metaphor, vague actors, and several unrelated drivers in one sentence. Do not simplify away causal qualifications or introduce trading instructions.
Use exactly these model-authored headings in this order: ## Today's focus, then ## Evidence and cross-currents. Earnings ahead is inserted separately later.
Today's focus merges the daily themes and signposts into 2-3 bullets. Begin each bullet with a bold judgment-led phrase, then briefly state its market implication and an observable confirmation or invalidation condition. Prioritize the dominant theme and the most material counterweight. Cover a source-reported major event within the next 48 hours when available, using an existing bullet or the third bullet. Target 70-100 visible English words in total (roughly 130-180 Chinese characters after translation), with a maximum of ${OPENING_DIGEST_FOCUS_MAX_WORDS}; shorter is fine when evidence is sparse. Never pad to reach a minimum word count or invent a secondary theme, condition, threshold, or event. Do not create separate What matters today or What to watch sections.
Evidence and cross-currents remains exactly two short paragraphs, together roughly 60-75 visible English words. Begin each with a bold judgment-led phrase. The first presents the strongest supporting evidence and its transmission mechanism; the second presents the strongest sourced contrary evidence or cross-current. Keep facts linked to supplied sources and separate facts from interpretation. Do not repeat the focus bullets or their watch conditions, add a third paragraph, or write a reconciling summary.
Keep the whole model-authored narrative within ${OPENING_DIGEST_NARRATIVE_MAX_WORDS} visible English words; there is no minimum total length. Do not move removed detail into another section to fill space.`;
}

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
  if (phase === 'cash-session') return 'This run is during the U.S. cash session. The formal edition is normally produced around 10:00 a.m. ET; describe it as the opening hour, not premarket.';
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
  "supporting_evidence":[{"point":"","evidence_grade":"official-data|wire-report|market-commentary|price-observation-only","observation_time":"ET timestamp of the observation or empty","source_ids":[]}],
  "contrary_evidence":[{"point":"","evidence_grade":"official-data|wire-report|market-commentary|price-observation-only","observation_time":"","source_ids":[]}],
  "transmission_chain":[{"from":"","to":"","mechanism":"","alternative_explanations":["plausible alternative readings that cannot yet be excluded"],"source_ids":[]}],
  "signposts":[{"observable":"","source_ids":[]}],
  "selected_source_ids":[],
  "change_from_prior":{"changed":false,"summary":""},
  "headline_candidates":[""]
}

Rules:
- Rank materiality by broad-market reach, genuine surprise/increment, likely persistence, source strength, and freshness. A routine 5% tracked-stock move is not automatically the theme.
- Broad U.S. market drivers outrank sector drivers; sector drivers outrank isolated company moves.
- Check at least one plausible contrary explanation. If evidence conflicts, choose neutral and say there is no dominant signal.
- Facts, causal mechanisms, expectations, contrary explanations, and signposts must cite existing source_ids. Never invent a number, ticker, date, time, level, cause, market expectation, or data release result. Do not create a scenario section or named base/counter scenarios.
- Grade every evidence item: official-data (a government agency, exchange, or issuer primary release), wire-report (independent wire/press reporting), market-commentary (analysis or quote from a strategist), or price-observation-only (a timestamped price with no accompanying explanation). Never upgrade a price observation into a causal grade.
- Record each evidence item's observation_time in ET when the source states one; leave it empty when the source does not state a time. When two supplied observations describe the same market variable at different times, both belong in the plan with their times, and the conflict must appear in contrary_evidence.
- Give each transmission_chain item at least one alternative_explanations entry unless the mechanism is backed by official data; an empty list is not allowed for wire-report or weaker grades.
- The structured attribution snapshot is a timestamped observation of the current market state. Plan the narrative around it: premarket or earlier source observations must be labeled as earlier in time, and a dominant theme that contradicts the snapshot must not be selected.
- Signposts must include at least one observable upcoming event scheduled within the next 48 hours when a supplied source reports one (macro data, policy decisions, summits, or trade talks); omit this only when no supplied source reports one.
- Plan 2-3 prioritized theme-and-signpost pairs for Today's focus: each judgment and its observable confirmation or invalidation must follow from the same supplied evidence. These merge the former theme and watch sections; do not select extra material just to fill space. Keep the strongest supporting and contrary evidence for Evidence and cross-currents, without repeating the full explanation in both sections.
- If the supplied material does not observe what was priced, use priced_expectation.status=not_observed and leave text empty.
- OIC Top 20 data shows only observed option volume/IVX for names appearing in that table. It does not prove direction, investor intent, market breadth, or the cause of a price move.
- The fixed 72-name universe is not the whole market. Describe it only as tracked-universe participation or dispersion.
- Previous editions are context for detecting a change or stale repetition, never evidence for today's facts.
- Before selecting a macro-release source, check its own release date and period. A prior-year or otherwise stale release page is never evidence for today's macro data; it may only support an explicit prior-period comparison.
- The headline must anchor today's single most market-moving or most distinctive development (a specific event, data release, policy decision, company result, or genuine surprise), like a senior sell-side strategist's daily note title: precise, restrained, and accurate. Accuracy always comes first: never add, stretch, or imply facts for the sake of clarity. Every candidate must also read as a natural, complete English sentence that a general financial reader understands in one pass — spell out what happened and to what; avoid telegraphic ellipsis, unexplained market jargon, metaphor, wordplay, and cryptic noun stacks. Do NOT use routine recurring daily moves as the headline subject — daily oil price gains or losses, day-to-day Treasury yield drift, or a generic index up/down day are forbidden. Exception: a genuine one-off event in oil or rates (for example an OPEC+ output decision, a CPI surprise, or an FOMC decision) may be named. Headlines must be non-sensational, ${OPENING_DIGEST_HEADLINE_MIN_WORDS}-${OPENING_DIGEST_HEADLINE_MAX_WORDS} English words, at most ${OPENING_DIGEST_HEADLINE_MAX_CHARS} characters, and must not overstate causality.
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
  const grades = new Set(['official-data', 'wire-report', 'market-commentary', 'price-observation-only']);
  const evidence = (value, limit) => (Array.isArray(value) ? value : []).map((item) => ({
    point: clean(item?.point, 500),
    evidence_grade: grades.has(String(item?.evidence_grade || '').toLowerCase())
      ? String(item.evidence_grade).toLowerCase()
      : 'wire-report',
    observation_time: clean(item?.observation_time, 40),
    source_ids: sourceIds(item?.source_ids),
  })).filter((item) => item.point && item.source_ids.length).slice(0, limit);
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
      from: clean(item?.from, 120), to: clean(item?.to, 120), mechanism: clean(item?.mechanism, 300),
      alternative_explanations: cleanArray(item?.alternative_explanations, 3, 240),
      source_ids: sourceIds(item?.source_ids),
    })).filter((item) => item.from && item.to && item.mechanism && item.source_ids.length).slice(0, 4),
    signposts: (Array.isArray(raw?.signposts) ? raw.signposts : []).map((item) => ({
      observable: clean(item?.observable, 240), source_ids: sourceIds(item?.source_ids),
    })).filter((item) => item.observable && item.source_ids.length).slice(0, 5),
    selected_source_ids: selected.length ? selected : fallbackSelected,
    change_from_prior: {
      changed: raw?.change_from_prior?.changed === true,
      summary: clean(raw?.change_from_prior?.summary, 300) || (prior ? 'No material change from the prior edition.' : 'Initial baseline.'),
    },
    headline_candidates: cleanArray(raw?.headline_candidates, 3, OPENING_DIGEST_HEADLINE_MAX_CHARS)
      .filter((headline) => visibleWords(headline) >= OPENING_DIGEST_HEADLINE_MIN_WORDS),
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

// Include both current and historical section names, in document order. Earnings are
// deterministically inserted and have their own checks; all authored analysis is audited.
export function openingDigestNarrativeBlocks(markdown) {
  const { lead, sections } = openingDigestBodyParts(markdown);
  return [['lead', lead], ...[...sections].filter(([heading]) => heading !== 'Earnings ahead')];
}

export function auditOpeningDigestInsight(markdown) {
  const warnings = [];
  const meta = parseOpeningDigestMetadata(markdown);
  const parts = openingDigestBodyParts(markdown);
  const headings = [...parts.sections.keys()];
  const expected = [...OPENING_DIGEST_REQUIRED_HEADINGS, ...(headings.includes('Earnings ahead') ? ['Earnings ahead'] : [])];
  if (meta.title !== 'Zen Opening Digest') warnings.push('Opening Digest 固定内容身份必须为 Zen Opening Digest');
  const headlineWords = visibleWords(meta.headline);
  if (!meta.headline || meta.headline.length > OPENING_DIGEST_HEADLINE_MAX_CHARS
    || headlineWords < OPENING_DIGEST_HEADLINE_MIN_WORDS || headlineWords > OPENING_DIGEST_HEADLINE_MAX_WORDS) {
    warnings.push(`Opening Digest 动态标题应为 ${OPENING_DIGEST_HEADLINE_MIN_WORDS}-${OPENING_DIGEST_HEADLINE_MAX_WORDS} 个词且不超过 ${OPENING_DIGEST_HEADLINE_MAX_CHARS} 字符`);
  }
  if (ROUTINE_HEADLINE_RE.test(meta.headline)) warnings.push('Opening Digest 动态标题疑似常规每日行情（油价/收益率/大盘涨跌），应为当天最重要或最有特点的事件');
  if (!OPENING_DIGEST_STANCES.includes(meta.stance)) warnings.push('Opening Digest stance 必须为 constructive、neutral 或 defensive');
  if (!OPENING_DIGEST_CONFIDENCE.includes(meta.confidence)) warnings.push('Opening Digest confidence 必须为 high、medium 或 low');
  if (JSON.stringify(headings) !== JSON.stringify(expected)) warnings.push(`Opening Digest 栏目顺序应为 ${expected.join(' → ')}`);
  const leadSentences = sentenceCount(parts.lead);
  if (leadSentences < 1 || leadSentences > 2) warnings.push(`Opening call 应为 1-2 句，当前 ${leadSentences} 句`);
  const focus = parts.sections.get("Today's focus") || '';
  const focusItems = focus.split('\n').map((line) => line.trim()).filter((line) => /^[-*]\s+/.test(line));
  const focusCount = focusItems.length;
  if (focusCount < 2 || focusCount > 3) warnings.push(`Today's focus 应为 2-3 条主线与验证条件，当前 ${focusCount}`);
  if (focus.split('\n').some((line) => line.trim() && !/^[-*]\s+/.test(line.trim()))) warnings.push("Today's focus 应只包含列表项");
  if (focusItems.some((item) => !/^[-*]\s+\*\*[^*]+\*\*/.test(item))) warnings.push("Today's focus 每条应以加粗的判断短语起头");
  if (/\bUTC\b/i.test(parts.body)) warnings.push('Opening Digest 用户可见正文不得使用 UTC，应统一显示 ET');
  if (/\b(?:because|due to)\b[^.]{0,100}\b(?:option interest|options activity|IVX|implied volatility)\b|\b(?:option interest|options activity|IVX|implied volatility)\b[^.]{0,100}\b(?:drove|caused|pushed|lifted)\b/i.test(parts.body)) warnings.push('Opening Digest 不得用 OIC/IV 共现推断价格因果');
  if (/\b(?:options? (?:market )?(?:skew|flow|volume)|call demand|put demand|IVX)\b[^.]{0,140}\b(?:bullish|bearish|direction|presage|predict|signal)\b/i.test(parts.body)) warnings.push('Opening Digest 不得用有限 OIC/期权数据推断方向、意图或后续涨跌');
  if (/\btracked(?:-universe)?\b[^.]{0,40}\bmarket breadth\b/i.test(parts.body)) warnings.push('固定跟踪池不得冒充全市场 breadth');
  const narrativeWords = visibleWords(parts.body.replace(/^## Earnings ahead[\s\S]*$/m, ''));
  if (narrativeWords > OPENING_DIGEST_NARRATIVE_MAX_WORDS) warnings.push(`Opening Digest 分析正文超过 ${OPENING_DIGEST_NARRATIVE_MAX_WORDS} 词:${narrativeWords}`);
  const evidenceWords = visibleWords(parts.sections.get('Evidence and cross-currents') || '');
  if (evidenceWords > OPENING_DIGEST_EVIDENCE_MAX_WORDS) warnings.push(`Opening Digest Evidence and cross-currents 超过 ${OPENING_DIGEST_EVIDENCE_MAX_WORDS} 词:${evidenceWords}`);
  const focusWords = visibleWords(focus);
  if (focusWords > OPENING_DIGEST_FOCUS_MAX_WORDS) warnings.push(`Opening Digest Today's focus 超过 ${OPENING_DIGEST_FOCUS_MAX_WORDS} 词:${focusWords}`);
  const narrativeComplete = Boolean(parts.lead && OPENING_DIGEST_REQUIRED_HEADINGS.every((heading) => parts.sections.get(heading)?.trim()));
  return {
    warnings,
    stats: { headlineSpecific: !warnings.some((item) => item.includes('动态标题')), stance: meta.stance, confidence: meta.confidence, leadSentences, focusCount, focusWords, narrativeComplete, mattersCount: focusCount, mattersWords: focusWords, observableSignpostCount: focusCount, narrativeWords, evidenceWords },
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
function visibleText(value) {
  return String(value || '')
    .replace(/!?\[([^\]]*)]\(https?:\/\/[^\s)]+\)/g, '$1')
    .replace(/<https?:\/\/[^>]+>/g, '')
    .replace(/https?:\/\/[^\s)>\]}"']+/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~>#|]/g, '');
}
function visibleWords(value) { return (visibleText(value).match(/[A-Za-z0-9][A-Za-z0-9'’./+%-]*/g) || []).length; }
function sentenceCount(value) {
  const text = visibleText(value).trim();
  if (!text) return 0;
  return [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)].filter((part) => visibleWords(part.segment) > 0).length;
}
