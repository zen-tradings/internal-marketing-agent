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
  assert.deepEqual(c.resources, {
    browserConcurrency: 1,
    wechatWriteConcurrency: 1,
    customerioWriteConcurrency: 1,
    openrouterConcurrency: 2,
    exaSearchQps: 8,
  });
  assert.equal(c.slack.postIntervalMs, 1000);
  assert.equal(c.defaultTimeoutMs, 600000);       // 默认 10min
  assert.equal('egress' in c, false);
  assert.equal(c.writer.openrouterApiKey, 'or-key');
  assert.equal(c.writer.model, 'deepseek/deepseek-chat');
  assert.equal(c.writer.plannerModel, 'deepseek/deepseek-chat');
  assert.equal(c.writer.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(c.writer.maxTokens, 12000);
  assert.equal(c.writer.reasoningEffort, 'high');
  assert.equal(c.writer.plannerReasoningEffort, 'none');
  assert.equal(c.writer.reviewReasoningEffort, 'none');
  assert.equal(c.writer.routerReasoningEffort, 'none');
  assert.equal(c.writer.optionsStrategyModel, 'anthropic/claude-fable-5');
  assert.equal(c.writer.optionsStrategyReasoningEffort, 'high');
  assert.equal(c.writer.optionsStrategyMaxTokens, 32000);
  assert.equal(c.writer.optionsStrategyTimeoutMs, 900000);
  assert.equal(c.writer.exaApiKey, 'exa-key');
  assert.equal(c.writer.exaBaseUrl, 'https://api.exa.ai');
  assert.equal(c.writer.exaPriorityResults, 4); // 默认
  assert.equal(c.writer.exaTimeoutMs, 45000); // 默认
  assert.equal(c.analysis.pipelineVersion, 'v2');
  assert.equal(c.analysis.searchMaxQueries, 8);
  assert.equal(c.analysis.recentWindowDays, 60);
  assert.equal(c.qdii.enabled, false);
  assert.equal(c.qdii.maxFundsSlack, 20);
  assert.equal(c.qdii.maxFundsDraft, 8);
  assert.equal(c.qdii.staleMaxDays, 366);
  assert.match(c.qdii.workerPath, /python\/qdii_worker\.py$/);
  assert.equal(c.documents.googleDocsAccessToken, '');
  assert.equal(c.documents.googleDocsRefreshToken, '');
  assert.equal(c.documents.githubToken, '');
  assert.equal(c.slack.editDebounceMs, 5000);
  assert.deepEqual(c.discord, {
    openingDigestEnabled: false,
    webhookUrl: '',
    expectedChannelId: '',
    timeoutMs: 30000,
    maxAttempts: 8,
  });
  assert.equal(c.translation.browserEnabled, true);
  assert.equal(c.translation.maxPdfPages, 120);
  assert.equal(c.translation.maxSourceBytes, 50 * 1024 * 1024);
  assert.equal(c.translation.datalabBaseUrl, 'https://www.datalab.to/api/v1');
  assert.equal(c.translation.datalabMode, 'balanced');
  assert.match(c.cover.generatorDir, /tools\/cover-generator$/);
  assert.equal('claudeBin' in c, false);
  assert.equal(c.wechat.appId, 'wx');
  assert.equal(c.wechat.timeoutMs, 30000);
  assert.equal(c.openingDigest.wechatEnabled, false);
  assert.equal(c.openingDigest.model, 'deepseek/deepseek-chat');
  assert.equal(c.openingDigest.earningsPythonPath, 'python3');
  assert.match(c.openingDigest.earningsWorkerPath, /python\/opening_digest_worker\.py$/);
  assert.equal(c.openingDigest.earningsWorkerTimeoutMs, 15000);
  assert.equal(c.workflowEnvironment.channel, 'wechat-draft');
  assert.equal(c.workflowEnvironment.newsletterEdition, 'Vol. 1');
  assert.match(c.assets.surveyImage, /assets\/zen-survey-qr\.jpg$/);
  assert.match(c.assets.footerImage, /assets\/zen-footer-qr\.png$/);
});

test('工作流环境在启动配置阶段拒绝未知渠道和无效域名', () => {
  const base = {
    SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x',
    WECHAT_APP_ID: 'wx', WECHAT_APP_SECRET: 'sec', OPENROUTER_API_KEY: 'or-key',
  };
  assert.throws(() => loadConfig({ ...base, WECHAT_CHANNEL: 'customerio-opening-digest' }), /WECHAT_CHANNEL/);
  assert.throws(() => loadConfig({ ...base, EXA_PRIORITY_DOMAINS: 'https:\/\/example.com/path' }), /无效域名/);
});

test('生产环境允许已验证的 1-2 并发并锁住重资源上限', () => {
  const base = {
    NODE_ENV: 'production',
    SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x',
    SLACK_ALLOWED_USER_IDS: 'U1', SLACK_ALLOWED_CHANNEL_IDS: 'C1',
    WECHAT_APP_ID: 'wx', WECHAT_APP_SECRET: 'sec',
    OPENROUTER_API_KEY: 'or-key',
  };
  assert.equal(loadConfig({ ...base, WECHAT_TIMEOUT_MS: '12345' }).wechat.timeoutMs, 12345);
  assert.equal(loadConfig({ ...base, MAX_CONCURRENCY: '2' }).maxConcurrency, 2);
  assert.throws(() => loadConfig({ ...base, MAX_CONCURRENCY: '3' }), /只能为 1 或 2/);
  assert.throws(() => loadConfig({ ...base, BROWSER_CONCURRENCY: '2' }), /BROWSER_CONCURRENCY 必须为 1/);
  assert.throws(() => loadConfig({ ...base, OPENROUTER_CONCURRENCY: '3' }), /不得超过 2/);
  assert.throws(() => loadConfig({ ...base, EXA_SEARCH_QPS: '9' }), /不得超过 8/);
  assert.throws(() => loadConfig({ ...base, SLACK_POST_INTERVAL_MS: '999' }), /不得小于 1000/);
});

test('Opening Digest 微信同步只有显式开关才启用', () => {
  const base = {
    SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x',
    WECHAT_APP_ID: 'wx', WECHAT_APP_SECRET: 'sec', OPENROUTER_API_KEY: 'or-key',
  };
  assert.equal(loadConfig({ ...base, OPENING_DIGEST_WECHAT_ENABLED: 'true' }).openingDigest.wechatEnabled, true);
  assert.equal(loadConfig({ ...base, OPENING_DIGEST_WECHAT_ENABLED: 'false' }).openingDigest.wechatEnabled, false);
  assert.equal(loadConfig({ ...base, OPENROUTER_MODEL: 'global/writer' }).openingDigest.model, 'global/writer');
  assert.equal(loadConfig({
    ...base,
    OPENROUTER_MODEL: 'global/writer',
    OPENING_DIGEST_MODEL: 'openai/gpt-oss-120b',
  }).openingDigest.model, 'openai/gpt-oss-120b');
});

test('Opening Digest Discord 同步要求官方 webhook，可锁定固定 channel id', () => {
  const base = {
    SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x',
    WECHAT_APP_ID: 'wx', WECHAT_APP_SECRET: 'sec', OPENROUTER_API_KEY: 'or-key',
  };
  assert.throws(() => loadConfig({ ...base, DISCORD_OPENING_DIGEST_ENABLED: 'true' }), /DISCORD_OPENING_DIGEST_WEBHOOK_URL/);
  assert.throws(() => loadConfig({
    ...base,
    DISCORD_OPENING_DIGEST_ENABLED: 'true',
    DISCORD_OPENING_DIGEST_WEBHOOK_URL: 'https://example.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz',
  }), /官方 discord\.com/);
  assert.throws(() => loadConfig({
    ...base,
    DISCORD_OPENING_DIGEST_ENABLED: 'true',
    DISCORD_OPENING_DIGEST_WEBHOOK_URL: 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_1234567890?wait=true',
  }), /官方 discord\.com/);
  const configured = loadConfig({
    ...base,
    DISCORD_OPENING_DIGEST_ENABLED: 'true',
    DISCORD_OPENING_DIGEST_WEBHOOK_URL: 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_1234567890',
    DISCORD_OPENING_DIGEST_CHANNEL_ID: '987654321098765432',
    DISCORD_WEBHOOK_TIMEOUT_MS: '12000',
    DISCORD_WEBHOOK_MAX_ATTEMPTS: '6',
  }).discord;
  assert.equal(configured.openingDigestEnabled, true);
  assert.equal(configured.expectedChannelId, '987654321098765432');
  assert.equal(configured.timeoutMs, 12000);
  assert.equal(configured.maxAttempts, 6);
  assert.doesNotMatch(JSON.stringify(configured), /example\.com/);
});

test('Opening Digest 财报 worker 默认复用 QDII Python 且允许独立覆盖', () => {
  const base = {
    SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x',
    WECHAT_APP_ID: 'wx', WECHAT_APP_SECRET: 'sec', OPENROUTER_API_KEY: 'or-key',
    QDII_PYTHON_PATH: '/release/.venv/bin/python',
  };
  assert.equal(loadConfig(base).openingDigest.earningsPythonPath, '/release/.venv/bin/python');
  const configured = loadConfig({
    ...base,
    OPENING_DIGEST_EARNINGS_PYTHON_PATH: '/custom/python',
    OPENING_DIGEST_EARNINGS_WORKER_PATH: '/custom/worker.py',
    OPENING_DIGEST_EARNINGS_WORKER_TIMEOUT_MS: '22000',
  }).openingDigest;
  assert.equal(configured.earningsPythonPath, '/custom/python');
  assert.equal(configured.earningsWorkerPath, '/custom/worker.py');
  assert.equal(configured.earningsWorkerTimeoutMs, 22000);
});

test('结构化直译抓取、浏览器、PDF、图片、Notion 与 Datalab 配置可由 env 覆盖', () => {
  const c = loadConfig({
    SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x',
    WECHAT_APP_ID: 'wx', WECHAT_APP_SECRET: 'sec',
    OPENROUTER_API_KEY: 'or-key',
    TRANSLATION_BROWSER_ENABLED: 'false',
    TRANSLATION_BROWSER_EXECUTABLE: '/Applications/Chromium',
    TRANSLATION_MAX_PDF_PAGES: '60',
    TRANSLATION_MAX_ASSET_COUNT: '30',
    NOTION_API_TOKEN: 'notion-secret',
    LINEAR_API_KEY: 'lin_api_secret',
    GOOGLE_DOCS_ACCESS_TOKEN: 'google-read-token',
    GOOGLE_DOCS_CLIENT_ID: 'google-client-id',
    GOOGLE_DOCS_CLIENT_SECRET: 'google-client-secret',
    GOOGLE_DOCS_REFRESH_TOKEN: 'google-refresh-token',
    GITHUB_TOKEN: 'github-read-token',
    DATALAB_API_KEY: 'datalab-secret',
    DATALAB_MODE: 'accurate',
  });
  assert.equal(c.translation.browserEnabled, false);
  assert.equal(c.translation.browserExecutablePath, '/Applications/Chromium');
  assert.equal(c.translation.maxPdfPages, 60);
  assert.equal(c.translation.maxAssetCount, 30);
  assert.equal(c.translation.notionApiToken, 'notion-secret');
  assert.equal(c.translation.linearApiKey, 'lin_api_secret');
  assert.equal(c.documents.googleDocsAccessToken, 'google-read-token');
  assert.equal(c.documents.googleDocsClientId, 'google-client-id');
  assert.equal(c.documents.googleDocsClientSecret, 'google-client-secret');
  assert.equal(c.documents.googleDocsRefreshToken, 'google-refresh-token');
  assert.equal(c.documents.githubToken, 'github-read-token');
  assert.equal(c.translation.datalabApiKey, 'datalab-secret');
  assert.equal(c.translation.datalabMode, 'accurate');
});

test('旧公网出口白名单变量不再生成运行时门禁配置', () => {
  const c = loadConfig({
    SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x',
    WECHAT_APP_ID: 'wx', WECHAT_APP_SECRET: 'sec',
    OPENROUTER_API_KEY: 'or-key', EXA_API_KEY: 'exa-key',
    EGRESS_GUARD_ENABLED: 'true', EXPECTED_EGRESS_IP: '203.0.113.8',
    EXPECTED_EGRESS_IPS: '198.51.100.4, 203.0.113.8, 2001:db8::1',
  });
  assert.equal('egress' in c, false);
});

test('OpenRouter 各角色的生成预算与 reasoning 可独立覆盖', () => {
  const c = loadConfig({
    SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x',
    WECHAT_APP_ID: 'wx', WECHAT_APP_SECRET: 'sec',
    OPENROUTER_API_KEY: 'or-key', EXA_API_KEY: 'exa-key',
    OPENROUTER_MAX_TOKENS: '16000', OPENROUTER_REASONING_EFFORT: 'high',
    OPENROUTER_PLANNER_REASONING_EFFORT: 'medium',
    OPENROUTER_REVIEW_REASONING_EFFORT: 'low',
    OPENROUTER_ROUTER_REASONING_EFFORT: 'low',
  });
  assert.equal(c.writer.maxTokens, 16000);
  assert.equal(c.writer.reasoningEffort, 'high');
  assert.equal(c.writer.plannerReasoningEffort, 'medium');
  assert.equal(c.writer.reviewReasoningEffort, 'low');
  assert.equal(c.writer.routerReasoningEffort, 'low');
});

test('期权策略 Fable profile 的模型、reasoning、预算和超时可独立覆盖', () => {
  const base = {
    SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x',
    WECHAT_APP_ID: 'wx', WECHAT_APP_SECRET: 'sec', OPENROUTER_API_KEY: 'or-key',
  };
  const c = loadConfig({
    ...base,
    OPTIONS_STRATEGY_MODEL: 'anthropic/custom-fable',
    OPTIONS_STRATEGY_REASONING_EFFORT: 'xhigh',
    OPTIONS_STRATEGY_MAX_TOKENS: '64000',
    OPTIONS_STRATEGY_TIMEOUT_MS: '1200000',
  });
  assert.equal(c.writer.optionsStrategyModel, 'anthropic/custom-fable');
  assert.equal(c.writer.optionsStrategyReasoningEffort, 'xhigh');
  assert.equal(c.writer.optionsStrategyMaxTokens, 64000);
  assert.equal(c.writer.optionsStrategyTimeoutMs, 1200000);
  assert.throws(
    () => loadConfig({ ...base, OPTIONS_STRATEGY_REASONING_EFFORT: 'none' }),
    /OPTIONS_STRATEGY_REASONING_EFFORT/,
  );
  assert.throws(
    () => loadConfig({ ...base, OPTIONS_STRATEGY_MAX_TOKENS: '0' }),
    /OPTIONS_STRATEGY_MAX_TOKENS/,
  );
});

test('分析 V2 的模型角色、搜索预算、时效窗口和 Slack 编辑防抖可独立配置', () => {
  const c = loadConfig({
    SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x',
    WECHAT_APP_ID: 'wx', WECHAT_APP_SECRET: 'sec',
    OPENROUTER_API_KEY: 'or-key',
    OPENROUTER_MODEL: 'qwen/qwen3.8-max',
    OPENROUTER_ROUTER_MODEL: 'z-ai/glm-5.2',
    OPENROUTER_PLANNER_MODEL: 'moonshotai/kimi-k3',
    OPENROUTER_REVIEW_MODEL: 'z-ai/glm-5.2',
    OPENROUTER_PLANNER_REASONING_EFFORT: 'high',
    ANALYSIS_PIPELINE_VERSION: 'v1',
    ANALYSIS_SEARCH_MAX_QUERIES: '5',
    ANALYSIS_RECENT_WINDOW_DAYS: '60',
    SLACK_EDIT_DEBOUNCE_MS: '2500',
  });
  assert.equal(c.writer.model, 'qwen/qwen3.8-max');
  assert.equal(c.writer.routerModel, 'z-ai/glm-5.2');
  assert.equal(c.writer.plannerModel, 'moonshotai/kimi-k3');
  assert.equal(c.writer.reviewModel, 'z-ai/glm-5.2');
  assert.equal(c.writer.plannerReasoningEffort, 'high');
  assert.equal(c.analysis.pipelineVersion, 'v1');
  assert.equal(c.analysis.searchMaxQueries, 5);
  assert.equal(c.analysis.recentWindowDays, 60);
  assert.equal(c.slack.editDebounceMs, 2500);
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

test('Customer.io newsletter 按 internal/pilot/full 阶段选择 segment 并默认锁住全量', () => {
  const base = {
    SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x',
    WECHAT_APP_ID: 'wx', WECHAT_APP_SECRET: 'sec',
    OPENROUTER_API_KEY: 'or-key', EXA_API_KEY: 'exa-key',
    CUSTOMERIO_INTERNAL_SEGMENT_ID: '17',
    CUSTOMERIO_PILOT_SEGMENT_ID: '18',
    CUSTOMERIO_FULL_SEGMENT_ID: '6',
  };
  const internal = loadConfig(base).customerio;
  assert.equal(internal.audienceStage, 'internal');
  assert.equal(internal.newsletterSegmentId, 17);
  assert.equal(internal.audienceMaxRecipients.internal, 10);
  assert.equal(internal.audienceMaxRecipients.pilot, 50);
  assert.equal(internal.allowFullAudience, false);

  const pilot = loadConfig({ ...base, NEWSLETTER_AUDIENCE_STAGE: 'pilot' }).customerio;
  assert.equal(pilot.newsletterSegmentId, 18);

  const full = loadConfig({
    ...base,
    NEWSLETTER_AUDIENCE_STAGE: 'full',
    CUSTOMERIO_ALLOW_FULL_AUDIENCE: 'true',
  }).customerio;
  assert.equal(full.newsletterSegmentId, 6);
  assert.equal(full.allowFullAudience, true);
});

test('Customer.io newsletter 拒绝未知 audience stage', () => {
  assert.throws(() => loadConfig({
    SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x',
    WECHAT_APP_ID: 'wx', WECHAT_APP_SECRET: 'sec',
    OPENROUTER_API_KEY: 'or-key', EXA_API_KEY: 'exa-key',
    NEWSLETTER_AUDIENCE_STAGE: 'everyone',
  }), /internal、pilot 或 full/);
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

test('EXA key 对配置加载可选,由原创研究工作流在执行时门禁', () => {
  const c = loadConfig({
    SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x',
    WECHAT_APP_ID: 'wx', WECHAT_APP_SECRET: 'sec',
    OPENROUTER_API_KEY: 'or-key',
  });
  assert.equal(c.writer.exaApiKey, '');
});

test('危险数字配置在启动时 fail-fast', () => {
  const base = {
    SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x',
    WECHAT_APP_ID: 'wx', WECHAT_APP_SECRET: 'sec',
    OPENROUTER_API_KEY: 'or-key',
  };
  assert.throws(() => loadConfig({ ...base, MAX_CONCURRENCY: '0' }), /MAX_CONCURRENCY 必须是正整数/);
  assert.throws(() => loadConfig({ ...base, DEFAULT_TIMEOUT_MS: 'NaN' }), /DEFAULT_TIMEOUT_MS 必须是正数/);
  assert.throws(() => loadConfig({ ...base, TRANSLATION_MAX_REDIRECTS: '-1' }), /TRANSLATION_MAX_REDIRECTS 必须是非负整数/);
  assert.throws(() => loadConfig({ ...base, TRANSLATION_MAX_PDF_PAGES: '0' }), /TRANSLATION_MAX_PDF_PAGES 必须是正整数/);
  assert.throws(() => loadConfig({ ...base, HEALTH_PORT: '70000' }), /HEALTH_PORT 必须在 0 到 65535 之间/);
});

test('生产环境强制 Slack 用户和频道允许名单', () => {
  const base = {
    NODE_ENV: 'production',
    SLACK_BOT_TOKEN: 'xoxb-x', SLACK_APP_TOKEN: 'xapp-x',
    WECHAT_APP_ID: 'wx', WECHAT_APP_SECRET: 'sec',
    OPENROUTER_API_KEY: 'or-key',
  };
  assert.throws(() => loadConfig(base), /SLACK_ALLOWED_USER_IDS/);
  assert.throws(() => loadConfig({ ...base, SLACK_ALLOWED_USER_IDS: 'U1' }), /SLACK_ALLOWED_CHANNEL_IDS/);
  assert.doesNotThrow(() => loadConfig({
    ...base,
    SLACK_ALLOWED_USER_IDS: 'U1',
    SLACK_ALLOWED_CHANNEL_IDS: 'C1',
  }));
});
