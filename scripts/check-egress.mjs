import 'dotenv/config';
import { loadEgressConfig } from '../src/config/index.js';
import { assertExpectedEgress } from '../src/lib/egress.js';

const config = loadEgressConfig();
if (!config.enabled) throw new Error('EGRESS_GUARD_ENABLED 未开启');

const guard = await assertExpectedEgress(config);
console.log(`固定出口校验:通过 (IPv${guard.family})`);

const targets = [
  ['Slack', 'https://slack.com/api/api.test', { method: 'POST' }],
  ['OpenRouter', 'https://openrouter.ai/api/v1/models', {}],
  ['Exa', 'https://api.exa.ai/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
  ['WeChat', 'https://api.weixin.qq.com/cgi-bin/token', {}],
  ['Customer.io', 'https://api.customer.io/v1/newsletters', {}],
];

for (const [name, url, init] of targets) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    // 4xx 代表目标 API 已收到请求；这里只验证 DNS/TLS/路由，不发送凭据或业务数据。
    if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
    console.log(`${name}:可达 (HTTP ${response.status})`);
  } catch (error) {
    console.error(`${name}:不可达 (${error.name === 'AbortError' ? '超时' : error.message})`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}
