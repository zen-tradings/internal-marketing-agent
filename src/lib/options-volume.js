import fs from 'node:fs';
import { chromium } from 'playwright-core';

const MIN_IMAGE_BYTES = 20 * 1024;

export class OptionsAuthenticationError extends Error {
  constructor(message = 'OIC 登录会话已失效') {
    super(message);
    this.name = 'OptionsAuthenticationError';
    this.code = 'OIC_AUTH_EXPIRED';
    this.stage = 'options-auth';
  }
}

export async function captureTrendingOptionsTable({
  url, storageStatePath, executablePath, timeoutMs = 45000, automationAuthorized = false,
}) {
  if (!automationAuthorized) throw optionsError('未设置 OIC_AUTOMATION_AUTHORIZED=true，拒绝自动访问 OIC');
  if (!storageStatePath || !fs.existsSync(storageStatePath)) throw new OptionsAuthenticationError('OIC 会话文件不存在，请通过 DO 临时 VNC 更新登录状态');
  if (!executablePath || !fs.existsSync(executablePath)) throw optionsError(`找不到 OIC 截图浏览器:${executablePath}`);
  const first = await captureAtScale({ url, storageStatePath, executablePath, timeoutMs, deviceScaleFactor: 2 });
  if (first.buffer.length <= 1024 * 1024) return first;
  const second = await captureAtScale({ url, storageStatePath, executablePath, timeoutMs, deviceScaleFactor: 1 });
  if (second.buffer.length > 2 * 1024 * 1024) throw optionsError(`期权表截图超过 Customer.io 2MB 限制:${second.buffer.length}`);
  return second;
}

async function captureAtScale({ url, storageStatePath, executablePath, timeoutMs, deviceScaleFactor }) {
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-dev-shm-usage'],
  });
  try {
    const context = await browser.newContext({
      storageState: storageStatePath,
      viewport: { width: 1440, height: 1200 },
      deviceScaleFactor,
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    try { await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 15000) }); } catch {}
    const table = await findTrendingTable(page);
    if (!table) {
      if (await looksLikeLogin(page)) throw new OptionsAuthenticationError();
      throw optionsError('未找到 OIC Trending Options Volume 表格，可能是页面结构已变更');
    }
    await waitForStableRows(table, timeoutMs);
    const rows = await table.locator('tr').count();
    const text = await table.innerText();
    if (rows < 21 || !/volume/i.test(text) || !/(call|put)/i.test(text)) {
      throw optionsError(`OIC 表格校验失败: rows=${rows}`);
    }
    await table.scrollIntoViewIfNeeded();
    const box = await table.boundingBox();
    if (!box || box.width < 300 || box.height < 200) throw optionsError('OIC 表格尺寸异常');
    const buffer = Buffer.from(await table.screenshot({ type: 'png', animations: 'disabled', caret: 'hide', timeout: timeoutMs }));
    if (buffer.length < MIN_IMAGE_BYTES || buffer.subarray(1, 4).toString('ascii') !== 'PNG') {
      throw optionsError('OIC 表格截图为空或不是 PNG');
    }
    return { buffer, rows: rows - 1, tableText: text, capturedAt: new Date().toISOString(), deviceScaleFactor };
  } finally { await browser.close(); }
}

async function looksLikeLogin(page) {
  for (const frame of page.frames()) {
    const passwordInputs = await frame.locator('input[type="password"]').count().catch(() => 0);
    if (passwordInputs) return true;
    const url = frame.url();
    const body = await frame.locator('body').innerText().catch(() => '');
    if (/(?:\/login|\/signin|sign-in)/i.test(url)
      && /(?:sign in|log in)/i.test(body)) return true;
  }
  return false;
}

async function findTrendingTable(page) {
  for (const frame of page.frames()) {
    const tables = frame.locator('table');
    const count = await tables.count().catch(() => 0);
    for (let index = 0; index < count; index++) {
      const table = tables.nth(index);
      const text = await table.innerText().catch(() => '');
      if (/volume/i.test(text) && /(call|put)/i.test(text) && (await table.locator('tr').count().catch(() => 0)) >= 21) return table;
    }
  }
  return null;
}

async function waitForStableRows(table, timeoutMs) {
  const signature = async () => table.locator('tr').allInnerTexts().then((rows) => rows.join('\n').replace(/\s+/g, ' ').trim());
  const first = await signature();
  if (!first) throw optionsError('OIC 表格尚未加载');
  await new Promise((resolve) => setTimeout(resolve, Math.min(2000, Math.max(250, timeoutMs / 20))));
  const second = await signature();
  if (first !== second) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const third = await signature();
    if (second !== third) throw optionsError('OIC 表格在截图前持续变化');
  }
}

function optionsError(message) { const error = new Error(message); error.stage = 'options'; return error; }
