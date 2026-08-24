const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
export const LINEAR_ALLOWED_WORKSPACE = 'zen-trading';
const ISSUE_IDENTIFIER_RE = /^[A-Z][A-Z0-9]*-\d+$/i;
const ISSUE_FIELDS = `
  identifier
  title
  description
  url
  createdAt
  creator { name }
`;
const ISSUE_BY_ID_QUERY = `
  query Issue($id: String!) {
    issue(id: $id) {
      ${ISSUE_FIELDS}
    }
  }
`;
const ISSUES_BY_TEAM_NUMBER_QUERY = `
  query Issues($teamKey: String!, $number: Float!) {
    issues(
      filter: {
        team: { key: { eq: $teamKey } }
        number: { eq: $number }
      }
      first: 1
    ) {
      nodes {
        ${ISSUE_FIELDS}
      }
    }
  }
`;

export function isLinearAppUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'linear.app' || host === 'www.linear.app';
  } catch {
    return false;
  }
}

export function isLinearIssueUrl(rawUrl) {
  return Boolean(parseLinearIssueUrl(rawUrl));
}

export function parseLinearIssueUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return undefined; }
  const host = url.hostname.toLowerCase();
  if (host !== 'linear.app' && host !== 'www.linear.app') return undefined;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 3 || parts[1].toLowerCase() !== 'issue') return undefined;
  const workspace = String(parts[0] || '').toLowerCase();
  const identifier = String(parts[2] || '').toUpperCase();
  if (!workspace || !ISSUE_IDENTIFIER_RE.test(identifier)) return undefined;
  const separator = identifier.lastIndexOf('-');
  const teamKey = identifier.slice(0, separator);
  const number = Number(identifier.slice(separator + 1));
  if (!teamKey || !Number.isInteger(number) || number <= 0) return undefined;
  return { workspace, identifier, teamKey, number };
}

export function isLinearUploadUrl(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase() === 'uploads.linear.app';
  } catch {
    return false;
  }
}

export function linearUploadAuthHeaders(rawUrl, apiKey) {
  const token = String(apiKey || '').trim();
  if (!token || !isLinearUploadUrl(rawUrl)) return {};
  return { Authorization: token };
}

export async function resolveLinearIssueSource({
  sourceUrl,
  config = {},
  fetchFn = globalThis.fetch,
  fetchWithRetry,
  timeoutMs = 30_000,
}) {
  const parsed = parseLinearIssueUrl(sourceUrl);
  if (!parsed) {
    throw new Error('Linear 链接不是 Issue；第一期只支持 https://linear.app/zen-trading/issue/TEAM-数字/...');
  }
  if (parsed.workspace !== LINEAR_ALLOWED_WORKSPACE) {
    throw new Error(`Linear Issue 不在允许的 workspace：${parsed.workspace}；当前只支持 ${LINEAR_ALLOWED_WORKSPACE}`);
  }
  const apiKey = String(config.linearApiKey || '').trim();
  if (!apiKey) throw new Error('未配置 LINEAR_API_KEY，无法读取私有 Linear Issue');

  let issue;
  try {
    issue = await fetchLinearIssue({
      parsed,
      apiKey,
      fetchFn,
      fetchWithRetry,
      timeoutMs,
    });
  } catch (error) {
    throw actionableLinearError(error);
  }
  const markdown = String(issue.description || '').trim();
  if (!markdown) throw new Error('Linear Issue 描述为空，没有可翻译或分析的正文');
  return {
    markdown,
    title: String(issue.title || parsed.identifier).trim(),
    author: String(issue.creator?.name || '').trim(),
    publishedDate: String(issue.createdAt || '').trim(),
    identifier: String(issue.identifier || parsed.identifier).trim(),
    url: String(issue.url || sourceUrl).trim(),
  };
}

export function actionableLinearError(error) {
  const message = safeError(error);
  if (/未配置 LINEAR_API_KEY/.test(message) || /不在允许的 workspace/.test(message) || /不是 Issue/.test(message)) {
    return error instanceof Error ? error : new Error(message);
  }
  if (/Linear GraphQL 获取失败:401/.test(message)) {
    return new Error('私有 Linear 读取失败：LINEAR_API_KEY 无效或已失效');
  }
  if (/Linear GraphQL 获取失败:403/.test(message)) {
    return new Error('私有 Linear 读取失败：授权账号无权查看该 Issue');
  }
  if (/Linear GraphQL 获取失败:404/.test(message) || /Issue 不存在/.test(message)) {
    return new Error('私有 Linear 读取失败：Issue 不存在，或授权账号无权查看');
  }
  return new Error(`Linear API 读取失败:${message}`);
}

async function fetchLinearIssue({ parsed, apiKey, fetchFn, fetchWithRetry, timeoutMs }) {
  let direct;
  try {
    const byId = await linearGraphql({
      query: ISSUE_BY_ID_QUERY,
      variables: { id: parsed.identifier },
      apiKey,
      fetchFn,
      fetchWithRetry,
      timeoutMs,
    });
    direct = byId.data?.issue;
  } catch (error) {
    if (isLinearAuthFailure(error)) throw error;
  }
  if (isUsableIssue(direct)) return direct;

  const byNumber = await linearGraphql({
    query: ISSUES_BY_TEAM_NUMBER_QUERY,
    variables: { teamKey: parsed.teamKey, number: parsed.number },
    apiKey,
    fetchFn,
    fetchWithRetry,
    timeoutMs,
  });
  const fallback = Array.isArray(byNumber.data?.issues?.nodes) ? byNumber.data.issues.nodes[0] : null;
  if (isUsableIssue(fallback)) return fallback;
  throw new Error('Linear Issue 不存在');
}

function isLinearAuthFailure(error) {
  return /Linear GraphQL 获取失败:40[13]/.test(safeError(error));
}

async function linearGraphql({ query, variables, apiKey, fetchFn, fetchWithRetry, timeoutMs }) {
  let response;
  try {
    response = await callLinearFetch(fetchFn, fetchWithRetry, {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    }, timeoutMs);
  } catch (error) {
    throw new Error(`Linear GraphQL 请求失败:${safeError(error)}`);
  }
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`Linear GraphQL 获取失败:${response.status}`);
  }
  assertNoLinearAuthError(payload);
  return payload;
}

function assertNoLinearAuthError(payload) {
  const messages = graphqlMessages(payload);
  if (/unauthoriz|unauthenticat|invalid api key|authentication/i.test(messages)) {
    throw new Error('Linear GraphQL 获取失败:401');
  }
  if (/forbidden|not have permission|access denied/i.test(messages)) {
    throw new Error('Linear GraphQL 获取失败:403');
  }
}

function graphqlMessages(payload) {
  return [
    ...(Array.isArray(payload?.errors) ? payload.errors.map((entry) => entry?.message) : []),
    payload?.error,
    payload?.message,
  ].filter(Boolean).join(' ');
}

function isUsableIssue(issue) {
  return Boolean(issue && typeof issue === 'object' && (issue.identifier || issue.title || issue.description));
}

async function callLinearFetch(fetchFn, fetchWithRetry, options, timeoutMs) {
  if (fetchWithRetry) {
    return fetchWithRetry(fetchFn, LINEAR_GRAPHQL_URL, options, { timeoutMs, attempts: 2 });
  }
  return fetchFn(LINEAR_GRAPHQL_URL, {
    ...options,
    signal: AbortSignal.timeout(Number(timeoutMs) || 30_000),
  });
}

async function readJsonResponse(response) {
  try { return await response.json(); } catch {}
  try {
    const text = await response.text();
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function safeError(error) {
  return String(error?.message || error || '未知错误').replace(/\s+/g, ' ').slice(0, 220);
}
