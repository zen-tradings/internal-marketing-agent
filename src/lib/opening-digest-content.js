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
  return auditOpeningDigestArticle({ article, research, asOf, requireFreshSources });
}

export function auditOpeningDigestArticle({
  article,
  research = [],
  asOf = new Date(),
  requireFreshSources = false,
} = {}) {
  const warnings = [];
  const body = String(article || '').replace(FRONTMATTER_RE, '').trim();
  const headings = [...body.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1]);
  if (JSON.stringify(headings) !== JSON.stringify(REQUIRED_HEADINGS)) {
    warnings.push(`Opening Digest 正文应按顺序只包含 ${REQUIRED_HEADINGS.map((item) => `## ${item}`).join('、')}`);
  }

  const catalystsHeadingAt = body.indexOf(`## ${REQUIRED_HEADINGS[0]}`);
  const marketReadStart = body.indexOf(`## ${REQUIRED_HEADINGS[1]}`);
  const catalystsStart = catalystsHeadingAt < 0
    ? 0
    : catalystsHeadingAt + `## ${REQUIRED_HEADINGS[0]}`.length;
  const catalystSection = body.slice(catalystsStart, marketReadStart < 0 ? body.length : marketReadStart).trim();
  const marketRead = marketReadStart < 0
    ? ''
    : body.slice(marketReadStart + `## ${REQUIRED_HEADINGS[1]}`.length).trim();
  const catalystItems = catalystSection.split('\n').map((line) => line.trim()).filter((line) => /^[-*]\s+/.test(line));
  if (catalystItems.length < 3 || catalystItems.length > 5) {
    warnings.push(`Opening Digest Today's catalysts 建议包含 3-5 条，当前为 ${catalystItems.length} 条`);
  }
  if (catalystSection.split('\n').map((line) => line.trim()).filter(Boolean).some((line) => !/^[-*]\s+/.test(line))) {
    warnings.push("Opening Digest Today's catalysts 建议只包含单行 Markdown 列表项");
  }

  const links = [];
  for (const [index, item] of catalystItems.entries()) {
    const itemLinks = [...item.matchAll(/\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/g)].map((match) => match[1]);
    if (itemLinks.length !== 1) {
      warnings.push(`Opening Digest 第 ${index + 1} 条 catalyst 建议只包含一个直接来源链接`);
    }
    const explanation = item.replace(/^[-*]\s+/, '').replace(/\[[^\]]+\]\(https?:\/\/[^\s)]+\)/g, '').replace(/^[\s—–:-]+/, '').trim();
    if (explanation.length < 40) {
      warnings.push(`Opening Digest 第 ${index + 1} 条 catalyst 缺少充分的事实和影响说明`);
    }
    if (STALE_ADMISSION_RE.test(item)) {
      warnings.push(`Opening Digest 第 ${index + 1} 条 catalyst 自述为旧闻或背景`);
    }
    links.push(...itemLinks);
  }
  if (new Set(links.map(normalizedUrl)).size !== links.length) {
    warnings.push('Opening Digest catalyst 来源链接存在重复');
  }
  if (marketRead.length < 80 || marketRead.length > 1600) {
    warnings.push(`Opening Digest Market read 长度异常:${marketRead.length}`);
  }
  if (/^[-*]\s+/m.test(marketRead) || STALE_ADMISSION_RE.test(marketRead)) {
    warnings.push('Opening Digest Market read 建议使用判断段落，不应以没有新消息或旧背景作为结论');
  }

  if (requireFreshSources) {
    const sources = new Map(research.filter((source) => source?.url).map((source) => [normalizedUrl(source.url), source]));
    const cutoff = previousRegularClose(asOf);
    for (const [index, link] of links.entries()) {
      const source = sources.get(normalizedUrl(link));
      if (!source) {
        warnings.push(`Opening Digest 第 ${index + 1} 个 catalyst 链接未匹配到本次检索来源`);
        continue;
      }
      const published = new Date(source.publishedDate || '');
      if (!Number.isFinite(published.getTime())) {
        warnings.push(`Opening Digest 第 ${index + 1} 个 catalyst 链接缺少可验证的发布日期`);
        continue;
      }
      if (published.getTime() < cutoff.getTime() || published.getTime() > asOf.getTime() + 5 * 60_000) {
        warnings.push(`Opening Digest 第 ${index + 1} 个 catalyst 链接不在上一交易日收盘至当前的时间窗口内`);
      }
    }
  }

  return {
    warnings,
    stats: { catalystCount: catalystItems.length, links, marketReadLength: marketRead.length },
    catalystCount: catalystItems.length,
    links,
    marketReadLength: marketRead.length,
  };
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
