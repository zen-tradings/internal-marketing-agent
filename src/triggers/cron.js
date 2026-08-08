import cron from 'node-cron';

export function parseCronTriggers(triggers = []) {
  return triggers.filter(t => t.startsWith('cron:')).map(t => t.slice(5).trim()).filter(Boolean);
}

export function registerCron({
  workflows,
  enqueue,
  notifyChannel = '',
  timezone = 'America/Los_Angeles',
  scheduleFn = cron.schedule,
  validateFn = cron.validate,
}) {
  let count = 0;
  for (const wf of Object.values(workflows)) {
    for (const expr of parseCronTriggers(wf.triggers)) {
      if (!validateFn(expr)) throw new Error(`无效 cron 表达式(${wf.id}):${expr}`);
      const enqueueWorkflow = () => enqueue({
        workflowId: wf.id,
        source: 'cron',
        input: wf.cronInput ?? '(定时任务)',
        notify: wf.cronNotify ?? (notifyChannel ? { channel: notifyChannel } : {}),
      });
      scheduleFn(expr, () => {
        if (typeof wf.shouldRun !== 'function') return enqueueWorkflow();
        Promise.resolve(wf.shouldRun(new Date()))
          .then((shouldRun) => { if (shouldRun) enqueueWorkflow(); })
          .catch((error) => console.error(`[cron] ${wf.id} 预检失败:`, error?.message || error));
      }, { timezone: wf.cronTimezone || timezone });
      count++;
    }
  }
  return count;
}
