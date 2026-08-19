import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectancySummary, aggregateReaderFeedback, normalizedEditDistance } from '../src/eval/value.js';

test('expectancySummary computes mean, win rate, and baseline comparison', () => {
  const summary = expectancySummary([1, -0.5, 2, -0.5, 3], [0.2, 0.2, 0.2, 0.2, 0.2]);
  assert.equal(summary.count, 5);
  assert.equal(summary.mean, 1);
  assert.equal(summary.winRate, 0.6);
  assert.equal(summary.baselineMean, 0.2);
  assert.equal(summary.meanExcessVsBaseline, 0.8);
  assert.equal(summary.beatsBaseline, true);
  assert.ok(summary.tStat > 0);
});

test('expectancySummary handles empty input and missing baseline', () => {
  assert.deepEqual(expectancySummary([]), { count: 0 });
  const summary = expectancySummary([1, 2]);
  assert.equal(summary.baselineMean, null);
  assert.equal(summary.beatsBaseline, null);
});

test('aggregateReaderFeedback computes satisfied rate overall and by edition', () => {
  const summary = aggregateReaderFeedback([
    { rating: 'positive', edition: 'Vol. 1' },
    { rating: 'negative', edition: 'Vol. 1' },
    { rating: 'positive', edition: 'Vol. 2' },
    { rating: 'invalid' },
  ]);
  assert.equal(summary.total, 3);
  assert.equal(summary.satisfiedRate, 0.6667);
  assert.equal(summary.byEdition['Vol. 1'].satisfiedRate, 0.5);
  assert.equal(summary.byEdition['Vol. 2'].satisfiedRate, 1);
});

test('normalizedEditDistance: 0 for identical, 1 for fully rewritten, fraction for partial edits', () => {
  assert.equal(normalizedEditDistance('same words here', 'same words here'), 0);
  assert.equal(normalizedEditDistance('alpha beta', 'gamma delta'), 1);
  const partial = normalizedEditDistance('the quick brown fox jumps', 'the quick red fox jumps');
  assert.equal(partial, 0.2);
  assert.equal(normalizedEditDistance('', ''), 0);
});
