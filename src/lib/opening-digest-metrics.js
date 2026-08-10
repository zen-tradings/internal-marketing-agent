const METRICS = [
  ['SPY', 'SPY'], ['QQQ', 'QQQ'], ['IWM', 'IWM'], ['VIX', '^VIX'],
  ['2Y UST', 'UST_TREASURY_2Y'], ['10Y UST', '^TNX'], ['DXY', 'DX-Y.NYB'], ['WTI', 'CL=F'], ['Gold', 'GC=F'],
];

export async function collectOpeningMetrics({ fetchFn = globalThis.fetch, timeoutMs = 10000, now = () => new Date() } = {}) {
  const result = await Promise.all(METRICS.map(async ([label, symbol]) => {
    try {
      return symbol === 'UST_TREASURY_2Y'
        ? await fetchTreasuryTwoYear({ label, fetchFn, timeoutMs, asOf: now() })
        : await fetchMetric({ label, symbol, fetchFn, timeoutMs });
    }
    catch { return { label, symbol, unavailable: true }; }
  }));
  return result;
}

async function fetchMetric({ label, symbol, fetchFn, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const endpoint = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
    const response = await fetchFn(endpoint, { signal: controller.signal, headers: { 'User-Agent': 'ZenOpeningDigest/1.0' } });
    if (!response.ok) throw new Error(`quote ${response.status}`);
    const quote = (await response.json())?.chart?.result?.[0];
    const closes = quote?.indicators?.quote?.[0]?.close?.filter(Number.isFinite) || [];
    if (closes.length < 1) throw new Error('quote missing close');
    const value = closes.at(-1);
    const prior = closes.length > 1 ? closes.at(-2) : undefined;
    return {
      label, symbol, value, prior,
      changePct: Number.isFinite(prior) && prior !== 0 ? ((value - prior) / prior) * 100 : undefined,
      asOf: new Date((quote?.meta?.regularMarketTime || quote?.timestamp?.at(-1) || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    };
  } finally { clearTimeout(timer); }
}

async function fetchTreasuryTwoYear({ label, fetchFn, timeoutMs, asOf }) {
  const year = asOf.getUTCFullYear();
  const endpoint = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(endpoint, { signal: controller.signal, headers: { 'User-Agent': 'ZenOpeningDigest/1.0' } });
    if (!response.ok) throw new Error(`treasury ${response.status}`);
    const lines = (await response.text()).trim().split(/\r?\n/).filter(Boolean);
    const headers = csvCells(lines.shift() || '');
    const dateIndex = headers.indexOf('Date');
    const valueIndex = headers.indexOf('2 Yr');
    if (dateIndex < 0 || valueIndex < 0) throw new Error('treasury columns missing');
    const rows = lines.map(csvCells).map((cells) => ({
      date: parseUsDate(cells[dateIndex]), value: Number(cells[valueIndex]),
    })).filter((row) => Number.isFinite(row.date?.getTime()) && Number.isFinite(row.value))
      .sort((left, right) => right.date - left.date);
    if (!rows.length) throw new Error('treasury 2Y missing');
    const current = rows[0];
    const prior = rows[1];
    return {
      label, symbol: 'UST_TREASURY_2Y', value: current.value,
      prior: prior?.value,
      changePct: prior?.value ? ((current.value - prior.value) / prior.value) * 100 : undefined,
      asOf: current.date.toISOString(),
      sourceNote: '2Y UST is the latest available U.S. Treasury daily par yield.',
    };
  } finally { clearTimeout(timer); }
}

export function validateOpeningMetrics(metrics = []) {
  const expected = METRICS.map(([label]) => label);
  if (!Array.isArray(metrics) || metrics.length !== expected.length) throw new Error(`Opening Digest 市场快照必须包含 ${expected.length} 项`);
  if (metrics.some((metric, index) => metric?.label !== expected[index])) throw new Error('Opening Digest 市场快照项目或顺序异常');
  const available = metrics.filter((metric) => !metric.unavailable && Number.isFinite(metric.value));
  if (available.length < expected.length - 1) throw new Error(`Opening Digest 市场快照可用数据不足:${available.length}/${expected.length}`);
  return metrics;
}

export function renderMetricsHtml(metrics = []) {
  const cards = metrics.map((metric) => {
    const value = metric.unavailable ? '—' : formatMetric(metric);
    const change = metric.unavailable || !Number.isFinite(metric.changePct)
      ? '' : `<span style="color:${metric.changePct >= 0 ? '#18765d' : '#a54747'};font-size:11px">${metric.changePct >= 0 ? '+' : ''}${metric.changePct.toFixed(2)}%</span>`;
    return `<td width="33.33%" style="padding:7px;border:1px solid #e4e0dc"><div style="font-size:10px;letter-spacing:.08em;color:#66787a">${escapeHtml(metric.label)}</div><div style="font-size:15px;color:#08272b;margin-top:3px">${value}</div>${change}</td>`;
  });
  const rows = [];
  for (let index = 0; index < cards.length; index += 3) rows.push(`<tr>${cards.slice(index, index + 3).join('')}</tr>`);
  const notes = [...new Set(metrics.map((metric) => metric.sourceNote).filter(Boolean))];
  const note = notes.length ? `<p style="margin:7px 0 18px;font-size:10px;line-height:150%;color:#66787a">${notes.map(escapeHtml).join(' ')}</p>` : '';
  return `<h2 style="margin:24px 0 10px;font-size:17px;line-height:1.35;font-weight:500;color:#08272b">Market snapshot</h2><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">${rows.join('')}</table>${note}`;
}
function formatMetric(metric) {
  const digits = /UST|VIX/.test(metric.label) ? 2 : metric.value >= 1000 ? 0 : 2;
  return Number(metric.value).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function csvCells(line) { return String(line).split(',').map((cell) => cell.trim().replace(/^"|"$/g, '').replaceAll('""', '"')); }
function parseUsDate(value) {
  const match = String(value || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? new Date(Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2]), 12)) : new Date(NaN);
}
