// Read-only task-status monitor. It reads the shared SQLite file without needing the bot process, making stuck
// queues (especially never-ending running tasks) easy to identify. Usage: npm run status with optional DB_PATH.
import dotenv from 'dotenv';
import fs from 'node:fs';
import Database from 'better-sqlite3';

dotenv.config({ override: true });

// Mirror src/config/index.js default/override rules without reusing loadConfig, which requires unrelated service
// environment variables such as SLACK_BOT_TOKEN and WECHAT_APP_ID; this script needs only dbPath.
const dbPath = process.env.DB_PATH || `${process.env.HOME || '.'}/zen-content-hub/runs.db`;

if (!fs.existsSync(dbPath)) {
  console.log(`未找到任务数据库: ${dbPath}`);
  console.log('(bot 可能尚未运行过,或 DB_PATH 配置的路径不同;可用 DB_PATH=/path/to/runs.db npm run status 指定)');
  process.exit(0);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const STATUSES = ['queued', 'running', 'needs_input', 'done', 'failed', 'cancelled', 'interrupted'];

function formatLocal(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function pad(value, width) {
  const s = String(value ?? '-');
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

console.log(`任务数据库: ${dbPath}`);
console.log('');

console.log('【状态统计】');
const counts = {};
for (const status of STATUSES) {
  counts[status] = db.prepare('SELECT COUNT(*) AS n FROM runs WHERE status = ?').get(status).n;
}
for (const status of STATUSES) {
  console.log(`  ${pad(status, 12)} ${counts[status]}`);
}

console.log('');
console.log('【最近 10 条任务】');
const recent = db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT 10').all();
if (!recent.length) {
  console.log('  (无记录)');
} else {
  for (const r of recent) {
    const shortId = pad(String(r.id).slice(0, 12), 14);
    const workflow = pad(r.workflow_id, 10);
    const status = pad(r.status, 11);
    const stage = pad(r.stage || '-', 10);
    const created = pad(formatLocal(r.created_at), 21);
    const inputPreview = String(r.input || '').replace(/\s+/g, ' ').slice(0, 30);
    let line = `  ${shortId} ${workflow} ${status} ${stage} ${created} ${inputPreview}`;
    if (r.error) line += `  [错误] ${String(r.error).replace(/\s+/g, ' ').slice(0, 60)}`;
    console.log(line);
  }
}

const running = db.prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY started_at").all();
if (running.length) {
  console.log('');
  console.log('【运行中任务提醒】');
  const now = Date.now();
  for (const r of running) {
    const startedAt = r.started_at || r.created_at;
    const minutes = Math.floor((now - startedAt) / 60000);
    const shortId = String(r.id).slice(0, 12);
    let line = `  任务 ${shortId}(${r.workflow_id})运行中任务已持续 ${minutes} 分钟`;
    if (minutes >= 15) {
      line += ' ⚠ 可能卡死,建议重启: launchctl kickstart -k gui/$(id -u)/com.zentrading.content-hub';
    }
    console.log(line);
  }
}

process.exit(0);
