import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeStrategy, expirationPayoff, checkOptionsStrategy } from '../src/eval/checks/options-strategy.js';

test('long call: breakeven = strike + premium, max loss = premium', () => {
  const result = analyzeStrategy([{ type: 'call', action: 'buy', strike: 100, premium: 5 }]);
  assert.deepEqual(result.breakevens, [105]);
  assert.equal(result.maxLoss, 5);
  assert.equal(result.maxProfit, Infinity);
});

test('long put: breakeven = strike - premium, max loss = premium', () => {
  const result = analyzeStrategy([{ type: 'put', action: 'buy', strike: 100, premium: 4 }]);
  assert.deepEqual(result.breakevens, [96]);
  assert.equal(result.maxLoss, 4);
  assert.equal(result.maxProfit, 96); // stock to zero
});

test('bull call spread: breakeven, capped loss and profit', () => {
  const legs = [
    { type: 'call', action: 'buy', strike: 100, premium: 5 },
    { type: 'call', action: 'sell', strike: 110, premium: 2 },
  ];
  const result = analyzeStrategy(legs);
  assert.deepEqual(result.breakevens, [103]);
  assert.equal(result.maxLoss, 3);
  assert.equal(result.maxProfit, 7);
  assert.equal(expirationPayoff(legs, 120), 7);
  assert.equal(expirationPayoff(legs, 90), -3);
});

test('short straddle has two breakevens', () => {
  const result = analyzeStrategy([
    { type: 'call', action: 'sell', strike: 100, premium: 4 },
    { type: 'put', action: 'sell', strike: 100, premium: 3 },
  ]);
  assert.deepEqual(result.breakevens, [93, 107]);
  assert.equal(result.unboundedLoss, true);
  assert.equal(result.maxLoss, Infinity);
});

test('covered call is bounded: stock leg offsets the short call', () => {
  const result = analyzeStrategy([
    { type: 'stock', action: 'buy', price: 100 },
    { type: 'call', action: 'sell', strike: 110, premium: 3 },
  ]);
  assert.equal(result.unboundedLoss, false);
  assert.equal(result.maxLoss, 97); // stock to zero minus premium
  assert.deepEqual(result.breakevens, [97]);
  assert.equal(result.maxProfit, 13);
});

test('checker flags a stated max loss on an unlimited-risk position', () => {
  const outcome = checkOptionsStrategy({
    strategy: { legs: [{ type: 'call', action: 'sell', strike: 100, premium: 3 }] },
    chain: { strikes: [100] },
    stated: { breakevens: [103], maxLoss: 3 },
  });
  assert.ok(outcome.errors.some((error) => /unlimited risk/.test(error)));
});

test('checker flags strikes missing from the chain and wrong breakevens', () => {
  const outcome = checkOptionsStrategy({
    strategy: { legs: [{ type: 'call', action: 'buy', strike: 102.5, premium: 5 }] },
    chain: { strikes: [100, 105] },
    stated: { breakevens: [110], maxLoss: 5 },
  });
  assert.ok(outcome.errors.some((error) => /does not exist in the supplied option chain/.test(error)));
  assert.ok(outcome.errors.some((error) => /stated breakeven 110/.test(error)));
});

test('checker requires max loss disclosure and warns without a chain', () => {
  const outcome = checkOptionsStrategy({
    strategy: { legs: [{ type: 'put', action: 'buy', strike: 100, premium: 4 }] },
    stated: { breakevens: [96] },
  });
  assert.ok(outcome.errors.some((error) => /max loss is not disclosed/.test(error)));
  assert.ok(outcome.warnings.some((warning) => /no option chain supplied/.test(warning)));
});

test('tolerance: near-equal stated values pass', () => {
  const outcome = checkOptionsStrategy({
    strategy: { legs: [{ type: 'call', action: 'buy', strike: 100, premium: 5 }] },
    chain: { strikes: [100] },
    stated: { breakevens: [105.04], maxLoss: 5.01 },
  });
  assert.deepEqual(outcome.errors, []);
});
