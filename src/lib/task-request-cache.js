import crypto from 'node:crypto';
import { costContext } from './cost-context.js';
import { throwIfTaskCancelled } from './task-cancellation.js';

const MAX_CACHED_BYTES = 8 * 1024 * 1024;
export function requestFingerprint(value) {
  const stable = item => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, stable(item[key])]))
    : Array.isArray(item) ? item.map(stable) : item;
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

// Cache lives only in one task's async context, including its generation retries.
// Rejected requests are evicted; no shared freshness or authorization boundary.
export async function reuseTaskRequest(kind, parameters, load, sizeOf = () => 0) {
  const context = costContext();
  throwIfTaskCancelled(context.signal);
  if (!context.requestCache) return { value: await load(), reused: false };
  const key = `${kind}:${requestFingerprint(parameters)}`;
  if (context.requestCache.has(key)) {
    const value = await context.requestCache.get(key);
    throwIfTaskCancelled(context.signal);
    return { value, reused: true };
  }
  if (context.requestCache.size >= 256) return { value: await load(), reused: false };
  const pending = Promise.resolve().then(load);
  context.requestCache.set(key, pending);
  try {
    const value = await pending;
    const bytes = sizeOf(value);
    const total = context.requestCache.cachedBytes || 0;
    if (total + bytes > MAX_CACHED_BYTES) context.requestCache.delete(key);
    else context.requestCache.cachedBytes = total + bytes;
    throwIfTaskCancelled(context.signal);
    return { value, reused: false };
  } catch (error) { context.requestCache.delete(key); throw error; }
}
