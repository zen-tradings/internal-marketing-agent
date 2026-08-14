export async function fetchWithTimeout(fetchFn, resource, options = {}, {
  timeoutMs = 30000,
  signal,
  label = 'HTTP',
} = {}) {
  const controller = new AbortController();
  const timeoutError = Object.assign(new Error(`${label} 请求超时(${timeoutMs}ms)`), {
    code: 'ETIMEDOUT',
  });
  const signals = [options.signal, signal, controller.signal].filter(Boolean);
  const requestSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (requestSignal?.aborted) throw requestSignal.reason;
        return fetchFn(resource, { ...options, signal: requestSignal });
      }),
      timeout,
    ]);
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted && !signal?.aborted) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
