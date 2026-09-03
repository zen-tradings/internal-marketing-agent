import { easternDateKey, isUsEquitySession } from './us-equity-calendar.js';
import { OPENING_DIGEST_UNIVERSE_GROUPS } from './opening-digest-universe.js';
import { openingDigestEarningsResearchQuery } from './opening-digest-earnings.js';
import { auditOpeningDigestInsight, parseOpeningDigestMetadata } from './opening-digest-editorial.js';

const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;
const REQUIRED_HEADINGS = ["Today's catalysts", 'Market read'];
const EARNINGS_HEADING = 'Earnings ahead';
const STALE_ADMISSION_RE = /\b(?:not\s+(?:a\s+)?new\s+(?:overnight|today|current)|background\s+rather\s+than|no\s+fresh\s+(?:official[- ]source\s+)?items?|previously\s+disclosed|not\s+(?:a\s+)?current[- ]window\s+catalyst)\b/i;
export const OPENING_DIGEST_CATALYST_MAX_WORDS = 40;
export const OPENING_DIGEST_MARKET_READ_MAX_WORDS = 80;
export const OPENING_DIGEST_MARKET_READ_MIN_SENTENCES = 3;
export const OPENING_DIGEST_MARKET_READ_MAX_SENTENCES = 5;

export function visibleEnglishWordCount(markdown) {
  const visible = String(markdown || '')
    .replace(/!\[([^\]]*)]\(https?:\/\/[^\s)]+\)/g, ' $1 ')
    .replace(/\[([^\]]+)]\(https?:\/\/[^\s)]+\)/g, ' $1 ')
    .replace(/<https?:\/\/[^>]+>/g, ' ')
    .replace(/https?:\/\/[^\s)>\]}"']+/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_~>#|]/g, ' ');
  return (visible.match(/(?:[$€£¥]\s*)?(?:[A-Za-z0-9]+(?:[.'’:/+-][A-Za-z0-9]+)*)%?/g) || []).length;
}

export function visibleEnglishSentenceCount(markdown) {
  const text = visibleMarkdownText(markdown);
  if (!text) return 0;
  try {
    const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
    return [...segmenter.segment(text)]
      .map((entry) => entry.segment.trim())
      .filter((entry) => visibleEnglishWordCount(entry) > 0).length;
  } catch {
    return text.split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
      .filter((entry) => visibleEnglishWordCount(entry) > 0).length;
  }
}

export function openingDigestEditorialBlocks(article) {
  const source = String(article || '');
  const catalystsHeading = /^## Today's catalysts\s*$/m.exec(source);
  const marketHeading = /^## Market read\s*$/m.exec(source);
  if (!catalystsHeading || !marketHeading || marketHeading.index <= catalystsHeading.index) {
    return { catalysts: [], marketRead: null };
  }
  const catalystsStart = catalystsHeading.index + catalystsHeading[0].length;
  const catalystsSection = source.slice(catalystsStart, marketHeading.index);
  const catalysts = [...catalystsSection.matchAll(/^[-*]\s+.+$/gm)].map((match, index) => ({
    id: `catalyst-${index + 1}`,
    kind: 'catalyst',
    index,
    text: match[0].trimEnd(),
    start: catalystsStart + match.index,
    end: catalystsStart + match.index + match[0].length,
  }));
  let marketStart = marketHeading.index + marketHeading[0].length;
  while (marketStart < source.length && /\s/.test(source[marketStart])) marketStart += 1;
  let marketEnd = source.length;
  while (marketEnd > marketStart && /\s/.test(source[marketEnd - 1])) marketEnd -= 1;
  const marketText = source.slice(marketStart, marketEnd);
  return {
    catalysts,
    marketRead: marketText ? {
      id: 'market-read', kind: 'market-read', text: marketText, start: marketStart, end: marketEnd,
    } : null,
  };
}

export async function compactOpeningDigestArticle({ article, compactBlock, verifyBlock } = {}) {
  const source = String(article || '');
  const parsed = openingDigestEditorialBlocks(source);
  const blocks = [...parsed.catalysts, ...(parsed.marketRead ? [parsed.marketRead] : [])];
  const replacements = [];
  const traceBlocks = [];
  for (const block of blocks) {
    const before = editorialBlockMetrics(block);
    const reasons = editorialRepairReasons(block, before);
    if (!reasons.length) {
      traceBlocks.push({ id: block.id, kind: block.kind, status: 'unchanged', before, after: before, reasons: [] });
      continue;
    }
    const trace = { id: block.id, kind: block.kind, status: 'reverted', before, after: before, reasons };
    try {
      if (typeof compactBlock !== 'function') throw new Error('compaction service unavailable');
      const result = await compactBlock({ block, metrics: before, reasons });
      const candidate = String(result?.revisedText ?? result?.revised_text ?? result ?? '').trim();
      if (!candidate) throw new Error('compaction returned empty text');
      const after = editorialBlockMetrics({ ...block, text: candidate });
      const candidateIssues = validateCompactedBlock(block, candidate, after);
      if (candidateIssues.length) throw new Error(candidateIssues.join('; '));
      const invariantIssues = openingDigestInvariantIssues(block.text, candidate);
      if (invariantIssues.length) throw new Error(invariantIssues.join('; '));
      if (typeof verifyBlock !== 'function') throw new Error('semantic verification service unavailable');
      const verification = await verifyBlock({ block, candidate, before, after });
      if (verification?.approved !== true) {
        const issues = Array.isArray(verification?.issues) ? verification.issues.join('; ') : 'semantic verification rejected the revision';
        throw new Error(issues || 'semantic verification rejected the revision');
      }
      replacements.push({ start: block.start, end: block.end, text: candidate });
      Object.assign(trace, { status: 'applied', after, verification: verification.summary || 'approved' });
    } catch (error) {
      trace.diagnostic = String(error?.message || error).slice(0, 500);
    }
    traceBlocks.push(trace);
  }
  let compacted = source;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    compacted = `${compacted.slice(0, replacement.start)}${replacement.text}${compacted.slice(replacement.end)}`;
  }
  return {
    article: compacted,
    trace: {
      attempted: traceBlocks.some((block) => block.reasons.length > 0),
      appliedCount: traceBlocks.filter((block) => block.status === 'applied').length,
      revertedCount: traceBlocks.filter((block) => block.status === 'reverted').length,
      blocks: traceBlocks,
    },
  };
}

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
  if (parseOpeningDigestMetadata(article).headline) {
    return auditModernOpeningDigestArticle({ article, research, asOf, requireFreshSources });
  }
  const warnings = [];
  const body = String(article || '').replace(FRONTMATTER_RE, '').trim();
  const headings = [...body.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1]);
  const expectedHeadings = headings[0] === EARNINGS_HEADING
    ? [EARNINGS_HEADING, ...REQUIRED_HEADINGS]
    : headings.at(-1) === EARNINGS_HEADING
      ? [...REQUIRED_HEADINGS, EARNINGS_HEADING]
      : REQUIRED_HEADINGS;
  if (JSON.stringify(headings) !== JSON.stringify(expectedHeadings)) {
    warnings.push(`Opening Digest 正文应按顺序包含可选 ## ${EARNINGS_HEADING}、## ${REQUIRED_HEADINGS[0]}、## ${REQUIRED_HEADINGS[1]}`);
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
  const earningsStart = body.indexOf(`## ${EARNINGS_HEADING}`);
  const nextHeadingAfterEarnings = earningsStart < 0 ? -1 : body.slice(earningsStart + 3).search(/^##\s+/m);
  const earningsEnd = nextHeadingAfterEarnings < 0 ? body.length : earningsStart + 3 + nextHeadingAfterEarnings;
  const earningsSection = earningsStart < 0 ? '' : body.slice(
    earningsStart + `## ${EARNINGS_HEADING}`.length,
    earningsEnd,
  ).trim();
  const earningsLines = earningsSection.split('\n').map((line) => line.trim()).filter(Boolean);
  const earningsLinks = [...earningsSection.matchAll(/\[[^\]]+]\((https?:\/\/[^\s)]+)\)/g)].map((match) => match[1]);
  if (earningsStart >= 0 && earningsLines.length !== 1) {
    warnings.push(`Opening Digest Earnings ahead 应为一个紧凑段落，当前非空行 ${earningsLines.length}`);
  }
  if (earningsLinks.length > 6) warnings.push(`Opening Digest Earnings ahead 最多展示 6 家，当前 ${earningsLinks.length}`);
  if (/(?:before open|after close|timing not supplied)(?!\s*(?:\(expected\)|;\s*call))/i.test(earningsSection)) {
    warnings.push('Opening Digest Yahoo-only 财报时段必须标记 expected');
  }
  const catalystItems = catalystSection.split('\n').map((line) => line.trim()).filter((line) => /^[-*]\s+/.test(line));
  const catalystWordCounts = catalystItems.map(visibleEnglishWordCount);
  if (catalystItems.length < 3 || catalystItems.length > 5) {
    warnings.push(`Opening Digest Today's catalysts 建议包含 3-5 条，当前为 ${catalystItems.length} 条`);
  }
  if (catalystSection.split('\n').map((line) => line.trim()).filter(Boolean).some((line) => !/^[-*]\s+/.test(line))) {
    warnings.push("Opening Digest Today's catalysts 建议只包含单行 Markdown 列表项");
  }

  const links = [];
  for (const [index, item] of catalystItems.entries()) {
    if (catalystWordCounts[index] > OPENING_DIGEST_CATALYST_MAX_WORDS) {
      warnings.push(`Opening Digest 第 ${index + 1} 条 catalyst 可见英文词数超过 ${OPENING_DIGEST_CATALYST_MAX_WORDS}:${catalystWordCounts[index]}`);
    }
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
  const marketReadWordCount = visibleEnglishWordCount(marketRead);
  const marketReadSentenceCount = visibleEnglishSentenceCount(marketRead);
  const marketReadParagraphCount = visibleParagraphCount(marketRead);
  const marketReadStructureValid = marketReadParagraphCount === 1
    && marketReadSentenceCount >= OPENING_DIGEST_MARKET_READ_MIN_SENTENCES
    && marketReadSentenceCount <= OPENING_DIGEST_MARKET_READ_MAX_SENTENCES
    && !/^[-*]\s+/m.test(marketRead);
  if (marketReadWordCount > OPENING_DIGEST_MARKET_READ_MAX_WORDS) {
    warnings.push(`Opening Digest Market read 可见英文词数超过 ${OPENING_DIGEST_MARKET_READ_MAX_WORDS}:${marketReadWordCount}`);
  }
  if (marketReadSentenceCount < OPENING_DIGEST_MARKET_READ_MIN_SENTENCES
    || marketReadSentenceCount > OPENING_DIGEST_MARKET_READ_MAX_SENTENCES) {
    warnings.push(`Opening Digest Market read 应为 ${OPENING_DIGEST_MARKET_READ_MIN_SENTENCES}-${OPENING_DIGEST_MARKET_READ_MAX_SENTENCES} 句，当前为 ${marketReadSentenceCount} 句`);
  }
  if (marketReadParagraphCount !== 1) {
    warnings.push(`Opening Digest Market read 应为单段，当前为 ${marketReadParagraphCount} 段`);
  }
  if (/^[-*]\s+/m.test(marketRead) || STALE_ADMISSION_RE.test(marketRead)) {
    warnings.push('Opening Digest Market read 建议使用判断段落，不应以没有新消息或旧背景作为结论');
  }

  if (requireFreshSources) {
    const sources = new Map(research.filter((source) => source?.url).map((source) => [normalizedUrl(source.url), source]));
    const cutoff = previousRegularClose(asOf);
    let macroLinks = 0;
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
      const earningsScheduleException = source.openingDigestKind === 'earnings-schedule';
      if (source.openingDigestKind === 'macro') macroLinks += 1;
      if ((!earningsScheduleException && published.getTime() < cutoff.getTime())
        || published.getTime() > asOf.getTime() + 5 * 60_000) {
        warnings.push(`Opening Digest 第 ${index + 1} 个 catalyst 链接不在上一交易日收盘至当前的时间窗口内`);
      }
    }
    if (macroLinks > 1) warnings.push(`Opening Digest Today's catalysts 建议最多包含一条宏观项，当前为 ${macroLinks} 条`);
  }

  return {
    warnings,
    stats: {
      earningsPresent: earningsStart >= 0,
      earningsCount: earningsLinks.length,
      earningsLinks,
      catalystCount: catalystItems.length,
      catalystWordCounts,
      links,
      marketReadLength: marketRead.length,
      marketReadWordCount,
      marketReadSentenceCount,
      marketReadParagraphCount,
      marketReadStructureValid,
    },
    earningsPresent: earningsStart >= 0,
    earningsCount: earningsLinks.length,
    earningsLinks,
    catalystCount: catalystItems.length,
    catalystWordCounts,
    links,
    marketReadLength: marketRead.length,
    marketReadWordCount,
    marketReadSentenceCount,
    marketReadParagraphCount,
    marketReadStructureValid,
  };
}

export function openingDigestResearchQueries(asOf = new Date(), earningsCalendar = null) {
  const date = easternDateKey(asOf);
  const startPublishedDate = previousRegularClose(asOf).toISOString();
  const endPublishedDate = asOf.toISOString();
  const common = { type: 'deep', numResults: 6, startPublishedDate, endPublishedDate };
  const groupQueries = OPENING_DIGEST_UNIVERSE_GROUPS.map((group) => {
    const entities = uniqueIssuers(group.members)
      .map((item) => `${item.company} (${item.ticker})`).join(', ');
    return {
      ...common,
      numResults: 5,
      kind: `opening-digest-universe-${group.id}`,
      openingDigestKind: 'universe-news',
      query: `Material company news since the prior US close for: ${entities}. Date ${date}.`,
      systemPrompt: 'Return only exact-company, current-window developments with plausible material market impact: filings, earnings or guidance, M&A, financing, major orders or customers, products, supply constraints, outages or cybersecurity, management, legal or regulatory actions, and explicit analyst upgrades or downgrades. Exclude unconfirmed rumors, price-target-only notes, maintained ratings, routine commentary, similarly named entities, and stale background.',
    };
  });
  const earningsVerification = openingDigestEarningsResearchQuery(earningsCalendar);
  return [
    {
      ...common,
      kind: 'opening-digest-market-news',
      openingDigestKind: 'market-news',
      query: `US stock market premarket and opening market-moving news ${date} earnings guidance large-cap catalysts`,
      systemPrompt: 'Return reporting published after the prior US regular close that can materially affect the current US equity opening. Exclude evergreen explainers, unrelated entities named Zen, and stale background.',
    },
    {
      ...common,
      kind: 'opening-digest-macro',
      openingDigestKind: 'macro',
      query: `US markets macro data Federal Reserve Treasury yields oil dollar economic releases ${date} market open`,
      systemPrompt: 'Return current-window macro, rates, currency, commodity, and policy catalysts for the US equity open. Prefer primary releases and independently reported market-moving developments.',
    },
    ...groupQueries,
    ...(earningsVerification ? [earningsVerification] : []),
  ];
}

export function openingDigestSearchInput(asOf = new Date()) {
  const date = easternDateKey(asOf);
  return `US equity opening digest for ${date}: market-moving developments published since the previous regular close, including macro data, rates, earnings, guidance, and large-cap catalysts.`;
}

function auditModernOpeningDigestArticle({ article, research, asOf, requireFreshSources }) {
  const insight = auditOpeningDigestInsight(article);
  const warnings = [...insight.warnings];
  const body = String(article || '').replace(FRONTMATTER_RE, '').trim();
  const editorial = body.replace(/^## Earnings ahead[\s\S]*$/m, '').trim();
  const links = [...editorial.matchAll(/\[[^\]]+]\((https?:\/\/[^\s)]+)\)/g)].map((match) => match[1]);
  if (new Set(links.map(normalizedUrl)).size !== links.length) warnings.push('Opening Digest 分析正文来源链接存在重复');
  if (requireFreshSources) {
    const sources = new Map(research.filter((source) => source?.url).map((source) => [normalizedUrl(source.url), source]));
    const cutoff = previousRegularClose(asOf);
    for (const [index, link] of links.entries()) {
      const source = sources.get(normalizedUrl(link));
      if (!source) {
        warnings.push(`Opening Digest 第 ${index + 1} 个分析链接未匹配到本次检索来源`);
        continue;
      }
      const published = new Date(source.publishedDate || '');
      if (!Number.isFinite(published.getTime())) warnings.push(`Opening Digest 第 ${index + 1} 个分析链接缺少可验证的发布日期`);
      else if (published < cutoff || published.getTime() > asOf.getTime() + 5 * 60_000) warnings.push(`Opening Digest 第 ${index + 1} 个分析链接不在上一交易日收盘至当前的时间窗口内`);
    }
  }
  const earnings = body.match(/^## Earnings ahead\s*\n([\s\S]*)$/m)?.[1] || '';
  const earningsLinks = [...earnings.matchAll(/\[[^\]]+]\((https?:\/\/[^\s)]+)\)/g)].map((match) => match[1]);
  return {
    warnings,
    stats: { ...insight.stats, links, earningsLinks, earningsPresent: /(^|\n)## Earnings ahead\s*$/m.test(body) },
    links,
    earningsLinks,
    earningsPresent: /(^|\n)## Earnings ahead\s*$/m.test(body),
    earningsCount: earningsLinks.length,
    catalystCount: insight.stats.mattersCount,
    catalystWordCounts: [],
    marketReadLength: 0,
    marketReadWordCount: insight.stats.narrativeWords,
    marketReadSentenceCount: insight.stats.leadSentences,
    marketReadParagraphCount: 1,
    marketReadStructureValid: insight.stats.scenarioComplete,
  };
}

function visibleMarkdownText(markdown) {
  return String(markdown || '')
    .replace(/!\[([^\]]*)]\(https?:\/\/[^\s)]+\)/g, ' $1 ')
    .replace(/\[([^\]]+)]\(https?:\/\/[^\s)]+\)/g, ' $1 ')
    .replace(/<https?:\/\/[^>]+>/g, ' ')
    .replace(/https?:\/\/[^\s)>\]}"']+/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_~>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function visibleParagraphCount(markdown) {
  return String(markdown || '').trim()
    ? String(markdown).trim().split(/\n\s*\n+/).filter((paragraph) => visibleEnglishWordCount(paragraph) > 0).length
    : 0;
}

function editorialBlockMetrics(block) {
  const text = String(block?.text || '');
  return {
    wordCount: visibleEnglishWordCount(text),
    sentenceCount: visibleEnglishSentenceCount(text),
    paragraphCount: visibleParagraphCount(text),
  };
}

function editorialRepairReasons(block, metrics) {
  if (block.kind === 'catalyst') {
    return metrics.wordCount > OPENING_DIGEST_CATALYST_MAX_WORDS
      ? [`word-count-${metrics.wordCount}-over-${OPENING_DIGEST_CATALYST_MAX_WORDS}`]
      : [];
  }
  const reasons = [];
  if (metrics.wordCount > OPENING_DIGEST_MARKET_READ_MAX_WORDS) {
    reasons.push(`word-count-${metrics.wordCount}-over-${OPENING_DIGEST_MARKET_READ_MAX_WORDS}`);
  }
  if (metrics.sentenceCount < OPENING_DIGEST_MARKET_READ_MIN_SENTENCES
    || metrics.sentenceCount > OPENING_DIGEST_MARKET_READ_MAX_SENTENCES) {
    reasons.push(`sentence-count-${metrics.sentenceCount}-outside-${OPENING_DIGEST_MARKET_READ_MIN_SENTENCES}-${OPENING_DIGEST_MARKET_READ_MAX_SENTENCES}`);
  }
  if (metrics.paragraphCount !== 1) reasons.push(`paragraph-count-${metrics.paragraphCount}-not-1`);
  if (/^[-*]\s+/m.test(block.text)) reasons.push('market-read-must-not-be-a-list');
  return reasons;
}

function validateCompactedBlock(original, candidate, metrics) {
  const issues = [];
  if (original.kind === 'catalyst') {
    if (/\n/.test(candidate) || !/^[-*]\s+\S/.test(candidate)) issues.push('catalyst must remain one Markdown list item');
    if (metrics.wordCount > OPENING_DIGEST_CATALYST_MAX_WORDS) {
      issues.push(`catalyst still exceeds ${OPENING_DIGEST_CATALYST_MAX_WORDS} visible English words`);
    }
    const links = candidate.match(/\[[^\]]+]\(https?:\/\/[^\s)]+\)/g) || [];
    if (links.length !== 1) issues.push('catalyst must retain exactly one direct source link');
  } else {
    if (/^#{1,6}\s+/m.test(candidate) || /^[-*]\s+/m.test(candidate)) issues.push('Market read must remain a plain paragraph');
    if (metrics.wordCount > OPENING_DIGEST_MARKET_READ_MAX_WORDS) {
      issues.push(`Market read still exceeds ${OPENING_DIGEST_MARKET_READ_MAX_WORDS} visible English words`);
    }
    if (metrics.sentenceCount < OPENING_DIGEST_MARKET_READ_MIN_SENTENCES
      || metrics.sentenceCount > OPENING_DIGEST_MARKET_READ_MAX_SENTENCES) {
      issues.push(`Market read must contain ${OPENING_DIGEST_MARKET_READ_MIN_SENTENCES}-${OPENING_DIGEST_MARKET_READ_MAX_SENTENCES} sentences`);
    }
    if (metrics.paragraphCount !== 1) issues.push('Market read must remain one paragraph');
  }
  return issues;
}

function openingDigestInvariantIssues(original, candidate) {
  const before = invariantSignature(original);
  const after = invariantSignature(candidate);
  const issues = [];
  for (const key of Object.keys(before)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) issues.push(`compaction changed ${key}`);
  }
  return issues;
}

function invariantSignature(value) {
  const text = String(value || '');
  return {
    URLs: text.match(/https?:\/\/[^\s)\]}>"]+/g) || [],
    numbers: text.match(/(?<![A-Za-z0-9])(?:[$€£¥]\s*)?[-+]?\d+(?:[,.]\d+)*(?:%|‰)?(?:\s+(?:thousand|million|billion|trillion))?/gi) || [],
    tickers: text.match(/\b(?:[A-Z]{2,6}|[A-Z]{1,5}\d[A-Z0-9-]*)\b/g) || [],
    dates: text.match(/\b(?:\d{4}-\d{2}-\d{2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s+\d{4})?)\b/gi) || [],
    times: text.match(/\b\d{1,2}:\d{2}(?:\s*(?:a\.m\.|p\.m\.|AM|PM))?(?:\s+(?:ET|EST|EDT|PT|PST|PDT|UTC|GMT))?\b/gi) || [],
  };
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

function uniqueIssuers(members) {
  const seen = new Set();
  return members.filter((item) => {
    if (seen.has(item.issuerKey)) return false;
    seen.add(item.issuerKey);
    return true;
  });
}
