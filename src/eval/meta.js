// Metric B: meta-eval of the auditor itself. Accumulates verdicts (ground truth vs checker flag)
// in a JSONL log and computes the confusion matrix. False negatives (a defect shipped unflagged)
// are the worst failure mode; false positives burn pipeline throughput on clean drafts.

import fs from 'node:fs';
import path from 'node:path';

export function verdictFromResult(result, at = new Date().toISOString()) {
  return {
    caseId: result.id,
    kind: result.kind,
    groundTruthDefect: result.groundTruthDefect === true,
    flagged: result.flagged === true,
    labeled: result.groundTruthDefect !== undefined,
    // 'independent' = labeled from a source the checkers were not tuned on (real incident, blind
    // human audit). 'fixture' = hand-built alongside the checkers; only a regression baseline.
    labelSource: result.labelSource === 'independent' ? 'independent' : 'fixture',
    at,
  };
}

export function appendVerdicts(file, verdicts) {
  if (!verdicts.length) return;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.appendFileSync(file, verdicts.map((verdict) => JSON.stringify(verdict)).join('\n') + '\n');
}

export function readVerdicts(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

export function confusionMatrix(verdicts) {
  const matrix = { truePositives: 0, falsePositives: 0, trueNegatives: 0, falseNegatives: 0 };
  for (const verdict of verdicts) {
    if (verdict.labeled === false) continue;
    if (verdict.groundTruthDefect && verdict.flagged) matrix.truePositives += 1;
    else if (verdict.groundTruthDefect && !verdict.flagged) matrix.falseNegatives += 1;
    else if (!verdict.groundTruthDefect && verdict.flagged) matrix.falsePositives += 1;
    else matrix.trueNegatives += 1;
  }
  return matrix;
}

export function summarizeMeta(verdicts) {
  const independent = verdicts.filter((verdict) => verdict.labelSource === 'independent');
  const byKind = {};
  for (const verdict of verdicts) {
    (byKind[verdict.kind] ||= []).push(verdict);
  }
  return {
    overall: withRates(confusionMatrix(verdicts)),
    // Rates over independently labeled cases only; the honest calibration number. null matrices
    // upstream should be presented as "baseline only", never as a production quality claim.
    independent: independent.length ? withRates(confusionMatrix(independent)) : null,
    independentCount: independent.length,
    baselineOnly: independent.length === 0,
    byKind: Object.fromEntries(Object.entries(byKind).map(([kind, entries]) => [kind, withRates(confusionMatrix(entries))])),
  };
}

function withRates(matrix) {
  const defects = matrix.truePositives + matrix.falseNegatives;
  const cleans = matrix.trueNegatives + matrix.falsePositives;
  return {
    ...matrix,
    // FN rate: share of real defects the auditor missed (silent bad sends).
    falseNegativeRate: defects ? round4(matrix.falseNegatives / defects) : null,
    // FP rate: share of clean drafts incorrectly flagged (wasted fix loops / needs_review).
    falsePositiveRate: cleans ? round4(matrix.falsePositives / cleans) : null,
    // Chance-corrected agreement between checker verdicts and ground-truth labels.
    // Report alongside raw rates: raw agreement overstates quality on imbalanced label sets.
    cohenKappa: cohenKappa(matrix),
  };
}

function cohenKappa(matrix) {
  const { truePositives: tp, falsePositives: fp, trueNegatives: tn, falseNegatives: fn } = matrix;
  const total = tp + fp + tn + fn;
  if (!total) return null;
  const observed = (tp + tn) / total;
  const expected = (((tp + fn) * (tp + fp)) + ((fp + tn) * (fn + tn))) / (total * total);
  if (expected === 1) return observed === 1 ? 1 : 0;
  return round4((observed - expected) / (1 - expected));
}

function round4(value) { return Math.round(value * 10000) / 10000; }
