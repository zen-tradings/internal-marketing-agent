// Metric C: value metrics. Pure statistics over externally collected data:
// - expectancySummary: do proposed strategies beat a baseline over historical outcomes?
// - aggregateReaderFeedback: satisfied/not-satisfied clicks from the newsletter footer buttons.
// - normalizedEditDistance: how much a human editor had to rewrite the draft before sending.
// Data collection (backtest fills, Customer.io click exports, final sent copies) happens outside
// this module; these functions only answer the questions given the data.

export function expectancySummary(returns, baselineReturns = []) {
  const values = (returns || []).map(Number).filter(Number.isFinite);
  if (!values.length) return { count: 0 };
  const mean = avg(values);
  const sd = stddev(values, mean);
  const wins = values.filter((value) => value > 0).length;
  const baseline = (baselineReturns || []).map(Number).filter(Number.isFinite);
  const baselineMean = baseline.length ? avg(baseline) : null;
  return {
    count: values.length,
    mean: round4(mean),
    median: round4(median(values)),
    stddev: round4(sd),
    winRate: round4(wins / values.length),
    total: round4(values.reduce((sum, value) => sum + value, 0)),
    // One-sample t statistic for mean > 0; treat |t| >= 2 as roughly significant.
    tStat: sd > 0 ? round4(mean / (sd / Math.sqrt(values.length))) : null,
    baselineMean: baselineMean === null ? null : round4(baselineMean),
    meanExcessVsBaseline: baselineMean === null ? null : round4(mean - baselineMean),
    beatsBaseline: baselineMean === null ? null : mean > baselineMean,
  };
}

// events: [{ rating: 'positive'|'negative', edition? }] — from feedback-URL click exports.
export function aggregateReaderFeedback(events) {
  const summary = { total: 0, positive: 0, negative: 0, satisfiedRate: null, byEdition: {} };
  for (const event of events || []) {
    const rating = String(event?.rating || '').toLowerCase();
    if (rating !== 'positive' && rating !== 'negative') continue;
    summary.total += 1;
    summary[rating] += 1;
    if (event.edition) {
      const bucket = summary.byEdition[event.edition] ||= { total: 0, positive: 0, negative: 0 };
      bucket.total += 1;
      bucket[rating] += 1;
    }
  }
  if (summary.total) summary.satisfiedRate = round4(summary.positive / summary.total);
  for (const bucket of Object.values(summary.byEdition)) {
    bucket.satisfiedRate = bucket.total ? round4(bucket.positive / bucket.total) : null;
  }
  return summary;
}

// Word-level Levenshtein distance normalized to [0, 1]. 0 = sent as drafted; 1 = fully rewritten.
export function normalizedEditDistance(draft, finalText) {
  const a = tokenize(draft);
  const b = tokenize(finalText);
  if (!a.length && !b.length) return 0;
  const distance = levenshtein(a, b);
  return round4(distance / Math.max(a.length, b.length));
}

function tokenize(text) {
  return String(text || '').toLowerCase().split(/\s+/).filter(Boolean);
}

function levenshtein(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function avg(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stddev(values, mean) {
  if (values.length < 2) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

function round4(value) { return Math.round(value * 10000) / 10000; }
