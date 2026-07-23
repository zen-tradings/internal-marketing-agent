import crypto from 'node:crypto';
import path from 'node:path';

export function runWorkDir(baseDir, runId) {
  if (!baseDir) throw new Error('工作流缺少 workDir');
  if (!runId) throw new Error('任务缺少 runId');
  const raw = String(runId);
  const readable = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 48) || 'run';
  const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  return path.join(baseDir, 'runs', `${readable}-${digest}`);
}

export function workflowForRun(workflow, runId) {
  const runtime = Object.create(workflow);
  Object.defineProperty(runtime, 'workDir', {
    value: runWorkDir(workflow.workDir, runId),
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return runtime;
}
