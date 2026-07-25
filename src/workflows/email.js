import { sharedResearch, officialFirstPolicy, envModel, envTimeoutMs, workDirFor } from './shared.js';

export function newsletterEdition() {
  const raw = String(process.env.NEWSLETTER_EDITION || 'Vol. 1').trim();
  const match = raw.match(/^vol\.?\s*(\d+)$/i);
  return match ? `Vol. ${match[1]}` : raw;
}

function promptTemplate(task) {
  const edition = newsletterEdition();
  return `You are the editor of the Zen Trading newsletter. Produce a concise, useful email edition based only on the supplied task and research material.

【Edition】
${edition}

【Task】
${task}

【Editorial requirements】
- Write in English unless the task explicitly requests another language.
- First decide the edition type from the task:
  - If it is a product/announcement/welcome edition (introducing what Zen is building, inviting feedback, or explaining a feature), write in that register: open with a clear statement of purpose, stay warm but professional, and close with one specific call to action. Do NOT force a market takeaway or a "What we're watching" list onto it.
  - If it is a market/research edition, lead with one clear, falsifiable takeaway (never a generic recap) and close with a short "What we're watching" list of 2-4 concrete signals.
- Use 2-4 short sections with judgment-led headings. Keep paragraphs short enough for email.
- Distinguish sourced facts from editorial interpretation. Do not invent facts, figures, dates, links, or quotes. Use the supplied research only where it is genuinely relevant to the task; ignore it for announcement editions if it does not fit.
- Avoid tables, raw HTML, images, and code blocks. The Customer.io template supplies layout, branding, and compliance links.
- Do not add a signature, unsubscribe link, physical address, or investment-advice disclaimer; the publishing template adds them.

【Output contract】
Return complete Markdown beginning with this YAML frontmatter:
---
title: A specific editorial headline
subject: Zen Research from Zen Trading · ${edition} | A concise subject
preheader: A preview sentence no longer than 140 characters
edition: ${edition}
---
Then write only the newsletter body in Markdown. Do not include explanations or publishing instructions.`;
}

export default {
  id: 'email',
  mode: 'newsletter',
  sourcePolicy: officialFirstPolicy(),
  factReview: true,
  triggers: ['slack'],
  systemPrompt: `You are the editor of the Zen Research from Zen Trading research newsletter. Use only the task and supplied research. Write clean, publication-ready Markdown for an email audience. Never invent facts, figures, dates, sources, or links. Put source links next to supported facts and do not add a duplicate sources list at the end. Follow the requested YAML frontmatter exactly and return no commentary outside the newsletter.`,
  outputInstruction: 'Use the newsletter-specific contract above to produce article.md for a Customer.io draft. Do not write WeChat publishing instructions or a Chinese public-account article unless the task explicitly requests Chinese.',
  get workDir() { return workDirFor('email'); },
  get model() { return envModel(); },
  channel: 'customerio-draft',
  get timeoutMs() { return envTimeoutMs(); },
  get research() { return sharedResearch(); },
  retries: 0,
  promptTemplate,
};
