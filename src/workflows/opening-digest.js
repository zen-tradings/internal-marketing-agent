import { sharedResearch, envModel, envTimeoutMs, workDirFor } from './shared.js';
import { easternDateKey, isUsEquitySession } from '../lib/us-equity-calendar.js';
import { runtimeConfig } from '../config/runtime.js';
import {
  openingDigestResearchQueries,
  openingDigestSearchInput,
  validateOpeningDigestArticle,
} from '../lib/opening-digest-content.js';
import { collectOpeningDigestUniverseContext } from '../lib/opening-digest-universe.js';
import { decorateOpeningDigestWithEarnings } from '../lib/opening-digest-earnings.js';
import {
  OPENING_DIGEST_HEADLINE_MAX_CHARS,
  OPENING_DIGEST_HEADLINE_MAX_WORDS,
  OPENING_DIGEST_HEADLINE_MIN_WORDS,
  openingDigestPhaseGuidance,
  openingDigestWritingGuidance,
} from '../lib/opening-digest-editorial.js';

const MARKET_PRIORITY_SOURCES = [
  'reuters.com', 'apnews.com', 'ft.com', 'wsj.com', 'bloomberg.com', 'cnbc.com',
  'marketwatch.com', 'barrons.com', 'nyse.com', 'nasdaq.com', 'bls.gov', 'bea.gov',
  'federalreserve.gov', 'treasury.gov',
];

function promptTemplate() {
  const date = easternDateKey(new Date());
  return `You are writing Zen Opening Digest for ${date}, for broad U.S. equity investors with AI infrastructure and semiconductors as important secondary coverage. ${openingDigestPhaseGuidance(new Date())}

Write in concise English with an institutional research tone. This is conditional market analysis, not trading instructions.

Lead with one evidence-bound opening call. Never force a bullish or bearish view.

Build 2-3 evidence chains using What happened → Why it matters → What confirms or contradicts the interpretation. Separate observed facts from analysis and assumptions. Examine the strongest contrary evidence in a dedicated paragraph inside Evidence and cross-currents and integrate observable confirmation or invalidation conditions into Today's focus. Do not merely repeat prices from the market snapshot. Do not create a scenario section or named base/counter scenarios.

Use only supplied research links. Keep links adjacent to supported facts. Never append numbered citation or footnote markers such as 【2】, 【3】【4】, [2], or [2, 3], and never emit the † glyph in visible copy; facts are attributed only through the inline markdown links you already include. A supplied price move may be reported as a timestamped price fact, but it cannot establish a catalyst. When no supplied source establishes a cause, write one factual price sentence only: omit a Reason clause entirely, and never comment that a cause is missing, unknown, or unasserted. Do not invent market expectations, price levels, breadth, gamma, positioning, causes, macro values, earnings dates, release outcomes, or conference-call times. A co-occurring price move and OIC/IV signal does not establish causality or investor direction. The 72-name tracked universe is not the whole market; call its pattern tracked-universe participation or dispersion, never market breadth. Use ET in visible copy, not UTC. Follow the run-phase guidance above exactly; only an explicitly identified off-cycle pre-open TEST may use the word premarket.

Numeric attribution is a hard rule. Every precise figure (a price, level, yield, spread, percentage with decimals, or odds) must appear verbatim in the linked source excerpt in the same sentence or come from the attribution snapshot; never attach a figure to a source that does not state it, and never compute an unsupported variant of a sourced figure.

Macro data claims must match the current release period. State the release's own date when citing a macro release; never source a current-period figure from a prior-year release page; use prior-period figures only as explicit comparisons (versus, from, since). If the supplied source does not state its own release date or period, do not present its figures as current-period data.

Causal language follows three calibrated tiers. Use a strong causal verb (drove, pushed, lifted, reflects) only when the claim is backed by official data or by at least two independent supplied sources. With a single wire source, use hedged language (is consistent with, likely supported by, points to) and state the transmission mechanism in its own sentence. When a price move and a potential driver merely coincide with no supplied mechanism, write that they coincided and use no directional causal verb. Never write that a factor directly supports or directly caused something unless a supplied source states that link.

Do not assert market-structure conditions such as absent or exhausted buyers, a lack of incremental demand, positioning, or flows unless a supplied source actually observes them; describe rotation between names or groups instead. When reporting that something surpassed, outpaced, or exceeded a comparable entity or record, state the comparison basis supplied by the source (for example, the same initial launch window) or omit the comparison.

The attribution snapshot capture time is the narrative now. Describe the market state as of that time; label earlier source observations with their own timestamps, and when an earlier observation conflicts with the snapshot, follow the snapshot without narrating the conflict.

The schedule is inserted later as Earnings ahead, so do not create that heading or repeat a merely upcoming earnings date as a catalyst. Do not use evergreen background, stale disclosure, unconfirmed rumors, or price-target-only notes as today's incremental information.

Return Markdown only with this frontmatter:
---
title: Zen Opening Digest
headline: An event-anchored professional headline naming today's single most market-moving or most distinctive development, written in clear natural English, ${OPENING_DIGEST_HEADLINE_MIN_WORDS}-${OPENING_DIGEST_HEADLINE_MAX_WORDS} words, no more than ${OPENING_DIGEST_HEADLINE_MAX_CHARS} characters
stance: constructive|neutral|defensive
confidence: high|medium|low
preheader: One specific sentence, no more than 140 characters
edition: ${date}
---

After frontmatter, write the Opening call with no heading, followed by the two authored sections:
${openingDigestWritingGuidance()}

Headline rules (apply strictly): the headline must anchor today's single most market-moving or most distinctive development (a specific event, data release, policy decision, company result, or genuine surprise), written like a senior sell-side strategist's daily note title: precise, restrained, and accurate. Accuracy always comes first: never add, stretch, or imply any fact to make the headline clearer. Clarity is a hard floor, not a stylistic option: the headline must read as a natural, complete English sentence that a general financial reader understands in one pass — spell out what happened and to what, and do not use telegraphic ellipsis, unexplained market jargon, metaphor, wordplay, or cryptic noun stacks. A headline that must be reread to be parsed has failed these rules even when it is precise and within the length limits. NEVER write a routine recurring daily move as the headline subject — daily oil price gains or losses, day-to-day Treasury yield drift, or a generic index up/down day are all forbidden and make the headline repetitive and worthless. Exception: a genuine one-off event in oil or rates (for example an OPEC+ output decision, a CPI surprise, or an FOMC decision) may be named. Do not sensationalize and do not overstate causality.`;
}

export default {
  id: 'opening-digest',
  mode: 'newsletter',
  sourcePolicy: { officialFirst: false, requireCitations: true, minOfficialSources: 0, failClosed: true },
  factReview: true,
  factReviewPolicy: 'severe-only',
  editorialPlanning: true,
  triggers: ['slack', 'cron:0 10 * * 1-5'],
  get cronTimezone() { return runtimeConfig()?.openingDigest?.timezone || process.env.OPENING_DIGEST_TIMEZONE || 'America/New_York'; },
  cronCatchUpWindowMinutes: 120,
  cronRunKey: (date) => easternDateKey(date),
  get cronInput() { return openingDigestSearchInput(new Date()); },
  shouldRun: (date) => (runtimeConfig()?.openingDigest?.enabled
    ?? /^(1|true|yes|on)$/i.test(String(process.env.OPENING_DIGEST_ENABLED || ''))) && isUsEquitySession(date),
  systemPrompt: 'You are the editor of Zen Opening Digest. Use only supplied research, keep claims sourced, and write concise English market commentary. Never provide investment advice.',
  outputInstruction: 'Return the Opening Digest Markdown contract only.',
  get workDir() { return workDirFor('opening-digest'); },
  get model() { return runtimeConfig()?.openingDigest?.model || process.env.OPENING_DIGEST_MODEL || envModel(); },
  channel: 'customerio-opening-digest',
  get timeoutMs() { return envTimeoutMs(); },
  get research() {
    const shared = sharedResearch();
    return {
      ...shared,
      minOfficialSources: 0,
      prioritySources: [...new Set([...MARKET_PRIORITY_SOURCES, ...shared.prioritySources])],
      extraQueries: (_subject, context = {}) => openingDigestResearchQueries(
        context.asOf || new Date(),
        context.editorialContext?.artifact?.earningsCalendar,
      ),
      // Eleven fixed lanes plus the earnings verification query; bounded so the earnings
      // verification lane is never sliced off.
      extraQueryLimit: 12,
      // Ten search lanes can return far more material than a 3-5 item digest needs.
      // Keep every source/link available while bounding each excerpt so generation and
      // severe-only review remain comfortably inside the global prompt limit.
      maxSourceExcerptChars: 1200,
    };
  },
  collectContext: ({ config, fetchFn, asOf, taskContext, signal }) => collectOpeningDigestUniverseContext({
    config,
    fetchFn,
    asOf,
    signal,
    history: taskContext?.openingDigestHistory,
  }),
  validateArticle: ({ article, research, asOf }) => validateOpeningDigestArticle({
    article, research, asOf, requireFreshSources: true,
  }),
  decorateArticle: ({ article, research, asOf, editorialContext }) => {
    const calendar = editorialContext?.artifact?.earningsCalendar;
    const decorated = decorateOpeningDigestWithEarnings(article, { calendar, research, asOf });
    if (editorialContext?.trace?.earningsCalendar && calendar?.selection) {
      editorialContext.trace.earningsCalendar.selection = calendar.selection;
    }
    return decorated;
  },
  retries: 0,
  promptTemplate,
};
