import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCases } from '../src/eval/cases.js';
import { runCases, summarize } from '../src/eval/harness.js';
import { summarizeMeta, verdictFromResult, confusionMatrix } from '../src/eval/meta.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const CASES_FILE = path.join(FIXTURES, 'eval-cases.jsonl');

test('labeled fixture set: every case passes and every kind is covered', async () => {
  const cases = loadCases(CASES_FILE);
  const results = await runCases(cases);
  const failed = results.filter((result) => !result.passed);
  assert.deepEqual(failed.map((result) => result.id), [], JSON.stringify(failed, null, 2));
  const summary = summarize(results);
  assert.equal(summary.total, cases.length);
  for (const kind of ['routing', 'source-policy', 'citation-grounding', 'gates', 'opening-digest-limits', 'options-strategy', 'qdii-reconcile']) {
    assert.ok(summary.byKind[kind]?.total >= 2 || kind === 'source-policy', `missing coverage for ${kind}`);
  }
});

test('meta-eval: fixture verdicts show zero FN/FP and are flagged as baseline-only', async () => {
  const results = await runCases(loadCases(CASES_FILE));
  const meta = summarizeMeta(results.map((result) => verdictFromResult(result)));
  assert.equal(meta.overall.falseNegatives, 0);
  assert.equal(meta.overall.falsePositives, 0);
  // All fixture labels were tuned alongside the checkers: no independent calibration data yet.
  assert.equal(meta.baselineOnly, true);
  assert.equal(meta.independent, null);
  assert.equal(meta.independentCount, 0);
});

test('meta-eval: independent labels are separated from fixture labels', async () => {
  const results = await runCases([{
    id: 'harvested-incident',
    kind: 'citation-grounding',
    labelSource: 'independent',
    input: { article: '[fake](https://fabricated.example.com/x)', allowedUrls: ['https://real.example.com/y'] },
    expect: { defect: true },
  }]);
  const meta = summarizeMeta(results.map((result) => verdictFromResult(result)));
  assert.equal(meta.baselineOnly, false);
  assert.equal(meta.independentCount, 1);
  assert.equal(meta.independent.truePositives, 1);
  assert.equal(meta.independent.falseNegativeRate, 0);
});

test('meta-eval: confusion matrix classifies FN and FP correctly', () => {
  const matrix = confusionMatrix([
    { labeled: true, groundTruthDefect: true, flagged: true },   // TP
    { labeled: true, groundTruthDefect: true, flagged: false },  // FN: defect shipped unflagged
    { labeled: true, groundTruthDefect: false, flagged: true },  // FP: clean draft flagged
    { labeled: true, groundTruthDefect: false, flagged: false }, // TN
    { labeled: false, groundTruthDefect: false, flagged: true }, // unlabeled, ignored
  ]);
  assert.deepEqual(matrix, { truePositives: 1, falsePositives: 1, trueNegatives: 1, falseNegatives: 1 });
  const meta = summarizeMeta([
    { kind: 'x', labeled: true, groundTruthDefect: true, flagged: false },
    { kind: 'x', labeled: true, groundTruthDefect: true, flagged: true },
  ]);
  assert.equal(meta.overall.falseNegativeRate, 0.5);
});

test('a missed defect surfaces as a failing case (simulated false negative)', async () => {
  // A fabricated URL that happens to be in the allowlist: the checker stays clean,
  // ground truth says defect, so the harness must report the case as failed.
  const results = await runCases([{
    id: 'fn-simulation',
    kind: 'citation-grounding',
    input: { article: '[a](https://ok.example.com/x)', allowedUrls: ['https://ok.example.com/x'] },
    expect: { defect: true },
    baseDir: FIXTURES,
  }]);
  assert.equal(results[0].passed, false);
  assert.equal(results[0].flagged, false);
});

test('loadCases rejects duplicate ids and unknown kinds', () => {
  assert.throws(() => loadCases(path.join(FIXTURES, 'nonexistent.jsonl')));
});

test('checker crash is contained and counted as flagged', async () => {
  const results = await runCases([{
    id: 'crash', kind: 'options-strategy', input: { strategy: { legs: [] } }, expect: { defect: true }, baseDir: FIXTURES,
  }]);
  assert.equal(results[0].flagged, true);
  assert.match(results[0].errors[0], /non-empty array/);
});
