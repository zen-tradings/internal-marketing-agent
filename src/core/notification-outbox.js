export async function deliverOrQueueNotification({
  store,
  notifier,
  runId,
  method,
  notify,
  payload,
}) {
  try {
    if (!notifier || typeof notifier[method] !== 'function') throw new Error('Slack notifier is not ready');
    const result = await notifier[method](notify, payload);
    if (method === 'respond' && result?.responseTs) store.setSlackResponseTs?.(runId, result.responseTs);
    store.markNotificationSentByRun?.(runId, method, Date.now());
    return { delivered: true, result };
  } catch (error) {
    if (typeof store.queueNotification === 'function') {
      store.queueNotification({ runId, method, notify, payload, error: error?.message || String(error) });
    } else {
      console.error(`[hub] notifier.${method} 失败且 store 不支持 outbox:`, error?.message || error);
    }
    return { delivered: false, error };
  }
}

export async function flushNotificationOutbox({ store, notifier, now = Date.now(), limit = 50 }) {
  if (!notifier || typeof store.listPendingNotifications !== 'function') return { delivered: 0, failed: 0 };
  let delivered = 0;
  let failed = 0;
  for (const row of store.listPendingNotifications({ now, limit })) {
    try {
      const run = store.getRun?.(row.run_id);
      const disposition = notificationDisposition(row.method, run);
      if (disposition === 'discard') {
        store.markNotificationSent(row.id, Date.now());
        continue;
      }
      if (disposition === 'defer') continue;
      const notify = JSON.parse(row.notify_json || '{}');
      const payload = JSON.parse(row.payload_json || '{}');
      if (typeof notifier[row.method] !== 'function') throw new Error(`未知 notifier 方法:${row.method}`);
      const result = await notifier[row.method](notify, payload);
      if (row.method === 'respond' && result?.responseTs) store.setSlackResponseTs?.(row.run_id, result.responseTs);
      store.markNotificationSent(row.id, Date.now());
      delivered += 1;
    } catch (error) {
      const attempts = Number(row.attempts || 0) + 1;
      const retryDelayMs = Math.min(5 * 60 * 1000, 5000 * (2 ** Math.min(attempts - 1, 6)));
      store.markNotificationFailed(row.id, {
        error: error?.message || String(error),
        nextAttemptAt: Date.now() + retryDelayMs,
      });
      failed += 1;
    }
  }
  return { delivered, failed };
}

function notificationDisposition(method, run) {
  if (!run) return 'discard';
  const terminalStatuses = new Set(['done', 'failed', 'cancelled', 'needs_input']);
  const expectedStatus = {
    success: 'done',
    failure: 'failed',
    cancelled: 'cancelled',
    needsInput: 'needs_input',
  }[method];
  if (expectedStatus) {
    if (run.status === expectedStatus) return 'send';
    return terminalStatuses.has(run.status) ? 'discard' : 'defer';
  }
  if (method === 'respond') {
    if (run.slack_response_ts) return 'discard';
    if (['done', 'failed'].includes(run.status)) return 'send';
    return terminalStatuses.has(run.status) ? 'discard' : 'defer';
  }
  return 'send';
}
