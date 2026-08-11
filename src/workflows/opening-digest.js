import { sharedResearch, envModel, envTimeoutMs, workDirFor } from './shared.js';
import { easternDateKey, isUsEquitySession } from '../lib/us-equity-calendar.js';
import {
  openingDigestResearchQueries,
  openingDigestSearchInput,
  validateOpeningDigestArticle,
} from '../lib/opening-digest-content.js';
import { collectOpeningDigestUniverseContext } from '../lib/opening-digest-universe.js';

const MARKET_PRIORITY_SOURCES = [
  'reuters.com', 'apnews.com', 'ft.com', 'wsj.com', 'bloomberg.com', 'cnbc.com',
  'marketwatch.com', 'barrons.com', 'nyse.com', 'nasdaq.com', 'bls.gov', 'bea.gov',
  'federalreserve.gov', 'treasury.gov',
];

function promptTemplate() {
  const date = easternDateKey(new Date());
  return `You are writing the editorial section of Zen Opening Digest for ${date}.

Write in English. This is a short US market opening digest, not investment advice.
Use 3 to 5 sourced market-moving items. Prioritize current-window company developments and supplied tracked-universe options signals; use at most one macro item, only when it materially affects the broad market or several tracked names. For each item include one direct source link and one concise reason it matters. Do not write a standalone price move: include a ticker's price action only when a supplied current source provides a verifiable catalyst for it. Combine standalone supplied IV signals into at most one item and state that coverage is limited to tracked names appearing in the OIC Top 20. Then write one restrained, falsifiable “Market read” paragraph. Do not invent price levels, options activity, causes, or macro values.
Do not use evergreen background, previously disclosed items, unconfirmed rumors, price-target-only notes, or sources without a verifiable publication date as today's catalysts. Explicit upgrades or downgrades are allowed. A still-upcoming earnings event in the current ET week may use an older verifiable schedule source; this exception does not apply to ordinary news. Never pad the digest with stale material; use only the number of supported items available.

Return Markdown only with this frontmatter:
---
title: Zen Opening Digest
subject: Zen Opening Digest · ${date}
preheader: Market signals, today’s catalysts, and options volume.
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
      extraQueries: () => openingDigestResearchQueries(new Date()),
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
  retries: 0,
  promptTemplate,
};
