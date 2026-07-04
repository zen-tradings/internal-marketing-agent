export function createQueue({ store, maxConcurrency = 1, handler }) {
  const pending = [];
  let active = 0;

  function schedule() {
    while (active < maxConcurrency && pending.length) {
      const run = pending.shift();
      active++;
      Promise.resolve()
        .then(() => handler(run))
        .catch((e) => { /* handler 内部已负责落库/告警 */ console.error(`[queue] run ${run.id} 失败:`, e?.message); })
        .finally(() => { active--; schedule(); });
    }
  }

  return {
    enqueue(task) {
      store.createRun(task);
      pending.push(task);
      schedule();
    },
  };
}
