import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根目录:src/config/index.js 上两级。用于解析 assets/ 下固定图的默认绝对路径,
// 不依赖 process.cwd()(启动目录可能不是仓库根)。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadEgressConfig(env = process.env) {
  const expectedIp = String(env.EXPECTED_EGRESS_IP || '').trim();
  const expectedIps = [...new Set([
    expectedIp,
    ...String(env.EXPECTED_EGRESS_IPS || '').split(',').map((value) => value.trim()),
  ].filter(Boolean))];
  return {
    enabled: booleanFlag(env.EGRESS_GUARD_ENABLED),
    // EXPECTED_EGRESS_IP 保留向后兼容；EXPECTED_EGRESS_IPS 用于追加多个允许出口。
    expectedIp,
    expectedIps,
    checkUrl: env.EGRESS_CHECK_URL || 'https://www.cloudflare.com/cdn-cgi/trace',
    timeoutMs: Number(env.EGRESS_CHECK_TIMEOUT_MS || 8000),
    retryMs: Number(env.EGRESS_RETRY_MS || 10000),
    monitorIntervalMs: Number(env.EGRESS_MONITOR_INTERVAL_MS || 30000),
    monitorFailureThreshold: Number(env.EGRESS_MONITOR_FAILURE_THRESHOLD || 2),
  };
}

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
  return {
    workDir: env.WORK_DIR || '/srv/zen/wechat',
    dbPath: env.DB_PATH || `${env.HOME || '.'}/zen-content-hub/runs.db`,
    maxConcurrency: Number(env.MAX_CONCURRENCY || 1),
    defaultTimeoutMs: Number(env.DEFAULT_TIMEOUT_MS || 10 * 60 * 1000),
    egress: loadEgressConfig(env),
    writer: {
      openrouterApiKey: need('OPENROUTER_API_KEY'),
      model: env.OPENROUTER_MODEL || 'qwen/qwen3-235b-a22b',
      routerModel: env.OPENROUTER_ROUTER_MODEL || env.OPENROUTER_MODEL || 'qwen/qwen3-235b-a22b',
      reviewModel: env.OPENROUTER_REVIEW_MODEL || env.OPENROUTER_MODEL || 'qwen/qwen3-235b-a22b',
      baseUrl: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      maxTokens: Number(env.OPENROUTER_MAX_TOKENS || 12000),
      reasoningEffort: env.OPENROUTER_REASONING_EFFORT || 'none',
      // 直译只需要原始链接/PDF 与 OpenRouter；Exa 仅由原创研究链要求。
      exaApiKey: env.EXA_API_KEY || '',
      exaBaseUrl: env.EXA_BASE_URL || 'https://api.exa.ai',
      exaNumResults: Number(env.EXA_NUM_RESULTS || 5),
      exaPriorityResults: Number(env.EXA_PRIORITY_RESULTS || 4),
      exaUserContentMaxChars: Number(env.EXA_USER_CONTENT_MAX_CHARS || 24000),
      exaTimeoutMs: Number(env.EXA_TIMEOUT_MS || 45000),
      temperature: env.OPENROUTER_TEMPERATURE === undefined ? 0.4 : Number(env.OPENROUTER_TEMPERATURE),
      httpReferer: env.OPENROUTER_HTTP_REFERER || 'https://zentradings.com',
      appTitle: env.OPENROUTER_APP_TITLE || 'Zen Content Hub',
    },
    translation: {
      // V2 先通过 dry-run 与人工复核渐进启用；关闭时完整保留既有直译引擎。
      v2Enabled: booleanFlag(env.TRANSLATION_V2_ENABLED),
      browserEnabled: env.TRANSLATION_BROWSER_ENABLED === undefined
        ? true
        : booleanFlag(env.TRANSLATION_BROWSER_ENABLED),
      browserExecutablePath: env.TRANSLATION_BROWSER_EXECUTABLE
        || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      browserTimeoutMs: Number(env.TRANSLATION_BROWSER_TIMEOUT_MS || 45000),
      fetchTimeoutMs: Number(env.TRANSLATION_FETCH_TIMEOUT_MS || 30000),
      maxSourceBytes: Number(env.TRANSLATION_MAX_SOURCE_BYTES || 12 * 1024 * 1024),
      maxAssetBytes: Number(env.TRANSLATION_MAX_ASSET_BYTES || 20 * 1024 * 1024),
      maxAssets: Number(env.TRANSLATION_MAX_ASSETS || 80),
      maxRedirects: Number(env.TRANSLATION_MAX_REDIRECTS || 5),
      notionApiToken: env.NOTION_API_TOKEN || '',
      doclingPath: env.TRANSLATION_DOCLING_PATH || '',
      doclingTimeoutMs: Number(env.TRANSLATION_DOCLING_TIMEOUT_MS || 180000),
      remoteFallback: env.TRANSLATION_REMOTE_FALLBACK || 'none',
    },
    slack: {
      botToken: need('SLACK_BOT_TOKEN'),
      appToken: need('SLACK_APP_TOKEN'),
      notifyChannel: env.NOTIFY_CHANNEL_ID || '',
    },
    wechat: { appId: need('WECHAT_APP_ID'), appSecret: need('WECHAT_APP_SECRET') },
    customerio: {
      appApiKey: env.CUSTOMERIO_APP_API_KEY || '',
      baseUrl: env.CUSTOMERIO_API_BASE_URL || 'https://api.customer.io',
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
      companyAddress: env.CUSTOMERIO_COMPANY_ADDRESS || '',
    },
    assets: {
      headerImage: env.WECHAT_HEADER_IMAGE || path.join(REPO_ROOT, 'assets', 'zen-header-banner.gif'),
      footerImage: env.WECHAT_FOOTER_IMAGE || path.join(REPO_ROOT, 'assets', 'zen-footer-qr.png'),
    },
  };
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function newsletterAudienceStage(value) {
  const stage = String(value || 'internal').trim().toLowerCase();
  if (!['internal', 'pilot', 'full'].includes(stage)) {
    throw new Error('NEWSLETTER_AUDIENCE_STAGE 必须是 internal、pilot 或 full');
  }
  return stage;
}

function booleanFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}
