import { easternDateKey, isUsEquitySession } from './us-equity-calendar.js';

const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;
const REQUIRED_HEADINGS = ["Today's catalysts", 'Market read'];
const STALE_ADMISSION_RE = /\b(?:not\s+(?:a\s+)?new\s+(?:overnight|today|current)|background\s+rather\s+than|no\s+fresh\s+(?:official[- ]source\s+)?items?|previously\s+disclosed|not\s+(?:a\s+)?current[- ]window\s+catalyst)\b/i;

export function validateOpeningDigestArticle({
  article,
  research = [],
  asOf = new Date(),
  requireFreshSources = false,
} = {}) {
  const body = String(article || '').replace(FRONTMATTER_RE, '').trim();
  const headings = [...body.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1]);
  if (JSON.stringify(headings) !== JSON.stringify(REQUIRED_HEADINGS)) {
    throw digestGateError(`Opening Digest 正文必须且只能按顺序包含 ${REQUIRED_HEADINGS.map((item) => `## ${item}`).join('、')}`);
  }

  const catalystsStart = body.indexOf(`## ${REQUIRED_HEADINGS[0]}`) + `## ${REQUIRED_HEADINGS[0]}`.length;
  const marketReadStart = body.indexOf(`## ${REQUIRED_HEADINGS[1]}`);
  const catalystSection = body.slice(catalystsStart, marketReadStart).trim();
  const marketRead = body.slice(marketReadStart + `## ${REQUIRED_HEADINGS[1]}`.length).trim();
  const catalystItems = catalystSection.split('\n').map((line) => line.trim()).filter((line) => /^[-*]\s+/.test(line));
  if (catalystItems.length < 3 || catalystItems.length > 5) {
    throw digestGateError(`Opening Digest Today's catalysts 必须包含 3-5 条，当前为 ${catalystItems.length} 条`);
  }
  if (catalystSection.split('\n').map((line) => line.trim()).filter(Boolean).some((line) => !/^[-*]\s+/.test(line))) {
    throw digestGateError("Opening Digest Today's catalysts 只能包含单行 Markdown 列表项");
  }

  const links = [];
  for (const [index, item] of catalystItems.entries()) {
    const itemLinks = [...item.matchAll(/\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/g)].map((match) => match[1]);
    if (itemLinks.length !== 1) {
      throw digestGateError(`Opening Digest 第 ${index + 1} 条 catalyst 必须且只能包含一个直接来源链接`);
    }
    const explanation = item.replace(/^[-*]\s+/, '').replace(/\[[^\]]+\]\(https?:\/\/[^\s)]+\)/g, '').replace(/^[\s—–:-]+/, '').trim();
    if (explanation.length < 40) {
      throw digestGateError(`Opening Digest 第 ${index + 1} 条 catalyst 缺少充分的事实和影响说明`);
    }
    if (STALE_ADMISSION_RE.test(item)) {
      throw digestGateError(`Opening Digest 第 ${index + 1} 条 catalyst 自述为旧闻或背景，不能进入今日催化剂`);
    }
    links.push(itemLinks[0]);
  }
  if (new Set(links.map(normalizedUrl)).size !== links.length) {
    throw digestGateError('Opening Digest catalyst 来源链接不得重复');
  }
  if (marketRead.length < 80 || marketRead.length > 1600) {
    throw digestGateError(`Opening Digest Market read 长度异常:${marketRead.length}`);
  }
  if (/^[-*]\s+/m.test(marketRead) || STALE_ADMISSION_RE.test(marketRead)) {
    throw digestGateError('Opening Digest Market read 不得用列表代替判断，也不得以没有新消息或旧背景作为结论');
  }

  if (requireFreshSources) {
    const sources = new Map(research.filter((source) => source?.url).map((source) => [normalizedUrl(source.url), source]));
    const cutoff = previousRegularClose(asOf);
    for (const [index, link] of links.entries()) {
      const source = sources.get(normalizedUrl(link));
      if (!source) throw digestGateError(`Opening Digest 第 ${index + 1} 条 catalyst 未匹配到本次检索来源`);
      const published = new Date(source.publishedDate || '');
      if (!Number.isFinite(published.getTime())) {
        throw digestGateError(`Opening Digest 第 ${index + 1} 条 catalyst 缺少可验证的发布日期，无法证明属于当前开盘窗口`);
      }
      if (published.getTime() < cutoff.getTime() || published.getTime() > asOf.getTime() + 5 * 60_000) {
        throw digestGateError(`Opening Digest 第 ${index + 1} 条 catalyst 不在上一交易日收盘至当前的时间窗口内`);
      }
    }
  }

  return { catalystCount: catalystItems.length, links, marketReadLength: marketRead.length };
}

export function openingDigestResearchQueries(asOf = new Date()) {
  const date = easternDateKey(asOf);
  const startPublishedDate = previousRegularClose(asOf).toISOString();
  const endPublishedDate = asOf.toISOString();
  const common = { type: 'deep', numResults: 8, startPublishedDate, endPublishedDate };
  return [
    {
      ...common,
      kind: 'opening-digest-market-news',
      query: `US stock market premarket and opening market-moving news ${date} earnings guidance large-cap catalysts`,
      systemPrompt: 'Return reporting published after the prior US regular close that can materially affect the current US equity opening. Exclude evergreen explainers, unrelated entities named Zen, and stale background.',
    },
    {
      ...common,
      kind: 'opening-digest-macro',
      query: `US markets macro data Federal Reserve Treasury yields oil dollar economic releases ${date} market open`,
      systemPrompt: 'Return current-window macro, rates, currency, commodity, and policy catalysts for the US equity open. Prefer primary releases and independently reported market-moving developments.',
    },
    {
      ...common,
      kind: 'opening-digest-corporate',
      query: `S&P 500 Nasdaq premarket earnings corporate news upgrades downgrades M&A ${date}`,
      systemPrompt: 'Return company-specific developments published after the prior US regular close with a plausible material effect on US index or sector trading today.',
    },
  ];
}

export function openingDigestSearchInput(asOf = new Date()) {
  const date = easternDateKey(asOf);
  return `US equity opening digest for ${date}: market-moving developments published since the previous regular close, including macro data, rates, earnings, guidance, and large-cap catalysts.`;
}

export function previousRegularClose(asOf = new Date()) {
  const currentKey = easternDateKey(asOf);
  const cursor = new Date(`${currentKey}T12:00:00Z`);
  do cursor.setUTCDate(cursor.getUTCDate() - 1); while (!isUsEquitySession(cursor));
  const sessionKey = cursor.toISOString().slice(0, 10);
  return easternWallTime(sessionKey, 16, 0);
}

function easternWallTime(dateKey, hour, minute) {
  const rough = new Date(`${dateKey}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'shortOffset',
  }).formatToParts(rough).find((part) => part.type === 'timeZoneName')?.value || 'GMT-5';
  const match = name.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  const offsetMinutes = match
    ? (Number(match[2]) * 60 + Number(match[3] || 0)) * (match[1] === '+' ? 1 : -1)
    : -300;
  return new Date(rough.getTime() - offsetMinutes * 60_000);
}

function normalizedUrl(value) {
  try {
    const url = new URL(String(value));
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch { return String(value || '').trim(); }
}

function digestGateError(message) {
  const error = new Error(message);
  error.stage = 'gate';
  return error;
}
