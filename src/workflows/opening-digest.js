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
import { openingDigestPhaseGuidance } from '../lib/opening-digest-editorial.js';

const MARKET_PRIORITY_SOURCES = [
  'reuters.com', 'apnews.com', 'ft.com', 'wsj.com', 'bloomberg.com', 'cnbc.com',
  'marketwatch.com', 'barrons.com', 'nyse.com', 'nasdaq.com', 'bls.gov', 'bea.gov',
  'federalreserve.gov', 'treasury.gov',
];

function promptTemplate() {
  const date = easternDateKey(new Date());
  return `You are writing Zen Opening Digest for ${date}, for broad U.S. equity investors with AI infrastructure and semiconductors as important secondary coverage. ${openingDigestPhaseGuidance(new Date())}

Write in concise English. The model-authored narrative should usually be 450-650 visible words, but shorten it rather than pad when evidence is sparse. This is conditional market analysis, not trading instructions.

Lead with one evidence-bound opening call of at most two sentences. The first sentence states the market tone as Constructive, Neutral, or Defensive and the dominant constraint or support. If a second sentence is needed, state the opposite boundary or why the support does not change the overall tone. Never force a bullish or bearish view.

Build 2-3 evidence chains using What happened → Why it matters → What confirms or contradicts the interpretation. Separate observed facts from analysis and assumptions. Examine the strongest contrary evidence in a dedicated paragraph inside Evidence and cross-currents and give observable confirmation or invalidation conditions in What to watch. Do not merely repeat prices from the market snapshot. Do not create a scenario section or named base/counter scenarios.

Use only supplied research links. Keep links adjacent to supported facts. Never append numbered citation or footnote markers such as 【2】, 【3】【4】, [2], or [2, 3], and never emit the † glyph in visible copy; facts are attributed only through the inline markdown links you already include. A supplied price move may be reported as a timestamped price fact, but it cannot establish a catalyst. When no supplied source establishes a cause, write one factual price sentence only: omit a Reason clause entirely, and never comment that a cause is missing, unknown, or unasserted. Do not invent market expectations, price levels, breadth, gamma, positioning, causes, macro values, earnings dates, release outcomes, or conference-call times. A co-occurring price move and OIC/IV signal does not establish causality or investor direction. The 72-name tracked universe is not the whole market; call its pattern tracked-universe participation or dispersion, never market breadth. Use ET in visible copy, not UTC. Follow the run-phase guidance above exactly; only an explicitly identified off-cycle pre-open TEST may use the word premarket.

Causal language follows three calibrated tiers. Use a strong causal verb (drove, pushed, lifted, reflects) only when the claim is backed by official data or by at least two independent supplied sources. With a single wire source, use hedged language (is consistent with, likely supported by, points to) and state the transmission mechanism in its own sentence. When a price move and a potential driver merely coincide with no supplied mechanism, write that they coincided and use no directional causal verb. Never write that a factor directly supports or directly caused something unless a supplied source states that link.

Do not assert market-structure conditions such as absent or exhausted buyers, a lack of incremental demand, positioning, or flows unless a supplied source actually observes them; describe rotation between names or groups instead. When reporting that something surpassed, outpaced, or exceeded a comparable entity or record, state the comparison basis supplied by the source (for example, the same initial launch window) or omit the comparison.

The attribution snapshot capture time is the narrative now. Describe the market state as of that time; label earlier source observations with their own timestamps, and when an earlier observation conflicts with the snapshot, follow the snapshot without narrating the conflict.

The schedule is inserted later as Earnings ahead, so do not create that heading or repeat a merely upcoming earnings date as a catalyst. Do not use evergreen background, stale disclosure, unconfirmed rumors, or price-target-only notes as today's incremental information.

Return Markdown only with this frontmatter:
---
title: Zen Opening Digest
headline: A specific 4-7 word headline, no more than 36 characters
stance: constructive|neutral|defensive
confidence: high|medium|low
preheader: One specific sentence, no more than 140 characters
edition: ${date}
---

After frontmatter, write the at-most-two-sentence Opening call as one paragraph with no heading. Then use exactly these headings in this order:
## What matters today
Write 2-3 short paragraphs, each beginning with a bold judgment-led phrase.
## Evidence and cross-currents
Write exactly two short paragraphs. The first paragraph presents the strongest supporting evidence for the opening call; the second presents the strongest contrary evidence or cross-current against it. Open each paragraph with a bold judgment-led phrase; do not use fixed labels such as "Supporting:" or "Constraining:". Inside each paragraph follow one line of reasoning: observed facts with inline links, then the transmission mechanism, then what it implies for the overall call. Keep each causal chain in its own sentence; do not stack several unrelated drivers into one sentence. The second paragraph must still be evidence-bound and cite supplied sources, never invented speculation. Do not add a third paragraph or a reconciling summary.
## What to watch
Write 3-5 observable, evidence-bound bullets. Do not give entry, exit, position, stop-loss, or take-profit instructions.`;
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
