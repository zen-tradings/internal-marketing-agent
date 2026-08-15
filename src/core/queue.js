import { createTaskCancelledError } from '../lib/task-cancellation.js';

export function createQueue({ store, maxConcurrency = 1, maxQueueSize = 100, handler }) {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency <= 0) throw new Error('maxConcurrency 必须是正整数');
  if (!Number.isInteger(maxQueueSize) || maxQueueSize <= 0) throw new Error('maxQueueSize 必须是正整数');
  const pending = [];
  const activeRuns = new Map();
  let active = 0;
  let stopped = false;
  let sequence = 0;
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
    const priority = normalizePriority(task.priority, task.workflowId);
    const queued = { ...task, priority, _queueSequence: sequence++ };
    if (persist) store.createRun(queued);
    pending.push(queued);
    pending.sort((a, b) => b.priority - a.priority || a._queueSequence - b._queueSequence);
    schedule();
    return queued;
  }

  function matches(run, { runId, channel, user }) {
    if (runId) return run.id === runId;
    const notify = notificationForRun(run);
    if (channel && notify?.channel !== channel) return false;
    if (user && notify?.user && notify.user !== user) return false;
    return Boolean(channel || user);
  }

  function notificationForRun(run) {
    let notify = run.notify;
    if ((!notify?.channel || !notify?.ts || !notify?.user) && store.getRun) {
      try { notify = { ...JSON.parse(store.getRun(run.id)?.notify_json || '{}'), ...notify }; }
      catch {}
    }
    return notify || {};
  }

  function cancel({ runId, channel, user, reason = '用户通过 Slack 停止任务' } = {}) {
    if (!runId) {
      const candidates = [
        ...[...activeRuns.values()].map((entry) => entry.run),
        ...pending,
      ].filter((run) => matches(run, { channel, user }))
        .map((run) => ({ ...run, notify: notificationForRun(run) }));
      if (candidates.length > 1) return { kind: 'ambiguous', runs: candidates };
    }
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
      return {
        active,
        pending: pending.length,
        pendingByPriority: {
          high: pending.filter((run) => run.priority > 0).length,
          normal: pending.filter((run) => run.priority <= 0).length,
        },
        stopped,
      };
    },
    state(runId) {
      if (activeRuns.has(runId)) return 'running';
      if (pending.some((run) => run.id === runId)) return 'queued';
      return 'unknown';
    },
  };
}

export function normalizePriority(priority, workflowId) {
  if (Number.isInteger(priority)) return priority;
  return workflowId === 'opening-digest' ? 100 : 0;
}
