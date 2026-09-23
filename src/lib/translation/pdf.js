import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cancellationErrorFromSignal } from '../task-cancellation.js';
import { safeError } from './shared.js';

export const execFileAsync = promisify(execFile);

export async function readPdfInfo(pdfPath, maxPdfPages, { signal, execute } = {}) {
  const output = await runCommand('pdfinfo', [pdfPath], {
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    signal,
    execute,
    missingMessage: 'PDF 页数校验缺少 Poppler 命令 pdfinfo',
    failureLabel: 'PDF 页数检查失败',
  });
  const pages = Number(/^Pages:\s+(\d+)/mi.exec(output)?.[1] || 0);
  if (!pages) throw new Error('PDF 页数识别失败');
  if (pages > maxPdfPages) throw new Error(`PDF 页数超过上限:${pages}/${maxPdfPages}`);
  return { pages, output };
}

export async function assertPdfPageLimit(pdfPath, maxPdfPages, options) {
  return (await readPdfInfo(pdfPath, maxPdfPages, options)).pages;
}

export function assertPdfResponse({
  buffer,
  sourceUrl = '',
  finalUrl = '',
  contentType = '',
}) {
  if (hasPdfSignature(buffer)) return true;
  const sample = Buffer.isBuffer(buffer)
    ? buffer.subarray(0, 4096).toString('utf8')
    : '';
  if (isSlackPrivateFileUrl(sourceUrl || finalUrl)
    && /<!doctype\s+html|<html\b|slack/i.test(sample)) {
    throw new Error(
      'Slack PDF 下载返回了登录页面而不是文件。Slack App 的 Bot Token 缺少 files:read 权限，'
      + '请在 OAuth & Permissions 中添加 files:read、重新安装 App 到工作区，然后重试原任务。',
    );
  }
  const type = String(contentType || '').split(';')[0].trim() || '未知';
  throw new Error(`PDF 下载响应不是有效 PDF（Content-Type: ${type}）`);
}

export function hasPdfSignature(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) return false;
  const searchWindow = buffer.subarray(0, Math.min(buffer.length, 1024));
  return searchWindow.indexOf(Buffer.from('%PDF-')) >= 0;
}

export function isSlackPrivateFileUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return /(?:^|\.)slack\.com$/i.test(url.hostname)
      && /\/files-pri\//i.test(url.pathname);
  } catch {
    return false;
  }
}

export async function runCommand(command, args, {
  timeout = 30000,
  maxBuffer = 32 * 1024 * 1024,
  signal,
  execute = execFileAsync,
  missingMessage = `PDF 元数据校验缺少 Poppler 命令 ${command}`,
  failureLabel = `${command} 执行失败`,
} = {}) {
  try {
    const result = await execute(command, args, {
      encoding: 'utf8', timeout, maxBuffer, signal, killSignal: 'SIGKILL',
    });
    return String(result?.stdout ?? result ?? '');
  } catch (error) {
    if (signal?.aborted) throw cancellationErrorFromSignal(signal);
    if (error?.code === 'ENOENT') throw new Error(missingMessage);
    const detail = error?.stderr ? String(error.stderr).slice(0, 300) : safeError(error);
    throw new Error(`${failureLabel}:${detail}`);
  }
}
