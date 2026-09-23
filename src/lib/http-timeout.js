import { manageResponseBody } from './response-lifecycle.js';

export async function fetchWithTimeout(fetchFn, resource, options = {}, {
  timeoutMs = 30000,
  signal,
  label = 'HTTP',
} = {}) {
  const controller = new AbortController();
  const timeoutError = Object.assign(new Error(`${label} 请求超时(${timeoutMs}ms)`), {
    code: 'ETIMEDOUT', name: 'AbortError',
  });
  const signals = [options.signal, signal, controller.signal].filter(Boolean);
  const requestSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(requestSignal.reason);
    if (requestSignal.aborted) onAbort();
    else requestSignal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const cleanup = () => {
    clearTimeout(timer);
    requestSignal.removeEventListener('abort', onAbort);
  };
  try {
    const response = await Promise.race([
      Promise.resolve().then(async () => {
        if (requestSignal.aborted) throw requestSignal.reason;
        const result = await fetchFn(resource, { ...options, signal: requestSignal });
        // An injected transport may ignore cancellation and resolve late. Close
        // that response too, so abandoning an attempt cannot leak its body.
        if (requestSignal.aborted) {
          try { await result?.body?.cancel?.(requestSignal.reason); } catch {}
          throw requestSignal.reason;
        }
        return result;
      }),
      aborted,
    ]);
    return manageResponseBody(response, { signal: requestSignal, onDone: cleanup });
  } catch (error) {
    cleanup();
    if (controller.signal.aborted && !options.signal?.aborted && !signal?.aborted) throw timeoutError;
    throw error;
  }
}
