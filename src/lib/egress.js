import net from 'node:net';

export const DEFAULT_EGRESS_CHECK_URL = 'https://www.cloudflare.com/cdn-cgi/trace';

function egressError(message, cause, code = 'EGRESS_UNKNOWN') {
  const error = new Error(message, cause ? { cause } : undefined);
  error.stage = 'egress';
  error.code = code;
  return error;
}

function parseEgressIp(body) {
  const text = String(body || '').trim();
  const traceMatch = /^ip=(.+)$/m.exec(text);
  if (traceMatch) return traceMatch[1].trim();
  try {
    const parsed = JSON.parse(text);
    return String(parsed.ip || '').trim();
  } catch {
    return '';
  }
}

export async function getPublicEgressIp({
  fetchFn = globalThis.fetch,
  checkUrl = DEFAULT_EGRESS_CHECK_URL,
  timeoutMs = 8000,
} = {}) {
  let parsedUrl;
  try { parsedUrl = new URL(checkUrl); }
  catch (error) { throw egressError('出口检查地址无效,已拒绝联网', error, 'EGRESS_CONFIG'); }
  if (parsedUrl.protocol !== 'https:') {
    throw egressError('出口检查必须使用 HTTPS,已拒绝联网', undefined, 'EGRESS_CONFIG');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchFn(checkUrl, {
      headers: { accept: 'text/plain, application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const ip = parseEgressIp(await response.text());
    if (!net.isIP(ip)) throw new Error('响应中没有有效 IP');
    return ip;
  } catch (error) {
    throw egressError('无法确认公网出口,已拒绝联网', error, 'EGRESS_UNKNOWN');
  } finally {
    clearTimeout(timer);
  }
}

export async function assertExpectedEgress(config = {}, deps = {}) {
  if (!config.enabled) return { skipped: true };
  const expectedIps = [...new Set([
    ...(Array.isArray(config.expectedIps) ? config.expectedIps : []),
    config.expectedIp,
  ].map((value) => String(value || '').trim()).filter(Boolean))];
  if (!expectedIps.length || expectedIps.some((ip) => !net.isIP(ip))) {
    throw egressError('出口保护已开启,但 EXPECTED_EGRESS_IP/EXPECTED_EGRESS_IPS 未配置或无效', undefined, 'EGRESS_CONFIG');
  }
  const actualIp = await getPublicEgressIp({
    fetchFn: deps.fetchFn,
    checkUrl: config.checkUrl,
    timeoutMs: config.timeoutMs,
  });
  if (!expectedIps.includes(actualIp)) {
    throw egressError('公网出口不在允许的代理 IP 白名单中,已拒绝联网', undefined, 'EGRESS_MISMATCH');
  }
  return { ok: true, family: net.isIP(actualIp) };
}

export async function waitForExpectedEgress(config = {}, {
  fetchFn,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onWait = () => {},
} = {}) {
  if (!config.enabled) return { skipped: true };
  for (;;) {
    try {
      return await assertExpectedEgress(config, { fetchFn });
    } catch (error) {
      onWait(error);
      await sleepFn(config.retryMs || 10000);
    }
  }
}

export function startEgressMonitor(config = {}, {
  fetchFn,
  onFailure = () => {},
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!config.enabled) return () => {};
  let checking = false;
  let consecutiveFailures = 0;
  const failureThreshold = Math.max(1, Number(config.monitorFailureThreshold) || 2);
  const timer = setIntervalFn(async () => {
    if (checking) return;
    checking = true;
    try {
      await assertExpectedEgress(config, { fetchFn });
      consecutiveFailures = 0;
    } catch (error) {
      // 已成功查到公网 IP 但不在白名单，或配置本身无效时立即退出；只有查询端点/TLS
      // 暂时不可用(EGRESS_UNKNOWN)才使用连续失败阈值，避免网络抖动反复杀死长任务。
      if (error.code === 'EGRESS_MISMATCH' || error.code === 'EGRESS_CONFIG') {
        consecutiveFailures = 0;
        onFailure(error);
        return;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= failureThreshold) {
        consecutiveFailures = 0;
        onFailure(error);
      }
    } finally {
      checking = false;
    }
  }, config.monitorIntervalMs || 30000);
  timer.unref?.();
  return () => clearIntervalFn(timer);
}
