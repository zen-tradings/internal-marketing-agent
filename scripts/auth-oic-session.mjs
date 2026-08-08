// Run this only on the DigitalOcean host inside a temporary Xvfb/VNC session.
// It never writes credentials; it serializes the logged-in browser state to the
// protected path configured by OIC_STORAGE_STATE_PATH.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium } from 'playwright-core';
import { loadConfig } from '../src/config/index.js';
import { countTrendingRows } from '../src/lib/options-volume.js';

const config = loadConfig();
const digest = config.openingDigest;
if (!digest.automationAuthorized) throw new Error('先在受保护环境中设置 OIC_AUTOMATION_AUTHORIZED=true');
if (!process.env.DISPLAY) throw new Error('此命令需要临时 Xvfb/VNC 图形会话；请勿在无 DISPLAY 的 shell 直接运行');

const browser = await chromium.launch({ executablePath: digest.browserExecutablePath, headless: false });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 }, timezoneId: 'America/New_York' });
  const page = await context.newPage();
  await page.goto(digest.optionsUrl, { waitUntil: 'domcontentloaded', timeout: digest.captureTimeoutMs });
  const prompt = readline.createInterface({ input, output });
  await prompt.question('在临时 VNC 浏览器中完成 OIC 登录/MFA 并确认表格可见后，按 Enter 保存会话。');
  prompt.close();
  const visibleRows = await maxTrendingRows(page);
  if (visibleRows < 20) throw new Error(`未验证到完整 Trending Options 表格（rows=${visibleRows}），不保存会话`);
  fs.mkdirSync(path.dirname(digest.storageStatePath), { recursive: true, mode: 0o750 });
  await context.storageState({ path: digest.storageStatePath });
  fs.chmodSync(digest.storageStatePath, 0o640);
  console.log(`已保存 OIC 会话：${digest.storageStatePath}`);
} finally { await browser.close(); }

async function maxTrendingRows(page) {
  let rows = 0;
  for (const frame of page.frames()) {
    const tables = frame.locator('table');
    const tableCount = await tables.count().catch(() => 0);
    for (let index = 0; index < tableCount; index++) {
      rows = Math.max(rows, await tables.nth(index).locator('tr').count().catch(() => 0));
    }
    rows = Math.max(rows, countTrendingRows(await frame.locator('body').innerText().catch(() => '')));
  }
  return rows;
}
