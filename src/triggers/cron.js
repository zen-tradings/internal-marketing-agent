import cron from 'node-cron';

export function parseCronTriggers(triggers = []) {
  return triggers.filter(t => t.startsWith('cron:')).map(t => t.slice(5).trim()).filter(Boolean);
}

export function validateCronConfiguration({
  workflows,
  timezone = 'America/Los_Angeles',
  validateFn = cron.validate,
} = {}) {
  const checkedTimezones = new Set();
  let count = 0;
  for (const wf of Object.values(workflows || {})) {
    const effectiveTimezone = wf.cronTimezone || timezone;
    if (!checkedTimezones.has(effectiveTimezone)) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: effectiveTimezone }).format(new Date()); }
      catch { throw new Error(`无效 cron 时区(${wf.id || 'global'}):${effectiveTimezone}`); }
      checkedTimezones.add(effectiveTimezone);
    }
    for (const expr of parseCronTriggers(wf.triggers)) {
      if (!validateFn(expr)) throw new Error(`无效 cron 表达式(${wf.id}):${expr}`);
      count += 1;
    }
  }
  return count;
}

export function registerCron({
  workflows,
  enqueue,
  notifyChannel = '',
  timezone = 'America/Los_Angeles',
  scheduleFn = cron.schedule,
  validateFn = cron.validate,
}) {
  validateCronConfiguration({ workflows, timezone, validateFn });
  let count = 0;
  for (const wf of Object.values(workflows)) {
    for (const expr of parseCronTriggers(wf.triggers)) {
      const enqueueWorkflow = (date = new Date()) => enqueueCronWorkflow({ wf, expr, date, enqueue, notifyChannel });
      scheduleFn(expr, () => {
        const date = new Date();
        if (typeof wf.shouldRun !== 'function') return enqueueWorkflow(date);
        Promise.resolve(wf.shouldRun(date))
          .then((shouldRun) => { if (shouldRun) enqueueWorkflow(date); })
          .catch((error) => console.error(`[cron] ${wf.id} 预检失败:`, error?.message || error));
      }, { timezone: wf.cronTimezone || timezone });
      count++;
    }
  }
  return count;
}

export async function reconcileCronWorkflows({
  workflows,
  enqueue,
  notifyChannel = '',
  timezone = 'America/Los_Angeles',
  now = new Date(),
} = {}) {
  let enqueued = 0;
  for (const wf of Object.values(workflows || {})) {
    const windowMinutes = Number(wf.cronCatchUpWindowMinutes || 0);
    if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) continue;
    for (const expr of parseCronTriggers(wf.triggers)) {
      const scheduledMinute = fixedDailyMinute(expr);
      if (scheduledMinute === undefined) continue;
      const currentMinute = zonedMinuteOfDay(now, wf.cronTimezone || timezone);
      if (currentMinute < scheduledMinute || currentMinute > scheduledMinute + windowMinutes) continue;
      if (typeof wf.shouldRun === 'function' && !await wf.shouldRun(now)) continue;
      const result = enqueueCronWorkflow({ wf, expr, date: now, enqueue, notifyChannel });
      if (result !== undefined) enqueued += 1;
    }
  }
  return enqueued;
}

function enqueueCronWorkflow({ wf, expr, date, enqueue, notifyChannel }) {
  const scheduleKey = typeof wf.cronRunKey === 'function' ? wf.cronRunKey(date, expr) : undefined;
  try {
    return enqueue({
      workflowId: wf.id,
      source: 'cron',
      input: wf.cronInput ?? '(定时任务)',
      notify: wf.cronNotify ?? (notifyChannel ? { channel: notifyChannel } : {}),
      ...(scheduleKey ? { scheduleKey } : {}),
    });
  } catch (error) {
    if (scheduleKey && /SQLITE_CONSTRAINT_(?:UNIQUE|PRIMARYKEY)|UNIQUE constraint failed/i.test(String(error?.code || error?.message || error))) {
      console.log(`[cron] ${wf.id} 已存在调度记录:${scheduleKey}`);
      return undefined;
    }
    throw error;
  }
}

function fixedDailyMinute(expr) {
  const [minute, hour] = String(expr || '').trim().split(/\s+/);
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return undefined;
  const value = Number(hour) * 60 + Number(minute);
  return value >= 0 && value < 24 * 60 ? value : undefined;
}

function zonedMinuteOfDay(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(values.hour) * 60 + Number(values.minute);
}
