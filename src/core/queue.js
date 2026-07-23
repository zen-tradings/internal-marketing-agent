export function createQueue({ store, maxConcurrency = 1, maxQueueSize = 100, handler }) {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency <= 0) throw new Error('maxConcurrency 必须是正整数');
  if (!Number.isInteger(maxQueueSize) || maxQueueSize <= 0) throw new Error('maxQueueSize 必须是正整数');
  const pending = [];
  let active = 0;
  let stopped = false;
  const idleWaiters = new Set();

  function settleIdle() {
    if (active !== 0 || (!stopped && pending.length)) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  function schedule() {
    if (stopped) { settleIdle(); return; }
    while (active < maxConcurrency && pending.length) {
      const run = pending.shift();
      active++;
      Promise.resolve()
        .then(() => handler(run))
        .catch((e) => {
          console.error(`[queue] run ${run.id} 失败:`, e?.message);
          try {
            const row = store.getRun?.(run.id);
            if (row && ['queued', 'running'].includes(row.status)) {
              store.setStatus(run.id, 'failed', {
                stage: 'internal',
                error: String(e?.message || e).slice(0, 500),
                finishedAt: Date.now(),
              });
            }
          } catch {}
        })
        .finally(() => { active--; schedule(); settleIdle(); });
    }
    settleIdle();
  }

  function push(task, persist) {
    if (stopped) throw new Error('队列正在关闭，暂不接受新任务');
    if (pending.length >= maxQueueSize) throw new Error(`队列已满(${maxQueueSize})`);
    if (persist) store.createRun(task);
    pending.push(task);
    schedule();
    return task;
  }

  return {
    enqueue(task) {
      return push(task, true);
    },
    restore(task) {
      return push(task, false);
    },
    stop() {
      stopped = true;
      settleIdle();
    },
    whenIdle() {
      if (active === 0 && (stopped || pending.length === 0)) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.add(resolve));
    },
    stats() {
      return { active, pending: pending.length, stopped };
    },
  };
}
