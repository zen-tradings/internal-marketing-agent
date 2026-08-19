// Metric A: routing correctness against a labeled set.
// Replays the production Slack router (deterministic rules first, optional stubbed model classifier)
// and compares the chosen workflow with the labeled answer. Never calls the network: pass
// input.classifyResult to simulate the model-classifier fallback.

import { resolveNaturalWorkflowTask } from '../../triggers/slack.js';

export const DEFAULT_WORKFLOW_IDS = [
  'wechat', 'sector', 'company', 'earnings', 'macro', 'morning', 'translate', 'email', 'qdii', 'opening-digest',
];

export async function checkRouting(input, expect = {}) {
  const errors = [];
  const warnings = [];
  const workflowIds = Array.isArray(input.workflowIds) && input.workflowIds.length
    ? input.workflowIds
    : DEFAULT_WORKFLOW_IDS;
  const route = await resolveNaturalWorkflowTask(String(input.task || ''), {
    workflowIds,
    defaultWorkflowId: input.defaultWorkflowId || 'wechat',
    previousWorkflowId: input.previousWorkflowId,
    classify: input.classifyResult !== undefined ? async () => input.classifyResult : undefined,
  });
  if (expect.workflowId && route.workflowId !== expect.workflowId) {
    errors.push(`routed to "${route.workflowId}" (reason: ${route.reason}), expected "${expect.workflowId}"`);
  }
  if (expect.reason && route.reason !== expect.reason) {
    warnings.push(`route reason "${route.reason}" differs from expected "${expect.reason}"`);
  }
  return { errors, warnings, details: { workflowId: route.workflowId, reason: route.reason } };
}
