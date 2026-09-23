import { fetchWithTimeout } from './http-timeout.js';


// Expand undici's generic "fetch failed" into diagnostic information with the underlying cause.
export function describeFetchError(e) {
  if (!e) return 'unknown error';
  const cause = e.cause;
  const causePart = cause ? ` (cause: ${cause.code || cause.message || cause.name || String(cause)})` : '';
  return `${e.message || e}${causePart}`;
}

// Identify retryable transient network errors such as dropped connections, TLS jitter, and timeouts; do not retry AbortError.
export function isTransientNetworkError(e) {
  if (!e || e.name === 'AbortError') return false;
  const msg = String(e.message || '');
  const code = String((e.cause && (e.cause.code || e.cause.name)) || e.code || '');
  return /fetch failed|network|socket|TLS|SSL|terminated/i.test(msg)
    || /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EPIPE|UND_ERR/i.test(`${code} ${msg}`);
}

// Retry only transient fetch-thrown network errors with backoff, never HTTP responses including 4xx/5xx. When
// opts.timeoutMs is present, wrap each attempt in a fresh AbortController; timeout aborts it as AbortError, which
// is not transient and is propagated to the caller's fallback logic.
export async function fetchWithRetry(fetchFn, url, options, opts = {}) {
  const {
    attempts = 3,
    backoffMs = [500, 1500, 4000],
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    timeoutMs,
    retryStatuses = [408, 425, 429, 500, 502, 503, 504],
  } = opts;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const response = timeoutMs
        ? await fetchWithTimeout(fetchFn, url, options, { timeoutMs })
        : await fetchFn(url, options);
      if (!retryStatuses.includes(response?.status) || i === attempts - 1) return response;
      try { await response.body?.cancel?.(); } catch {}
      const retryAfterMs = retryAfterDelay(response);
      await sleep(retryAfterMs ?? backoffMs[Math.min(i, backoffMs.length - 1)]);
    } catch (e) {
      lastErr = e;
      if (!isTransientNetworkError(e)) throw e; // Preserve non-transient error identity, including AbortError.
      if (i === attempts - 1) break;
      await sleep(backoffMs[Math.min(i, backoffMs.length - 1)]);
    }
  }
  const err = new Error(`网络请求失败(重试 ${attempts} 次后放弃): ${describeFetchError(lastErr)}`);
  err.cause = lastErr;
  throw err;
}

export function retryAfterDelay(response) {
  const value = response?.headers?.get?.('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30000);
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, Math.min(at - Date.now(), 30000));
}
