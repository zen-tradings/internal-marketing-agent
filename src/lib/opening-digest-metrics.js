const METRICS = [
  ['SPY', 'SPY'], ['QQQ', 'QQQ'], ['IWM', 'IWM'], ['VIX', '^VIX'],
  ['2Y UST', '^UST2Y'], ['10Y UST', '^TNX'], ['DXY', 'DX-Y.NYB'], ['WTI', 'CL=F'], ['Gold', 'GC=F'],
];

export async function collectOpeningMetrics({ fetchFn = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const result = await Promise.all(METRICS.map(async ([label, symbol]) => {
    try { return await fetchMetric({ label, symbol, fetchFn, timeoutMs }); }
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
      asOf: new Date((quote?.regularMarketTime || quote?.timestamp?.at(-1) || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    };
  } finally { clearTimeout(timer); }
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
  return `<h2 style="margin:24px 0 10px;font-size:17px;line-height:1.35;font-weight:500;color:#08272b">Market snapshot</h2><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">${rows.join('')}</table>`;
}
function formatMetric(metric) {
  const digits = /UST|VIX/.test(metric.label) ? 2 : metric.value >= 1000 ? 0 : 2;
  return Number(metric.value).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
