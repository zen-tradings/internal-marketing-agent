import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertExpectedEgress, getPublicEgressIp, startEgressMonitor, waitForExpectedEgress } from '../src/lib/egress.js';

const response = (body, ok = true, status = 200) => ({ ok, status, text: async () => body });

test('出口保护未开启时不发网络请求', async () => {
  let called = false;
  const out = await assertExpectedEgress({}, { fetchFn: async () => { called = true; } });
  assert.deepEqual(out, { skipped: true });
  assert.equal(called, false);
});

test('解析 Cloudflare trace 并接受匹配的固定出口', async () => {
  const config = { enabled: true, expectedIp: '203.0.113.8', checkUrl: 'https://check.test', timeoutMs: 50 };
  const out = await assertExpectedEgress(config, { fetchFn: async () => response('ip=203.0.113.8\nloc=US\n') });
  assert.deepEqual(out, { ok: true, family: 4 });
});

test('接受多个允许出口中的任意一个并兼容旧的单 IP 配置', async () => {
  const config = {
    enabled: true,
    expectedIp: '203.0.113.8',
    expectedIps: ['203.0.113.8', '198.51.100.4'],
  };
  const out = await assertExpectedEgress(config, { fetchFn: async () => response('ip=198.51.100.4\nloc=US\n') });
  assert.deepEqual(out, { ok: true, family: 4 });
});

test('允许出口白名单中存在无效 IP 时 fail closed', async () => {
  await assert.rejects(
    () => assertExpectedEgress(
      { enabled: true, expectedIps: ['203.0.113.8', 'not-an-ip'] },
      { fetchFn: async () => response('ip=203.0.113.8\n') },
    ),
    (error) => error.stage === 'egress' && /未配置或无效/.test(error.message),
  );
});

test('出口不匹配时 fail closed 且错误文案不泄露实际 IP', async () => {
  const config = { enabled: true, expectedIp: '203.0.113.8' };
  await assert.rejects(
    () => assertExpectedEgress(config, { fetchFn: async () => response('ip=198.51.100.4\nloc=CN\n') }),
    (error) => {
      assert.equal(error.stage, 'egress');
      assert.match(error.message, /白名单/);
      assert.doesNotMatch(error.message, /198\.51\.100\.4/);
      return true;
    },
  );
});

test('查询失败和无效响应都 fail closed', async () => {
  await assert.rejects(
    () => getPublicEgressIp({ fetchFn: async () => response('oops') }),
    (error) => error.stage === 'egress' && /无法确认/.test(error.message),
  );
  await assert.rejects(
    () => getPublicEgressIp({ fetchFn: async () => { throw new Error('offline'); } }),
    (error) => error.stage === 'egress' && /无法确认/.test(error.message),
  );
});

test('出口检查地址必须使用 HTTPS', async () => {
  await assert.rejects(
    () => getPublicEgressIp({ checkUrl: 'http://check.test', fetchFn: async () => response('ip=203.0.113.8') }),
    (error) => error.stage === 'egress' && /HTTPS/.test(error.message),
  );
});

test('启动等待会重试直到固定出口恢复', async () => {
  let attempts = 0;
  const waits = [];
  const out = await waitForExpectedEgress(
    { enabled: true, expectedIp: '203.0.113.8', retryMs: 1 },
    {
      fetchFn: async () => response(`ip=${++attempts < 3 ? '198.51.100.4' : '203.0.113.8'}\n`),
      sleepFn: async (ms) => waits.push(ms),
    },
  );
  assert.equal(out.ok, true);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1, 1]);
});

test('后台监控对查询失败使用阈值,成功后重置计数', async () => {
  let tick;
  let failures = 0;
  const results = ['bad', 'good', 'bad', 'bad'];
  const stop = startEgressMonitor(
    { enabled: true, expectedIp: '203.0.113.8', monitorFailureThreshold: 2 },
    {
      fetchFn: async () => {
        if (results.shift() === 'good') return response('ip=203.0.113.8\n');
        throw new Error('temporary TLS failure');
      },
      onFailure: () => { failures += 1; },
      setIntervalFn: (fn) => { tick = fn; return { unref() {} }; },
      clearIntervalFn: () => {},
    },
  );
  await tick(); // 第一次失败,容忍
  assert.equal(failures, 0);
  await tick(); // 成功,失败计数归零
  await tick(); // 再次第一次失败
  assert.equal(failures, 0);
  await tick(); // 连续第二次失败,触发
  assert.equal(failures, 1);
  stop();
});

test('后台监控查到非白名单 IP 时不等待阈值,立即退出', async () => {
  let tick;
  let failures = 0;
  startEgressMonitor(
    { enabled: true, expectedIp: '203.0.113.8', monitorFailureThreshold: 8 },
    {
      fetchFn: async () => response('ip=198.51.100.4\n'),
      onFailure: () => { failures += 1; },
      setIntervalFn: (fn) => { tick = fn; return { unref() {} }; },
      clearIntervalFn: () => {},
    },
  );
  await tick();
  assert.equal(failures, 1);
});
