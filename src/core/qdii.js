import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { hasPdfSignature, safeFetchResource } from '../workflows/translation-source-text.js';
import { throwIfTaskCancelled } from '../lib/task-cancellation.js';

const FUND_CODE_RE = /(?<!\d)(\d{6})(?!\d)/g;
const QDII_TERMS_RE = /(?:\bqdii\b|\bfunds?\b|\bholdings?\b|portfolio|基金|持仓|仓位|占净值|投资明细)/i;
const ANALYSIS_TERMS_RE = /(?:compare|comparison|analy[sz]e|analysis|explain|concentration|risk|change|difference|比较|对比|分析|解释|集中度|风险|变化|差异)/i;
const REPLY_TERMS_RE = /(?:reply|respond|in\s+(?:this\s+)?(?:thread|slack)|direct(?:ly)?\s+reply|回复|直接回复|线程)/i;
const WECHAT_TERMS_RE = /(?:\bwechat\b|public[- ]account|公众号|微信草稿)/i;
const NEWSLETTER_TERMS_RE = /(?:newsletter|customer\.?io|email\s+draft|邮件|电子报)/i;
const FULL_TERMS_RE = /(?:\bfull\b|complete\s+holdings?|all\s+(?:equity\s+)?holdings?|完整持仓|全部持仓|所有.*投资明细)/i;
const CSRC_BASE = 'http://eid.csrc.gov.cn';

export class QdiiNeedsInputError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'QdiiNeedsInputError';
    this.stage = 'needs_input';
    this.needsInput = true;
    this.details = { kind: 'qdii', question: message, ...details };
  }
}

export function extractQdiiFundCodes(input) {
  return [...new Set([...String(input || '').matchAll(FUND_CODE_RE)].map((match) => match[1]))];
}

export function detectQdiiTaskPlan(input) {
  const text = String(input || '').trim();
  const codes = extractQdiiFundCodes(text);
  const explicitQdii = /^(?:qdii|fund|holdings?|基金查询)\s*[:：]/i.test(text);
  const codeOnly = codes.length > 0 && text.replace(FUND_CODE_RE, '').replace(/[\s,，、;；]+/g, '') === '';
  const qdii = codes.length > 0 && (explicitQdii || codeOnly || QDII_TERMS_RE.test(text));
  if (!qdii) return { qdii: false, codes: [] };
  const wantsWechat = WECHAT_TERMS_RE.test(text) || /^(?:wechat|微信)\s*[:：]/i.test(text);
  const wantsNewsletter = NEWSLETTER_TERMS_RE.test(text) || /^(?:newsletter|email|邮件)\s*[:：]/i.test(text);
  const destination = wantsNewsletter ? 'newsletter' : wantsWechat ? 'wechat' : 'slack';
  const dualReply = destination !== 'slack' && REPLY_TERMS_RE.test(text);
  return {
    qdii: true,
    codes,
    destination,
    dualReply,
    language: explicitLanguage(text) || (destination === 'wechat' ? 'zh' : 'en'),
    wantsAnalysis: ANALYSIS_TERMS_RE.test(text),
    wantsFull: FULL_TERMS_RE.test(text),
    requestedPeriod: parseRequestedPeriod(text),
    explicitQdii,
    codeOnly,
  };
}

export function explicitLanguage(input) {
  const text = String(input || '');
  if (/(?:reply|respond|write|output|draft|answer).{0,24}\b(?:in\s+)?english\b|英文(?:输出|回复|撰写|写作)|用英文/i.test(text)) return 'en';
  if (/(?:reply|respond|write|output|draft|answer).{0,24}\b(?:in\s+)?chinese\b|中文(?:输出|回复|撰写|写作)|用中文/i.test(text)) return 'zh';
  return undefined;
}

export function parseRequestedPeriod(input) {
  const text = String(input || '');
  const yearMatch = text.match(/\b(20\d{2})\b|((?:20\d{2})年)/);
  const year = Number(yearMatch?.[1] || yearMatch?.[2]?.slice(0, 4));
  if (!year) return null;
  if (/(?:annual|year[- ]end|fy|年报|年度报告)/i.test(text)) return period(year, 'FY');
  if (/(?:half[- ]year|semi[- ]annual|\bh1\b|中报|中期报告|半年报)/i.test(text)) return period(year, 'H1');
  const quarter = text.match(/(?:\bq([1-4])\b|第?([一二三四1234])季度|([一二三四1234])季报)/i);
  if (!quarter) return null;
  const raw = quarter[1] || quarter[2] || quarter[3];
  const q = Number({ 一: 1, 二: 2, 三: 3, 四: 4 }[raw] || raw);
  return period(year, q === 1 ? 'Q1' : q === 2 ? 'H1' : q === 3 ? 'Q3' : 'FY');
}

export function parseReportPeriodLabel(label) {
  const text = String(label || '').replace(/\s+/g, '');
  const year = Number(text.match(/(20\d{2})/)?.[1]);
  if (!year) return null;
  if (/(?:年度报告|年报|annual|\bFY\b)/i.test(text) && !/(?:半年度|中期|半年)/.test(text)) return period(year, 'FY');
  if (/(?:半年度|中期|半年|H1)/i.test(text)) return period(year, 'H1');
  const quarterMatch = text.match(/第?([一二三四1-4])季度|([一二三四1-4])季/);
  const quarterRaw = quarterMatch?.[1] || quarterMatch?.[2];
  const q = Number({ 一: 1, 二: 2, 三: 3, 四: 4 }[quarterRaw] || quarterRaw);
  if (q) return period(year, q === 1 ? 'Q1' : q === 2 ? 'H1' : q === 3 ? 'Q3' : 'FY');
  return null;
}

function period(year, type) {
  const end = type === 'Q1' ? `${year}-03-31`
    : type === 'H1' ? `${year}-06-30`
      : type === 'Q3' ? `${year}-09-30`
        : `${year}-12-31`;
  return { year, type, end, key: `${year}-${type}` };
}

export function expectedQdiiPeriod(asOf = new Date()) {
  const date = dateOnly(asOf);
  const year = date.getUTCFullYear();
  const candidates = [
    { value: period(year - 1, 'FY'), deadline: addWeekdays(new Date(Date.UTC(year, 2, 31)), 3) },
    { value: period(year, 'Q1'), deadline: addWeekdays(new Date(Date.UTC(year, 2, 31)), 18) },
    { value: period(year, 'H1'), deadline: addWeekdays(new Date(Date.UTC(year, 7, 31)), 3) },
    { value: period(year, 'Q3'), deadline: addWeekdays(new Date(Date.UTC(year, 8, 30)), 18) },
  ];
  let expected = period(year - 1, 'Q3');
  for (const candidate of candidates) {
    if (date >= candidate.deadline) expected = candidate.value;
  }
  return expected;
}

function dateOnly(value) {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addWeekdays(start, count) {
  const result = new Date(start);
  let remaining = count;
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    const day = result.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return result;
}

function periodOrdinal(value) {
  if (!value) return -1;
  return value.year * 4 + ({ Q1: 0, H1: 1, Q3: 2, FY: 3 }[value.type] ?? -1);
}

export function normalizeAkshareFund(rawFund, {
  requestedPeriod,
  expectedPeriod,
  asOf = new Date(),
  staleMaxDays = 366,
} = {}) {
  if (!rawFund) return { ok: false, code: '', error: 'AKShare returned no fund data' };
  const code = String(rawFund.requested_code || rawFund.fund_code || '').padStart(6, '0');
  const fundName = String(rawFund.fund_name || '').trim();
  const fundType = String(rawFund.fund_type || '').trim();
  const isQdii = rawFund.is_qdii === true || /QDII/i.test(`${fundName} ${fundType}`);
  if (!isQdii) {
    return {
      ok: false,
      code,
      nonQdii: Boolean(fundName || fundType),
      unverified: !fundName && !fundType,
      error: `Fund ${code} could not be verified as a public QDII fund`,
    };
  }
  if (rawFund.error) return { ok: false, code, fundName, error: rawFund.error };
  const grouped = new Map();
  for (const row of Array.isArray(rawFund.rows) ? rawFund.rows : []) {
    const reportPeriod = parseReportPeriodLabel(row.report_label || row.quarter || row.report_period);
    if (!reportPeriod) continue;
    const securityCode = String(row.security_code ?? row['股票代码'] ?? '').trim();
    const securityName = String(row.security_name ?? row['股票名称'] ?? '').trim();
    const navRatioPct = numeric(row.nav_ratio_pct ?? row['占净值比例']);
    const marketValue = numeric(row.market_value ?? row['持仓市值']);
    if (!securityCode || !securityName || !Number.isFinite(navRatioPct) || navRatioPct < 0 || navRatioPct > 100) continue;
    const key = reportPeriod.key;
    if (!grouped.has(key)) grouped.set(key, { reportPeriod, holdings: [] });
    grouped.get(key).holdings.push({
      rank: grouped.get(key).holdings.length + 1,
      securityCode,
      securityName,
      navRatioPct,
      marketValue: Number.isFinite(marketValue) && marketValue >= 0 ? marketValue : null,
      marketValueCurrency: 'CNY',
      marketValueUnit: '10k CNY',
    });
  }
  const groups = [...grouped.values()].sort((a, b) => periodOrdinal(b.reportPeriod) - periodOrdinal(a.reportPeriod));
  const selected = requestedPeriod
    ? groups.find((entry) => entry.reportPeriod.key === requestedPeriod.key)
    : groups[0];
  if (!selected?.holdings.length) return { ok: false, code, fundName, error: requestedPeriod ? `AKShare does not contain ${requestedPeriod.key}` : 'AKShare returned no usable holdings' };
  selected.holdings.sort((a, b) => a.rank - b.rank || b.navRatioPct - a.navRatioPct);
  const expected = requestedPeriod || expectedPeriod || expectedQdiiPeriod(asOf);
  const current = requestedPeriod
    ? selected.reportPeriod.key === requestedPeriod.key
    : periodOrdinal(selected.reportPeriod) >= periodOrdinal(expected);
  const ageDays = Math.max(0, Math.floor((dateOnly(asOf) - new Date(`${selected.reportPeriod.end}T00:00:00Z`)) / 86400000));
  // Eastmoney/AKShare often exposes only the ranked headline table even for H1/FY
  // (and can return 11 rows for dual share classes). It cannot prove full coverage.
  const disclosureScope = 'top10';
  return {
    ok: true,
    code,
    masterCode: String(rawFund.master_code || code),
    fundName,
    fundType,
    manager: String(rawFund.manager || ''),
    officialWebsite: safeOfficialWebsite(rawFund.official_website),
    reportPeriod: selected.reportPeriod,
    disclosureScope,
    holdings: dedupeHoldings(selected.holdings),
    source: {
      provider: 'Eastmoney / AKShare',
      url: `https://fundf10.eastmoney.com/ccmx_${code}.html`,
      fetchedAt: new Date(asOf).toISOString(),
    },
    freshness: {
      status: current ? 'current' : ageDays <= staleMaxDays ? 'stale-allowed' : 'expired',
      expectedPeriod: expected,
      ageDays,
    },
    warnings: current ? [] : [`AKShare holdings are stale: ${selected.reportPeriod.key}; expected ${expected.key}.`],
  };
}

function safeOfficialWebsite(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : '';
  } catch { return ''; }
}

function dedupeHoldings(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.securityCode}\u0000${row.securityName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function numeric(value) {
  const parsed = Number(String(value ?? '').replace(/[,，%\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export async function runQdiiQuery({
  input,
  taskPlan: suppliedTaskPlan,
  config,
  workDir,
  fetchFn = globalThis.fetch,
  workerFn = runQdiiPythonWorker,
  now = new Date(),
  signal,
  onProgress,
} = {}) {
  const detectedPlan = detectQdiiTaskPlan(input);
  const taskPlan = suppliedTaskPlan?.qdii ? { ...detectedPlan, ...suppliedTaskPlan } : detectedPlan;
  if (!taskPlan.qdii) throw new QdiiNeedsInputError('Please include at least one six-digit QDII fund code and ask for holdings data.');
  if (config?.qdii?.enabled === false) throw new Error('QDII query support is disabled by QDII_ENABLED');
  const limit = taskPlan.destination === 'slack' ? config.qdii.maxFundsSlack : config.qdii.maxFundsDraft;
  if (taskPlan.codes.length > limit) throw new Error(`QDII query exceeds the ${limit}-fund limit for this destination`);
  throwIfTaskCancelled(signal);
  fs.mkdirSync(workDir, { recursive: true });
  await onProgress?.({ stage: 'qdii-akshare', message: `Querying AKShare for ${taskPlan.codes.length} QDII fund(s)` });
  const workerResult = await workerFn({
    action: 'query',
    fundCodes: taskPlan.codes,
    year: taskPlan.requestedPeriod?.year ? String(taskPlan.requestedPeriod.year) : '',
  }, { config, signal });
  const expectedPeriod = expectedQdiiPeriod(now);
  const normalized = (workerResult?.funds || []).map((fund) => normalizeAkshareFund(fund, {
    requestedPeriod: taskPlan.requestedPeriod,
    expectedPeriod,
    asOf: now,
    staleMaxDays: config.qdii.staleMaxDays,
  }));
  const byCode = new Map(normalized.map((item) => [item.code, item]));
  const results = [];
  const failures = [];
  const downloadBudget = { used: 0, max: config.qdii.maxTaskDownloadBytes };
  for (const code of taskPlan.codes) {
    throwIfTaskCancelled(signal);
    const primary = byCode.get(code) || { ok: false, code, error: 'AKShare returned no result for this code' };
    if (primary.nonQdii) {
      failures.push({ code, error: primary.error });
      continue;
    }
    const needsVerifiedFull = taskPlan.wantsFull
      && taskPlan.requestedPeriod
      && ['H1', 'FY'].includes(taskPlan.requestedPeriod.type)
      && primary.disclosureScope !== 'full';
    if (primary.ok && primary.freshness.status === 'current' && !needsVerifiedFull) {
      results.push(primary);
      continue;
    }
    await onProgress?.({ stage: 'qdii-official', message: `Checking official disclosures for ${code}` });
    let official;
    try {
      official = await fetchOfficialHoldings({
        code,
        primary,
        requestedPeriod: taskPlan.requestedPeriod,
        expectedPeriod,
        config,
        workDir,
        fetchFn,
        workerFn,
        signal,
        downloadBudget,
      });
    } catch (error) {
      primary.officialFallbackError = String(error?.message || error).slice(0, 500);
    }
    if (official?.ok) {
      results.push(official);
      continue;
    }
    if (primary.ok && primary.freshness.status === 'stale-allowed') {
      primary.warnings.push(`Official fallback failed${primary.officialFallbackError ? `: ${primary.officialFallbackError}` : '.'}`);
      results.push(primary);
      continue;
    }
    failures.push({ code, error: primary.error || primary.officialFallbackError || 'No usable holdings found' });
  }
  if (!results.length && failures.length && (taskPlan.codeOnly || normalized.every((item) => item.nonQdii))) {
    throw new QdiiNeedsInputError('The supplied six-digit code(s) could not be verified as public QDII funds. Please confirm the fund codes or add “QDII holdings” to the request.', { failures });
  }
  const payload = {
    kind: 'qdii-holdings',
    query: {
      request: String(input || '').slice(0, 4000),
      fundCodes: taskPlan.codes,
      requestedPeriod: taskPlan.requestedPeriod,
      expectedPeriod,
      language: taskPlan.language,
      wantsAnalysis: taskPlan.wantsAnalysis,
      wantsFull: taskPlan.wantsFull,
    },
    results,
    failures,
    generatedAt: new Date(now).toISOString(),
  };
  if (taskPlan.wantsAnalysis && results.length) {
    try {
      payload.analysis = await generateQdiiAnalysis(payload, { config, fetchFn, signal });
    } catch (error) {
      payload.analysisWarning = `Analysis was unavailable: ${String(error?.message || error).slice(0, 300)}`;
    }
  }
  const artifactPath = path.join(workDir, 'qdii-result.json');
  fs.writeFileSync(artifactPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return { ...payload, artifactPath, taskPlan };
}

export async function generateQdiiAnalysis(payload, { config, fetchFn = globalThis.fetch, signal } = {}) {
  const writer = config?.writer || {};
  if (!writer.openrouterApiKey || !writer.model) throw new Error('OpenRouter is not configured');
  const evidence = (payload.results || []).map((fund) => qdiiEvidenceText(fund)).join('\n\n');
  const language = payload.query?.language === 'zh' ? 'Chinese' : 'English';
  const response = await fetchFn(`${String(writer.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${writer.openrouterApiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': writer.httpReferer || 'https://zentradings.com',
      'X-OpenRouter-Title': writer.appTitle || 'Zen Content Hub',
    },
    body: JSON.stringify({
      model: writer.reviewModel || writer.model,
      temperature: 0,
      max_tokens: 700,
      reasoning: { effort: writer.reviewReasoningEffort || 'none', exclude: true },
      messages: [
        {
          role: 'system',
          content: `You summarize structured public-fund holdings evidence. Write in ${language}. Use only the supplied rows. Preserve all fund codes, report periods, percentages, values, disclosure-scope labels, and stale-data warnings exactly. Do not claim top-ten disclosure is a full portfolio. Return at most four concise bullet points and no table.`,
        },
        {
          role: 'user',
          content: `User request:\n${String(payload.query?.request || '').slice(0, 4000)}\n\nStructured evidence:\n${evidence}`.slice(0, 80000),
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`OpenRouter analysis failed: ${response.status}`);
  const data = await response.json();
  const raw = data?.choices?.[0]?.message?.content;
  const text = Array.isArray(raw) ? raw.map((part) => part?.text || '').join('') : String(raw || '');
  if (!text.trim()) throw new Error('OpenRouter analysis returned empty content');
  return text.trim().slice(0, 5000);
}

export async function runQdiiPythonWorker(payload, { config, signal, spawnFn = spawn } = {}) {
  const pythonPath = config?.qdii?.pythonPath;
  const workerPath = config?.qdii?.workerPath;
  if (!pythonPath || !workerPath) throw new Error('QDII Python worker is not configured');
  const timeoutMs = Number(config.qdii.workerTimeoutMs || 120000);
  return new Promise((resolve, reject) => {
    const child = spawnFn(pythonPath, [workerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
      env: qdiiWorkerEnvironment(process.env),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`QDII Python worker timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish(reject, error));
    child.once('close', (code) => {
      if (code !== 0) return finish(reject, new Error(`QDII Python worker failed (${code}): ${stderr.slice(0, 1000)}`));
      try { finish(resolve, JSON.parse(stdout)); }
      catch (error) { finish(reject, new Error(`QDII Python worker returned invalid JSON: ${error.message}`)); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function qdiiWorkerEnvironment(environment) {
  const allowed = [
    'PATH', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'HTTP_PROXY', 'HTTPS_PROXY',
    'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  ];
  const output = { PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' };
  for (const key of allowed) {
    if (environment[key] !== undefined) output[key] = environment[key];
  }
  return output;
}

async function fetchOfficialHoldings({
  code,
  primary,
  requestedPeriod,
  expectedPeriod,
  config,
  workDir,
  fetchFn,
  workerFn,
  signal,
  downloadBudget,
}) {
  const targetPeriod = requestedPeriod || expectedPeriod;
  const attempts = [];
  const providerDiscoveries = [
    () => discoverCsrcReports({ code, config, fetchFn }),
    () => discoverExchangeReports({ code, config, fetchFn }),
    () => discoverManagerReports({ code, managerUrl: primary?.officialWebsite, config, fetchFn }),
  ];
  for (const discover of providerDiscoveries) {
    throwIfTaskCancelled(signal);
    let candidates = [];
    try { candidates = await discover(); }
    catch (error) { attempts.push({ stage: 'discover', error: String(error?.message || error) }); }
    const ordered = candidates
      .filter((candidate) => candidate.reportPeriod)
      .sort((a, b) => {
        const aTarget = a.reportPeriod.key === targetPeriod.key ? 1 : 0;
        const bTarget = b.reportPeriod.key === targetPeriod.key ? 1 : 0;
        return bTarget - aTarget || periodOrdinal(b.reportPeriod) - periodOrdinal(a.reportPeriod);
      });
    for (const candidate of ordered.slice(0, config.qdii.maxReportCandidates)) {
      if (requestedPeriod && candidate.reportPeriod.key !== requestedPeriod.key) continue;
      if (!requestedPeriod && periodOrdinal(candidate.reportPeriod) < periodOrdinal(targetPeriod)) continue;
      try {
        const fetched = await safeFetchResource({
          url: candidate.url,
          fetchFn,
          dnsLookup: config.translation?.dnsLookup,
          accept: 'application/pdf,*/*;q=0.2',
          maxBytes: config.qdii.maxReportBytes,
        });
        if (!hasPdfSignature(fetched.buffer)) throw new Error('Official report response is not a real PDF');
        if (downloadBudget) {
          downloadBudget.used += fetched.buffer.length;
          if (downloadBudget.used > downloadBudget.max) throw new Error(`QDII task download budget exceeded: ${downloadBudget.used}/${downloadBudget.max}`);
        }
        const reportDir = path.join(workDir, 'official-reports', code);
        fs.mkdirSync(reportDir, { recursive: true });
        const pdfPath = path.join(reportDir, `${candidate.reportPeriod.key}.pdf`);
        fs.writeFileSync(pdfPath, fetched.buffer, { mode: 0o600 });
        const extracted = await workerFn({
          action: 'extract_pdf',
          pdfPath,
          fundCode: code,
          masterCode: primary?.masterCode || code,
          fundName: primary?.fundName || '',
          manager: primary?.manager || '',
          reportPeriod: candidate.reportPeriod,
        }, { config, signal });
        const validated = normalizeOfficialExtraction(extracted, {
          code,
          candidate: { ...candidate, url: fetched.finalUrl },
          expectedPeriod: targetPeriod,
        });
        if (validated.ok) return validated;
        attempts.push({ stage: 'extract', url: candidate.url, error: validated.error });
      } catch (error) {
        attempts.push({ stage: 'download-or-extract', url: candidate.url, error: String(error?.message || error) });
      }
    }
  }
  const lastAttempt = attempts.at(-1);
  const detail = lastAttempt?.error ? `: ${lastAttempt.error}` : '';
  const error = new Error(`No verified official report was usable for ${code}${detail}`);
  error.attempts = attempts;
  throw error;
}

export async function discoverCsrcReports({ code, config = {}, fetchFn = globalThis.fetch } = {}) {
  const form = new URLSearchParams({ cFundCode: code }).toString();
  const validation = await safeFetchResource({
    url: `${CSRC_BASE}/fund/disclose/validate_fund.do`,
    fetchFn,
    dnsLookup: config.translation?.dnsLookup,
    method: 'POST',
    body: form,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    accept: 'application/json,text/plain,*/*;q=0.2',
    maxBytes: 64 * 1024,
  });
  const data = JSON.parse(validation.buffer.toString('utf8').replace(/^\uFEFF/, ''));
  if (!data?.isSuccess || !Number.isInteger(Number(data.fundId))) return [];
  const detail = await safeFetchResource({
    url: `${CSRC_BASE}/fund/disclose/fund_detail_search.do?cFundCode=${encodeURIComponent(data.fundId)}`,
    fetchFn,
    dnsLookup: config.translation?.dnsLookup,
    accept: 'text/html,*/*;q=0.2',
    maxBytes: 2 * 1024 * 1024,
  });
  return reportCandidatesFromHtml(detail.buffer.toString('utf8'), detail.finalUrl, 'CSRC EID');
}

export async function discoverExchangeReports({ code, config = {}, fetchFn = globalThis.fetch } = {}) {
  const pages = [
    `https://www.sse.com.cn/disclosure/fund/announcement/?productId=${encodeURIComponent(code)}`,
    `https://www.szse.cn/disclosure/fund/notice/index.html?code=${encodeURIComponent(code)}`,
  ];
  const output = [];
  for (const url of pages) {
    try {
      const fetched = await safeFetchResource({
        url,
        fetchFn,
        dnsLookup: config.translation?.dnsLookup,
        accept: 'text/html,*/*;q=0.2',
        maxBytes: 2 * 1024 * 1024,
      });
      output.push(...reportCandidatesFromHtml(fetched.buffer.toString('utf8'), fetched.finalUrl, new URL(url).hostname));
    } catch {}
  }
  return output.filter((item) => item.title.includes(code) || item.url.includes(code));
}

export async function discoverManagerReports({ code, managerUrl, config = {}, fetchFn = globalThis.fetch } = {}) {
  if (!managerUrl) return [];
  const url = new URL(managerUrl);
  url.searchParams.set('keyword', code);
  const fetched = await safeFetchResource({
    url: url.toString(),
    fetchFn,
    dnsLookup: config.translation?.dnsLookup,
    accept: 'text/html,*/*;q=0.2',
    maxBytes: 2 * 1024 * 1024,
  });
  return reportCandidatesFromHtml(fetched.buffer.toString('utf8'), fetched.finalUrl, url.hostname)
    .filter((item) => item.title.includes(code) || item.url.includes(code));
}

export function reportCandidatesFromHtml(html, baseUrl, provider) {
  const dom = new JSDOM(String(html || ''));
  const output = [];
  const seen = new Set();
  for (const anchor of dom.window.document.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href') || '';
    if (!/(?:\.pdf(?:$|[?#])|instance_show_pdf_id\.do|fund_attach_detail)/i.test(href)) continue;
    const container = anchor.closest('tr,li,div,p') || anchor.parentElement || anchor;
    const title = String(container.textContent || anchor.textContent || '').replace(/\s+/g, ' ').trim();
    const reportPeriod = parseReportPeriodLabel(title);
    if (!reportPeriod) continue;
    let url;
    try { url = new URL(href, baseUrl).toString(); } catch { continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    output.push({ provider, title, url, reportPeriod });
  }
  dom.window.close();
  return output;
}

export function normalizeOfficialExtraction(raw, { code, candidate, expectedPeriod } = {}) {
  if (!raw || raw.scan_detected) return { ok: false, code, error: raw?.scan_detected ? 'Official PDF appears to be scanned; OCR is not enabled in v1' : 'PDF extractor returned no data' };
  if (raw.identity_verified !== true) return { ok: false, code, error: 'Official PDF identity gate failed' };
  const reportPeriod = parseReportPeriodLabel(raw.report_label) || candidate?.reportPeriod;
  if (!reportPeriod || (candidate?.reportPeriod && reportPeriod.key !== candidate.reportPeriod.key)) {
    return { ok: false, code, error: 'Official PDF report period did not match the selected disclosure' };
  }
  const holdings = [];
  for (const row of Array.isArray(raw.holdings) ? raw.holdings : []) {
    const securityCode = String(row.security_code || '').trim();
    const securityName = String(row.security_name || '').trim();
    const navRatioPct = numeric(row.nav_ratio_pct);
    const marketValue = numeric(row.market_value);
    if (!securityCode || !securityName || !Number.isFinite(navRatioPct) || navRatioPct < 0 || navRatioPct > 100) continue;
    holdings.push({
      rank: positiveInt(row.rank) || holdings.length + 1,
      securityCode,
      securityName,
      navRatioPct,
      marketValue: Number.isFinite(marketValue) && marketValue >= 0 ? marketValue : null,
      marketValueCurrency: String(raw.market_value_currency || 'CNY'),
      marketValueUnit: String(raw.market_value_unit || 'source unit'),
    });
  }
  const unique = dedupeHoldings(holdings);
  if (!unique.length || unique.length !== holdings.length) return { ok: false, code, error: 'Official PDF holdings were empty or contained duplicate securities' };
  const desiredScope = ['Q1', 'Q3'].includes(reportPeriod.type) ? 'top10' : 'full';
  const disclosureScope = raw.disclosure_scope === 'full' && unique.length > 10 ? 'full' : 'top10';
  if (desiredScope === 'full' && disclosureScope !== 'full') return { ok: false, code, error: 'Official H1/FY table did not prove complete holdings coverage' };
  return {
    ok: true,
    code,
    masterCode: String(raw.master_code || code),
    fundName: String(raw.fund_name || ''),
    manager: String(raw.manager || ''),
    reportPeriod,
    disclosureScope,
    holdings: unique.sort((a, b) => a.rank - b.rank),
    source: { provider: candidate.provider, url: candidate.url, fetchedAt: new Date().toISOString() },
    freshness: { status: periodOrdinal(reportPeriod) >= periodOrdinal(expectedPeriod) ? 'current' : 'stale-allowed', expectedPeriod, ageDays: null },
    warnings: [],
  };
}

export function qdiiSourcesForWriter(payload) {
  return (payload?.results || []).map((fund, index) => ({
    id: `qdii-${fund.code}-${index + 1}`,
    title: `${fund.fundName || fund.code} disclosed equity holdings (${fund.reportPeriod.key})`,
    url: fund.source.url,
    publishedDate: fund.reportPeriod.end,
    official: fund.source.provider !== 'Eastmoney / AKShare',
    priority: true,
    userSpecified: false,
    sourceType: 'qdii-holdings',
    text: qdiiEvidenceText(fund, payload.failures),
  }));
}

function qdiiEvidenceText(fund, failures = []) {
  const rows = fund.holdings.map((row) => [
    row.rank,
    row.securityCode,
    row.securityName,
    row.navRatioPct,
    row.marketValue ?? 'N/A',
    row.marketValueUnit,
  ].join('\t'));
  return [
    `Fund code: ${fund.code}`,
    `Fund name: ${fund.fundName}`,
    `Report period: ${fund.reportPeriod.key} (${fund.reportPeriod.end})`,
    `Disclosure scope: ${fund.disclosureScope}`,
    `Freshness: ${fund.freshness.status}`,
    `Provider: ${fund.source.provider}`,
    ...(fund.warnings || []).map((warning) => `Warning: ${warning}`),
    'Rank\tSecurity code\tSecurity name\tNAV weight (%)\tMarket value\tMarket value unit',
    ...rows,
    ...(failures.length ? [`Other requested funds unavailable: ${failures.map((item) => `${item.code} (${item.error})`).join('; ')}`] : []),
    'These rows are structured evidence. Preserve every code, percentage, market value, report period, disclosure-scope label, and warning exactly; do not infer undisclosed holdings.',
  ].join('\n');
}

export function formatQdiiSlackMessages(payload, { maxChars = 3000, language = payload?.query?.language || 'en' } = {}) {
  const chunks = [];
  const isZh = language === 'zh';
  for (const fund of payload?.results || []) {
    const warning = (fund.warnings || []).length
      ? `${isZh ? '⚠️ 警告' : '⚠️ Warning'}: ${(fund.warnings || []).join(' ')}`
      : '';
    const header = [
      `*${escapeSlack(fund.fundName || fund.code)}* (${fund.code})`,
      `${isZh ? '报告期' : 'Report period'}: ${fund.reportPeriod.key} · ${isZh ? '披露范围' : 'Scope'}: ${fund.disclosureScope}`,
      `${isZh ? '来源' : 'Source'}: <${fund.source.url}|${escapeSlack(fund.source.provider)}>`,
      warning,
    ].filter(Boolean).join('\n');
    const rows = fund.holdings.slice(0, payload.query?.wantsFull && ['H1', 'FY'].includes(fund.reportPeriod.type) ? fund.holdings.length : 10);
    const lines = rows.map((row) => `${String(row.rank).padStart(2)}  ${truncate(row.securityCode, 12).padEnd(12)} ${truncate(row.securityName, 22).padEnd(22)} ${formatNumber(row.navRatioPct).padStart(7)}%  ${formatMarketValue(row)}`);
    const columnHeader = isZh
      ? ' #  代码         名称                    净值占比     市值'
      : ' #  Code         Name                    NAV wt.     Market value';
    const blocks = chunkLines(lines, Math.max(500, maxChars - header.length - columnHeader.length - 16));
    blocks.forEach((block, index) => chunks.push(`${index === 0 ? header : `*${fund.code} ${isZh ? '续' : 'continued'}*`}\n\`\`\`\n${columnHeader}\n${block.join('\n')}\n\`\`\``));
  }
  if (payload?.failures?.length) {
    chunks.push(`${language === 'zh' ? '*未取得数据*' : '*Unavailable funds*'}\n${payload.failures.map((item) => `• ${item.code}: ${escapeSlack(item.error)}`).join('\n')}`);
  }
  if (payload?.analysis) chunks.push(`*${language === 'zh' ? '分析' : 'Analysis'}*\n${payload.analysis}`);
  if (payload?.analysisWarning) chunks.push(`⚠️ ${escapeSlack(payload.analysisWarning)}`);
  if (!chunks.length) chunks.push(language === 'zh' ? '未取得可用的 QDII 股票持仓数据。' : 'No usable QDII equity holdings were found.');
  return chunks;
}

function chunkLines(lines, maxChars) {
  const chunks = [];
  let current = [];
  let length = 0;
  for (const line of lines) {
    if (current.length && length + line.length + 1 > maxChars) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(line);
    length += line.length + 1;
  }
  if (current.length) chunks.push(current);
  return chunks.length ? chunks : [[]];
}

function truncate(value, max) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

function formatNumber(value) {
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatMarketValue(row) {
  if (!Number.isFinite(row.marketValue)) return 'N/A';
  return `${Number(row.marketValue).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${row.marketValueUnit}`;
}

function escapeSlack(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
