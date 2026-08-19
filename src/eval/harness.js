// Eval harness: dispatches labeled cases to checkers (Metric A) and emits verdicts consumable by
// the meta-eval (Metric B). A case passes when its checker verdict matches the ground-truth label:
//   expect.defect=true  -> the checker must flag at least one error (otherwise: false negative)
//   expect.defect=false -> the checker must stay clean          (otherwise: false positive)
// Kind-specific expectations (workflowId, kind, ...) are validated inside each checker.

import { resolveText, resolveJson } from './cases.js';
import { checkRouting } from './checks/routing.js';
import { checkSourcePolicy } from './checks/source-policy.js';
import { checkCitations } from './checks/citations.js';
import { checkGates } from './checks/gates.js';
import { checkOpeningDigestLimits } from './checks/opening-digest.js';
import { checkOptionsStrategy } from './checks/options-strategy.js';
import { checkQdiiReconcile } from './checks/qdii-reconcile.js';

export async function runCase(entry) {
  const { kind, input, expect = {}, baseDir } = entry;
  let outcome;
  try {
    if (kind === 'routing') outcome = await checkRouting(input, expect);
    else if (kind === 'source-policy') outcome = checkSourcePolicy(input, expect);
    else if (kind === 'citation-grounding') {
      outcome = checkCitations(input, expect, {
        article: resolveText(input, baseDir, 'article', 'articlePath'),
        allowedUrls: input.allowedUrls ?? traceUrls(resolveJson(input, baseDir, 'trace', 'tracePath')),
      });
    } else if (kind === 'gates') {
      outcome = checkGates(input, expect, { markdown: resolveText(input, baseDir, 'markdown', 'markdownPath') });
    } else if (kind === 'opening-digest-limits') {
      outcome = checkOpeningDigestLimits(input, expect, { article: resolveText(input, baseDir, 'article', 'articlePath') });
    } else if (kind === 'options-strategy') outcome = checkOptionsStrategy(input, expect);
    else if (kind === 'qdii-reconcile') {
      outcome = checkQdiiReconcile(input, expect, { payload: resolveJson(input, baseDir, 'payload', 'payloadPath') });
    } else throw new Error(`no checker for kind: ${kind}`);
  } catch (error) {
    outcome = { errors: [`checker crashed: ${String(error?.message || error)}`], warnings: [] };
  }

  const flagged = outcome.errors.length > 0;
  const groundTruthDefect = expect.defect === true;
  const passed = expect.defect === undefined ? !flagged : flagged === groundTruthDefect;
  return {
    id: entry.id,
    kind,
    passed,
    flagged,
    groundTruthDefect: expect.defect,
    labelSource: entry.labelSource === 'independent' ? 'independent' : 'fixture',
    errors: outcome.errors,
    warnings: outcome.warnings,
    details: outcome.details,
  };
}

export async function runCases(cases) {
  const results = [];
  for (const entry of cases) results.push(await runCase(entry));
  return results;
}

export function summarize(results) {
  const byKind = {};
  for (const result of results) {
    const bucket = byKind[result.kind] ||= { total: 0, passed: 0 };
    bucket.total += 1;
    if (result.passed) bucket.passed += 1;
  }
  return {
    total: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    byKind,
  };
}

function traceUrls(trace) {
  if (!trace) return undefined;
  return (trace.selectedSources || []).map((source) => source?.url).filter(Boolean);
}
