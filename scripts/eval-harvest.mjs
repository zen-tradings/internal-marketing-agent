#!/usr/bin/env node
// Harvest eval cases from real run artifacts. Usage:
//   node scripts/eval-harvest.mjs <run-dir> [--kind citation-grounding|gates] [--defect true|false] [--id <case-id>]
// Reads article.md (+ research-trace.json when present) from a workflow run directory and prints
// a JSONL case line ready to append to an eval cases file. Label with --defect once reviewed;
// unlabeled cases still run but are excluded from FN/FP rates. Read-only: never modifies runs.

import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config();

const args = process.argv.slice(2);
const runDir = args.find((arg) => !arg.startsWith('--'));
const kind = flagValue('--kind') || 'citation-grounding';
const defectRaw = flagValue('--defect');
const caseId = flagValue('--id') || `${kind}-${path.basename(runDir || 'run')}`;

if (!runDir || !fs.existsSync(runDir)) {
  console.error('Usage: node scripts/eval-harvest.mjs <run-dir> [--kind citation-grounding|gates] [--defect true|false] [--id <case-id>]');
  process.exit(1);
}

const articlePath = path.join(runDir, 'article.md');
if (!fs.existsSync(articlePath)) {
  console.error(`no article.md in ${runDir}`);
  process.exit(1);
}
const article = fs.readFileSync(articlePath, 'utf8');

const expect = {};
if (defectRaw === 'true') expect.defect = true;
else if (defectRaw === 'false') expect.defect = false;

let input;
if (kind === 'citation-grounding') {
  const tracePath = path.join(runDir, 'research-trace.json');
  if (!fs.existsSync(tracePath)) {
    console.error(`no research-trace.json in ${runDir}; cannot build the allowed source set`);
    process.exit(1);
  }
  const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
  const allowedUrls = [...new Set([
    ...(trace.selectedSources || []).map((source) => source?.url),
    ...(trace.taskContract?.user_urls || []),
  ].filter(Boolean))];
  input = { article, allowedUrls };
} else if (kind === 'gates') {
  input = { markdown: article };
} else {
  console.error(`unsupported harvest kind: ${kind} (supported: citation-grounding, gates)`);
  process.exit(1);
}

// Harvested cases are labeled from real runs, not tuned alongside the checkers, so they count
// as independent labels in the meta-eval once --defect is set.
console.log(JSON.stringify({ id: caseId, kind, labelSource: 'independent', input, expect }));

function flagValue(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}
