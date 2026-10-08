import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { knownNumber } from '../lib/cost-telemetry.js';

// One-time, local-only preservation before 14-day task cleanup. Legacy traces
// cover only some calls; never infer current configuration or missing fees.
export function legacyCostEvents(trace, identity, now = Date.now()) {
  const events = [];
  const append = (request, vendor, index) => {
    if (request.cacheHit) return;
    const occurredAt = Date.parse(request.requestStartedAt || request.startedAt || '');
    if (!Number.isFinite(occurredAt) || occurredAt < now - 90 * 86400000 || occurredAt > now) return;
    const value = vendor === 'exa'
      ? (typeof request.costDollars === 'object' ? request.costDollars?.total : request.costDollars)
      : request.cost;
    // Old inference traces replaced absent usage with zero. That zero cannot
    // establish a genuinely free generation; retain it as unknown.
    const costUsd = vendor === 'openrouter' && knownNumber(value) === 0 ? null : knownNumber(value);
    events.push({ attemptId: 'legacy-' + crypto.createHash('sha256').update(`${identity}:${vendor}:${index}:${occurredAt}`).digest('hex'),
      generationId: request.generationId || request.requestId, occurredAt, vendor,
      workflowId: trace.workflowId, stage: request.stage || request.kind || 'legacy-unspecified',
      model: request.resolvedModel || request.requestedModel, provider: request.provider,
      outcome: request.outcome || (request.status === 'ok' ? 'completed' : 'unknown'),
      costUsd, promptTokens: request.promptTokens, completionTokens: request.completionTokens,
      reasoningTokens: request.reasoningTokens, cachedTokens: request.cachedTokens,
      durationMs: request.durationMs, source: 'legacy-trace' });
  };
  for (const group of ['analysisInference', 'translationInference']) {
    for (const [index, request] of (trace[group]?.requests || []).entries()) append(request, 'openrouter', `${group}:${index}`);
  }
  for (const [index, request] of (trace.requests || []).entries()) append(request, 'exa', index);
  return events;
}

export function importLegacyCosts({ costs, workflows, now = Date.now() }) {
  if (costs.importCompleted('legacy-traces')) return { skipped: true };
  let count = 0, bytes = 0, files = 0;
  for (const workflow of Object.values(workflows)) {
    const root = path.join(workflow.workDir, 'runs');
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const filename = path.join(root, entry.name, 'research-trace.json');
      if (!fs.existsSync(filename) || fs.lstatSync(filename).isSymbolicLink()) continue;
      const size = fs.statSync(filename).size;
      if (size > 16 * 1024 * 1024 || bytes + size > 64 * 1024 * 1024 || ++files > 1000) throw new Error('Legacy cost import exceeded bounded scan; traces preserved');
      bytes += size;
      let trace;
      try { trace = JSON.parse(fs.readFileSync(filename, 'utf8')); }
      catch { continue; } // unreadable legacy trace cannot establish usage
      for (const event of legacyCostEvents(trace, `${workflow.id}/${entry.name}`, now)) { costs.record(event); count++; }
    }
  }
  costs.markImportCompleted('legacy-traces');
  return { events: count, files };
}
