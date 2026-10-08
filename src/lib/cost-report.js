import { knownNumber } from './cost-telemetry.js';

export function summarizeCosts(events) {
  const summary = { requests: 0, legacyTraceRequests: 0, knownCostRequests: 0, unknownCostRequests: 0,
    knownCostUsd: 0, emptyCostUsd: 0, errorCostUsd: 0, cachedTokens: 0,
    byVendor: {}, byWorkflow: {}, byStage: {}, byModel: {} };
  for (const event of events) {
    summary.requests++;
    if (event.source === 'legacy-trace') summary.legacyTraceRequests++;
    const cost = knownNumber(event.costUsd);
    if (cost === null) summary.unknownCostRequests++;
    else { summary.knownCostRequests++; summary.knownCostUsd += cost; }
    if (event.outcome === 'empty') summary.emptyCostUsd += cost || 0;
    if (event.outcome === 'error') summary.errorCostUsd += cost || 0;
    summary.cachedTokens += event.cachedTokens || 0;
    for (const [group, key] of [['byVendor', 'vendor'], ['byWorkflow', 'workflowId'], ['byStage', 'stage'], ['byModel', 'model']]) {
      const bucket = summary[group][event[key] || 'unknown'] ||= { requests: 0, knownCostUsd: 0, unknownCostRequests: 0 };
      bucket.requests++; bucket.knownCostUsd += cost || 0;
      if (cost === null) bucket.unknownCostRequests++;
    }
  }
  return summary;
}

export function costPeriods(events, { month, timezone = 'America/Los_Angeles', now = Date.now(), configurationId } = {}) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit' });
  const monthOf = timestamp => {
    const parts = formatter.formatToParts(new Date(timestamp));
    return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}`;
  };
  const selectedMonth = month || monthOf(now);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(selectedMonth)) throw new Error('Month must be YYYY-MM');
  return {
    timezone,
    calendarMonth: { month: selectedMonth, completed: selectedMonth < monthOf(now),
      ...summarizeCosts(events.filter(event => monthOf(event.occurredAt) === selectedMonth)) },
    rolling30Days: summarizeCosts(events.filter(event => event.occurredAt >= now - 30 * 86400000 && event.occurredAt <= now)),
    currentConfiguration: configurationId ? { configurationId,
      ...summarizeCosts(events.filter(event => event.configurationId === configurationId && event.occurredAt >= now - 30 * 86400000 && event.occurredAt <= now)) } : null,
  };
}
