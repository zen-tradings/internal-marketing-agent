import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根目录:src/config/index.js 上两级。用于解析 assets/ 下固定图的默认绝对路径,
// 不依赖 process.cwd()(启动目录可能不是仓库根)。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadConfig(env = process.env) {
  const need = (k) => {
    const v = env[k];
    if (!v) throw new Error(`缺少环境变量 ${k}`);
    return v;
  };
  return {
    workDir: env.WORK_DIR || '/srv/zen/wechat',
    dbPath: env.DB_PATH || `${env.HOME || '.'}/zen-content-hub/runs.db`,
    maxConcurrency: Number(env.MAX_CONCURRENCY || 1),
    defaultTimeoutMs: Number(env.DEFAULT_TIMEOUT_MS || 10 * 60 * 1000),
    writer: {
      openrouterApiKey: need('OPENROUTER_API_KEY'),
      model: env.OPENROUTER_MODEL || 'qwen/qwen3-235b-a22b',
      baseUrl: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      exaApiKey: need('EXA_API_KEY'),
      exaBaseUrl: env.EXA_BASE_URL || 'https://api.exa.ai',
      exaNumResults: Number(env.EXA_NUM_RESULTS || 5),
      exaPriorityResults: Number(env.EXA_PRIORITY_RESULTS || 4),
      exaUserContentMaxChars: Number(env.EXA_USER_CONTENT_MAX_CHARS || 24000),
      temperature: env.OPENROUTER_TEMPERATURE === undefined ? 0.4 : Number(env.OPENROUTER_TEMPERATURE),
      httpReferer: env.OPENROUTER_HTTP_REFERER || 'https://zentradings.com',
      appTitle: env.OPENROUTER_APP_TITLE || 'Zen Content Hub',
    },
    slack: {
      botToken: need('SLACK_BOT_TOKEN'),
      appToken: need('SLACK_APP_TOKEN'),
      notifyChannel: env.NOTIFY_CHANNEL_ID || '',
    },
    wechat: { appId: need('WECHAT_APP_ID'), appSecret: need('WECHAT_APP_SECRET') },
    assets: {
      headerImage: env.WECHAT_HEADER_IMAGE || path.join(REPO_ROOT, 'assets', 'zen-header-banner.gif'),
      footerImage: env.WECHAT_FOOTER_IMAGE || path.join(REPO_ROOT, 'assets', 'zen-footer-qr.png'),
    },
  };
}
