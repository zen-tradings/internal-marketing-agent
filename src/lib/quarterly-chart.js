const BLOCK_RE = /```quarterly-chart\s*([\s\S]*?)```/g;

export function renderQuarterlyCharts(markdown) {
  return String(markdown || '').replace(BLOCK_RE, (_, raw) => {
    try { return renderChart(JSON.parse(raw.trim())); }
    catch { return ''; }
  });
}

function renderChart(spec) {
  const periods = stringArray(spec.periods);
  const revenue = numberArray(spec.revenue);
  const margin = numberArray(spec.grossMargin);
  if (periods.length < 4 || periods.length > 6 || revenue.length !== periods.length || margin.length !== periods.length) return '';

  const maxRevenue = Math.max(...revenue);
  if (!(maxRevenue > 0)) return '';
  const title = escapeHtml(spec.title || '季度趋势');
  const unit = escapeHtml(spec.revenueUnit || '');
  const source = escapeHtml(spec.source || '公司披露');
  const rows = periods.map((period, i) => {
    const width = Math.max(12, Math.round(revenue[i] / maxRevenue * 100));
    return `<section style="margin:.72em 0;">
  <section style="display:flex;justify-content:space-between;font-size:.76em;color:#586678;margin-bottom:.28em;"><span>${escapeHtml(period)}</span><span>${revenue[i]}${unit} · 毛利率 ${margin[i]}%</span></section>
  <section style="height:.72em;background:#E6E2D9;border-radius:999px;overflow:hidden;"><section style="width:${width}%;height:100%;background:#16335C;border-radius:999px;"></section></section>
</section>`;
  }).join('\n');

  return `<section data-quarterly-chart="true" style="background:#FFFFFF;border:1px solid #E6E2D9;border-radius:.55em;padding:1em 1.1em;margin:1.2em 0;">
<section style="color:#16335C;font-size:.96em;font-weight:700;margin-bottom:.8em;">${title}</section>
${rows}
<section style="color:#9AA0A6;font-size:.68em;margin-top:.8em;">柱长代表营收相对规模 · 来源:${source}</section>
</section>`;
}

function stringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.trim()) ? value : [];
}

function numberArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === 'number' && Number.isFinite(v)) ? value : [];
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
