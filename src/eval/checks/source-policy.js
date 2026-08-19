// Metric A: source-policy classification correctness.
// Verifies that research tasks get a research policy and relationship/welcome newsletters skip research,
// by replaying the production sourcePolicyFor() classifier.

import { sourcePolicyFor } from '../../core/runner.js';

export function checkSourcePolicy(input, expect = {}) {
  const errors = [];
  const warnings = [];
  const policy = sourcePolicyFor({ input: String(input.task || ''), workflow: input.workflow || {} });
  if (expect.kind && policy.kind !== expect.kind) {
    errors.push(`source policy kind "${policy.kind}", expected "${expect.kind}"`);
  }
  if (expect.skipResearch !== undefined && policy.skipResearch !== expect.skipResearch) {
    errors.push(`skipResearch=${policy.skipResearch}, expected ${expect.skipResearch}`);
  }
  if (expect.requireCitations !== undefined && policy.requireCitations !== expect.requireCitations) {
    errors.push(`requireCitations=${policy.requireCitations}, expected ${expect.requireCitations}`);
  }
  if (expect.requireOfficial !== undefined && policy.requireOfficial !== expect.requireOfficial) {
    errors.push(`requireOfficial=${policy.requireOfficial}, expected ${expect.requireOfficial}`);
  }
  return { errors, warnings, details: policy };
}
