import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import { fetchUsesGlobalTransport, rebindFetchTransport } from './task-cancellation.js';
import { fetchWithTimeout } from './http-timeout.js';
import { isLinearUploadUrl } from './linear.js';
const DEFAULT_FETCH_LIMITS = { maxSourceBytes: 50 * 1024 * 1024, maxRedirects: 5, fetchTimeoutMs: 30000 };

export async function assertSafeHttpUrl(rawUrl, { dnsLookup = dns.lookup } = {}) {
  return (await resolveSafeHttpUrl(rawUrl, { dnsLookup })).url;
}

export async function resolveSafeHttpUrl(rawUrl, { dnsLookup = dns.lookup } = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('原文链接格式无效'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 http(s) 原文链接');
  if (url.username || url.password) throw new Error('原文链接不得包含用户名或密码');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('原文链接指向本机或内部地址');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('原文链接指向私网或保留地址');
    return { url, addresses: [{ address: host, family: net.isIPv4(host) ? 4 : 6 }] };
  }
  let records;
  try { records = await dnsLookup(host, { all: true, verbatim: true }); }
  catch (error) { throw new Error(`原文域名解析失败:${String(error?.message || error)}`); }
  const addresses = (records || []).map((record) => ({
    address: String(record?.address || ''),
    family: Number(record?.family) || net.isIP(record?.address),
  }));
  if (!addresses.length || addresses.some((record) => !record.family || isPrivateIp(record.address))) {
    throw new Error('原文域名解析到私网或保留地址');
  }
  return { url, addresses };
}

export function isPrivateIp(address) {
  const value = String(address || '').toLowerCase();
  if (net.isIPv4(value)) {
    const [a, b, c] = value.split('.').map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224;
  }
  if (net.isIPv6(value)) {
    const bytes = ipv6Bytes(value);
    if (!bytes) return true;
    if (matchesIpv6Prefix(bytes, '::', 128) || matchesIpv6Prefix(bytes, '::1', 128)) return true;
    if (matchesIpv6Prefix(bytes, '::ffff:0:0', 96)) {
      return isPrivateIp(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
    }
    if (matchesIpv6Prefix(bytes, '64:ff9b:1::', 48)
      || matchesIpv6Prefix(bytes, '100::', 64)
      || matchesIpv6Prefix(bytes, '2001::', 23)
      || matchesIpv6Prefix(bytes, '2001:db8::', 32)
      || matchesIpv6Prefix(bytes, '3fff::', 20)
      || matchesIpv6Prefix(bytes, '5f00::', 16)
      || matchesIpv6Prefix(bytes, 'fc00::', 7)
      || matchesIpv6Prefix(bytes, 'fe80::', 10)
      || matchesIpv6Prefix(bytes, 'ff00::', 8)) return true;
    if (matchesIpv6Prefix(bytes, '2002::', 16)) {
      return isPrivateIp(`${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`);
    }
    return false;
  }
  return true;
}

function ipv6Bytes(address) {
  let value = String(address || '').split('%')[0].toLowerCase();
  if (!net.isIPv6(value)) return undefined;
  const dotted = value.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) {
    const octets = dotted.split('.').map(Number);
    value = value.slice(0, -dotted.length)
      + `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const sides = value.split('::');
  if (sides.length > 2) return undefined;
  const left = sides[0] ? sides[0].split(':').filter(Boolean) : [];
  const right = sides[1] ? sides[1].split(':').filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  if ((sides.length === 1 && missing !== 0) || missing < 0) return undefined;
  const groups = [...left, ...Array(sides.length === 2 ? missing : 0).fill('0'), ...right];
  if (groups.length !== 8) return undefined;
  const bytes = Buffer.alloc(16);
  for (let index = 0; index < groups.length; index += 1) {
    const group = Number.parseInt(groups[index], 16);
    if (!Number.isInteger(group) || group < 0 || group > 0xffff) return undefined;
    bytes.writeUInt16BE(group, index * 2);
  }
  return bytes;
}

function matchesIpv6Prefix(bytes, prefix, bits) {
  const prefixBytes = ipv6Bytes(prefix);
  if (!prefixBytes) return false;
  const whole = Math.floor(bits / 8);
  for (let index = 0; index < whole; index += 1) {
    if (bytes[index] !== prefixBytes[index]) return false;
  }
  const remainder = bits % 8;
  if (!remainder) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (bytes[whole] & mask) === (prefixBytes[whole] & mask);
}

export async function safeFetchResource({
  url,
  fetchFn = globalThis.fetch,
  fetchWithRetry,
  limits = DEFAULT_FETCH_LIMITS,
  dnsLookup = dns.lookup,
  accept,
  headers = {},
  maxBytes = limits.maxSourceBytes,
  method = 'GET',
  body,
  pinnedFetchFactory = pinnedHttpFetch,
}) {
  const requestMethod = String(method || 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(requestMethod)) throw new Error(`安全下载不支持请求方法:${requestMethod}`);
  const requestBody = body === undefined || body === null ? undefined : String(body);
  if (requestBody && Buffer.byteLength(requestBody) > 64 * 1024) throw new Error('安全下载请求体超过 64KB 上限');
  let current = url;
  let currentHeaders = { ...headers };
  for (let redirects = 0; redirects <= limits.maxRedirects; redirects += 1) {
    // Official Linear uploads stay on a fixed public host. Skip local DNS pinning
    // so a managed Fake-IP resolver cannot map uploads.linear.app to 198.18/8
    // and abort an otherwise authenticated asset download.
    const resolved = isLinearUploadUrl(current)
      ? { url: new URL(current), addresses: [] }
      : await resolveSafeHttpUrl(current, { dnsLookup });
    const requestFetch = !isLinearUploadUrl(current) && fetchUsesGlobalTransport(fetchFn)
      ? rebindFetchTransport(fetchFn, pinnedFetchFactory(resolved.addresses))
      : fetchFn;
    const response = await callFetch(fetchWithRetry, requestFetch, current, {
      redirect: 'manual',
      method: requestMethod,
      body: requestBody,
      headers: {
        Accept: accept || '*/*',
        'User-Agent': 'Mozilla/5.0 ZenTranslationBot/3.0',
        ...currentHeaders,
      },
    }, limits.fetchTimeoutMs);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await cancelResponseBody(response);
      if (!location) throw new Error(`原文重定向缺少 Location:${response.status}`);
      const next = new URL(location, current).toString();
      if (new URL(next).origin !== new URL(current).origin) {
        currentHeaders = stripSensitiveRequestHeaders(currentHeaders);
      }
      current = next;
      continue;
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      throw new Error(`原文获取失败:${response.status} ${response.statusText}`);
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) {
      await cancelResponseBody(response);
      throw new Error(`原文响应超过大小上限:${declared}`);
    }
    const buffer = await readResponseBufferWithLimit(response, maxBytes);
    if (!buffer.length) throw new Error('原文响应为空');
    return {
      finalUrl: current,
      contentType: response.headers.get('content-type') || '',
      buffer,
      status: response.status,
    };
  }
  throw new Error(`原文重定向超过 ${limits.maxRedirects} 次`);
}

function stripSensitiveRequestHeaders(headers) {
  const sensitive = new Set(['authorization', 'cookie', 'proxy-authorization']);
  return Object.fromEntries(
    Object.entries(headers || {}).filter(([name]) => !sensitive.has(name.toLowerCase())),
  );
}

export async function readResponseBufferWithLimit(response, maxBytes) {
  const limit = Number(maxBytes);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('响应大小上限配置无效');
  const reader = response?.body?.getReader?.();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > limit) throw new Error(`原文响应超过大小上限:${buffer.length}`);
    return buffer;
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > limit) {
        await reader.cancel('response size limit exceeded').catch(() => {});
        throw new Error(`原文响应超过大小上限:${total}`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}

async function cancelResponseBody(response) {
  try { await response?.body?.cancel?.(); } catch {}
}

export async function callFetch(fetchWithRetry, fetchFn, url, options, timeoutMs) {
  if (fetchWithRetry) return fetchWithRetry(fetchFn, url, options, { timeoutMs, attempts: 2 });
  return fetchWithTimeout(fetchFn, url, options, { timeoutMs, label: '原文获取' });
}

function pinnedHttpFetch(addresses) {
  const safeAddresses = addresses.map((record) => ({ address: record.address, family: record.family }));
  return async function fetchPinned(rawUrl, options = {}) {
    const target = new URL(rawUrl);
    const transport = target.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const request = transport.request(target, {
        method: options.method || 'GET',
        headers: options.headers,
        signal: options.signal,
        lookup(_hostname, lookupOptions, callback) {
          const wantedFamily = Number(lookupOptions?.family) || 0;
          const candidates = wantedFamily
            ? safeAddresses.filter((record) => record.family === wantedFamily)
            : safeAddresses;
          const selected = candidates[0] || safeAddresses[0];
          if (!selected) {
            callback(Object.assign(new Error('安全 DNS 结果为空'), { code: 'ENOTFOUND' }));
            return;
          }
          if (lookupOptions?.all) callback(null, candidates.length ? candidates : safeAddresses);
          else callback(null, selected.address, selected.family);
        },
      }, (incoming) => {
        try {
          const responseHeaders = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            responseHeaders.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
          }
          resolve(new Response(Readable.toWeb(incoming), {
            status: incoming.statusCode,
            statusText: incoming.statusMessage,
            headers: responseHeaders,
          }));
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      });
      request.once('error', reject);
      request.end(options.body);
    });
  };
}

