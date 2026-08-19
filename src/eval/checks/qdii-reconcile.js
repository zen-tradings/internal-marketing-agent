// Metric A: QDII reply reconciliation. Numbers in the Slack reply must match the structured
// qdii-result.json payload: fund code and report period present, every stated holding weight equal
// to the source navRatioPct within tolerance, and no full-portfolio claim for top10 disclosure.

const DEFAULT_TOLERANCE_PCT_POINTS = 0.05;
const FULL_CLAIM_RE = /\b(?:full|complete|entire|all)\s+(?:portfolio|holdings?)\b|完整持仓|全部持仓|所有持仓/i;

export function reconcileQdiiReply(reply, payload, { tolerancePctPoints = DEFAULT_TOLERANCE_PCT_POINTS } = {}) {
  const errors = [];
  const warnings = [];
  const text = String(reply || '');
  const results = Array.isArray(payload?.results) ? payload.results : [];
  if (!results.length) return { errors: ['payload has no fund results to reconcile against'], warnings, details: {} };

  let checkedHoldings = 0;
  let statedHoldings = 0;
  for (const fund of results) {
    if (fund.code && !text.includes(String(fund.code))) {
      errors.push(`reply does not mention fund code ${fund.code}`);
    }
    const periodKey = fund.reportPeriod?.key;
    if (periodKey && !text.includes(periodKey) && !(fund.reportPeriod?.end && text.includes(fund.reportPeriod.end))) {
      errors.push(`reply does not state the report period ${periodKey} for fund ${fund.code}`);
    }
    if (fund.disclosureScope === 'top10' && FULL_CLAIM_RE.test(text)) {
      errors.push('reply claims full portfolio coverage but the source disclosure is top10 only');
    }
    for (const holding of fund.holdings || []) {
      checkedHoldings += 1;
      const stated = statedWeightNear(text, holding.securityName);
      if (stated === undefined) continue;
      statedHoldings += 1;
      if (Math.abs(stated - holding.navRatioPct) > tolerancePctPoints) {
        errors.push(`holding ${holding.securityName}: reply states ${stated}% but source has ${holding.navRatioPct}%`);
      }
    }
  }
  if (checkedHoldings && statedHoldings === 0) {
    warnings.push('reply states no holding weights; nothing to reconcile numerically');
  } else if (checkedHoldings && statedHoldings < checkedHoldings / 2) {
    warnings.push(`reply states weights for only ${statedHoldings}/${checkedHoldings} holdings`);
  }
  return { errors, warnings, details: { checkedHoldings, statedHoldings } };
}

export function checkQdiiReconcile(input, expect = {}, { reply, payload } = {}) {
  return reconcileQdiiReply(reply ?? input.reply, payload ?? input.payload, {
    tolerancePctPoints: input.tolerancePctPoints,
  });
}

// Find a percentage stated on the same line as the holding name.
function statedWeightNear(text, name) {
  if (!name) return undefined;
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line.includes(name)) continue;
    const match = line.match(/(\d+(?:\.\d+)?)\s*%/);
    if (match) return Number(match[1]);
  }
  return undefined;
}
