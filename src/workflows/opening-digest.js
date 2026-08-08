import { sharedResearch, officialFirstPolicy, envModel, envTimeoutMs, workDirFor } from './shared.js';
import { easternDateKey, isUsEquitySession } from '../lib/us-equity-calendar.js';

function promptTemplate() {
  const date = easternDateKey(new Date());
  return `You are writing the editorial section of Zen Opening Digest for ${date}.

Write in English. This is a short US market opening digest, not investment advice.
Use 3 to 5 sourced market-moving news items from the prior regular close through the current opening window. For each item include a direct source link and one concise reason it matters. Then write one restrained, falsifiable “Market read” paragraph. Do not invent price levels, options activity, or macro values: those are rendered separately by the system.

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
  sourcePolicy: officialFirstPolicy(),
  factReview: true,
  triggers: ['slack', 'cron:15 10 * * 1-5'],
  cronTimezone: 'America/New_York',
  cronInput: 'Create today\'s Zen Opening Digest.',
  shouldRun: (date) => /^(1|true|yes|on)$/i.test(String(process.env.OPENING_DIGEST_ENABLED || '')) && isUsEquitySession(date),
  systemPrompt: 'You are the editor of Zen Opening Digest. Use only supplied research, keep claims sourced, and write concise English market commentary. Never provide investment advice.',
  outputInstruction: 'Return the Opening Digest Markdown contract only.',
  get workDir() { return workDirFor('opening-digest'); },
  get model() { return envModel(); },
  channel: 'customerio-opening-digest',
  get timeoutMs() { return envTimeoutMs(); },
  get research() { return sharedResearch(); },
  retries: 0,
  promptTemplate,
};
