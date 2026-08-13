import { sharedResearch, envModel, envTimeoutMs, workDirFor } from './shared.js';
import { easternDateKey, isUsEquitySession } from '../lib/us-equity-calendar.js';
import {
  openingDigestResearchQueries,
  openingDigestSearchInput,
  validateOpeningDigestArticle,
} from '../lib/opening-digest-content.js';
import { collectOpeningDigestUniverseContext } from '../lib/opening-digest-universe.js';
import { decorateOpeningDigestWithEarnings } from '../lib/opening-digest-earnings.js';

const MARKET_PRIORITY_SOURCES = [
  'reuters.com', 'apnews.com', 'ft.com', 'wsj.com', 'bloomberg.com', 'cnbc.com',
  'marketwatch.com', 'barrons.com', 'nyse.com', 'nasdaq.com', 'bls.gov', 'bea.gov',
  'federalreserve.gov', 'treasury.gov',
];

function promptTemplate() {
  const date = easternDateKey(new Date());
  return `You are writing the editorial section of Zen Opening Digest for ${date}.

Write in English. This is a short US market opening digest, not investment advice.
Use 3 to 5 sourced market-moving items. Each item must be one Markdown list line containing no more than 40 visible English words, including its visible link label but excluding its URL. Prioritize the supplied tracked-universe signals and current-window company developments; use at most one macro item, only when it materially affects the broad market or several tracked names. Each non-price item needs one direct source link and only the essential fact plus a concise market implication. A supplied price move may be reported as a timestamped price fact. When no supplied source establishes a catalyst, write one factual price sentence only: omit a Reason clause entirely, and never comment that a cause is missing, unknown, or unasserted. Combine standalone supplied IV signals into at most one item and state that coverage is limited to tracked names appearing in the OIC Top 20.
Then write one restrained, falsifiable “Market read” paragraph of 3 to 5 sentences and no more than 80 visible English words. Use an overview-details-optional synthesis structure: the first sentence states the overall market interpretation; the middle 1 to 3 sentences explain the main drivers, divergences, or validation conditions; an optional final sentence summarizes the read or states what would invalidate it. Do not repeat catalyst detail unnecessarily or provide investment advice. Do not invent price levels, options activity, causes, macro values, earnings dates, or conference-call times.
Do not use evergreen background, previously disclosed items, unconfirmed rumors, price-target-only notes, or sources without a verifiable publication date as today's catalysts. Explicit upgrades or downgrades are allowed. The schedule itself is inserted later as Earnings ahead, so do not create that heading and do not repeat a merely upcoming earnings date as a catalyst. Never pad the digest with stale material; use only the number of supported items available.

Return Markdown only with this frontmatter:
---
title: Zen Opening Digest
subject: Zen Opening Digest · ${date}
preheader: Market signals, earnings ahead, today’s catalysts, and options volume.
edition: ${date}
---
Then use exactly these headings:
## Today's catalysts
## Market read`;
}

export default {
  id: 'opening-digest',
  mode: 'newsletter',
  sourcePolicy: { officialFirst: false, requireCitations: true, minOfficialSources: 0, failClosed: true },
  factReview: true,
  factReviewPolicy: 'severe-only',
  triggers: ['slack', 'cron:15 10 * * 1-5'],
  cronTimezone: 'America/New_York',
  get cronInput() { return openingDigestSearchInput(new Date()); },
  shouldRun: (date) => /^(1|true|yes|on)$/i.test(String(process.env.OPENING_DIGEST_ENABLED || '')) && isUsEquitySession(date),
  systemPrompt: 'You are the editor of Zen Opening Digest. Use only supplied research, keep claims sourced, and write concise English market commentary. Never provide investment advice.',
  outputInstruction: 'Return the Opening Digest Markdown contract only.',
  get workDir() { return workDirFor('opening-digest'); },
  get model() { return envModel(); },
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
