// Keep deadlines and resource permits alive until the body is consumed, cancelled,
// or fails. A zero-sized queue avoids eagerly buffering an unconsumed response.
export function manageResponseBody(response, { signal, onDone = () => {} } = {}) {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener('abort', abort);
    onDone();
  };
  let reader;
  let streamController;
  const abort = () => {
    const reason = signal.reason || new Error('HTTP response aborted');
    streamController?.error(reason);
    void reader?.cancel(reason).catch(() => {});
    finish();
  };
  if (!response?.body?.getReader) { finish(); return response; }
  reader = response.body.getReader();
  const body = new ReadableStream({
    start(controller) {
      streamController = controller;
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (finished) return;
        if (done) { controller.close(); finish(); }
        else controller.enqueue(value);
      } catch (error) {
        if (!finished) controller.error(error);
        finish();
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
  const wrapped = new Response(body, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
  for (const key of ['url', 'redirected', 'type']) {
    Object.defineProperty(wrapped, key, { value: response[key] });
  }
  return wrapped;
}
