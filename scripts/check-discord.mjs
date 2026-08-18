import dotenv from 'dotenv';
import { inspectDiscordWebhook } from '../src/channels/discord-opening-digest.js';

dotenv.config({
  path: process.env.DOTENV_CONFIG_PATH || undefined,
  override: true,
});

const webhookUrl = String(process.env.DISCORD_OPENING_DIGEST_WEBHOOK_URL || '').trim();
if (!webhookUrl) throw new Error('缺少环境变量 DISCORD_OPENING_DIGEST_WEBHOOK_URL');

const result = await inspectDiscordWebhook({
  webhookUrl,
  expectedChannelId: String(process.env.DISCORD_OPENING_DIGEST_CHANNEL_ID || '').trim(),
  timeoutMs: Number(process.env.DISCORD_WEBHOOK_TIMEOUT_MS || 30000),
});

console.log(`Discord webhook:可用 (guild_id=${result.guildId || '未返回'}, channel_id=${result.channelId}, name=${result.name || '未命名'})`);
console.log('本检查只读 webhook 元数据，不会在 Discord 发布消息。');
