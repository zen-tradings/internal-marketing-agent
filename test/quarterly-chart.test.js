import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareRenderContext } from '@wenyan-md/core/wrapper';
import { renderQuarterlyCharts } from '../src/lib/quarterly-chart.js';
import { getInputContent } from '../src/lib/getInputContent.js';
import { RENDER_OPTS } from '../src/channels/wechat-draft.js';

test('把季度数据块渲染为微信兼容的内联趋势图', () => {
  const markdown = `前文
\`\`\`quarterly-chart
{"title":"AMAT <趋势>","periods":["Q1","Q2","Q3","Q4"],"revenue":[70,72,75,79],"grossMargin":[48.1,48.5,49.0,49.9],"revenueUnit":"亿美元","source":"公司财报"}
\`\`\`
后文`;
  const out = renderQuarterlyCharts(markdown);
  assert.match(out, /data-quarterly-chart="true"/);
  assert.match(out, /AMAT &lt;趋势&gt;/);
  assert.match(out, /Q4/);
  assert.match(out, /79亿美元 · 毛利率 49.9%/);
  assert.doesNotMatch(out, /```quarterly-chart/);
});

test('季度不足或 JSON 非法时显式失败,避免图表静默丢失', () => {
  const tooShort = '前```quarterly-chart\n{"periods":["Q1"],"revenue":[1],"grossMargin":[2]}\n```后';
  assert.throws(() => renderQuarterlyCharts(tooShort), /季度图表数据不完整/);
  assert.throws(() => renderQuarterlyCharts('前```quarterly-chart\n{x}\n```后'), /季度图表 JSON 无效/);
});

test('内联趋势图能通过 Wenyan 渲染进入微信正文', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quarterly-chart-'));
  const file = path.join(dir, 'article.md');
  const chart = renderQuarterlyCharts(`---\ntitle: T\n---\n\`\`\`quarterly-chart
{"periods":["Q1","Q2","Q3","Q4"],"revenue":[1,2,3,4],"grossMargin":[45,46,47,48]}
\`\`\``);
  await fs.writeFile(file, chart);
  try {
    const ctx = await prepareRenderContext(undefined, { ...RENDER_OPTS, file }, getInputContent);
    assert.match(ctx.gzhContent.content, /data-quarterly-chart="true"/);
    assert.match(ctx.gzhContent.content, /毛利率 48%/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
