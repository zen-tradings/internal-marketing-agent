import { createHash } from 'node:crypto';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_DRIVE_EXPORT_BASE = 'https://www.googleapis.com/drive/v3/files';
const TOKEN_EXPIRY_SKEW_MS = 60_000;

let tokenCache = {
  credentialKey: '',
  accessToken: '',
  expiresAt: 0,
  pending: null,
};

export function isGoogleDocUrl(rawUrl) {
  return Boolean(googleDocId(rawUrl));
}

export function googleDocId(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return ''; }
  if (url.hostname.toLowerCase() !== 'docs.google.com') return '';
  return url.pathname.match(/^\/document(?:\/u\/\d+)?\/d\/([^/]+)/)?.[1] || '';
}

export async function resolveGoogleDocsSource({
  sourceUrl,
  config = {},
  fetchFn = globalThis.fetch,
  timeoutMs = 30_000,
}) {
  const fileId = googleDocId(sourceUrl);
  if (!fileId) throw new Error('无法识别 Google Docs 文档 ID');
  assertCompleteOAuthConfig(config);

  const accessToken = await googleDocsAccessToken({ config, fetchFn, timeoutMs });
  if (!accessToken) {
    return {
      acquisitionUrl: `https://docs.google.com/document/d/${encodeURIComponent(fileId)}/export?format=html`,
      requestHeaders: {},
      authenticated: false,
    };
  }
  return {
    acquisitionUrl: `${GOOGLE_DRIVE_EXPORT_BASE}/${encodeURIComponent(fileId)}/export?mimeType=text%2Fhtml`,
    requestHeaders: { Authorization: `Bearer ${accessToken}` },
    authenticated: true,
  };
}

async function googleDocsAccessToken({ config, fetchFn, timeoutMs }) {
  if (config.googleDocsClientId
    && config.googleDocsClientSecret
    && config.googleDocsRefreshToken) {
    return refreshGoogleAccessToken({ config, fetchFn, timeoutMs });
  }
  return String(config.googleDocsAccessToken || '').trim();
}

async function refreshGoogleAccessToken({ config, fetchFn, timeoutMs }) {
  const credentialKey = createHash('sha256')
    .update(`${config.googleDocsClientId}\0${config.googleDocsRefreshToken}`)
    .digest('hex');
  const now = Date.now();
  if (tokenCache.credentialKey === credentialKey
    && tokenCache.accessToken
    && tokenCache.expiresAt - TOKEN_EXPIRY_SKEW_MS > now) {
    return tokenCache.accessToken;
  }
  if (tokenCache.credentialKey === credentialKey && tokenCache.pending) {
    return tokenCache.pending;
  }

  const pending = requestGoogleAccessToken({ config, fetchFn, timeoutMs })
    .then(({ accessToken, expiresIn }) => {
      tokenCache = {
        credentialKey,
        accessToken,
        expiresAt: Date.now() + expiresIn * 1000,
        pending: null,
      };
      return accessToken;
    })
    .catch((error) => {
      if (tokenCache.credentialKey === credentialKey) {
        tokenCache = { credentialKey: '', accessToken: '', expiresAt: 0, pending: null };
      }
      throw error;
    });
  tokenCache = { credentialKey, accessToken: '', expiresAt: 0, pending };
  return pending;
}

async function requestGoogleAccessToken({ config, fetchFn, timeoutMs }) {
  const body = new URLSearchParams({
    client_id: config.googleDocsClientId,
    client_secret: config.googleDocsClientSecret,
    refresh_token: config.googleDocsRefreshToken,
    grant_type: 'refresh_token',
  });
  let response;
  try {
    response = await fetchFn(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(Number(timeoutMs) || 30_000),
    });
  } catch (error) {
    throw new Error(`Google OAuth 刷新失败:${safeError(error)}`);
  }

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    const reason = String(payload.error_description || payload.error || response.statusText || 'unknown_error')
      .replace(/\s+/g, ' ')
      .slice(0, 180);
    throw new Error(`Google OAuth 刷新失败:${response.status} ${reason}`);
  }
  const accessToken = String(payload.access_token || '').trim();
  if (!accessToken) throw new Error('Google OAuth 刷新失败:响应缺少 access_token');
  const expiresIn = Math.max(120, Number(payload.expires_in) || 3600);
  return { accessToken, expiresIn };
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

function assertCompleteOAuthConfig(config) {
  const names = [
    ['GOOGLE_DOCS_CLIENT_ID', config.googleDocsClientId],
    ['GOOGLE_DOCS_CLIENT_SECRET', config.googleDocsClientSecret],
    ['GOOGLE_DOCS_REFRESH_TOKEN', config.googleDocsRefreshToken],
  ];
  const configured = names.filter(([, value]) => String(value || '').trim());
  if (configured.length > 0 && configured.length < names.length) {
    const missing = names.filter(([, value]) => !String(value || '').trim()).map(([name]) => name);
    throw new Error(`Google Docs OAuth 配置不完整，缺少 ${missing.join('、')}`);
  }
}

function safeError(error) {
  return String(error?.message || error || '未知错误').replace(/\s+/g, ' ').slice(0, 220);
}
