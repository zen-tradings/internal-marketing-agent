import { cancellationErrorFromSignal, throwIfTaskCancelled } from '../lib/task-cancellation.js';

export function createResourceGovernor({
  browserConcurrency = 1,
  wechatWriteConcurrency = 1,
  customerioWriteConcurrency = 1,
  openrouterConcurrency = 2,
  exaSearchQps = 8,
  fetchFn = globalThis.fetch,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const resources = new Map([
    ['browser', createSemaphore('browser', browserConcurrency)],
    ['wechat-write', createSemaphore('wechat-write', wechatWriteConcurrency)],
    ['customerio-write', createSemaphore('customerio-write', customerioWriteConcurrency)],
    ['openrouter', createSemaphore('openrouter', openrouterConcurrency)],
  ]);
  const exaSearch = createStartRateGate({ name: 'exa-search', qps: exaSearchQps, now, sleep });

  async function run(name, fn, signal) {
    const resource = resources.get(name);
    if (!resource) throw new Error(`未知资源门禁:${name}`);
    const release = await resource.acquire(signal);
    try { return await fn(); }
    finally { release(); }
  }

  async function governedFetch(resource, options = {}) {
    const url = requestUrl(resource);
    const signal = options?.signal;
    if (isExaSearchUrl(url)) await exaSearch.wait(signal);
    if (!isOpenRouterUrl(url)) return fetchFn(resource, options);

    const first = await run('openrouter', () => fetchFn(resource, options), signal);
    if (![429, 503].includes(Number(first?.status))) return first;
    const retryMs = retryAfterMilliseconds(first?.headers?.get?.('retry-after'), now());
    if (retryMs === null) return first;
    await cancellableSleep(Math.min(retryMs, 60_000), signal, sleep);
    return run('openrouter', () => fetchFn(resource, options), signal);
  }

  return {
    run,
    acquire(name, signal) {
      const resource = resources.get(name);
      if (!resource) throw new Error(`未知资源门禁:${name}`);
      return resource.acquire(signal);
    },
    fetch: governedFetch,
    stats() {
      return {
        browser: resources.get('browser').stats(),
        wechatWrite: resources.get('wechat-write').stats(),
        customerioWrite: resources.get('customerio-write').stats(),
        openrouter: resources.get('openrouter').stats(),
        exaSearch: exaSearch.stats(),
      };
    },
  };
}

export function createSemaphore(name, limit = 1) {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error(`${name} concurrency 必须是正整数`);
  let active = 0;
  const waiters = [];

  function dispatch() {
    while (active < limit && waiters.length) {
      const waiter = waiters.shift();
      if (waiter.signal?.aborted) {
        waiter.cleanup();
        waiter.reject(cancellationErrorFromSignal(waiter.signal));
        continue;
      }
      active += 1;
      waiter.cleanup();
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        active -= 1;
        dispatch();
      });
    }
  }

  function acquire(signal) {
    throwIfTaskCancelled(signal);
    return new Promise((resolve, reject) => {
      const waiter = {
        signal,
        resolve,
        reject,
        cleanup() { if (signal && waiter.onAbort) signal.removeEventListener('abort', waiter.onAbort); },
      };
      waiter.onAbort = () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        waiter.cleanup();
        reject(cancellationErrorFromSignal(signal));
      };
      if (signal) signal.addEventListener('abort', waiter.onAbort, { once: true });
      waiters.push(waiter);
      dispatch();
    });
  }

  return { acquire, stats: () => ({ active, waiting: waiters.length, limit }) };
}

function createStartRateGate({ name, qps, now, sleep }) {
  if (!Number.isFinite(qps) || qps <= 0) throw new Error(`${name} QPS 必须是正数`);
  const intervalMs = 1000 / qps;
  let nextAt = 0;
  let waiting = 0;
  return {
    async wait(signal) {
      throwIfTaskCancelled(signal);
      const scheduledAt = Math.max(now(), nextAt);
      nextAt = scheduledAt + intervalMs;
      const delay = Math.max(0, scheduledAt - now());
      if (!delay) return;
      waiting += 1;
      try { await cancellableSleep(delay, signal, sleep); }
      finally { waiting -= 1; }
    },
    stats: () => ({ waiting, qps }),
  };
}

async function cancellableSleep(ms, signal, sleep) {
  throwIfTaskCancelled(signal);
  if (!signal) return sleep(ms);
  let onAbort;
  try {
    await Promise.race([
      Promise.resolve().then(() => sleep(ms)),
      new Promise((_, reject) => {
        onAbort = () => reject(cancellationErrorFromSignal(signal));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function requestUrl(resource) {
  if (typeof resource === 'string' || resource instanceof URL) return String(resource);
  return String(resource?.url || '');
}

function isOpenRouterUrl(value) {
  try { return /(^|\.)openrouter\.ai$/i.test(new URL(value).hostname); }
  catch { return false; }
}

function isExaSearchUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)exa\.ai$/i.test(url.hostname) && /\/search\/?$/.test(url.pathname);
  } catch { return false; }
}

export function retryAfterMilliseconds(value, now = Date.now()) {
  const text = String(value || '').trim();
  if (!text) return null;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}
