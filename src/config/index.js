export function loadConfig(env = process.env) {
  const need = (k) => {
    const v = env[k];
    if (!v) throw new Error(`缺少环境变量 ${k}`);
    return v;
  };
  return {
    workDir: env.WORK_DIR || '/srv/zen/wechat',
    dbPath: env.DB_PATH || `${env.HOME || '.'}/zen-content-hub/runs.db`,
    claudeBin: env.CLAUDE_BIN || '/Users/clarachen/.local/bin/claude',
    maxConcurrency: Number(env.MAX_CONCURRENCY || 1),
    defaultTimeoutMs: Number(env.DEFAULT_TIMEOUT_MS || 10 * 60 * 1000),
    proxy: {
      https: env.CHILD_HTTPS_PROXY || '',
      http: env.CHILD_HTTP_PROXY || '',
      all: env.CHILD_ALL_PROXY || '',
      noProxy: env.NO_PROXY || 'api.weixin.qq.com,mp.weixin.qq.com',
    },
    slack: {
      botToken: need('SLACK_BOT_TOKEN'),
      appToken: need('SLACK_APP_TOKEN'),
      notifyChannel: env.NOTIFY_CHANNEL_ID || '',
    },
    wechat: { appId: need('WECHAT_APP_ID'), appSecret: need('WECHAT_APP_SECRET') },
  };
}
