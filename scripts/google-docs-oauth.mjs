import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = path.join(ROOT, '.env');
dotenv.config({ path: ENV_PATH });

const clientId = String(process.env.GOOGLE_DOCS_CLIENT_ID || '').trim();
const clientSecret = String(process.env.GOOGLE_DOCS_CLIENT_SECRET || '').trim();
if (!clientId || !clientSecret) {
  console.error('请先在 .env 设置 GOOGLE_DOCS_CLIENT_ID 和 GOOGLE_DOCS_CLIENT_SECRET。');
  process.exit(1);
}

const state = crypto.randomBytes(24).toString('hex');
const callback = deferred();
const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
  if (requestUrl.pathname !== '/oauth2/callback') {
    response.writeHead(404).end('Not found');
    return;
  }
  if (requestUrl.searchParams.get('state') !== state) {
    response.writeHead(400).end('Invalid OAuth state');
    callback.reject(new Error('Google OAuth state 校验失败'));
    return;
  }
  const error = requestUrl.searchParams.get('error');
  const code = requestUrl.searchParams.get('code');
  if (error || !code) {
    response.writeHead(400).end('Google authorization was not completed.');
    callback.reject(new Error(`Google 授权未完成:${error || 'missing_code'}`));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Google Docs authorization completed. You can close this tab.');
  callback.resolve(code);
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
const redirectUri = `http://127.0.0.1:${address.port}/oauth2/callback`;
const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authorizationUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: 'https://www.googleapis.com/auth/drive.readonly',
  access_type: 'offline',
  prompt: 'consent',
  include_granted_scopes: 'true',
  state,
}).toString();

console.log('请在浏览器完成 Google 只读授权。若浏览器未自动打开，请访问：');
console.log(authorizationUrl.toString());
if (process.platform === 'darwin') {
  const opener = spawn('open', [authorizationUrl.toString()], {
    detached: true,
    stdio: 'ignore',
  });
  opener.unref();
}

try {
  const code = await withTimeout(callback.promise, 5 * 60 * 1000);
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await tokenResponse.json();
  if (!tokenResponse.ok) {
    throw new Error(`${tokenResponse.status} ${payload.error_description || payload.error || 'unknown_error'}`);
  }
  const refreshToken = String(payload.refresh_token || '').trim();
  if (!refreshToken) {
    throw new Error('Google 未返回 refresh_token；请撤销该应用已有授权后重试');
  }
  upsertEnvValue(ENV_PATH, 'GOOGLE_DOCS_REFRESH_TOKEN', refreshToken);
  console.log('已将 GOOGLE_DOCS_REFRESH_TOKEN 写入本机 .env（不会输出 token 内容）。');
  console.log('下一步运行：npm run check:documents -- "<私有 Google Docs 链接>"');
} finally {
  server.close();
}

function upsertEnvValue(filePath, name, value) {
  const quoted = JSON.stringify(value);
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const line = `${name}=${quoted}`;
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  const next = pattern.test(current)
    ? current.replace(pattern, line)
    : `${current.replace(/\s*$/, '\n')}${line}\n`;
  fs.writeFileSync(filePath, next, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('等待 Google 授权超时')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
