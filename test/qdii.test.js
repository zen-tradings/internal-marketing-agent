import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectQdiiTaskPlan,
  discoverCsrcReports,
  expectedQdiiPeriod,
  extractQdiiFundCodes,
  formatQdiiSlackMessages,
  normalizeAkshareFund,
  normalizeOfficialExtraction,
  parseReportPeriodLabel,
  qdiiSourcesForWriter,
  reportCandidatesFromHtml,
  runQdiiQuery,
} from '../src/core/qdii.js';

function rawFund(code = '513100', label = '2026年1季度股票投资明细', count = 10) {
  return {
    requested_code: code,
    fund_name: '国泰纳斯达克100交易型开放式指数证券投资基金(QDII)',
    fund_type: 'QDII-ETF',
    manager: '国泰基金管理有限公司',
    is_qdii: true,
    rows: Array.from({ length: count }, (_, index) => ({
      rank: index + 1,
      security_code: `US${String(index + 1).padStart(3, '0')}`,
      security_name: `Security ${index + 1}`,
      nav_ratio_pct: 9.5 - index * 0.3,
      market_value: 10000 - index * 100,
      report_label: label,
    })),
  };
}

function config(overrides = {}) {
  return {
    qdii: {
      enabled: true,
      maxFundsSlack: 20,
      maxFundsDraft: 8,
      staleMaxDays: 366,
      maxReportBytes: 30 * 1024 * 1024,
      maxTaskDownloadBytes: 150 * 1024 * 1024,
      maxReportCandidates: 3,
      ...overrides,
    },
    writer: {},
    translation: {},
  };
}

test('QDII 意图支持中英文、批量代码、渠道默认和显式双输出', () => {
  assert.deepEqual(extractQdiiFundCodes('compare 513100, 513390 and 513100'), ['513100', '513390']);
  const direct = detectQdiiTaskPlan('What are the latest holdings of QDII fund 513100?');
  assert.equal(direct.qdii, true);
  assert.equal(direct.destination, 'slack');
  assert.equal(direct.language, 'en');
  const wechat = detectQdiiTaskPlan('微信：查询 513100 持仓并写公众号');
  assert.equal(wechat.destination, 'wechat');
  assert.equal(wechat.language, 'zh');
  const dual = detectQdiiTaskPlan('Newsletter: query fund 513100 holdings, reply here and create a draft');
  assert.equal(dual.destination, 'newsletter');
  assert.equal(dual.dualReply, true);
  assert.equal(detectQdiiTaskPlan('分析股票 600519').qdii, false, '普通股票代码不能仅因六位数字触发');
  assert.equal(detectQdiiTaskPlan('513100').codeOnly, true);
  assert.equal(
    detectQdiiTaskPlan('write analysis post based on https://linear.app/zen-trading/issue/ZEN-36/qdii-holdings-513100').qdii,
    false,
    'URL slug 中的主题词和六位数字不能成为 QDII 查询参数',
  );
});

test('报告期解析统一 Q1/H1/Q3/FY，latest 门禁按法定时限加三个工作日推进', () => {
  assert.equal(parseReportPeriodLabel('2025年第一季度报告').key, '2025-Q1');
  assert.equal(parseReportPeriodLabel('2025第二季度报告').key, '2025-H1');
  assert.equal(parseReportPeriodLabel('2025年中期报告').key, '2025-H1');
  assert.equal(parseReportPeriodLabel('2025年度报告').key, '2025-FY');
  assert.equal(expectedQdiiPeriod(new Date('2026-03-20T00:00:00Z')).key, '2025-Q3');
  assert.equal(expectedQdiiPeriod(new Date('2026-04-06T00:00:00Z')).key, '2025-FY');
  assert.equal(expectedQdiiPeriod(new Date('2026-08-10T00:00:00Z')).key, '2026-Q1');
  assert.equal(expectedQdiiPeriod(new Date('2026-09-04T00:00:00Z')).key, '2026-H1');
});

test('AKShare 规范化保留代码字符串、单位、披露范围和时效警告', () => {
  const current = normalizeAkshareFund(rawFund(), {
    expectedPeriod: { year: 2026, type: 'Q1', key: '2026-Q1', end: '2026-03-31' },
    asOf: new Date('2026-08-10T00:00:00Z'),
  });
  assert.equal(current.ok, true);
  assert.equal(current.code, '513100');
  assert.equal(current.disclosureScope, 'top10');
  assert.equal(current.freshness.status, 'current');
  assert.equal(current.holdings[0].securityCode, 'US001');
  assert.equal(current.holdings[0].marketValueUnit, '10k CNY');

  const stale = normalizeAkshareFund(rawFund('513100', '2025年3季度股票投资明细'), {
    expectedPeriod: { year: 2026, type: 'Q1', key: '2026-Q1', end: '2026-03-31' },
    asOf: new Date('2026-08-10T00:00:00Z'),
    staleMaxDays: 366,
  });
  assert.equal(stale.freshness.status, 'stale-allowed');
  assert.match(stale.warnings[0], /stale/);
});

test('证监会详情页只收集带报告期的真实 PDF/instance 链接', () => {
  const html = `
    <table><tr><td><a href="../disclose/instance_show_pdf_id.do?instanceid=1475826">PDF</a>：2026第一季度报告</td></tr>
    <tr><td><a href="/guide.pdf">guide</a>操作指南</td></tr></table>`;
  const candidates = reportCandidatesFromHtml(html, 'http://eid.csrc.gov.cn/fund/disclose/detail.html', 'CSRC EID');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].reportPeriod.key, '2026-Q1');
  assert.match(candidates[0].url, /instanceid=1475826/);
});

test('证监会发现器通过安全 POST 验证基金代码后读取详情页', async () => {
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('validate_fund.do')) {
      return new Response('{"fundId":3388,"isSuccess":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('<tr><td><a href="../disclose/instance_show_pdf_id.do?instanceid=1">PDF</a>：2026第一季度报告</td></tr>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const dnsLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const candidates = await discoverCsrcReports({ code: '513100', config: { translation: { dnsLookup } }, fetchFn });
  assert.equal(candidates.length, 1);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body, 'cFundCode=513100');
});

test('当前 AKShare 数据直接落 run 级 artifact，不触发官方下载', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qdii-run-'));
  let workerCalls = 0;
  const result = await runQdiiQuery({
    input: 'QDII: latest holdings for 513100',
    config: config(),
    workDir: root,
    now: new Date('2026-08-10T00:00:00Z'),
    workerFn: async () => { workerCalls += 1; return { funds: [rawFund()] }; },
  });
  assert.equal(workerCalls, 1);
  assert.equal(result.results.length, 1);
  assert.equal(result.failures.length, 0);
  assert.equal(fs.existsSync(path.join(root, 'qdii-result.json')), true);
});

test('过期 AKShare 按 CSRC 优先回退并接受通过身份门禁的官方季度表', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qdii-official-'));
  const calls = [];
  const stale = rawFund('513100', '2025年3季度股票投资明细');
  const officialRows = rawFund().rows.map((row) => ({
    rank: row.rank,
    security_code: row.security_code,
    security_name: row.security_name,
    nav_ratio_pct: row.nav_ratio_pct,
    market_value: row.market_value * 10000,
  }));
  const workerFn = async (request) => request.action === 'query'
    ? { funds: [stale] }
    : {
        identity_verified: true,
        scan_detected: false,
        report_label: '2026年第1季度报告',
        fund_name: stale.fund_name,
        manager: stale.manager,
        master_code: '513100',
        disclosure_scope: 'top10',
        market_value_currency: 'CNY',
        market_value_unit: '人民币元',
        holdings: officialRows,
      };
  const fetchFn = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('validate_fund.do')) return new Response('{"fundId":3388,"isSuccess":true}');
    if (url.includes('fund_detail_search.do')) {
      return new Response('<tr><td><a href="../disclose/instance_show_pdf_id.do?instanceid=1">PDF</a>：2026第一季度报告</td></tr>');
    }
    return new Response(Buffer.from('%PDF-1.4\nfixture'), { headers: { 'content-type': 'application/pdf' } });
  };
  const officialConfig = config();
  officialConfig.translation.dnsLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const result = await runQdiiQuery({
    input: 'QDII: latest holdings for 513100',
    config: officialConfig,
    workDir: root,
    now: new Date('2026-08-10T00:00:00Z'),
    workerFn,
    fetchFn,
  });
  assert.equal(result.results[0].source.provider, 'CSRC EID', JSON.stringify(result.results[0]));
  assert.equal(result.results[0].reportPeriod.key, '2026-Q1');
  assert.equal(calls.some((call) => call.url.includes('sse.com.cn')), false, 'CSRC 成功后不继续查交易所');
});

test('官方 H1/FY 只有超过十行且明确完整表时才标为 full', () => {
  const candidate = { provider: 'CSRC EID', url: 'https://example.com/report.pdf', reportPeriod: { year: 2025, type: 'FY', key: '2025-FY', end: '2025-12-31' } };
  const raw = {
    identity_verified: true,
    report_label: '2025年度报告',
    disclosure_scope: 'full',
    market_value_currency: 'CNY',
    market_value_unit: '人民币元',
    holdings: rawFund('513100', '2025年度报告', 12).rows,
  };
  const full = normalizeOfficialExtraction(raw, { code: '513100', candidate, expectedPeriod: candidate.reportPeriod });
  assert.equal(full.ok, true);
  assert.equal(full.disclosureScope, 'full');
  assert.equal(normalizeOfficialExtraction({ ...raw, disclosure_scope: 'top10' }, { code: '513100', candidate }).ok, false);
  assert.equal(normalizeOfficialExtraction({ ...raw, holdings: [...raw.holdings, raw.holdings[0]] }, { code: '513100', candidate }).ok, false);
});

test('目标批量上限分别为 Slack 20 只和草稿 8 只', async () => {
  const codes = Array.from({ length: 21 }, (_, index) => String(510000 + index));
  await assert.rejects(() => runQdiiQuery({
    input: `QDII: holdings ${codes.join(' ')}`,
    config: config(),
    workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qdii-limit-')),
    workerFn: async () => ({ funds: [] }),
  }), /20-fund limit/);
  await assert.rejects(() => runQdiiQuery({
    input: `Newsletter: QDII holdings ${codes.slice(0, 9).join(' ')}`,
    config: config(),
    workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qdii-limit-')),
    workerFn: async () => ({ funds: [] }),
  }), /8-fund limit/);
});

test('只有代码时 AKShare 明确识别为非 QDII 就询问，不进入官方报告兜底', async () => {
  let fetched = false;
  await assert.rejects(() => runQdiiQuery({
    input: '600519',
    config: config(),
    workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'qdii-non-fund-')),
    workerFn: async () => ({ funds: [{ requested_code: '600519', fund_name: '普通证券投资基金', fund_type: '混合型', is_qdii: false, rows: [] }] }),
    fetchFn: async () => { fetched = true; throw new Error('must not fetch'); },
  }), (error) => error?.name === 'QdiiNeedsInputError');
  assert.equal(fetched, false);
});

test('Slack 英文表格默认前十并保留来源，AKShare 年报不冒充完整持仓', () => {
  const fund = normalizeAkshareFund(rawFund('513100', '2025年年度报告', 12), {
    requestedPeriod: { year: 2025, type: 'FY', key: '2025-FY', end: '2025-12-31' },
    asOf: new Date('2026-03-01T00:00:00Z'),
  });
  const payload = {
    query: { language: 'en', wantsFull: false },
    results: [fund],
    failures: [{ code: '513390', error: 'No data' }],
  };
  const messages = formatQdiiSlackMessages(payload);
  assert.match(messages[0], /Report period: 2025-FY/);
  assert.match(messages[0], /Eastmoney \/ AKShare/);
  assert.equal((messages[0].match(/US\d{3}/g) || []).length, 10);
  assert.match(messages.at(-1), /513390/);
  const sources = qdiiSourcesForWriter(payload);
  assert.match(sources[0].text, /do not infer undisclosed holdings/i);
  assert.match(sources[0].text, /Disclosure scope: top10/);
});
