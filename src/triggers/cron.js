import cron from 'node-cron';

export function parseCronTriggers(triggers = []) {
  return triggers.filter(t => t.startsWith('cron:')).map(t => t.slice(5));
}

export function registerCron({ workflows, enqueue, scheduleFn = cron.schedule }) {
  let count = 0;
  for (const wf of Object.values(workflows)) {
    for (const expr of parseCronTriggers(wf.triggers)) {
      scheduleFn(expr, () => enqueue({ workflowId: wf.id, source: 'cron', input: wf.cronInput ?? '(定时任务)', notify: wf.cronNotify ?? {} }));
      count++;
    }
  }
  return count;
}
