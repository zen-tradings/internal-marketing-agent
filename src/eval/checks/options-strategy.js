// Metric A: options-strategy arithmetic gate.
// Recomputes expiration breakevens and max loss from the strategy legs and compares them with the
// values stated in the draft; verifies every strike exists in the supplied chain. Pure math, no data
// fetch: the chain must be provided by the caller (fixture or captured quote snapshot).
//
// Leg shape: { type: 'call'|'put'|'stock', action: 'buy'|'sell', strike?, premium?, price?, qty? }
// Payoff is per share at expiration; qty defaults to 1.

const DEFAULT_ABS_TOL = 0.05;
const DEFAULT_REL_TOL = 0.01;

export function expirationPayoff(legs, spot) {
  let total = 0;
  for (const leg of legs) {
    const qty = Number(leg.qty || 1);
    const sign = leg.action === 'sell' ? -1 : 1;
    if (leg.type === 'stock') {
      total += sign * qty * (spot - Number(leg.price ?? leg.strike ?? 0));
      continue;
    }
    const strike = Number(leg.strike);
    const premium = Number(leg.premium || 0);
    const intrinsic = leg.type === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
    total += sign * qty * (intrinsic - premium);
  }
  return total;
}

export function analyzeStrategy(legs) {
  validateLegs(legs);
  const strikes = legs.filter((leg) => leg.type !== 'stock').map((leg) => Number(leg.strike));
  const maxStrike = strikes.length ? Math.max(...strikes) : 100;
  const far = maxStrike * 3 + 100;
  const knots = [...new Set([0, ...strikes, far])].sort((a, b) => a - b);
  const values = knots.map((spot) => expirationPayoff(legs, spot));

  // Slope above the highest strike: all calls are in the money, puts are worthless.
  let upSlope = 0;
  for (const leg of legs) {
    const qty = Number(leg.qty || 1) * (leg.action === 'sell' ? -1 : 1);
    if (leg.type === 'call' || leg.type === 'stock') upSlope += qty;
  }
  const unboundedLoss = upSlope < -1e-9;
  const maxLoss = unboundedLoss ? Infinity : -Math.min(...values, 0);
  const unboundedProfit = upSlope > 1e-9;
  const maxProfit = unboundedProfit ? Infinity : Math.max(...values, 0);

  const breakevens = [];
  for (let i = 0; i < knots.length; i += 1) {
    if (Math.abs(values[i]) < 1e-9 && knots[i] > 0) pushUnique(breakevens, knots[i]);
    if (i + 1 < knots.length && values[i] * values[i + 1] < 0) {
      const x = knots[i] + (knots[i + 1] - knots[i]) * (-values[i] / (values[i + 1] - values[i]));
      pushUnique(breakevens, round2(x));
    }
  }
  return { breakevens: breakevens.map(round2), maxLoss: finiteRound(maxLoss), maxProfit: finiteRound(maxProfit), unboundedLoss };
}

export function checkOptionsStrategy(input, expect = {}) {
  const errors = [];
  const warnings = [];
  const legs = input.strategy?.legs;
  let computed;
  try { computed = analyzeStrategy(legs); }
  catch (error) { return { errors: [String(error?.message || error)], warnings, details: {} }; }

  const chainStrikes = input.chain?.strikes;
  if (Array.isArray(chainStrikes) && chainStrikes.length) {
    const available = new Set(chainStrikes.map(Number));
    for (const leg of legs) {
      if (leg.type === 'stock') continue;
      if (!available.has(Number(leg.strike))) {
        errors.push(`strike ${leg.strike} does not exist in the supplied option chain`);
      }
    }
  } else {
    warnings.push('no option chain supplied; strike existence not verified');
  }

  const stated = input.stated || {};
  const tol = (value) => Math.max(
    Number(input.absTolerance ?? DEFAULT_ABS_TOL),
    Number(input.relTolerance ?? DEFAULT_REL_TOL) * Math.abs(value),
  );

  if (Array.isArray(stated.breakevens) && stated.breakevens.length) {
    for (const statedBe of stated.breakevens) {
      const nearest = computed.breakevens.find((be) => Math.abs(be - Number(statedBe)) <= tol(be));
      if (nearest === undefined) {
        errors.push(`stated breakeven ${statedBe} does not match recomputed breakevens [${computed.breakevens.join(', ')}]`);
      }
    }
    if (stated.breakevens.length !== computed.breakevens.length) {
      warnings.push(`stated ${stated.breakevens.length} breakeven(s) but the strategy has ${computed.breakevens.length}`);
    }
  } else {
    warnings.push('no breakeven stated in the draft');
  }

  if (stated.maxLoss === undefined || stated.maxLoss === null) {
    errors.push('max loss is not disclosed');
  } else if (computed.unboundedLoss) {
    errors.push(`stated max loss ${stated.maxLoss} but the position has unlimited risk`);
  } else if (Math.abs(Number(stated.maxLoss) - computed.maxLoss) > tol(computed.maxLoss)) {
    errors.push(`stated max loss ${stated.maxLoss} does not match recomputed ${computed.maxLoss}`);
  }

  if (stated.maxProfit !== undefined && stated.maxProfit !== null && Number.isFinite(computed.maxProfit)
    && Math.abs(Number(stated.maxProfit) - computed.maxProfit) > tol(computed.maxProfit)) {
    errors.push(`stated max profit ${stated.maxProfit} does not match recomputed ${computed.maxProfit}`);
  }

  return { errors, warnings, details: { computed } };
}

function validateLegs(legs) {
  if (!Array.isArray(legs) || !legs.length) throw new Error('strategy.legs must be a non-empty array');
  for (const leg of legs) {
    if (!['call', 'put', 'stock'].includes(leg.type)) throw new Error(`invalid leg type: ${leg.type}`);
    if (!['buy', 'sell'].includes(leg.action)) throw new Error(`invalid leg action: ${leg.action}`);
    if (leg.type !== 'stock') {
      if (!Number.isFinite(Number(leg.strike)) || Number(leg.strike) <= 0) throw new Error('option leg needs a positive strike');
      if (!Number.isFinite(Number(leg.premium)) || Number(leg.premium) < 0) throw new Error('option leg needs a non-negative premium');
    }
  }
}

function pushUnique(list, value) {
  if (!list.some((existing) => Math.abs(existing - value) < 1e-6)) list.push(value);
}

function round2(value) { return Math.round(value * 100) / 100; }
function finiteRound(value) { return Number.isFinite(value) ? round2(value) : value; }
