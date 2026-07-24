import { createTaskCancelledError } from '../lib/task-cancellation.js';

export function createQueue({ store, maxConcurrency = 1, maxQueueSize = 100, handler }) {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency <= 0) throw new Error('maxConcurrency 必须是正整数');
  if (!Number.isInteger(maxQueueSize) || maxQueueSize <= 0) throw new Error('maxQueueSize 必须是正整数');
  const pending = [];
  const activeRuns = new Map();
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
      const controller = new AbortController();
      let resolveDone;
      const entry = {
        run,
        controller,
        phase: 'starting',
        done: new Promise((resolve) => { resolveDone = resolve; }),
      };
      activeRuns.set(run.id, entry);
      active++;
      Promise.resolve()
        .then(() => handler(run, {
          signal: controller.signal,
          setPhase(phase) { entry.phase = String(phase || 'unknown'); },
        }))
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
        .finally(() => {
          activeRuns.delete(run.id);
          active--;
          resolveDone();
          schedule();
          settleIdle();
        });
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

  function matches(run, { runId, channel, user }) {
    if (runId) return run.id === runId;
    let notify = run.notify;
    if ((!notify?.channel || (user && !notify?.user)) && store.getRun) {
      try { notify = { ...JSON.parse(store.getRun(run.id)?.notify_json || '{}'), ...notify }; }
      catch {}
    }
    if (channel && notify?.channel !== channel) return false;
    if (user && notify?.user && notify.user !== user) return false;
    return Boolean(channel || user);
  }

  function cancel({ runId, channel, user, reason = '用户通过 Slack 停止任务' } = {}) {
    const activeEntry = [...activeRuns.values()]
      .reverse()
      .find((entry) => matches(entry.run, { runId, channel, user }));
    if (activeEntry) {
      if (['publish', 'published'].includes(activeEntry.phase)) {
        return { kind: 'too-late', run: activeEntry.run, phase: activeEntry.phase };
      }
      if (activeEntry.controller.signal.aborted) {
        return { kind: 'stopping', run: activeEntry.run, phase: activeEntry.phase, done: activeEntry.done };
      }
      activeEntry.controller.abort(createTaskCancelledError(reason));
      return { kind: 'active', run: activeEntry.run, phase: activeEntry.phase, done: activeEntry.done };
    }

    let pendingIndex = -1;
    for (let index = pending.length - 1; index >= 0; index--) {
      if (matches(pending[index], { runId, channel, user })) {
        pendingIndex = index;
        break;
      }
    }
    if (pendingIndex >= 0) {
      const [run] = pending.splice(pendingIndex, 1);
      store.setStatus(run.id, 'cancelled', {
        stage: 'cancelled',
        error: reason,
        finishedAt: Date.now(),
      });
      settleIdle();
      return { kind: 'pending', run, phase: 'queued', done: Promise.resolve() };
    }

    const persisted = runId ? store.getRun?.(runId) : undefined;
    if (persisted?.media_id || persisted?.status === 'done') {
      return { kind: 'too-late', run: { id: runId }, phase: 'published' };
    }
    return { kind: 'none', run: runId ? { id: runId } : undefined };
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
    cancel,
    whenIdle() {
      if (active === 0 && (stopped || pending.length === 0)) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.add(resolve));
    },
    stats() {
      return { active, pending: pending.length, stopped };
    },
  };
}
