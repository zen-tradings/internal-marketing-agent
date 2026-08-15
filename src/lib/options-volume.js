import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { acquireRuntimeResource } from '../config/runtime.js';

const MIN_IMAGE_BYTES = 20 * 1024;
// The screenshot is now a same-session consistency checkpoint only. It is not
// uploaded or retained, but we keep the previously approved high-resolution
// capture so the capture step itself remains unchanged.
const DEVICE_SCALE_FACTOR = 3.4;
const EXPECTED_HEADERS = [
  '', 'Ticker', 'Name', 'Call Options Volume (%)', 'Put Options Volume (%)',
  'Total Option Volume', 'IVX 30', 'IVX Change %',
];

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
  return captureAtScale({
    url, storageStatePath, executablePath, timeoutMs, deviceScaleFactor: DEVICE_SCALE_FACTOR,
  });
}

async function captureAtScale({ url, storageStatePath, executablePath, timeoutMs, deviceScaleFactor }) {
  const releaseBrowser = await acquireRuntimeResource('browser');
  let browser;
  try {
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ['--disable-background-networking', '--disable-component-update', '--disable-dev-shm-usage'],
    });
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
    const surface = await findTrendingSurface(page);
    if (!surface) {
      if (await looksLikeLogin(page)) throw new OptionsAuthenticationError();
      throw optionsError('未找到 OIC Trending Options Volume 表格，可能是页面结构已变更');
    }
    const data = await waitForStableData(surface, timeoutMs);
    await surface.prepareScreenshot?.();
    await surface.locator.scrollIntoViewIfNeeded();
    const box = await surface.locator.boundingBox();
    if (!box || box.width < 300 || box.height < 200) throw optionsError('OIC 表格尺寸异常');
    const buffer = Buffer.from(await surface.locator.screenshot({ type: 'png', animations: 'disabled', caret: 'hide', timeout: timeoutMs }));
    if (buffer.length < MIN_IMAGE_BYTES || buffer.subarray(1, 4).toString('ascii') !== 'PNG') {
      throw optionsError('OIC 表格截图为空或不是 PNG');
    }
    const afterScreenshot = validateTrendingOptionsData(await surface.snapshot());
    if (dataSignature(data) !== dataSignature(afterScreenshot)) {
      throw optionsError('OIC 表格在截图期间发生变化，拒绝生成不一致的邮件表格');
    }
    const { width, height } = pngDimensions(buffer);
    return {
      buffer, data, rows: data.rows.length, capturedAt: new Date().toISOString(),
      deviceScaleFactor, width, height,
    };
  } finally {
    try { await browser?.close(); }
    finally { releaseBrowser(); }
  }
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

async function findTrendingSurface(page) {
  for (const frame of page.frames()) {
    const tables = frame.locator('table');
    const count = await tables.count().catch(() => 0);
    for (let index = 0; index < count; index++) {
      const table = tables.nth(index);
      const text = await table.innerText().catch(() => '');
      const tableRows = await table.locator('tr').count().catch(() => 0);
      if (/volume/i.test(text) && /(call|put)/i.test(text) && tableRows >= 21) {
        return {
          locator: table,
          snapshot: async () => {
            const bodyText = await frame.locator('body').innerText().catch(() => '');
            const extracted = await table.evaluate((element) => {
              const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
              const allRows = [...element.querySelectorAll('tr')];
              const headerRow = allRows.find((row) => /total option volume/i.test(clean(row.innerText)));
              const rows = allRows
                .map((row) => [...row.querySelectorAll(':scope > th, :scope > td')].map((cell) => clean(cell.innerText)))
                .filter((cells) => cells.length === 8 && /^\d{1,2}$/.test(cells[0]));
              return {
                headers: headerRow
                  ? [...headerRow.querySelectorAll(':scope > th, :scope > td')].map((cell) => clean(cell.innerText))
                  : [],
                rows,
              };
            });
            return dataFromExtractedText(bodyText, extracted);
          },
        };
      }
    }
  }
  // The live iVolatility embed renders component divs rather than a semantic
  // table. Each native row currently contains eight direct child cells. Read
  // those cells from the authenticated frame and keep the iframe screenshot as
  // a same-session consistency checkpoint.
  const frame = page.frames().find((item) => /private-authorization\.ivolatility\.com/i.test(item.url()));
  const iframe = page.locator('iframe[src*="private-authorization.ivolatility.com"]').first();
  if (frame && await iframe.count().catch(() => 0)) {
    return {
      locator: iframe,
      prepareScreenshot: async () => {
        const contentHeight = await frame.evaluate(() => Math.max(
          document.documentElement?.scrollHeight || 0,
          document.body?.scrollHeight || 0,
        )).catch(() => 0);
        if (contentHeight > 0) {
          await iframe.evaluate((element, height) => {
            element.style.setProperty('height', `${height + 8}px`, 'important');
            element.setAttribute('height', String(height + 8));
          }, contentHeight);
        }
      },
      snapshot: () => frame.evaluate(() => {
        const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const bodyText = document.body?.innerText || '';
        const nativeHeader = document.querySelector('.oic-most-active-stocks-table-header');
        const headerCandidate = nativeHeader || [...document.querySelectorAll('div')].find((element) => {
          const cells = [...element.children].map((child) => clean(child.innerText));
          return cells.length === 8 && cells.includes('Ticker') && cells.includes('Total Option Volume');
        });
        let rowElements = [...document.querySelectorAll('.oic-most-active-stocks-table-row:not(.oic-most-active-stocks-table-header)')];
        if (!rowElements.length) {
          rowElements = [...document.querySelectorAll('div')].filter((element) => {
            const cells = [...element.children].map((child) => clean(child.innerText));
            return cells.length === 8 && /^\d{1,2}$/.test(cells[0]) && /^\S+$/.test(cells[1]);
          });
        }
        return {
          bodyText,
          headers: headerCandidate ? [...headerCandidate.children].map((child) => clean(child.innerText)) : [],
          rows: rowElements.map((element) => [...element.children].map((child) => clean(child.innerText))),
        };
      }).then((extracted) => dataFromExtractedText(extracted.bodyText, extracted)),
    };
  }
  return null;
}

async function waitForStableData(surface, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let priorSignature = '';
  let priorData;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const data = validateTrendingOptionsData(await surface.snapshot());
      const signature = dataSignature(data);
      if (signature === priorSignature) return priorData;
      priorSignature = signature;
      priorData = data;
    } catch (error) {
      lastError = error;
      priorSignature = '';
      priorData = undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw optionsError(`OIC 表格未能稳定通过完整校验: ${lastError?.message || 'timeout'}`);
}

function dataFromExtractedText(bodyText, extracted) {
  const lines = String(bodyText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    asOf: lines.find((line) => /^As of\s+/i.test(line)) || '',
    headers: extracted.headers || [],
    rows: extracted.rows || [],
    attribution: lines.find((line) => /^Data provided by\s+/i.test(line)) || '',
  };
}

export function validateTrendingOptionsData(input) {
  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const data = {
    asOf: clean(input?.asOf),
    headers: Array.isArray(input?.headers) ? input.headers.map(clean) : [],
    rows: Array.isArray(input?.rows) ? input.rows.map((row) => Array.isArray(row) ? row.map(clean) : []) : [],
    attribution: clean(input?.attribution),
  };
  if (!/^As of\s+\S+/i.test(data.asOf)) throw optionsError('OIC 数据缺少 As of 时间戳');
  if (data.headers.length !== EXPECTED_HEADERS.length) throw optionsError(`OIC 表头列数异常:${data.headers.length}`);
  const actualHeaders = data.headers.map(canonicalHeader);
  const expectedHeaders = EXPECTED_HEADERS.map(canonicalHeader);
  if (!['', 'rank'].includes(actualHeaders[0])
    || actualHeaders.slice(1).some((header, index) => header !== expectedHeaders[index + 1])) {
    throw optionsError(`OIC 表头不匹配:${data.headers.join(' | ')}`);
  }
  if (data.rows.length !== 20) throw optionsError(`OIC 表格必须恰好包含20行，当前:${data.rows.length}`);
  let priorVolume = Infinity;
  for (let index = 0; index < data.rows.length; index++) {
    const cells = data.rows[index];
    if (cells.length !== 8) throw optionsError(`OIC 第${index + 1}行列数异常:${cells.length}`);
    const [rank, ticker, name, callVolume, putVolume, totalVolume, ivx30, ivxChange] = cells;
    if (Number(rank) !== index + 1) throw optionsError(`OIC 排名必须连续1-20，第${index + 1}行得到:${rank}`);
    if (!/^\S{1,20}$/.test(ticker)) throw optionsError(`OIC 第${rank}行 ticker 无效`);
    if (!name || name.length > 200) throw optionsError(`OIC 第${rank}行名称无效`);
    const call = parsePercent(callVolume);
    const put = parsePercent(putVolume);
    if (!Number.isFinite(call) || !Number.isFinite(put) || Math.abs(call + put - 100) > 0.02) {
      throw optionsError(`OIC 第${rank}行 call/put 百分比无效`);
    }
    if (!/^\d{1,3}(?:,\d{3})*$/.test(totalVolume) && !/^\d+$/.test(totalVolume)) {
      throw optionsError(`OIC 第${rank}行总成交量格式无效`);
    }
    const volume = Number(totalVolume.replaceAll(',', ''));
    if (!Number.isSafeInteger(volume) || volume <= 0 || volume > priorVolume) {
      throw optionsError(`OIC 第${rank}行总成交量排序或数值无效`);
    }
    priorVolume = volume;
    if (!isFiniteNumberText(ivx30) || !isFiniteNumberText(ivxChange)) {
      throw optionsError(`OIC 第${rank}行 IVX 数值无效`);
    }
  }
  if (!/ivolatility/i.test(data.attribution)) throw optionsError('OIC 数据缺少 iVolatility attribution');
  return data;
}

function canonicalHeader(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function parsePercent(value) {
  if (!/^[+-]?\d+(?:\.\d+)?\s*%$/.test(String(value || ''))) return NaN;
  return Number(String(value).replace('%', '').trim());
}
function isFiniteNumberText(value) {
  return /^[+-]?\d+(?:\.\d+)?%?$/.test(String(value || ''))
    && Number.isFinite(Number(String(value).replace('%', '')));
}
function dataSignature(data) { return JSON.stringify(data); }

export function countTrendingRows(text) {
  return [...String(text || '').matchAll(/(?:^|\n)(\d{1,2})\s+[^\n]+/g)]
    .map((match) => Number(match[1]))
    .filter((number, index, all) => number >= 1 && number <= 20 && all.indexOf(number) === index)
    .length;
}

function pngDimensions(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function optionsError(message) { const error = new Error(message); error.stage = 'options'; return error; }
