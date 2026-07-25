export function createTaskCancelledError(reason = '用户通过 Slack 停止任务') {
  const error = new Error(reason);
  error.name = 'AbortError';
  error.code = 'TASK_CANCELLED';
  error.stage = 'cancelled';
  return error;
}

export function cancellationErrorFromSignal(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return createTaskCancelledError();
}

export function throwIfTaskCancelled(signal) {
  if (signal?.aborted) throw cancellationErrorFromSignal(signal);
}

export function isTaskCancelled(error, signal) {
  return Boolean(
    signal?.aborted
    || error?.code === 'TASK_CANCELLED'
    || error?.stage === 'cancelled'
  );
}

export function withTaskCancellation(fetchFn, signal) {
  if (!signal) return fetchFn;
  return (resource, options = {}) => {
    throwIfTaskCancelled(signal);
    const requestSignal = options?.signal;
    const combinedSignal = requestSignal && requestSignal !== signal
      ? AbortSignal.any([signal, requestSignal])
      : signal;
    return fetchFn(resource, { ...options, signal: combinedSignal });
  };
}
