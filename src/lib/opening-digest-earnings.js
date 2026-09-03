import { spawn } from 'node:child_process';
import { easternDateKey } from './us-equity-calendar.js';

const MAX_CALENDAR_RESULTS = 100;
const MAX_DISPLAYED_EVENTS = 6;
const MAX_VERIFICATION_CANDIDATES = 12;
const PRESELECTION_PER_GROUP = 24;
const YAHOO_CALENDAR_URL = 'https://finance.yahoo.com/calendar/earnings';
const ACCEPTED_EXCHANGES = /(?:NASDAQ|NYSE|NEW YORK STOCK EXCHANGE|NMS|NGM|NCM|NYQ|ASE|AMEX)/i;
const REJECTED_EXCHANGES = /(?:OTC|PNK|PINK|OQB|OQX|GREY)/i;
const EXCLUDED_OFFICIAL_HOSTS = /(?:finance\.yahoo|marketwatch|bloomberg|reuters|cnbc|seekingalpha|investing\.com|marketscreener|tipranks|stockanalysis|earningswhispers|fool\.com)$/i;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function remainingEarningsWindow(asOf = new Date()) {
  const startDate = easternDateKey(asOf);
  const cursor = new Date(`${startDate}T12:00:00Z`);
  const day = cursor.getUTCDay();
  if (day === 6) return { startDate, endDate: startDate };
  const daysToFriday = day === 0 ? 5 : Math.max(0, 5 - day);
  cursor.setUTCDate(cursor.getUTCDate() + daysToFriday);
  return { startDate, endDate: cursor.toISOString().slice(0, 10) };
}

export async function collectOpeningDigestEarnings({
  config,
  asOf = new Date(),
  fetchFn = globalThis.fetch,
  signal,
  trackedTickers = [],
  workerFn = runOpeningDigestEarningsWorker,
  listingConcurrency = 6,
  listingTimeoutMs = 5000,
} = {}) {
  const window = remainingEarningsWindow(asOf);
  const digest = config?.openingDigest || {};
  if (!digest.earningsPythonPath || !digest.earningsWorkerPath) {
    return unavailableCalendar(window, 'Opening Digest earnings worker is not configured');
  }
  let raw;
  let workerError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      raw = await workerFn({ action: 'query', ...window, limit: MAX_CALENDAR_RESULTS }, { config, signal });
      workerError = null;
      break;
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      workerError = error;
    }
  }
  if (workerError) return unavailableCalendar(window, workerError.message);

  let normalized;
  try { normalized = normalizeWorkerResult(raw, window, asOf); }
  catch (error) { return unavailableCalendar(window, error.message); }
  if (!normalized.length) {
    return calendarResult({ window, raw, candidates: [], shortlist: [], listingChecks: [], status: 'ok' });
  }

  const tracked = new Set(trackedTickers.map((item) => String(item).toUpperCase()));
  const ai = normalized.filter((item) => tracked.has(item.symbol)).slice(0, PRESELECTION_PER_GROUP);
  const broad = normalized.filter((item) => !tracked.has(item.symbol)).slice(0, PRESELECTION_PER_GROUP);
  const preselection = [...ai.map((item) => ({ ...item, editorialGroup: 'ai-tech' })),
    ...broad.map((item) => ({ ...item, editorialGroup: 'broad-market' }))];
  const listingChecks = await mapConcurrent(preselection, listingConcurrency, async (candidate) => {
    try {
      return await verifyUsListing(candidate, { fetchFn, signal, timeoutMs: listingTimeoutMs });
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      return { symbol: candidate.symbol, accepted: false, unavailable: true, error: error.message };
    }
  });
  const bySymbol = new Map(listingChecks.map((item) => [item.symbol, item]));
  const verified = preselection.filter((item) => bySymbol.get(item.symbol)?.accepted)
    .map((item) => ({ ...item, listing: bySymbol.get(item.symbol) }));
  const unavailableCount = listingChecks.filter((item) => item.unavailable).length;
  if (!verified.length && unavailableCount === listingChecks.length) {
    return unavailableCalendar(window, 'all Yahoo listing verification requests failed', {
      capturedAt: raw.capturedAt,
      candidates: normalized,
      listingChecks,
    });
  }
  const verifiedAi = verified.filter((item) => item.editorialGroup === 'ai-tech');
  const verifiedBroad = verified.filter((item) => item.editorialGroup === 'broad-market');
  const shortlist = balancedTake(verifiedAi, verifiedBroad, MAX_VERIFICATION_CANDIDATES / 2, MAX_VERIFICATION_CANDIDATES);
  return calendarResult({ window, raw, candidates: normalized, shortlist, listingChecks, status: 'ok' });
}

export function openingDigestEarningsResearchQuery(calendar) {
  if (calendar?.status !== 'ok' || !Array.isArray(calendar.shortlist) || !calendar.shortlist.length) return null;
  const entities = calendar.shortlist
    .map((item) => `${item.company || item.symbol} (${item.symbol})`)
    .join(', ');
  return {
    type: 'deep',
    numResults: 12,
    kind: 'opening-digest-earnings-verification',
    openingDigestKind: 'earnings-verification',
    official: true,
    query: `Official issuer earnings releases and conference-call schedules from ${calendar.startDate} through ${calendar.endDate} for: ${entities}`,
    systemPrompt: 'Return only exact issuer investor-relations pages, issuer press releases, exchange announcements, or issuer-authored releases on established press-release wires. Each result must match one named issuer and explicitly state the earnings date. Prefer sources that state the conference-call or webcast time and timezone. Exclude financial calendars, news summaries, transcript sites, estimates, already-reported results, similarly named issuers, and dates outside the requested window.',
  };
}

export function decorateOpeningDigestWithEarnings(article, { calendar, research = [], asOf = new Date() } = {}) {
  const cleaned = removeGeneratedEarningsSection(String(article || ''));
  if (calendar?.status !== 'ok') return cleaned;
  const selection = selectEarningsHighlights(calendar, research, asOf);
  calendar.selection = selection;
  const paragraph = selection.events.length
    ? renderEarningsParagraph(selection.events)
    : 'No major U.S.-listed earnings events were selected for the remainder of this week.';
  return appendBodySection(cleaned, `## Earnings ahead\n${paragraph}`);
}

export function selectEarningsHighlights(calendar, research = [], asOf = new Date()) {
  const sources = research.filter((source) => source?.openingDigestKind === 'earnings-verification');
  const otherResearch = research.filter((source) => !['earnings-verification', 'earnings-calendar'].includes(source?.openingDigestKind));
  const enriched = (calendar?.shortlist || []).map((candidate) => {
    const official = findOfficialCall(candidate, sources);
    return {
      ...candidate,
      official,
      relevance: sourceMentionsCandidate(otherResearch, candidate) ? 1 : 0,
    };
  }).filter((candidate) => isStillUpcoming(candidate, asOf));
  const score = (item) => (item.official ? 1_000_000 : 0)
    + item.relevance * 100_000
    + Math.log10(Math.max(1, Number(item.marketCap) || 1)) * 100;
  const sorted = [...enriched].sort((left, right) => score(right) - score(left));
  const ai = sorted.filter((item) => item.editorialGroup === 'ai-tech');
  const broad = sorted.filter((item) => item.editorialGroup === 'broad-market');
  const events = balancedTake(ai, broad, 3, MAX_DISPLAYED_EVENTS)
    .sort((left, right) => eventSortTime(left) - eventSortTime(right) || left.symbol.localeCompare(right.symbol));
  return {
    schemaVersion: 1,
    selectedAt: asOf.toISOString(),
    policy: 'balanced-broad-market-and-ai-tech',
    maxEvents: MAX_DISPLAYED_EVENTS,
    events,
  };
}

export function renderEarningsParagraph(events) {
  const groups = new Map();
  for (const event of events) {
    const dateKey = eventEasternDate(event);
    if (!groups.has(dateKey)) groups.set(dateKey, []);
    groups.get(dateKey).push(event);
  }
  return [...groups.entries()].map(([dateKey, items]) => {
    const label = formatEnglishDate(dateKey);
    return `**${label}:** ${items.map(renderEarningsEvent).join('; ')}`;
  }).join('. ');
}

export async function runOpeningDigestEarningsWorker(payload, { config, signal, spawnFn = spawn } = {}) {
  const pythonPath = config?.openingDigest?.earningsPythonPath;
  const workerPath = config?.openingDigest?.earningsWorkerPath;
  if (!pythonPath || !workerPath) throw new Error('Opening Digest earnings worker is not configured');
  const timeoutMs = Number(config.openingDigest.earningsWorkerTimeoutMs || 15000);
  return new Promise((resolve, reject) => {
    const child = spawnFn(pythonPath, [workerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
      env: earningsWorkerEnvironment(process.env),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let oversized = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`Opening Digest earnings worker timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 1024 * 1024) {
        oversized = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish(reject, error));
    child.once('close', (code) => {
      if (oversized) return finish(reject, new Error('Opening Digest earnings worker output exceeded 1MB'));
      if (code !== 0) return finish(reject, new Error(`Opening Digest earnings worker failed (${code}): ${stderr.slice(0, 1000)}`));
      try { finish(resolve, JSON.parse(stdout)); }
      catch (error) { finish(reject, new Error(`Opening Digest earnings worker returned invalid JSON: ${error.message}`)); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function normalizeWorkerResult(raw, window, asOf) {
  if (raw?.schemaVersion !== 1 || raw?.provider !== 'yfinance-yahoo'
    || raw?.startDate !== window.startDate || raw?.endDate !== window.endDate
    || !Array.isArray(raw?.candidates) || raw.candidates.length > MAX_CALENDAR_RESULTS) {
    throw new Error('Opening Digest earnings worker returned an invalid calendar envelope');
  }
  const byCompany = new Map();
  for (const value of raw.candidates) {
    const symbol = String(value?.symbol || '').toUpperCase();
    const company = String(value?.company || '').trim();
    const eventStartDate = String(value?.eventStartDate || '');
    const instant = new Date(eventStartDate);
    const timing = ['BMO', 'AMC', 'TNS', 'TAS'].includes(String(value?.timing || '').toUpperCase())
      ? String(value.timing).toUpperCase() : '';
    if (!/^[A-Z0-9][A-Z0-9.\-]{0,14}$/.test(symbol) || !company || !Number.isFinite(instant.getTime())) continue;
    const dateKey = easternDateKey(instant);
    if (dateKey < window.startDate || dateKey > window.endDate || value.reportedEps != null) continue;
    const companyKey = normalizeCompany(company);
    const item = {
      symbol,
      company,
      marketCap: finiteNumber(value.marketCap),
      eventName: String(value.eventName || '').slice(0, 120),
      eventStartDate: instant.toISOString(),
      timing,
      epsEstimate: finiteNumber(value.epsEstimate),
      reportedEps: null,
      sourceUrl: yahooCalendarUrl(window),
    };
    const prior = byCompany.get(companyKey);
    if (!prior || preferredShareClass(item, prior)) byCompany.set(companyKey, item);
  }
  return [...byCompany.values()]
    .sort((left, right) => (right.marketCap || 0) - (left.marketCap || 0)
      || eventSortTime(left) - eventSortTime(right));
}

async function verifyUsListing(candidate, { fetchFn, signal, timeoutMs }) {
  const endpoint = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(candidate.symbol)}?range=1d&interval=1d`;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal) signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(endpoint, { signal: controller.signal, headers: { 'User-Agent': 'ZenOpeningDigest/1.0' } });
      if (!response.ok) {
        const error = new Error(`listing ${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      const meta = (await response.json())?.chart?.result?.[0]?.meta || {};
      const exchange = String(meta.fullExchangeName || meta.exchangeName || meta.exchange || '').trim();
      const instrumentType = String(meta.instrumentType || '').toUpperCase();
      const accepted = instrumentType === 'EQUITY' && ACCEPTED_EXCHANGES.test(exchange) && !REJECTED_EXCHANGES.test(exchange);
      return { symbol: candidate.symbol, accepted, exchange, instrumentType, unavailable: false };
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
  throw lastError || new Error('listing unavailable');
}

function findOfficialCall(candidate, sources) {
  const matches = [];
  for (const source of sources) {
    const content = sourceContent(source);
    if (!isOfficialAnnouncement(source) || !matchesCandidate(content, candidate)
      || !matchesEventDate(content, candidate) || !/(?:conference\s+call|earnings\s+call|webcast)/i.test(content)) continue;
    const call = extractCallTime(content);
    if (!call) continue;
    const reportTiming = /before\s+(?:the\s+)?(?:market|markets)(?:\s+open|\s+opens|\s+opening)/i.test(content)
      ? 'BMO'
      : /after\s+(?:the\s+)?(?:market|markets)(?:\s+close|\s+closes|\s+closing)|after\s+market\s+close/i.test(content)
        ? 'AMC' : '';
    matches.push({
      sourceUrl: source.url,
      sourceTitle: source.title || '',
      callTime: call.label,
      callMinutes: call.minutes,
      reportTiming,
    });
  }
  const unique = new Map(matches.map((item) => [`${item.callMinutes}:${item.sourceUrl}`, item]));
  const times = new Set([...unique.values()].map((item) => item.callMinutes));
  return times.size === 1 ? [...unique.values()][0] : null;
}

function extractCallTime(content) {
  const semantic = /(?:conference\s+call|earnings\s+call|webcast)/gi;
  const candidates = [];
  for (const match of content.matchAll(semantic)) {
    const snippet = content.slice(Math.max(0, match.index - 140), Math.min(content.length, match.index + 260));
    for (const time of snippet.matchAll(/\b(1[0-2]|0?\d)(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\s*(ET|EST|EDT|Eastern(?:\s+Time)?)/gi)) {
      const hour12 = Number(time[1]);
      const minute = Number(time[2] || 0);
      const pm = /^p/i.test(time[3]);
      const hour24 = (hour12 % 12) + (pm ? 12 : 0);
      const zone = /^Eastern/i.test(time[4]) ? 'ET' : time[4].toUpperCase();
      candidates.push({
        minutes: hour24 * 60 + minute,
        label: `${hour12}:${String(minute).padStart(2, '0')} ${pm ? 'p.m.' : 'a.m.'} ${zone}`,
      });
    }
  }
  const unique = new Map(candidates.map((item) => [item.minutes, item]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}

function isStillUpcoming(candidate, asOf) {
  const dateKey = eventEasternDate(candidate);
  const currentKey = easternDateKey(asOf);
  if (dateKey > currentKey) return true;
  if (dateKey < currentKey) return false;
  if (candidate.official) {
    const parts = easternParts(asOf);
    return candidate.official.callMinutes > parts.hour * 60 + parts.minute;
  }
  return candidate.timing === 'AMC';
}

function renderEarningsEvent(event) {
  const official = event.official;
  const sourceUrl = official?.sourceUrl || event.sourceUrl;
  const timing = official?.reportTiming || event.timing;
  const phrase = timing === 'BMO' ? 'before open' : timing === 'AMC' ? 'after close' : 'timing not supplied';
  if (!official) return `[${event.symbol}](${sourceUrl}) ${phrase} (expected)`;
  const report = official.reportTiming ? phrase : `${phrase} (expected)`;
  return `[${event.symbol}](${sourceUrl}) ${report}; call ${official.callTime}`;
}

function isOfficialAnnouncement(source) {
  try {
    const url = new URL(String(source?.url || ''));
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if (EXCLUDED_OFFICIAL_HOSTS.test(hostname)) return false;
    if (/(?:businesswire|globenewswire|prnewswire)\.com$/i.test(hostname)) return true;
    return Boolean(source?.official)
      && /(?:investor|investors|\bir\.|news|press|release|announcement|results)/i.test(`${hostname}${url.pathname}`);
  } catch { return false; }
}

function sourceContent(source) {
  const text = typeof source?.text === 'string' ? source.text : '';
  const highlights = Array.isArray(source?.highlights) ? source.highlights.join(' ') : String(source?.highlights || '');
  return `${source?.title || ''} ${text} ${highlights} ${source?.url || ''}`.replace(/\s+/g, ' ').trim();
}

function matchesCandidate(content, candidate) {
  const ticker = new RegExp(`(?:^|[^A-Z0-9])${escapeRegex(candidate.symbol)}(?:$|[^A-Z0-9])`, 'i');
  if (ticker.test(content)) return true;
  const tokens = normalizeCompany(candidate.company).split(' ').filter((item) => item.length >= 3).slice(0, 3);
  return tokens.length > 0 && tokens.every((token) => content.toLowerCase().includes(token));
}

function matchesEventDate(content, candidate) {
  const key = eventEasternDate(candidate);
  const [year, month, day] = key.split('-').map(Number);
  const monthName = MONTHS[month - 1];
  return new RegExp(`\\b${monthName}(?:\\w+)?\\s+0?${day}(?:st|nd|rd|th)?,?\\s+${year}\\b`, 'i').test(content)
    || new RegExp(`\\b${year}[-/]0?${month}[-/]0?${day}\\b`).test(content)
    || new RegExp(`\\b0?${month}[/]0?${day}[/]${year}\\b`).test(content);
}

function sourceMentionsCandidate(sources, candidate) {
  return sources.some((source) => matchesCandidate(sourceContent(source), candidate));
}

function eventEasternDate(event) { return easternDateKey(new Date(event.eventStartDate)); }

function eventSortTime(event) {
  const instant = new Date(event.eventStartDate).getTime();
  return Number.isFinite(instant) ? instant : Number.MAX_SAFE_INTEGER;
}

function formatEnglishDate(dateKey) {
  const date = new Date(`${dateKey}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
}

function appendBodySection(article, section) {
  return `${String(article || '').trim()}\n\n${section}\n`;
}

function removeGeneratedEarningsSection(article) {
  const lines = article.split('\n');
  const start = lines.findIndex((line) => /^##\s+Earnings ahead\s*$/.test(line));
  if (start < 0) return article;
  let end = start + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end])) end += 1;
  lines.splice(start, end - start);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function balancedTake(left, right, perGroup, limit) {
  const selected = [...left.slice(0, perGroup), ...right.slice(0, perGroup)];
  const selectedSymbols = new Set(selected.map((item) => item.symbol));
  const remainder = [...left.slice(perGroup), ...right.slice(perGroup)]
    .sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
  for (const item of remainder) {
    if (selected.length >= limit) break;
    if (!selectedSymbols.has(item.symbol)) { selected.push(item); selectedSymbols.add(item.symbol); }
  }
  return selected.slice(0, limit);
}

async function mapConcurrent(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(12, concurrency)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function calendarResult({ window, raw, candidates, shortlist, listingChecks, status }) {
  const sourceUrl = yahooCalendarUrl(window);
  return {
    schemaVersion: 1,
    status,
    provider: 'yfinance-yahoo',
    capturedAt: raw?.capturedAt || null,
    ...window,
    candidates,
    listingChecks,
    shortlist,
    sourceUrl,
    diagnostics: [],
    sources: shortlist.length ? [{
      title: `Yahoo Finance earnings calendar ${window.startDate} through ${window.endDate}`,
      url: sourceUrl,
      publishedDate: raw?.capturedAt || null,
      text: `Expected US-region earnings candidates: ${shortlist.map((item) => `${item.company} (${item.symbol}) ${eventEasternDate(item)} ${item.timing || 'timing-not-supplied'}`).join('; ')}. Yahoo timing is expected and is not an exact conference-call time.`,
      openingDigestKind: 'earnings-calendar',
      specialist: true,
    }] : [],
  };
}

function unavailableCalendar(window, error, extra = {}) {
  return {
    schemaVersion: 1,
    status: 'unavailable',
    provider: 'yfinance-yahoo',
    capturedAt: extra.capturedAt || null,
    ...window,
    candidates: extra.candidates || [],
    listingChecks: extra.listingChecks || [],
    shortlist: [],
    sourceUrl: yahooCalendarUrl(window),
    diagnostics: [`Opening Digest earnings calendar unavailable:${String(error || 'unknown error').slice(0, 500)}`],
    sources: [],
  };
}

function yahooCalendarUrl(window) {
  const query = new URLSearchParams({ from: window.startDate, to: window.endDate, day: window.startDate });
  return `${YAHOO_CALENDAR_URL}?${query}`;
}

function earningsWorkerEnvironment(environment) {
  const allowed = [
    'PATH', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'HTTP_PROXY', 'HTTPS_PROXY',
    'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  ];
  const output = { PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' };
  for (const key of allowed) if (environment[key] !== undefined) output[key] = environment[key];
  return output;
}

function normalizeCompany(value) {
  return String(value || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(?:incorporated|corporation|company|holdings?|group|limited|ltd|inc|corp|plc|adr|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function preferredShareClass(candidate, prior) {
  if ((candidate.marketCap || 0) !== (prior.marketCap || 0)) return (candidate.marketCap || 0) > (prior.marketCap || 0);
  return candidate.symbol.length < prior.symbol.length;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function easternParts(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(value).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  return { hour: parts.hour, minute: parts.minute };
}

function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
