import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();
export const COST_STAGE = Symbol('zen.costStage');
export function costContext() { return context.getStore() || {}; }
export function withCostContext(fields, fn) {
  const parent = costContext();
  const next = { ...parent, ...fields };
  if (fields.runId && fields.runId !== parent.runId && !fields.requestCache) {
    next.requestCache = new Map(); next.cacheBytes = 0; next.signal = fields.signal;
  }
  return context.run(next, fn);
}
