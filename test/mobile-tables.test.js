import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findUnreadableTables, normalizeWideTables } from '../src/lib/mobile-tables.js';

test('紧凑五列表在手机宽度可读时原样放行', () => {
  const md = '| Q | Rev | GM | OM | EPS |\n|---|---:|---:|---:|---:|\n|Q1|10|20%|8%|1.2|';
  const result = normalizeWideTables(md);
  assert.equal(result.changed, false);
  assert.equal(findUnreadableTables(md).length, 0);
});

test('长表头五列表自动拆为四列加两列,首列重复且数据不丢失', () => {
  const md = [
    '| 报告期 | 营业收入（亿元） | 同比增速 | 毛利率 | 净利润/归母净利润（亿元） |',
    '|---|---:|---:|---:|---:|',
    '| 2025年 | 617.99 | 155.60% | 41.02% | 归母净利润18.75 |',
  ].join('\n');
  const result = normalizeWideTables(md);
  assert.equal(result.changed, true);
  assert.equal(result.transformedTables, 1);
  assert.equal(result.outputTables, 2);
  assert.match(result.markdown, /\| 报告期 \| 营业收入（亿元） \| 同比增速 \| 毛利率 \|/);
  assert.match(result.markdown, /\| 报告期 \| 净利润\/归母净利润（亿元） \|/);
  assert.equal((result.markdown.match(/2025年/g) || []).length, 2);
  assert.equal(result.remainingUnreadableTables, 0);
});

test('七列表按首列加三指标分组,生成两个四列表', () => {
  const md = '| 公司 | 指标一很长 | 指标二很长 | 指标三很长 | 指标四很长 | 指标五很长 | 指标六很长 |\n|---|---|---|---|---|---|---|\n|A|1|2|3|4|5|6|';
  const result = normalizeWideTables(md);
  assert.equal(result.outputTables, 2);
  assert.equal((result.markdown.match(/^\| 公司 /gm) || []).length, 2);
  assert.equal(result.remainingUnreadableTables, 0);
});

test('列数不一致的宽表不自动篡改并留给最终门禁拦截', () => {
  const md = '|a|b|c|d|e|\n|---|---|---|---|---|\n|1|2|3|4|';
  const result = normalizeWideTables(md);
  assert.equal(result.changed, false);
  assert.equal(result.remainingUnreadableTables, 1);
});
