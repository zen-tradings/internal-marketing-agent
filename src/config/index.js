import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Repository root: two levels above src/config/index.js. Resolve default absolute fixed-image paths from assets/
// without depending on process.cwd(), which may not be the repository root.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadConfig(env = process.env) {
  const need = (k) => {
    const v = env[k];
    if (!v) throw new Error(`缺少环境变量 ${k}`);
    return v;
  };
  const customerioAudienceStage = newsletterAudienceStage(env.NEWSLETTER_AUDIENCE_STAGE);
  const legacyNewsletterSegmentId = positiveInteger(env.CUSTOMERIO_NEWSLETTER_SEGMENT_ID);
  const customerioAudienceSegmentIds = {
    internal: positiveInteger(env.CUSTOMERIO_INTERNAL_SEGMENT_ID) || legacyNewsletterSegmentId,
    pilot: positiveInteger(env.CUSTOMERIO_PILOT_SEGMENT_ID),
    full: positiveInteger(env.CUSTOMERIO_FULL_SEGMENT_ID),
  };
  const slackAllowedUserIds = csvValues(env.SLACK_ALLOWED_USER_IDS);
  const slackAllowedChannelIds = csvValues(env.SLACK_ALLOWED_CHANNEL_IDS);
  const production = String(env.NODE_ENV || '').toLowerCase() === 'production';
  const maxConcurrency = positiveIntegerOrThrow(env.MAX_CONCURRENCY, 1, 'MAX_CONCURRENCY');
  const resources = {
    browserConcurrency: positiveIntegerOrThrow(env.BROWSER_CONCURRENCY, 1, 'BROWSER_CONCURRENCY'),
    wechatWriteConcurrency: positiveIntegerOrThrow(env.WECHAT_WRITE_CONCURRENCY, 1, 'WECHAT_WRITE_CONCURRENCY'),
    customerioWriteConcurrency: positiveIntegerOrThrow(env.CUSTOMERIO_WRITE_CONCURRENCY, 1, 'CUSTOMERIO_WRITE_CONCURRENCY'),
    openrouterConcurrency: positiveIntegerOrThrow(env.OPENROUTER_CONCURRENCY, 2, 'OPENROUTER_CONCURRENCY'),
    exaSearchQps: positiveNumber(env.EXA_SEARCH_QPS, 8, 'EXA_SEARCH_QPS'),
  };
  const slackPostIntervalMs = positiveNumber(env.SLACK_POST_INTERVAL_MS, 1000, 'SLACK_POST_INTERVAL_MS');
  const discordOpeningDigestEnabled = booleanFlag(env.DISCORD_OPENING_DIGEST_ENABLED);
  const discordWebhookUrl = validatedDiscordWebhookUrl(env.DISCORD_OPENING_DIGEST_WEBHOOK_URL);
  if (discordOpeningDigestEnabled && !discordWebhookUrl) {
    throw new Error('DISCORD_OPENING_DIGEST_ENABLED=true 时必须配置 DISCORD_OPENING_DIGEST_WEBHOOK_URL');
  }
  const workDir = env.WORK_DIR || '/srv/zen/wechat';
  const dbPath = env.DB_PATH || path.resolve(env.HOME || '.', 'zen-content-hub', 'runs.db');
  if (production) {
    if (!slackAllowedUserIds.length) throw new Error('生产环境必须配置 SLACK_ALLOWED_USER_IDS');
    if (!slackAllowedChannelIds.length) throw new Error('生产环境必须配置 SLACK_ALLOWED_CHANNEL_IDS');
    if (maxConcurrency > 2) throw new Error('生产环境 MAX_CONCURRENCY 只能为 1 或 2');
    if (resources.browserConcurrency !== 1) throw new Error('生产环境 BROWSER_CONCURRENCY 必须为 1');
    if (resources.wechatWriteConcurrency !== 1) throw new Error('生产环境 WECHAT_WRITE_CONCURRENCY 必须为 1');
    if (resources.customerioWriteConcurrency !== 1) throw new Error('生产环境 CUSTOMERIO_WRITE_CONCURRENCY 必须为 1');
    if (resources.openrouterConcurrency > 2) throw new Error('生产环境 OPENROUTER_CONCURRENCY 不得超过 2');
    if (positiveIntegerOrThrow(env.TRANSLATION_BATCH_CONCURRENCY, 2, 'TRANSLATION_BATCH_CONCURRENCY') > 2) {
      throw new Error('生产环境 TRANSLATION_BATCH_CONCURRENCY 不得超过 2');
    }
    if (resources.exaSearchQps > 8) throw new Error('生产环境 EXA_SEARCH_QPS 不得超过 8');
    if (slackPostIntervalMs < 1000) throw new Error('生产环境 SLACK_POST_INTERVAL_MS 不得小于 1000');
    if (!path.isAbsolute(workDir)) throw new Error('生产环境 WORK_DIR 必须是绝对路径');
    if (!path.isAbsolute(dbPath)) throw new Error('生产环境 DB_PATH 必须是绝对路径');
  }
  return {
    workDir,
    dbPath,
    maxConcurrency,
    maxQueueSize: positiveIntegerOrThrow(env.MAX_QUEUE_SIZE, 100, 'MAX_QUEUE_SIZE'),
    resources,
    defaultTimeoutMs: positiveNumber(env.DEFAULT_TIMEOUT_MS, 10 * 60 * 1000, 'DEFAULT_TIMEOUT_MS'),
    runRetentionDays: positiveIntegerOrThrow(env.RUN_RETENTION_DAYS, 90, 'RUN_RETENTION_DAYS'),
    slackThreadRetentionDays: positiveIntegerOrThrow(env.SLACK_THREAD_RETENTION_DAYS, 30, 'SLACK_THREAD_RETENTION_DAYS'),
    cronTimezone: env.CRON_TIMEZONE || 'America/Los_Angeles',
    health: {
      host: env.HEALTH_HOST || '127.0.0.1',
      port: portNumber(env.HEALTH_PORT, 0, 'HEALTH_PORT'),
    },
    writer: {
      openrouterApiKey: need('OPENROUTER_API_KEY'),
      model: env.OPENROUTER_MODEL || 'qwen/qwen3.8-max',
      routerModel: env.OPENROUTER_ROUTER_MODEL || env.OPENROUTER_MODEL || 'qwen/qwen3.8-max',
      plannerModel: env.OPENROUTER_PLANNER_MODEL || env.OPENROUTER_MODEL || 'qwen/qwen3.8-max',
      reviewModel: env.OPENROUTER_REVIEW_MODEL || env.OPENROUTER_MODEL || 'qwen/qwen3.8-max',
      optionsStrategyModel: env.OPTIONS_STRATEGY_MODEL || 'anthropic/claude-fable-5',
      baseUrl: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      maxTokens: positiveIntegerOrThrow(env.OPENROUTER_MAX_TOKENS, 12000, 'OPENROUTER_MAX_TOKENS'),
      maxPromptChars: positiveIntegerOrThrow(env.OPENROUTER_MAX_PROMPT_CHARS, 160000, 'OPENROUTER_MAX_PROMPT_CHARS'),
      coverTimeoutMs: positiveNumber(env.COVER_REQUEST_TIMEOUT_MS, 30000, 'COVER_REQUEST_TIMEOUT_MS'),
      coverProcessTimeoutMs: positiveNumber(env.COVER_PROCESS_TIMEOUT_MS, 90000, 'COVER_PROCESS_TIMEOUT_MS'),
      reasoningEffort: env.OPENROUTER_REASONING_EFFORT || 'high',
      plannerReasoningEffort: env.OPENROUTER_PLANNER_REASONING_EFFORT || 'none',
      reviewReasoningEffort: env.OPENROUTER_REVIEW_REASONING_EFFORT || 'none',
      routerReasoningEffort: env.OPENROUTER_ROUTER_REASONING_EFFORT || 'none',
      optionsStrategyReasoningEffort: reasoningEffort(
        env.OPTIONS_STRATEGY_REASONING_EFFORT,
        'high',
        'OPTIONS_STRATEGY_REASONING_EFFORT',
      ),
      optionsStrategyMaxTokens: positiveIntegerOrThrow(
        env.OPTIONS_STRATEGY_MAX_TOKENS,
        32000,
        'OPTIONS_STRATEGY_MAX_TOKENS',
      ),
      optionsStrategyTimeoutMs: positiveNumber(
        env.OPTIONS_STRATEGY_TIMEOUT_MS,
        15 * 60 * 1000,
        'OPTIONS_STRATEGY_TIMEOUT_MS',
      ),
      // Translation needs only the original link/PDF and OpenRouter; Exa is required only by original research.
      exaApiKey: env.EXA_API_KEY || '',
      exaBaseUrl: env.EXA_BASE_URL || 'https://api.exa.ai',
      exaNumResults: positiveIntegerOrThrow(env.EXA_NUM_RESULTS, 5, 'EXA_NUM_RESULTS'),
      exaPriorityResults: positiveIntegerOrThrow(env.EXA_PRIORITY_RESULTS, 4, 'EXA_PRIORITY_RESULTS'),
      exaUserContentMaxChars: positiveIntegerOrThrow(env.EXA_USER_CONTENT_MAX_CHARS, 24000, 'EXA_USER_CONTENT_MAX_CHARS'),
      exaTimeoutMs: positiveNumber(env.EXA_TIMEOUT_MS, 45000, 'EXA_TIMEOUT_MS'),
      temperature: finiteNumber(env.OPENROUTER_TEMPERATURE, 0.4, 'OPENROUTER_TEMPERATURE'),
      httpReferer: env.OPENROUTER_HTTP_REFERER || 'https://zentradings.com',
      appTitle: env.OPENROUTER_APP_TITLE || 'Zen Content Hub',
    },
    analysis: {
      pipelineVersion: analysisPipelineVersion(env.ANALYSIS_PIPELINE_VERSION),
      searchMaxQueries: positiveIntegerOrThrow(env.ANALYSIS_SEARCH_MAX_QUERIES, 8, 'ANALYSIS_SEARCH_MAX_QUERIES'),
      recentWindowDays: positiveIntegerOrThrow(env.ANALYSIS_RECENT_WINDOW_DAYS, 60, 'ANALYSIS_RECENT_WINDOW_DAYS'),
    },
    workflowEnvironment: {
      channel: workflowChannel(env.WECHAT_CHANNEL),
      morningCron: String(env.MORNING_CRON || '').trim(),
      newsletterEdition: newsletterEdition(env.NEWSLETTER_EDITION),
      priorityDomains: domainValues(env.EXA_PRIORITY_DOMAINS, 'EXA_PRIORITY_DOMAINS'),
      priorityDomainsOverride: Boolean(String(env.EXA_PRIORITY_DOMAINS || '').trim()),
      officialDomains: domainValues(env.EXA_OFFICIAL_DOMAINS, 'EXA_OFFICIAL_DOMAINS'),
      officialDomainsOverride: Boolean(String(env.EXA_OFFICIAL_DOMAINS || '').trim()),
      excludedMediaDomains: domainValues(env.EXA_EXCLUDED_MEDIA_DOMAINS, 'EXA_EXCLUDED_MEDIA_DOMAINS'),
      independentMediaDomains: domainValues(env.EXA_INDEPENDENT_MEDIA_DOMAINS, 'EXA_INDEPENDENT_MEDIA_DOMAINS'),
    },
    qdii: {
      enabled: booleanFlag(env.QDII_ENABLED),
      pythonPath: env.QDII_PYTHON_PATH || 'python3',
      workerPath: env.QDII_WORKER_PATH || path.join(REPO_ROOT, 'python', 'qdii_worker.py'),
      workerTimeoutMs: positiveNumber(env.QDII_WORKER_TIMEOUT_MS, 120000, 'QDII_WORKER_TIMEOUT_MS'),
      maxFundsSlack: positiveIntegerOrThrow(env.QDII_MAX_FUNDS_SLACK, 20, 'QDII_MAX_FUNDS_SLACK'),
      maxFundsDraft: positiveIntegerOrThrow(env.QDII_MAX_FUNDS_DRAFT, 8, 'QDII_MAX_FUNDS_DRAFT'),
      staleMaxDays: positiveIntegerOrThrow(env.QDII_STALE_MAX_DAYS, 366, 'QDII_STALE_MAX_DAYS'),
      maxReportBytes: positiveIntegerOrThrow(env.QDII_MAX_REPORT_BYTES, 30 * 1024 * 1024, 'QDII_MAX_REPORT_BYTES'),
      maxTaskDownloadBytes: positiveIntegerOrThrow(env.QDII_MAX_TASK_DOWNLOAD_BYTES, 150 * 1024 * 1024, 'QDII_MAX_TASK_DOWNLOAD_BYTES'),
      maxReportCandidates: positiveIntegerOrThrow(env.QDII_MAX_REPORT_CANDIDATES, 3, 'QDII_MAX_REPORT_CANDIDATES'),
    },
    translation: {
      // Translation prefers structured HTML from the source; Datalab parses PDFs before returning to the same pipeline.
      // It has an independent quality-gated inference role and can consume both globally-governed OpenRouter slots.
      model: env.OPENROUTER_TRANSLATION_MODEL || env.OPENROUTER_MODEL || 'qwen/qwen3.8-max',
      reasoningEffort: env.OPENROUTER_TRANSLATION_REASONING_EFFORT || 'high',
      batchConcurrency: positiveIntegerOrThrow(
        env.TRANSLATION_BATCH_CONCURRENCY,
        2,
        'TRANSLATION_BATCH_CONCURRENCY',
      ),
      browserEnabled: env.TRANSLATION_BROWSER_ENABLED === undefined
        ? true
        : booleanFlag(env.TRANSLATION_BROWSER_ENABLED),
      browserExecutablePath: env.TRANSLATION_BROWSER_EXECUTABLE
        || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      browserTimeoutMs: positiveNumber(env.TRANSLATION_BROWSER_TIMEOUT_MS, 45000, 'TRANSLATION_BROWSER_TIMEOUT_MS'),
      fetchTimeoutMs: positiveNumber(env.TRANSLATION_FETCH_TIMEOUT_MS, 30000, 'TRANSLATION_FETCH_TIMEOUT_MS'),
      maxSourceBytes: positiveIntegerOrThrow(env.TRANSLATION_MAX_SOURCE_BYTES, 50 * 1024 * 1024, 'TRANSLATION_MAX_SOURCE_BYTES'),
      maxPdfPages: positiveIntegerOrThrow(env.TRANSLATION_MAX_PDF_PAGES, 120, 'TRANSLATION_MAX_PDF_PAGES'),
      maxRedirects: nonNegativeInteger(env.TRANSLATION_MAX_REDIRECTS, 5, 'TRANSLATION_MAX_REDIRECTS'),
      maxAssetCount: positiveIntegerOrThrow(env.TRANSLATION_MAX_ASSET_COUNT, 80, 'TRANSLATION_MAX_ASSET_COUNT'),
      maxAssetBytes: positiveIntegerOrThrow(env.TRANSLATION_MAX_ASSET_BYTES, 40 * 1024 * 1024, 'TRANSLATION_MAX_ASSET_BYTES'),
      maxSingleAssetBytes: positiveIntegerOrThrow(env.TRANSLATION_MAX_SINGLE_ASSET_BYTES, 10 * 1024 * 1024, 'TRANSLATION_MAX_SINGLE_ASSET_BYTES'),
      notionApiToken: env.NOTION_API_TOKEN || '',
      linearApiKey: env.LINEAR_API_KEY || '',
      datalabApiKey: env.DATALAB_API_KEY || '',
      datalabBaseUrl: env.DATALAB_API_BASE_URL || 'https://www.datalab.to/api/v1',
      datalabMode: translationMode(env.DATALAB_MODE),
      datalabTimeoutMs: positiveNumber(env.DATALAB_TIMEOUT_MS, 5 * 60 * 1000, 'DATALAB_TIMEOUT_MS'),
      datalabPollIntervalMs: positiveNumber(env.DATALAB_POLL_INTERVAL_MS, 2000, 'DATALAB_POLL_INTERVAL_MS'),
    },
    slack: {
      botToken: need('SLACK_BOT_TOKEN'),
      appToken: need('SLACK_APP_TOKEN'),
      notifyChannel: env.NOTIFY_CHANNEL_ID || '',
      allowedUserIds: slackAllowedUserIds,
      allowedChannelIds: slackAllowedChannelIds,
      rateLimitPerMinute: positiveIntegerOrThrow(env.SLACK_RATE_LIMIT_PER_MINUTE, 10, 'SLACK_RATE_LIMIT_PER_MINUTE'),
      editDebounceMs: nonNegativeInteger(env.SLACK_EDIT_DEBOUNCE_MS, 5000, 'SLACK_EDIT_DEBOUNCE_MS'),
      postIntervalMs: slackPostIntervalMs,
    },
    discord: {
      openingDigestEnabled: discordOpeningDigestEnabled,
      webhookUrl: discordWebhookUrl,
      expectedChannelId: discordSnowflake(env.DISCORD_OPENING_DIGEST_CHANNEL_ID, 'DISCORD_OPENING_DIGEST_CHANNEL_ID'),
      timeoutMs: positiveNumber(env.DISCORD_WEBHOOK_TIMEOUT_MS, 30000, 'DISCORD_WEBHOOK_TIMEOUT_MS'),
      maxAttempts: positiveIntegerOrThrow(env.DISCORD_WEBHOOK_MAX_ATTEMPTS, 8, 'DISCORD_WEBHOOK_MAX_ATTEMPTS'),
    },
    documents: {
      googleDocsAccessToken: env.GOOGLE_DOCS_ACCESS_TOKEN || '',
      googleDocsClientId: env.GOOGLE_DOCS_CLIENT_ID || '',
      googleDocsClientSecret: env.GOOGLE_DOCS_CLIENT_SECRET || '',
      googleDocsRefreshToken: env.GOOGLE_DOCS_REFRESH_TOKEN || '',
      githubToken: env.GITHUB_TOKEN || '',
    },
    wechat: {
      appId: need('WECHAT_APP_ID'),
      appSecret: need('WECHAT_APP_SECRET'),
      timeoutMs: positiveNumber(env.WECHAT_TIMEOUT_MS, 30000, 'WECHAT_TIMEOUT_MS'),
    },
    customerio: {
      appApiKey: env.CUSTOMERIO_APP_API_KEY || '',
      baseUrl: env.CUSTOMERIO_API_BASE_URL || 'https://api.customer.io',
      timeoutMs: positiveNumber(env.CUSTOMERIO_TIMEOUT_MS, 30000, 'CUSTOMERIO_TIMEOUT_MS'),
      audienceStage: customerioAudienceStage,
      audienceSegmentIds: customerioAudienceSegmentIds,
      audienceMaxRecipients: {
        internal: positiveInteger(env.CUSTOMERIO_INTERNAL_MAX_RECIPIENTS) || 10,
        pilot: positiveInteger(env.CUSTOMERIO_PILOT_MAX_RECIPIENTS) || 50,
        full: positiveInteger(env.CUSTOMERIO_FULL_MAX_RECIPIENTS),
      },
      allowFullAudience: booleanFlag(env.CUSTOMERIO_ALLOW_FULL_AUDIENCE),
      newsletterSegmentId: customerioAudienceSegmentIds[customerioAudienceStage],
      subscriptionTopicId: positiveInteger(env.CUSTOMERIO_SUBSCRIPTION_TOPIC_ID),
      from: env.CUSTOMERIO_NEWSLETTER_FROM || 'Zen Trading <support@zentradings.com>',
      edition: env.NEWSLETTER_EDITION || 'Vol. 1',
      siteUrl: env.CUSTOMERIO_SITE_URL || 'https://zentradings.com',
      feedbackUrl: env.CUSTOMERIO_NEWSLETTER_FEEDBACK_URL || '',
      headerImageUrl: env.CUSTOMERIO_NEWSLETTER_HEADER_IMAGE_URL || '',
      contactEmail: env.CUSTOMERIO_NEWSLETTER_CONTACT_EMAIL || '',
    },
    openingDigest: {
      enabled: booleanFlag(env.OPENING_DIGEST_ENABLED),
      wechatEnabled: booleanFlag(env.OPENING_DIGEST_WECHAT_ENABLED),
      model: env.OPENING_DIGEST_MODEL || env.OPENROUTER_MODEL || 'qwen/qwen3.8-max',
      timezone: env.OPENING_DIGEST_TIMEZONE || 'America/New_York',
      earningsPythonPath: env.OPENING_DIGEST_EARNINGS_PYTHON_PATH || env.QDII_PYTHON_PATH || 'python3',
      earningsWorkerPath: env.OPENING_DIGEST_EARNINGS_WORKER_PATH
        || path.join(REPO_ROOT, 'python', 'opening_digest_worker.py'),
      earningsWorkerTimeoutMs: positiveNumber(
        env.OPENING_DIGEST_EARNINGS_WORKER_TIMEOUT_MS,
        15000,
        'OPENING_DIGEST_EARNINGS_WORKER_TIMEOUT_MS',
      ),
      optionsUrl: env.OIC_TRENDING_OPTIONS_URL
        || 'https://www.optionseducation.org/toolsoptionquotes/trending-options-volume',
      storageStatePath: env.OIC_STORAGE_STATE_PATH || '/etc/zen-content-hub/oic-storage-state.json',
      captureTimeoutMs: positiveNumber(env.OIC_CAPTURE_TIMEOUT_MS, 45000, 'OIC_CAPTURE_TIMEOUT_MS'),
      automationAuthorized: booleanFlag(env.OIC_AUTOMATION_AUTHORIZED),
      segmentId: positiveInteger(env.CUSTOMERIO_OPENING_DIGEST_SEGMENT_ID),
      subscriptionTopicId: positiveInteger(env.CUSTOMERIO_OPENING_DIGEST_TOPIC_ID),
      assetFolderId: positiveInteger(env.CUSTOMERIO_OPENING_DIGEST_ASSET_FOLDER_ID),
      browserExecutablePath: env.OPENING_DIGEST_BROWSER_EXECUTABLE
        || env.TRANSLATION_BROWSER_EXECUTABLE
        || '/usr/bin/google-chrome',
    },
    assets: {
      headerImage: env.WECHAT_HEADER_IMAGE || path.join(REPO_ROOT, 'assets', 'zen-header-banner.gif'),
      surveyImage: env.WECHAT_SURVEY_IMAGE || path.join(REPO_ROOT, 'assets', 'zen-survey-qr.jpg'),
      footerImage: env.WECHAT_FOOTER_IMAGE || path.join(REPO_ROOT, 'assets', 'zen-footer-qr.png'),
    },
    cover: {
      generatorDir: env.COVER_GENERATOR_DIR
        || path.join(REPO_ROOT, 'tools', 'cover-generator'),
    },
    infographic: {
      // Writing tasks generate infographics from article content; the channel skips translation regardless of this flag.
      enabled: env.INFOGRAPHIC_ENABLED === undefined
        ? true
        : booleanFlag(env.INFOGRAPHIC_ENABLED),
      maxImages: positiveIntegerOrThrow(env.INFOGRAPHIC_MAX_IMAGES, 2, 'INFOGRAPHIC_MAX_IMAGES'),
      timeoutMs: positiveNumber(env.INFOGRAPHIC_TIMEOUT_MS, 45000, 'INFOGRAPHIC_TIMEOUT_MS'),
      processTimeoutMs: positiveNumber(env.INFOGRAPHIC_PROCESS_TIMEOUT_MS, 90000, 'INFOGRAPHIC_PROCESS_TIMEOUT_MS'),
      generatorDir: env.INFOGRAPHIC_GENERATOR_DIR
        || path.join(REPO_ROOT, 'tools', 'infographic-generator'),
    },
  };
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function validatedDiscordWebhookUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let url;
  try { url = new URL(text); }
  catch { throw new Error('DISCORD_OPENING_DIGEST_WEBHOOK_URL 无效'); }
  const pathOk = /^\/api(?:\/v\d+)?\/webhooks\/\d{16,22}\/[A-Za-z0-9._-]{20,}$/.test(url.pathname);
  if (url.protocol !== 'https:' || url.hostname !== 'discord.com' || !pathOk || url.username || url.password || url.search || url.hash) {
    throw new Error('DISCORD_OPENING_DIGEST_WEBHOOK_URL 必须是官方 discord.com HTTPS webhook 地址');
  }
  return url.toString();
}

function discordSnowflake(value, label) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (!/^\d{16,22}$/.test(text)) throw new Error(`${label} 必须是 Discord channel snowflake`);
  return text;
}

function positiveIntegerOrThrow(value, fallback, label) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} 必须是正整数`);
  return parsed;
}

function nonNegativeInteger(value, fallback, label) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} 必须是非负整数`);
  return parsed;
}

function portNumber(value, fallback, label) {
  const parsed = nonNegativeInteger(value, fallback, label);
  if (parsed > 65535) throw new Error(`${label} 必须在 0 到 65535 之间`);
  return parsed;
}

function positiveNumber(value, fallback, label) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} 必须是正数`);
  return parsed;
}

function finiteNumber(value, fallback, label) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} 必须是有限数字`);
  return parsed;
}

function csvValues(value) {
  return [...new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean))];
}

function newsletterAudienceStage(value) {
  const stage = String(value || 'internal').trim().toLowerCase();
  if (!['internal', 'pilot', 'full'].includes(stage)) {
    throw new Error('NEWSLETTER_AUDIENCE_STAGE 必须是 internal、pilot 或 full');
  }
  return stage;
}

function workflowChannel(value) {
  const channel = String(value || 'wechat-draft').trim();
  if (!['wechat-draft', 'mock'].includes(channel)) throw new Error('WECHAT_CHANNEL 必须是 wechat-draft 或 mock');
  return channel;
}

function newsletterEdition(value) {
  const edition = String(value || 'Vol. 1').trim();
  if (!edition || edition.length > 80) throw new Error('NEWSLETTER_EDITION 必须是 1-80 字符');
  return edition;
}

function domainValues(value, label) {
  const values = csvValues(value);
  for (const domain of values) {
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) {
      throw new Error(`${label} 包含无效域名:${domain}`);
    }
  }
  return values.map((domain) => domain.toLowerCase());
}

function booleanFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function translationMode(value) {
  const mode = String(value || 'balanced').trim().toLowerCase();
  if (!['fast', 'balanced', 'accurate'].includes(mode)) {
    throw new Error('DATALAB_MODE 必须是 fast、balanced 或 accurate');
  }
  return mode;
}

function analysisPipelineVersion(value) {
  const version = String(value || 'v2').trim().toLowerCase();
  if (!['v1', 'v2'].includes(version)) {
    throw new Error('ANALYSIS_PIPELINE_VERSION 必须是 v1 或 v2');
  }
  return version;
}

function reasoningEffort(value, fallback, label) {
  const effort = String(value || fallback).trim().toLowerCase();
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    throw new Error(`${label} 必须是 low、medium、high、xhigh 或 max`);
  }
  return effort;
}
