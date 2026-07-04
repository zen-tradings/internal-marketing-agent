import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/index.js';

test('loadConfig 读取 env 并给出默认值', () => {
  const env = {
    WORK_DIR: '/srv/zen',
    SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x', NOTIFY_CHANNEL_ID: 'C1',
    WECHAT_APP_ID: 'wx', WECHAT_APP_SECRET: 'sec',
    HTTPS_PROXY: 'http://127.0.0.1:7897',
  };
  const c = loadConfig(env);
  assert.equal(c.workDir, '/srv/zen');
  assert.equal(c.maxConcurrency, 1);              // 默认
  assert.equal(c.defaultTimeoutMs, 600000);       // 默认 10min
  assert.equal(c.proxy.https, 'http://127.0.0.1:7897');
  assert.ok(c.proxy.noProxy.includes('weixin.qq.com'));
  assert.equal(c.wechat.appId, 'wx');
});

test('缺关键 env 抛错', () => {
  assert.throws(() => loadConfig({}), /SLACK_BOT_TOKEN/);
});
