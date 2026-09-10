import 'dotenv/config';
import fs from 'node:fs';
import { loadConfig } from '../src/config/index.js';
import { installResourceGovernor, installRuntimeConfig } from '../src/config/runtime.js';
import { createResourceGovernor } from '../src/core/resource-governor.js';
import { makeChannel } from '../src/channels/wechat-draft.js';
import { runWorkDir } from '../src/lib/run-workdir.js';

const articlePath = process.argv[2];
if (!articlePath) {
  console.error('usage: node scripts/publish-local-article.mjs <article.md>');
  process.exit(2);
}

const required = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'WECHAT_APP_ID', 'WECHAT_APP_SECRET', 'OPENROUTER_API_KEY'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`缺少必需环境变量:${missing.join(', ')}。请先在仓库 .env 中配置真实凭据。`);
  process.exit(2);
}
const config = installRuntimeConfig(loadConfig(process.env));
installResourceGovernor(createResourceGovernor({ ...config.resources, fetchFn: globalThis.fetch }));

const runId = `local-anon-${Date.now()}`;
const workDir = runWorkDir(config.workDir, runId);
fs.mkdirSync(workDir, { recursive: true });
const target = `${workDir}/article.md`;
fs.copyFileSync(articlePath, target);

const channel = makeChannel();
const result = await channel.publish({
  articlePath: target,
  config,
  workflow: { mode: 'analysis', workDir },
  runId,
  notifier: {
    warn: async (_notify, message) => { console.warn('[warn]', JSON.stringify(message)); },
  },
});
console.log(JSON.stringify({ runId, ...result }, null, 2));
