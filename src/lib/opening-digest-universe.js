import { createHash } from 'node:crypto';
import { captureTrendingOptionsTable, validateTrendingOptionsData } from './options-volume.js';
import { easternDateKey } from './us-equity-calendar.js';

export const OPENING_DIGEST_UNIVERSE_GROUPS = Object.freeze([
  group('cloud-data-centers-software', [
    ['META', 'Meta Platforms', 'meta'],
    ['GOOGL', 'Alphabet', 'alphabet'], ['GOOG', 'Alphabet', 'alphabet'],
    ['AMZN', 'Amazon', 'amazon'], ['MSFT', 'Microsoft', 'microsoft'],
    ['BABA', 'Alibaba Group', 'alibaba'], ['SPCX', 'SpaceX', 'spacex'],
    ['ORCL', 'Oracle', 'oracle'], ['GDS', 'GDS Holdings', 'gds'],
    ['VNET', 'VNET Group', 'vnet'], ['EQIX', 'Equinix', 'equinix'],
    ['DLR', 'Digital Realty', 'digital-realty'], ['BX', 'Blackstone', 'blackstone'],
    ['BAM', 'Brookfield Asset Management', 'brookfield-asset-management'],
    ['IBM', 'IBM', 'ibm'], ['SAP', 'SAP', 'sap'],
    ['DOCN', 'DigitalOcean', 'digitalocean'], ['CRWV', 'CoreWeave', 'coreweave'],
    ['NBIS', 'Nebius Group', 'nebius'],
  ]),
  group('semiconductors-design', [
    ['NVDA', 'NVIDIA', 'nvidia'], ['AMD', 'Advanced Micro Devices', 'amd'],
    ['AVGO', 'Broadcom', 'broadcom'], ['QCOM', 'Qualcomm', 'qualcomm'],
    ['MRVL', 'Marvell Technology', 'marvell'], ['HPE', 'Hewlett Packard Enterprise', 'hpe'],
    ['ASX', 'ASE Technology Holding', 'ase-technology'],
    ['TSM', 'Taiwan Semiconductor Manufacturing', 'tsmc'],
    ['UMC', 'United Microelectronics', 'umc'], ['GFS', 'GlobalFoundries', 'globalfoundries'],
    ['INTC', 'Intel', 'intel'], ['STM', 'STMicroelectronics', 'stmicroelectronics'],
    ['SKHY', 'SK hynix', 'sk-hynix'], ['ARM', 'Arm Holdings', 'arm'],
    ['CDNS', 'Cadence Design Systems', 'cadence'], ['SNPS', 'Synopsys', 'synopsys'],
  ]),
  group('semiconductor-equipment', [
    ['ASML', 'ASML Holding', 'asml'], ['LRCX', 'Lam Research', 'lam-research'],
    ['KLAC', 'KLA', 'kla'], ['TER', 'Teradyne', 'teradyne'],
    ['ACMR', 'ACM Research', 'acm-research'],
  ]),
  group('networking-optics', [
    ['DELL', 'Dell Technologies', 'dell'], ['CSCO', 'Cisco Systems', 'cisco'],
    ['CIEN', 'Ciena', 'ciena'], ['ANET', 'Arista Networks', 'arista'],
    ['COHR', 'Coherent', 'coherent'], ['LITE', 'Lumentum', 'lumentum'],
    ['GLW', 'Corning', 'corning'],
  ]),
  group('memory-storage', [
    ['MU', 'Micron Technology', 'micron'], ['WDC', 'Western Digital', 'western-digital'],
    ['PSTG', 'Pure Storage', 'pure-storage'], ['STX', 'Seagate Technology', 'seagate'],
  ]),
  group('power-industrials', [
    ['VRT', 'Vertiv', 'vertiv'], ['JCI', 'Johnson Controls', 'johnson-controls'],
    ['ETN', 'Eaton', 'eaton'], ['ABB', 'ABB', 'abb'], ['GEV', 'GE Vernova', 'ge-vernova'],
    ['CAT', 'Caterpillar', 'caterpillar'], ['CMI', 'Cummins', 'cummins'],
    ['PWR', 'Quanta Services', 'quanta-services'], ['HUBB', 'Hubbell', 'hubbell'],
    ['CEG', 'Constellation Energy', 'constellation-energy'], ['VST', 'Vistra', 'vistra'],
    ['TLN', 'Talen Energy', 'talen-energy'], ['CCJ', 'Cameco', 'cameco'],
    ['BE', 'Bloom Energy', 'bloom-energy'], ['FLNC', 'Fluence Energy', 'fluence'],
  ]),
  group('miners-hpc', [
    ['IREN', 'IREN', 'iren'], ['APLD', 'Applied Digital', 'applied-digital'],
    ['CIFR', 'Cipher Mining', 'cipher-mining'], ['CORZ', 'Core Scientific', 'core-scientific'],
    ['HUT', 'Hut 8', 'hut-8'], ['MARA', 'MARA Holdings', 'mara'],
  ]),
]);

export const OPENING_DIGEST_UNIVERSE = Object.freeze(
  OPENING_DIGEST_UNIVERSE_GROUPS.flatMap((item) => item.members),
);
export const OPENING_DIGEST_UNIVERSE_HASH = createHash('sha256')
  .update(OPENING_DIGEST_UNIVERSE.map((item) => `${item.ticker}:${item.issuerKey}`).join('|'))
  .digest('hex');

const UNIVERSE_BY_TICKER = new Map(OPENING_DIGEST_UNIVERSE.map((item) => [item.ticker, item]));
const PRICE_MOVE_THRESHOLD = 5;
const IVX_ABSOLUTE_THRESHOLD = 60;
const IVX_POINT_CHANGE_THRESHOLD = 5;
const OIC_SOURCE_URL = 'https://www.optionseducation.org/toolsoptionquotes/trending-options-volume';

export async function collectOpeningDigestUniverseContext({
  config,
  fetchFn = globalThis.fetch,
  asOf = new Date(),
  signal,
  history,
  captureOptions = captureTrendingOptionsTable,
  quoteConcurrency = 8,
  quoteTimeoutMs = 8000,
} = {}) {
  const dateKey = easternDateKey(asOf);
  const diagnostics = [];
  const [quotes, options] = await Promise.all([
    collectUniverseQuotes({ fetchFn, asOf, signal, concurrency: quoteConcurrency, timeoutMs: quoteTimeoutMs }),
    collectUniverseOptions({ config, asOf, captureOptions, history }),
  ]);
  diagnostics.push(...quotes.diagnostics, ...options.diagnostics);
  const sources = [
    ...quotes.movers.map(quoteSource),
    ...(options.triggers.length ? [optionsSource(options)] : []),
  ];
  const artifact = {
    schemaVersion: 1,
    dateKey,
    universeHash: OPENING_DIGEST_UNIVERSE_HASH,
    capturedAt: asOf.toISOString(),
    quotes,
    options: options.prepared,
    optionSignals: {
      universeMatches: options.matches,
      triggers: options.triggers,
      history: options.history,
      coverageNote: 'IV coverage is limited to universe tickers appearing in the OIC Trending Options Volume Top 20.',
    },
    diagnostics,
  };
  return {
    artifact,
    sources,
    diagnostics,
    trace: {
      schemaVersion: artifact.schemaVersion,
      dateKey,
      universeHash: artifact.universeHash,
      universeSize: OPENING_DIGEST_UNIVERSE.length,
      quoteCoverage: quotes.coverage,
      priceMovers: quotes.movers,
      oicUniverseMatches: options.matches,
      ivTriggers: options.triggers,
      ivHistory: options.history,
      diagnostics,
    },
    promptText: universePromptText({ quotes, options }),
  };
}

export async function collectUniverseQuotes({
  fetchFn = globalThis.fetch,
  asOf = new Date(),
  signal,
  concurrency = 8,
  timeoutMs = 8000,
} = {}) {
  const results = new Array(OPENING_DIGEST_UNIVERSE.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(16, concurrency)) }, async () => {
    while (cursor < OPENING_DIGEST_UNIVERSE.length) {
      const index = cursor++;
      const member = OPENING_DIGEST_UNIVERSE[index];
      try { results[index] = await fetchUniverseQuote({ member, fetchFn, asOf, signal, timeoutMs }); }
      catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        results[index] = { ticker: member.ticker, issuerKey: member.issuerKey, unavailable: true, error: error.message };
      }
    }
  });
  await Promise.all(workers);
  const available = results.filter((item) => item && !item.unavailable);
  const failures = results.filter((item) => item?.unavailable).map((item) => ({ ticker: item.ticker, error: item.error }));
  const movers = dedupeIssuerMovers(available.filter((item) => Math.abs(item.changePct) >= PRICE_MOVE_THRESHOLD));
  return {
    capturedAt: asOf.toISOString(),
    coverage: { requested: OPENING_DIGEST_UNIVERSE.length, available: available.length, failed: failures.length },
    movers,
    failures,
    diagnostics: failures.length ? [`Opening Digest universe 行情 ${failures.length}/${results.length} 个标的不可用`] : [],
  };
}

export function analyzeUniverseOptions(data, historyData = { sessions: [], rows: [] }) {
  const validated = validateTrendingOptionsData(data);
  const matches = validated.rows
    .filter((cells) => UNIVERSE_BY_TICKER.has(String(cells[1]).toUpperCase()))
    .map(optionRow);
  const history = summarizeHistory(historyData, matches.map((item) => item.ticker));
  const triggers = matches.filter((item) => item.ivx30 >= IVX_ABSOLUTE_THRESHOLD
    || item.ivxPointChange >= IVX_POINT_CHANGE_THRESHOLD)
    .map((item) => ({ ...item, history: history[item.ticker] || emptyHistory() }));
  return { data: validated, matches, triggers, history };
}

async function collectUniverseOptions({ config, asOf, captureOptions, history }) {
  const digest = config?.openingDigest || {};
  const diagnostics = [];
  const sessionDate = easternDateKey(asOf);
  try {
    const captured = await captureOptions({
      url: digest.optionsUrl,
      storageStatePath: digest.storageStatePath,
      executablePath: digest.browserExecutablePath,
      timeoutMs: digest.captureTimeoutMs,
      automationAuthorized: digest.automationAuthorized,
    });
    const base = analyzeUniverseOptions(captured.data);
    try {
      await history?.recordCapture?.({
        sessionDate,
        capturedAt: captured.capturedAt || asOf.toISOString(),
        status: 'success',
        rows: base.matches,
      });
    } catch (error) { diagnostics.push(`Opening Digest IV 历史写入失败:${error.message}`); }
    let historyData = { sessions: [], rows: [] };
    try { historyData = await history?.listHistory?.({ limitSessions: 60 }) || historyData; }
    catch (error) { diagnostics.push(`Opening Digest IV 历史读取失败:${error.message}`); }
    const analyzed = analyzeUniverseOptions(captured.data, historyData);
    return {
      ...analyzed,
      prepared: {
        data: analyzed.data,
        capturedAt: captured.capturedAt || asOf.toISOString(),
      },
      diagnostics,
    };
  } catch (error) {
    if (history?.recordCapture) {
      try {
        await history.recordCapture({ sessionDate, capturedAt: asOf.toISOString(), status: 'failed', error: error.message, rows: [] });
      } catch (historyError) { diagnostics.push(`Opening Digest IV 失败记录写入失败:${historyError.message}`); }
    }
    diagnostics.push(`Opening Digest universe OIC 采集失败:${error.message}`);
    return { prepared: null, matches: [], triggers: [], history: {}, diagnostics };
  }
}

async function fetchUniverseQuote({ member, fetchFn, asOf, signal, timeoutMs }) {
  const endpoint = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(member.ticker)}?range=1d&interval=5m&includePrePost=false`;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal) signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(endpoint, {
        signal: controller.signal,
        headers: { 'User-Agent': 'ZenOpeningDigest/1.0' },
      });
      if (!response.ok) {
        const error = new Error(`quote ${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      return normalizeQuote(member, await response.json(), asOf);
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw signal.reason || error;
      const retryable = error.retryable || error.name === 'AbortError' || error instanceof TypeError;
      if (!retryable || attempt === 1) break;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
    }
  }
  throw lastError || new Error('quote unavailable');
}

function normalizeQuote(member, payload, asOf) {
  const quote = payload?.chart?.result?.[0];
  const meta = quote?.meta || {};
  const value = Number(meta.regularMarketPrice);
  const prior = Number(meta.chartPreviousClose ?? meta.previousClose);
  const timestampSeconds = Number(meta.regularMarketTime || quote?.timestamp?.at(-1));
  const capturedAt = new Date(timestampSeconds * 1000);
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(prior) || prior <= 0) throw new Error('quote missing current or previous close');
  if (!Number.isFinite(capturedAt.getTime()) || easternDateKey(capturedAt) !== easternDateKey(asOf)) throw new Error('quote is stale for current ET date');
  return {
    ticker: member.ticker,
    company: member.company,
    issuerKey: member.issuerKey,
    value,
    prior,
    changePct: ((value - prior) / prior) * 100,
    asOf: capturedAt.toISOString(),
    sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(member.ticker)}`,
  };
}

function dedupeIssuerMovers(items) {
  const byIssuer = new Map();
  for (const item of items) {
    const prior = byIssuer.get(item.issuerKey);
    if (!prior || Math.abs(item.changePct) > Math.abs(prior.changePct)) byIssuer.set(item.issuerKey, item);
  }
  return [...byIssuer.values()].sort((left, right) => Math.abs(right.changePct) - Math.abs(left.changePct));
}

function optionRow(cells) {
  const [rank, ticker, name, callVolume, putVolume, totalVolume, ivx30Text, ivxChangeText] = cells;
  const ivx30 = numeric(ivx30Text);
  const ivxChangePct = numeric(ivxChangeText);
  const denominator = 1 + ivxChangePct / 100;
  const priorIvx30 = denominator > 0 ? ivx30 / denominator : NaN;
  const ivxPointChange = Number.isFinite(priorIvx30) ? ivx30 - priorIvx30 : NaN;
  return {
    rank: Number(rank), ticker: String(ticker).toUpperCase(), name,
    callVolume, putVolume, totalVolume,
    ivx30, ivxChangePct, ivxPointChange,
  };
}

function summarizeHistory(historyData, tickers) {
  const sessions = Array.isArray(historyData?.sessions) ? historyData.sessions : [];
  const rows = Array.isArray(historyData?.rows) ? historyData.rows : [];
  const output = {};
  for (const ticker of tickers) {
    const appearances = rows.filter((row) => row.ticker === ticker)
      .sort((left, right) => String(right.session_date).localeCompare(String(left.session_date)));
    let consecutive = 0;
    for (const session of sessions) {
      if (appearances.some((row) => row.session_date === session)) consecutive += 1;
      else break;
    }
    output[ticker] = {
      appearances: appearances.length,
      successfulCaptures: sessions.length,
      consecutiveAppearances: consecutive,
      firstAppearanceInWindow: appearances.length === 1,
    };
  }
  return output;
}

function quoteSource(item) {
  return {
    title: `${item.ticker} market quote`,
    url: item.sourceUrl,
    publishedDate: item.asOf,
    text: `${item.ticker} (${item.company}) was ${signed(item.changePct)}% at ${item.asOf}, versus the prior regular close. This is a price fact only; no cause is asserted.`,
    openingDigestKind: 'universe-price',
    specialist: true,
  };
}

function optionsSource(options) {
  return {
    title: 'OIC Trending Options Volume',
    url: OIC_SOURCE_URL,
    publishedDate: options.prepared?.capturedAt,
    text: `OIC Top 20 universe IV signals: ${options.triggers.map((item) => `${item.ticker} IVX30 ${item.ivx30.toFixed(2)}%, derived one-day change ${signed(item.ivxPointChange)} volatility points`).join('; ')}. Coverage is limited to universe tickers appearing in the OIC Top 20.`,
    openingDigestKind: 'universe-iv',
    specialist: true,
  };
}

function universePromptText({ quotes, options }) {
  return `【Opening Digest tracked-universe signals】
Universe size: ${OPENING_DIGEST_UNIVERSE.length}. Price coverage: ${quotes.coverage.available}/${quotes.coverage.requested}.
Price movers at or above 5% versus prior regular close: ${JSON.stringify(quotes.movers)}
OIC universe matches: ${JSON.stringify(options.matches)}
OIC IV triggers (IVX30 >= 60% or derived one-day increase >= 5 volatility points): ${JSON.stringify(options.triggers)}
IV limitation: this is not a full-universe IV scan; it only covers tracked tickers that appear in the OIC Top 20.
Selection rules: prioritize material tracked-universe events; a price-only mover may be used without inventing a cause; combine standalone IV signals into at most one catalyst; allow at most one genuinely material macro catalyst; accept explicit upgrades/downgrades but not price-target-only notes or unconfirmed rumors; current-week earnings schedules may use an older verifiable schedule source.`;
}

function group(id, tuples) {
  return Object.freeze({
    id,
    members: Object.freeze(tuples.map(([ticker, company, issuerKey]) => Object.freeze({ ticker, company, issuerKey, group: id }))),
  });
}

function numeric(value) { return Number(String(value ?? '').replace(/[%,$]/g, '').replaceAll(',', '').trim()); }
function signed(value) { return `${value >= 0 ? '+' : ''}${Number(value).toFixed(2)}`; }
function emptyHistory() { return { appearances: 0, successfulCaptures: 0, consecutiveAppearances: 0, firstAppearanceInWindow: false }; }
