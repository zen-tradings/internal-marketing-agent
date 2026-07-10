import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/index.js';

test('loadConfig 读取 env 并给出默认值', () => {
  const env = {
    WORK_DIR: '/srv/zen',
    SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x', NOTIFY_CHANNEL_ID: 'C1',
    WECHAT_APP_ID: 'wx', WECHAT_APP_SECRET: 'sec',
    OPENROUTER_API_KEY: 'or-key',
    OPENROUTER_MODEL: 'deepseek/deepseek-chat',
    EXA_API_KEY: 'exa-key',
  };
  const c = loadConfig(env);
  assert.equal(c.workDir, '/srv/zen');
  assert.equal(c.maxConcurrency, 1);              // 默认
  assert.equal(c.defaultTimeoutMs, 600000);       // 默认 10min
  assert.equal(c.writer.openrouterApiKey, 'or-key');
  assert.equal(c.writer.model, 'deepseek/deepseek-chat');
  assert.equal(c.writer.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(c.writer.exaApiKey, 'exa-key');
  assert.equal(c.writer.exaBaseUrl, 'https://api.exa.ai');
  assert.equal(c.writer.exaPriorityResults, 4); // 默认
  assert.equal(c.writer.exaTimeoutMs, 45000); // 默认
  assert.equal('claudeBin' in c, false);
  assert.equal(c.wechat.appId, 'wx');
});

test('EXA_PRIORITY_RESULTS 覆盖优先路默认返回数', () => {
  const env = {
    SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x',
    WECHAT_APP_ID: 'wx', WECHAT_APP_SECRET: 'sec',
    OPENROUTER_API_KEY: 'or-key',
    EXA_API_KEY: 'exa-key',
    EXA_PRIORITY_RESULTS: '7',
  };
  const c = loadConfig(env);
  assert.equal(c.writer.exaPriorityResults, 7);
});

test('EXA_TIMEOUT_MS 覆盖单请求超时默认值', () => {
  const env = {
    SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x',
    WECHAT_APP_ID: 'wx', WECHAT_APP_SECRET: 'sec',
    OPENROUTER_API_KEY: 'or-key',
    EXA_API_KEY: 'exa-key',
    EXA_TIMEOUT_MS: '8000',
  };
  const c = loadConfig(env);
  assert.equal(c.writer.exaTimeoutMs, 8000);
});

test('缺关键 env 抛错', () => {
  assert.throws(() => loadConfig({ OPENROUTER_API_KEY: 'or-key', EXA_API_KEY: 'exa-key' }), /SLACK_BOT_TOKEN/);
});

test('缺 OpenRouter key 抛错', () => {
  const env = {
    SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x',
    WECHAT_APP_ID: 'wx', WECHAT_APP_SECRET: 'sec',
    EXA_API_KEY: 'exa-key',
  };
  assert.throws(() => loadConfig(env), /OPENROUTER_API_KEY/);
});
