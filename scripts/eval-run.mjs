#!/usr/bin/env node
// Offline eval runner. Usage:
//   node scripts/eval-run.mjs <cases.jsonl> [--json] [--verdicts <file.jsonl>] [--mutate]
//   node scripts/eval-run.mjs --meta <verdicts.jsonl>
// Runs labeled cases (Metric A), optionally appends verdicts, and --meta prints the
// accumulated false-negative / false-positive summary (Metric B). --mutate injects known
// defect types into the clean cases and reports checker recall (synthetic FN measurement).
// Read-only otherwise.

import dotenv from 'dotenv';
import crypto from 'node:crypto';
import fs from 'node:fs';

dotenv.config();

const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const wantMutate = args.includes('--mutate');
const metaIndex = args.indexOf('--meta');
const verdictsIndex = args.indexOf('--verdicts');

const { loadCases } = await import('../src/eval/cases.js');
const { runCases, summarize } = await import('../src/eval/harness.js');
const { appendVerdicts, readVerdicts, summarizeMeta, verdictFromResult } = await import('../src/eval/meta.js');

if (metaIndex !== -1) {
  const file = args[metaIndex + 1];
  if (!file) usage();
  const meta = summarizeMeta(readVerdicts(file));
  if (wantJson) { console.log(JSON.stringify(meta, null, 2)); process.exit(0); }
  console.log(`Meta-eval over ${file}`);
  if (meta.baselineOnly) {
    console.log('NOTE: baseline only. All verdicts come from fixture labels the checkers were tuned on;');
    console.log('rates are a regression baseline, not a production quality claim. Harvest real incidents');
    console.log('(npm run eval:harvest) to accumulate independent labels.');
  } else {
    console.log(`independent labels: ${meta.independentCount}`);
    printMatrix('independent (honest calibration)', meta.independent);
  }
  printMatrix('overall', meta.overall);
  for (const [kind, matrix] of Object.entries(meta.byKind)) printMatrix(kind, matrix);
  process.exit(0);
}

const casesFile = args.find((arg, index) => !arg.startsWith('--')
  && (verdictsIndex === -1 || index !== verdictsIndex + 1));
if (!casesFile) usage();

const cases = loadCases(casesFile);
const results = await runCases(cases);
const summary = summarize(results);

if (verdictsIndex !== -1) {
  const file = args[verdictsIndex + 1];
  if (!file) usage();
  // Fingerprint the exact cases file so accumulated rates stay traceable to the eval-set version.
  const casesSha256 = crypto.createHash('sha256').update(fs.readFileSync(casesFile)).digest('hex').slice(0, 16);
  appendVerdicts(file, results.map((result) => ({ ...verdictFromResult(result), casesFile, casesSha256 })));
}

let mutation;
if (wantMutate) {
  const { runMutationSuite } = await import('../src/eval/mutations.js');
  mutation = await runMutationSuite(cases);
}

if (wantJson) {
  console.log(JSON.stringify({ summary, mutation, results }, null, 2));
} else {
  for (const result of results) {
    console.log(`${result.passed ? 'PASS' : 'FAIL'} [${result.kind}] ${result.id}`);
    if (!result.passed) {
      if (result.groundTruthDefect && !result.flagged) console.log('  false negative: defect was not flagged');
      for (const error of result.errors) console.log(`  error: ${error}`);
    }
    for (const warning of result.warnings) console.log(`  warn: ${warning}`);
  }
  console.log(`\n${summary.passed}/${summary.total} cases passed`);
  for (const [kind, bucket] of Object.entries(summary.byKind)) {
    console.log(`- ${kind}: ${bucket.passed}/${bucket.total}`);
  }
  if (mutation) {
    console.log(`\nMutation suite: ${mutation.caught}/${mutation.mutants} injected defects caught (recall ${mutation.recall === null ? 'n/a' : `${(mutation.recall * 100).toFixed(1)}%`})`);
    for (const [id, bucket] of Object.entries(mutation.byMutation)) {
      console.log(`- ${id}: ${bucket.caught}/${bucket.mutants}`);
    }
    for (const miss of mutation.missed) console.log(`  MISSED (synthetic false negative): ${miss.id}`);
  }
}
process.exit(summary.failed || (mutation && mutation.missed.length) ? 1 : 0);

function printMatrix(label, matrix) {
  console.log(`\n[${label}] TP=${matrix.truePositives} FN=${matrix.falseNegatives} FP=${matrix.falsePositives} TN=${matrix.trueNegatives}`);
  console.log(`  false-negative rate (missed defects): ${format(matrix.falseNegativeRate)}`);
  console.log(`  false-positive rate (flagged clean drafts): ${format(matrix.falsePositiveRate)}`);
}

function format(rate) { return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`; }

function usage() {
  console.error('Usage: node scripts/eval-run.mjs <cases.jsonl> [--json] [--verdicts <file>] | --meta <verdicts.jsonl>');
  process.exit(1);
}
