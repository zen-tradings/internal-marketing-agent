import { decodeBasicHtmlEntities } from '../../lib/html-entities.js';
import { isDirectUserUrl, loadDirectUserSources, recoverOfficialDocumentMirrors } from '../user-sources.js';
import { safeText, trimTrailingSlash } from './model-client.js';
import { LEGAL_OFFICIAL_SOURCES, EDITORIAL_SEARCH_POLICY, assignSourceIds, strictOfficialSource, extractUrls, dedupeByUrl, flattenExaResults, sanitizeExaDomains, selectAnalysisSources, isGovernmentFundedMediaSource, applyEditorialSourcePolicy, urlMatchesAnyDomain, isLikelyOfficialSource, isRelevantLegalSource, extraQueryLimitFor } from './shared.js';
import { startTrace, finishTrace, failTrace } from './trace.js';
import { describeFetchError, fetchWithRetry } from '../../lib/fetch-retry.js';

export async function searchExaV2({
  taskContract,
  searchPlan,
  workflow,
  writer,
  fetchFn,
  trace,
  taskContext,
  config,
  recentWindowDays,
  asOf,
}) {
  const userUrls = taskContract.user_urls || [];
  const directPromise = loadDirectUserSources({
    userUrls,
    attachments: taskContext?.attachments || [],
    workDir: workflow.workDir,
    config,
    fetchFn,
    fetchWithRetry,
    signal: taskContext?.signal,
    trace,
  });
  const exaUserUrls = userUrls.filter((url) => !isDirectUserUrl(url));
  const exaContentsPromise = exaUserUrls.length
    ? fetchExaContents({ urls: exaUserUrls, writer, fetchFn, trace })
    : Promise.resolve([]);
  const prioritySources = sanitizeExaDomains(workflow?.research?.prioritySources || []);
  const officialDomains = sanitizeExaDomains(workflow?.research?.officialSources || []);
  const recentStart = new Date(asOf.getTime() - recentWindowDays * 24 * 60 * 60 * 1000).toISOString();
  const workflowQuerySubject = [
    ...(taskContract.exact_entities_and_versions || []).map((entity) => entity.literal),
    ...(taskContract.search_aliases || []),
  ].join(' / ') || String(taskContract.raw_prompt || '').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').slice(0, 220);
  const workflowQueries = typeof workflow?.research?.extraQueries === 'function'
    ? workflow.research.extraQueries(workflowQuerySubject).filter(Boolean).slice(0, extraQueryLimitFor(workflow))
    : [];
  const searchPromise = Promise.allSettled(searchPlan.map((querySpec) => {
    const baseOptions = {
      kind: `analysis-${querySpec.lane}`,
      language: querySpec.language,
      type: querySpec.lane === 'official' ? 'deep' : 'auto',
      numResults: querySpec.lane === 'official'
        ? Math.max(6, writer.exaPriorityResults || 4)
        : writer.exaNumResults || 5,
      ...(querySpec.startPublishedDate
        ? { startPublishedDate: querySpec.startPublishedDate }
        : querySpec.recent ? { startPublishedDate: recentStart } : {}),
      ...(querySpec.endPublishedDate ? { endPublishedDate: querySpec.endPublishedDate } : {}),
    };
    if (querySpec.lane === 'official') {
      const discovery = searchExaOpen({
        query: querySpec.query,
        options: {
          ...baseOptions,
          systemPrompt: 'Return primary sources for the exact named entities and versions: official product releases and documentation, issuer or regulator disclosures, original papers, or original repositories. Exclude forums, media rewrites, aggregators, similarly named companies, and nearby model versions.',
          additionalQueries: [`${querySpec.query} official release`, `${querySpec.query} official documentation`],
        },
        writer,
        fetchFn,
        trace,
      });
      const constrained = officialDomains.length
        ? searchExaOpen({
            query: querySpec.query,
            options: {
              ...baseOptions,
              kind: 'analysis-official-domain',
              includeDomains: officialDomains,
            },
            writer,
            fetchFn,
            trace,
          })
        : Promise.resolve([]);
      return Promise.allSettled([discovery, constrained]).then((results) =>
        dedupeByUrl(results.flatMap((result) => result.status === 'fulfilled' ? result.value : []))
          .map((source) => ({ ...source, retrievalLane: 'official' })));
    }
    if (querySpec.lane === 'priority' && prioritySources.length) {
      return searchExaOpen({
        query: querySpec.query,
        options: {
          ...baseOptions,
          includeDomains: prioritySources,
        },
        writer,
        fetchFn,
        trace,
      }).then((results) => results.map((source) => ({
        ...source,
        priority: true,
        retrievalLane: 'priority',
      })));
    }
    return searchExaOpen({
      query: querySpec.query,
      options: baseOptions,
      writer,
      fetchFn,
      trace,
    }).then((results) => results.map((source) => ({ ...source, retrievalLane: 'open' })));
  }));
  const workflowSearchPromise = Promise.allSettled(workflowQueries.map((spec) =>
    searchExaOpen({
      query: typeof spec === 'string' ? spec : spec.query,
      options: typeof spec === 'string'
        ? {}
        : {
            ...spec,
            ...(spec.kind === 'company-value-chain' ? { startPublishedDate: recentStart } : {}),
          },
      writer,
      fetchFn,
      trace,
    }).then((results) => results.map((source) => ({
      ...source,
      retrievalLane: spec.kind === 'company-official-disclosures' || spec.kind === 'quarterly-financials'
        ? 'official'
        : 'priority',
      ...(spec.kind === 'company-value-chain' ? { priority: true } : {}),
      ...(typeof spec === 'object' && spec?.openingDigestKind
        ? { openingDigestKind: spec.openingDigestKind }
        : {}),
    })))));
  const [directResult, exaContentsResult, settled, workflowSettled] = await Promise.all([
    directPromise,
    exaContentsPromise.then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ status: 'rejected', reason }),
    ),
    searchPromise,
    workflowSearchPromise,
  ]);
  if (directResult.errors.length) {
    trace.directUserSourceErrors = directResult.errors;
    const privateDocumentErrors = directResult.errors
      .filter((entry) => ['notion', 'google-doc', 'linear'].includes(entry.kind));
    if (privateDocumentErrors.length) {
      throw new Error(`用户文档读取失败:${privateDocumentErrors
        .map((entry) => `${entry.name || entry.url}: ${entry.error}`)
        .join('; ')}`);
    }
  }
  const initiallyLoadedUserSources = [
    ...directResult.sources,
    ...(exaContentsResult.status === 'fulfilled'
      ? exaContentsResult.value.map((source) => ({ ...source, userSpecified: true, retrievalLane: 'user' }))
      : []),
  ];
  if (exaContentsResult.status === 'rejected') {
    trace.userSourceError = describeFetchError(exaContentsResult.reason).slice(0, 500);
  }
  const recoveredSources = await recoverUnavailableUserUrls({
    userUrls,
    loadedSources: initiallyLoadedUserSources,
    taskContract,
    writer,
    config,
    fetchFn,
    trace,
  });
  const exactRecoveredSources = recoveredSources.filter((source) => source.userSpecified);
  const supplementalRecoveredSources = recoveredSources.filter((source) => !source.userSpecified);
  const userSources = [...initiallyLoadedUserSources, ...exactRecoveredSources];
  if (taskContract.only_user_links) {
    return assignSourceIds(applyEditorialSourcePolicy(dedupeByUrl(userSources)));
  }
  const searched = [...settled, ...workflowSettled]
    .flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  const merged = dedupeByUrl([...userSources, ...supplementalRecoveredSources, ...searched]);
  for (const source of merged) {
    if (!source.userSpecified && strictOfficialSource(source, taskContract, officialDomains)) {
      source.official = true;
    }
  }
  return assignSourceIds(selectAnalysisSources(
    applyEditorialSourcePolicy(merged),
    asOf,
    recentWindowDays,
  ));
}

export async function recoverUnavailableUserUrls({
  userUrls,
  loadedSources,
  taskContract,
  writer,
  config,
  fetchFn,
  trace,
}) {
  const unavailable = (Array.isArray(userUrls) ? userUrls : [])
    .filter((userUrl) => !(Array.isArray(loadedSources) ? loadedSources : [])
      .some((source) => sameSourceUrl(source?.url, userUrl)))
    .slice(0, 2);
  if (!unavailable.length) return [];

  let cachedExactSources = [];
  const directDocumentUrls = unavailable.filter(isDirectUserUrl);
  if (directDocumentUrls.length) {
    try {
      cachedExactSources = (await fetchExaContents({
        urls: directDocumentUrls,
        writer,
        fetchFn,
        trace,
        kind: 'user-document-cache-recovery',
      }))
        .filter((source) => hasUsableSourceText(source)
          && directDocumentUrls.some((userUrl) => sameSourceUrl(source?.url, userUrl)))
        .map((source) => ({
          ...source,
          userSpecified: true,
          retrievalLane: 'user-recovery',
          recoveredForUserUrl: directDocumentUrls.find((userUrl) => sameSourceUrl(source?.url, userUrl)),
        }));
    } catch (error) {
      trace.userDocumentCacheRecoveryError = describeFetchError(error).slice(0, 500);
    }
  }
  const stillUnavailable = unavailable.filter((userUrl) => !cachedExactSources
    .some((source) => sameSourceUrl(source?.url, userUrl)));

  const settled = await Promise.allSettled(stillUnavailable.map((userUrl) =>
    searchExaOpen({
      query: buildUserUrlRecoveryQuery(userUrl, taskContract),
      options: {
        kind: 'user-url-recovery',
        type: 'auto',
        numResults: Math.max(5, Number(writer.exaNumResults || 5)),
      },
      writer,
      fetchFn,
      trace,
    }).then((results) => results.map((source) => ({
      ...source,
      retrievalLane: 'user-recovery',
      recoveredForUserUrl: userUrl,
      ...(sameSourceUrl(source.url, userUrl) ? { userSpecified: true } : { specialist: true }),
    })))));
  const searchedRecoverySources = settled
    .flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  const officialMirrors = await recoverOfficialDocumentMirrors({
    userUrls: stillUnavailable,
    discoverySources: searchedRecoverySources,
    config,
    fetchFn,
    fetchWithRetry,
  });
  const recovered = [
    ...cachedExactSources,
    ...officialMirrors.sources,
    ...searchedRecoverySources,
  ];
  trace.userSourceRecovery = {
    attemptedUrls: unavailable,
    cachedExactUrls: cachedExactSources.map((source) => source.url),
    officialMirrorUrls: officialMirrors.sources.map((source) => source.url),
    officialMirrorAttempts: officialMirrors.attempts,
    exactRecoveredUrls: recovered.filter((source) => source.userSpecified).map((source) => source.url),
    supplementalUrls: recovered.filter((source) => !source.userSpecified).map((source) => source.url),
    failedSearches: settled.filter((result) => result.status === 'rejected').length,
  };
  return recovered;
}

export function hasUsableSourceText(source) {
  return String(source?.text || source?.summary || '').trim().length >= 40;
}

export function buildUserUrlRecoveryQuery(rawUrl, taskContract = {}) {
  const decodedUrl = decodeBasicHtmlEntities(rawUrl);
  let urlContext = decodedUrl;
  try {
    const url = new URL(decodedUrl);
    const pathTerms = safeDecodeURIComponent(url.pathname)
      .replace(/\.[a-z0-9]{2,6}$/i, ' ')
      .replace(/[-_/]+/g, ' ');
    const campaignTerms = safeDecodeURIComponent(url.searchParams.get('utm_campaign') || '')
      .replace(/[-_]+/g, ' ');
    urlContext = `${url.hostname.replace(/^www\./, '')} ${pathTerms} ${campaignTerms}`;
  } catch {}
  const entityContext = [
    ...(taskContract.exact_entities_and_versions || []).map((entity) => entity.literal),
    ...(taskContract.search_aliases || []).slice(0, 4),
  ].filter(Boolean).join(' ');
  const requirementContext = (taskContract.must_cover || [])
    .slice(0, 2)
    .join(' ')
    .replace(/https?:\/\/\S+/g, ' ');
  return `${urlContext} ${entityContext} ${requirementContext}`
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 420);
}

export function sameSourceUrl(left, right) {
  return comparableSourceUrl(left) === comparableSourceUrl(right);
}

export function comparableSourceUrl(rawUrl) {
  try {
    const url = new URL(decodeBasicHtmlEntities(rawUrl));
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    url.searchParams.sort();
    return url.toString();
  } catch {
    return String(rawUrl || '').trim();
  }
}

export function safeDecodeURIComponent(value) {
  try { return decodeURIComponent(String(value || '')); }
  catch { return String(value || ''); }
}

// Research entry point: fetch up to five user URLs through Exa /contents as top-priority material alongside primary
// and configured priority sources; search remaining prompt text through priority and open lanes in parallel; then
// merge and URL-deduplicate by user-specified, primary, priority, deep-research, and open-search precedence.
export async function searchExa({ input, writer, workflow, fetchFn, trace, sourcePolicy, editorialContext = null, asOf = new Date() }) {
  if (sourcePolicy.skipResearch) {
    // Relationship emails such as welcomes and announcements do not search markets. With user links and Exa,
    // read only those materials without expanding search or imposing mandatory citation gates.
    const { urls } = extractUrls(input, 5);
    if (!urls.length || !writer.exaApiKey) return [];
    try {
      return (await fetchExaContents({ urls, writer, fetchFn, trace }))
        .map((source) => ({ ...source, userSpecified: true }));
    } catch {
      return [];
    }
  }
  // Ordinary tasks cap full-content URLs at five; strict official/primary-source tasks allow eight to accommodate
  // independent exchange, regulator, and company-IR evidence chains while keeping prompt growth bounded.
  const maxUserUrls = sourcePolicy.requireOfficial ? 8 : 5;
  const { urls, remainder } = extractUrls(input, maxUserUrls);

  const contentsPromise = urls.length
    ? fetchExaContents({ urls, writer, fetchFn, trace }).then(
        (results) => results.map((r) => ({ ...r, userSpecified: true })),
        () => [], // Fetch failure degrades only this material and does not affect other sources.
      )
    : Promise.resolve([]);

  const prioritySources = sanitizeExaDomains(workflow?.research?.prioritySources);
  const hasPriority = sourcePolicy.kind !== 'legal-document-analysis'
    && Array.isArray(prioritySources)
    && prioritySources.length > 0;
  const officialSources = sanitizeExaDomains(sourcePolicy.kind === 'legal-document-analysis'
    ? LEGAL_OFFICIAL_SOURCES
    : workflow?.research?.officialSources);
  const hasOfficial = sourcePolicy.requireOfficial && Array.isArray(officialSources) && officialSources.length > 0;

  // Legal cases must read the user-provided docket first, then add case name and number to search terms. Searching
  // only a generic request would return many official pages unrelated to the case.
  const earlyContents = sourcePolicy.kind === 'legal-document-analysis' ? await contentsPromise : null;
  const sourceIdentity = earlyContents
    ?.map((source) => source.title || '')
    .filter(Boolean)
    .join(' ')
    .slice(0, 500);
  const searchQuery = sourcePolicy.kind === 'legal-document-analysis' && sourceIdentity
    ? sourceIdentity
    : [remainder, sourceIdentity].filter(Boolean).join(' ').trim();

  let searchResults = [];
  if (searchQuery) {
    const extraQueries = typeof workflow?.research?.extraQueries === 'function'
      ? workflow.research.extraQueries(searchQuery, { editorialContext, asOf }).filter(Boolean).slice(0, extraQueryLimitFor(workflow))
      : [];
    const [openSettled, prioritySettled, officialSettled, officialDiscoverySettled, legalSettled, ...extraSettled] = await Promise.allSettled([
      searchExaOpen({ query: searchQuery, writer, fetchFn, trace }),
      hasPriority ? searchExaPriority({ query: searchQuery, writer, prioritySources, fetchFn, trace }) : Promise.resolve([]),
      hasOfficial ? searchExaPriority({
        query: sourcePolicy.kind === 'legal-document-analysis'
          ? `${searchQuery} complaint docket order court filing`
          : `${searchQuery} official filing investor relations exchange data`,
        writer,
        prioritySources: officialSources,
        fetchFn,
        trace,
        kind: 'official-search',
        official: true,
      }) : Promise.resolve([]),
      sourcePolicy.requireOfficial ? searchExaOpen({
        query: sourcePolicy.kind === 'legal-document-analysis'
          ? `${searchQuery} official court docket complaint order primary record`
          : `${searchQuery} official primary source investor relations filing regulator original data`,
        options: {
          type: 'deep',
          numResults: Math.max(6, writer.exaPriorityResults || 4),
          kind: 'official-discovery',
          systemPrompt: sourcePolicy.kind === 'legal-document-analysis'
            ? 'Return records for this exact court case only. Prefer PACER, the court, the complaint, orders, exhibits, and regulator records. Exclude unrelated legal documents and generic identity or privacy pages.'
            : 'Return official and primary sources only: issuer investor-relations pages, regulatory filings, exchanges, government data, original research papers, or the original software repository. Exclude news summaries and aggregators.',
          additionalQueries: sourcePolicy.kind === 'legal-document-analysis'
            ? [`${searchQuery} complaint PDF`, `${searchQuery} case docket filing`]
            : [`${searchQuery} official investor relations filing`, `${searchQuery} regulator exchange original source`],
        },
        writer, fetchFn, trace,
      }) : Promise.resolve([]),
      sourcePolicy.kind === 'legal-document-analysis' ? searchExaOpen({
        query: `${searchQuery} complaint docket case filing analysis`,
        options: {
          type: 'deep',
          numResults: Math.max(8, writer.exaNumResults || 5),
          kind: 'legal-record-search',
          systemPrompt: 'Find materials about this exact case only. Rank the complaint, docket, orders, exhibits, named-agency records, and precise reporting above commentary. Match the case number and party names. Exclude unrelated cases and generic documents.',
          additionalQueries: [`${searchQuery} complaint PDF`, `${searchQuery} court docket`],
        },
        writer, fetchFn, trace,
      }) : Promise.resolve([]),
      ...extraQueries.map((spec) => searchExaOpen({
        query: typeof spec === 'string' ? spec : spec.query,
        options: typeof spec === 'string' ? {} : spec,
        writer,
        fetchFn,
        trace,
      }).then((results) => results.map((source) => ({
        ...source,
        ...(typeof spec === 'object' && spec?.openingDigestKind
          ? { openingDigestKind: spec.openingDigestKind }
          : {}),
        ...(typeof spec === 'object' && spec?.official ? { official: true } : {}),
      })))),
    ]);
    const openFailed = openSettled.status === 'rejected';
    const priorityFailed = hasPriority && prioritySettled.status === 'rejected';
    if (openFailed && (!hasPriority || priorityFailed)) {
      throw openFailed ? openSettled.reason : prioritySettled.reason;
    }
    const priorityResults = hasPriority && prioritySettled.status === 'fulfilled' ? prioritySettled.value : [];
    const rawOfficialResults = hasOfficial && officialSettled.status === 'fulfilled' ? officialSettled.value : [];
    const officialResults = sourcePolicy.kind === 'legal-document-analysis'
      ? rawOfficialResults.filter((source) => isRelevantLegalSource(source, sourceIdentity, true))
      : rawOfficialResults;
    const discoveredOfficial = officialDiscoverySettled.status === 'fulfilled'
      ? officialDiscoverySettled.value
          .filter((source) => isLikelyOfficialSource(source, officialSources))
          .filter((source) => sourcePolicy.kind !== 'legal-document-analysis' || isRelevantLegalSource(source, sourceIdentity, true))
          .map((source) => ({ ...source, official: true }))
      : [];
    const openResults = openSettled.status === 'fulfilled' ? openSettled.value : [];
    const legalResults = legalSettled.status === 'fulfilled'
      ? legalSettled.value.filter((source) => isRelevantLegalSource(source, sourceIdentity))
      : [];
    const extraResults = extraSettled.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
    searchResults = [...officialResults, ...discoveredOfficial, ...legalResults, ...priorityResults, ...extraResults, ...openResults];
  }

  const contentsResults = earlyContents || await contentsPromise;
  const merged = applyEditorialSourcePolicy(dedupeByUrl([...contentsResults, ...searchResults]).map((source) => ({
    ...source,
    ...(source.official || urlMatchesAnyDomain(source.url, officialSources) ? { official: true } : {}),
  })));
  if (sourcePolicy.requireOfficial) {
    const officialCount = merged.filter((source) => source.official).length;
    if (officialCount < sourcePolicy.minOfficialSources) {
      throw new Error(`严格来源门禁:仅检索到 ${officialCount} 个官方/一手来源,至少需要 ${sourcePolicy.minOfficialSources} 个`);
    }
  }
  return merged;
}

export async function searchExaOpen({ query, options = {}, writer, fetchFn, trace }) {
  const numResults = options.numResults || writer.exaNumResults || 5;
  const url = `${trimTrailingSlash(writer.exaBaseUrl || 'https://api.exa.ai')}/search`;
  const searchSystemPrompt = [options.systemPrompt, EDITORIAL_SEARCH_POLICY].filter(Boolean).join(' ');
  const body = {
      query,
      numResults,
      type: options.type || 'auto',
      contents: {
        text: { verbosity: 'compact' },
        highlights: { query, maxCharacters: 1200 },
        ...(options.subpages ? { subpages: options.subpages, subpageTarget: options.subpageTarget } : {}),
      },
      ...(options.category ? { category: options.category } : {}),
      ...(searchSystemPrompt && (options.type || 'auto') === 'deep'
        ? { systemPrompt: searchSystemPrompt }
        : {}),
      ...(options.additionalQueries ? { additionalQueries: options.additionalQueries } : {}),
      ...(options.includeDomains ? { includeDomains: options.includeDomains } : {}),
      ...(options.startPublishedDate ? { startPublishedDate: options.startPublishedDate } : {}),
      ...(options.endPublishedDate ? { endPublishedDate: options.endPublishedDate } : {}),
    };
  const event = startTrace(trace, {
    kind: options.kind || 'open-search',
    endpoint: '/search',
    query,
    language: options.language,
    searchType: body.type,
    category: body.category,
    includeDomains: body.includeDomains,
    startPublishedDate: body.startPublishedDate,
  });
  try {
    const res = await fetchWithRetry(fetchFn, url, {
      method: 'POST',
      headers: {
        'x-api-key': writer.exaApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, { timeoutMs: writer.exaTimeoutMs || 45000 });
    if (!res.ok) throw new Error(`Exa search failed: ${res.status} ${res.statusText} ${await safeText(res)}`.trim());
    const data = await res.json();
    const roots = Array.isArray(data.results) ? data.results.slice(0, numResults) : [];
    const flattened = flattenExaResults(roots);
    const excluded = flattened.filter((result) => isGovernmentFundedMediaSource(result));
    const results = flattened
      .filter((result) => !isGovernmentFundedMediaSource(result))
      .map((result) => ({
        ...result,
        ...(options.kind === 'quarterly-financials' ? { financialReport: true } : {}),
        ...(options.kind && !['open-search', 'official-discovery'].includes(options.kind) ? { specialist: true } : {}),
      }));
    event.excludedGovernmentFundedMedia = excluded.map((result) => result.url).filter(Boolean);
    finishTrace(event, { requestId: data.requestId, costDollars: data.costDollars, results });
    return results;
  } catch (e) {
    failTrace(event, e);
    throw e;
  }
}

export async function searchExaPriority({ query, writer, prioritySources, fetchFn, trace, kind = 'priority-search', official = false }) {
  const numResults = writer.exaPriorityResults || 4;
  const url = `${trimTrailingSlash(writer.exaBaseUrl || 'https://api.exa.ai')}/search`;
  const event = startTrace(trace, { kind, endpoint: '/search', query, includeDomains: prioritySources });
  try {
  const res = await fetchWithRetry(fetchFn, url, {
    method: 'POST',
    headers: {
      'x-api-key': writer.exaApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      numResults,
      type: 'auto',
      includeDomains: prioritySources,
      contents: {
        text: { verbosity: 'compact' },
        highlights: { query, maxCharacters: 1200 },
      },
    }),
  }, { timeoutMs: writer.exaTimeoutMs || 45000 });
  if (!res.ok) throw new Error(`Exa priority search failed: ${res.status} ${res.statusText} ${await safeText(res)}`.trim());
  const data = await res.json();
  const rawResults = Array.isArray(data.results) ? data.results.slice(0, numResults) : [];
  const results = rawResults.filter((result) => !isGovernmentFundedMediaSource(result));
  event.excludedGovernmentFundedMedia = rawResults
    .filter((result) => isGovernmentFundedMediaSource(result))
    .map((result) => result.url)
    .filter(Boolean);
  finishTrace(event, { requestId: data.requestId, costDollars: data.costDollars, results });
  return results.map((r) => ({
    ...r,
    ...(official
      ? (urlMatchesAnyDomain(r.url, prioritySources) ? { official: true } : {})
      : { priority: true }),
  }));
  } catch (e) {
    failTrace(event, e);
    throw e;
  }
}

// User-provided URLs use full-content fetches (text: true) without highlights, which are query-centric excerpts;
// formatResearch separately raises their character cap through userSpecified.
export async function fetchExaContents({ urls, writer, fetchFn, trace, kind = 'user-contents' }) {
  const url = `${trimTrailingSlash(writer.exaBaseUrl || 'https://api.exa.ai')}/contents`;
  const event = startTrace(trace, { kind, endpoint: '/contents', urls });
  try {
  const res = await fetchWithRetry(fetchFn, url, {
    method: 'POST',
    headers: {
      'x-api-key': writer.exaApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ urls, text: true }),
  }, { timeoutMs: writer.exaTimeoutMs || 45000 });
  if (!res.ok) throw new Error(`Exa contents failed: ${res.status} ${res.statusText} ${await safeText(res)}`.trim());
  const data = await res.json();
  const results = Array.isArray(data.results) ? data.results : [];
  finishTrace(event, {
    requestId: data.requestId,
    costDollars: data.costDollars,
    results,
    contentStatuses: data.statuses,
  });
  return results;
  } catch (e) {
    failTrace(event, e);
    throw e;
  }
}
