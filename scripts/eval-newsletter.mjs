#!/usr/bin/env node
// Offline newsletter quality eval. Usage:
//   node scripts/eval-newsletter.mjs <article.md>           deterministic rubric only
//   node scripts/eval-newsletter.mjs --latest [workflow]    eval newest run's article.md under WORK_DIR
//   node scripts/eval-newsletter.mjs --judge <article.md>   add the optional OpenRouter LLM rubric pass
// Read-only: never touches channels, SQLite state, or Slack.

import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config();

const args = process.argv.slice(2);
const wantJudge = args.includes('--judge');
const wantJson = args.includes('--json');
const latestIndex = args.indexOf('--latest');
const positional = args.filter((arg, index) => !arg.startsWith('--') && index !== latestIndex + 1);

const { evaluateNewsletter, formatEvalReport, judgeNewsletterWithModel } = await import('../src/lib/newsletter-eval.js');

let articlePath;
if (latestIndex !== -1) {
  const workflowId = args[latestIndex + 1] && !args[latestIndex + 1].startsWith('--') ? args[latestIndex + 1] : 'email';
  const base = process.env.WORK_DIR || '/srv/zen/wechat';
  const runsDir = path.join(workflowId === 'wechat' ? base : path.join(base, workflowId), 'runs');
  if (!fs.existsSync(runsDir)) {
    console.error(`runs directory not found: ${runsDir}`);
    process.exit(1);
  }
  const candidates = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsDir, entry.name, 'article.md'))
    .filter((candidate) => fs.existsSync(candidate));
  if (!candidates.length) {
    console.error(`no article.md found under: ${runsDir}`);
    process.exit(1);
  }
  articlePath = candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
} else {
  articlePath = positional[0];
}

if (!articlePath || !fs.existsSync(articlePath)) {
  console.error('Usage: node scripts/eval-newsletter.mjs [--judge] [--json] <article.md | --latest [workflow]>');
  process.exit(1);
}

const markdown = fs.readFileSync(articlePath, 'utf8');
const result = evaluateNewsletter(markdown, { edition: process.env.NEWSLETTER_EDITION || 'Vol. 1' });
result.file = articlePath;

if (wantJudge) {
  const { loadConfig } = await import('../src/config/index.js');
  try {
    result.judge = await judgeNewsletterWithModel(markdown, { config: loadConfig() });
  } catch (error) {
    result.judgeError = String(error?.message || error);
  }
}

if (wantJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`File: ${articlePath}`);
  console.log(formatEvalReport(result));
  if (result.judge) {
    console.log(`\nLLM judge: ${result.judge.score}/100 — ${result.judge.summary || '(no summary)'}`);
    for (const [key, value] of Object.entries(result.judge.scores)) console.log(`- ${key}: ${value}/100`);
    for (const issue of result.judge.issues) console.log(`  [model] ${issue}`);
  }
  if (result.judgeError) console.log(`\nLLM judge unavailable: ${result.judgeError}`);
}
