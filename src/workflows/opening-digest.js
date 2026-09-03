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

Lead with one evidence-bound opening call. State the market tone as Constructive, Neutral, or Defensive; explain the dominant constraint or support; and say what materially changed from the prior formal edition. If signals conflict, explicitly say no single signal dominates. Never force a bullish or bearish view.

Build 2-3 evidence chains using What happened → Why it matters → What confirms or contradicts the interpretation. Separate observed facts from analysis and assumptions. Compare the base case with one plausible counter-case and give observable confirmation or invalidation conditions. Do not merely repeat prices from the market snapshot.

Use only supplied research links. Keep links adjacent to supported facts. A supplied price move may be reported as a timestamped price fact, but it cannot establish a catalyst. When no supplied source establishes a cause, write one factual price sentence only: omit a Reason clause entirely, and never comment that a cause is missing, unknown, or unasserted. Do not invent market expectations, price levels, breadth, gamma, positioning, causes, macro values, earnings dates, release outcomes, or conference-call times. A co-occurring price move and OIC/IV signal does not establish causality or investor direction. The 72-name tracked universe is not the whole market; call its pattern tracked-universe participation or dispersion, never market breadth. Use ET in visible copy, not UTC. Follow the run-phase guidance above exactly; only an explicitly identified off-cycle pre-open TEST may use the word premarket.

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

After frontmatter, write a 2-4 sentence Opening call as one paragraph with no heading. Then use exactly these headings in this order:
## What matters today
Write 2-3 short paragraphs, each beginning with a bold judgment-led phrase.
## Evidence and cross-currents
Write one compact paragraph containing both supporting and contrary evidence.
## Scenario map
- **Base case —** conditions, expected read, and observable confirmation.
- **Counter-case —** conditions and how the main judgment would be invalidated.
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
  triggers: ['slack', 'cron:15 10 * * 1-5'],
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
      extraQueryLimit: 10,
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
