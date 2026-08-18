import { fetchWithTimeout } from '../lib/http-timeout.js';

const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096;
const DISCORD_EMBED_FIELD_LIMIT = 25;
const DISCORD_EMBED_TOTAL_LIMIT = 6000;
const DISCORD_WEBHOOK_USERNAME = 'Zen Opening Digest';
const DISCORD_COLOR = 0x0b3b40;
const USER_AGENT = 'DiscordBot (https://zentradings.com, 2.0.0)';

export function renderDiscordOpeningDigest(payload, { coverImageUrl = '' } = {}) {
  assertOpeningPayload(payload);
  const messages = [marketSnapshotMessage(payload, coverImageUrl)];
  messages.push(...editorialMessages(payload));
  if (payload.options?.data?.rows?.length) messages.push(...optionsMessages(payload));
  const total = messages.length;
  return messages.map((message, index) => withCommonMessageFields(message, payload.dateKey, index + 1, total));
}

export async function inspectDiscordWebhook({ webhookUrl, expectedChannelId = '', fetchFn = globalThis.fetch, timeoutMs = 30000 }) {
  const target = discordWebhookUrl(webhookUrl);
  const response = await discordRequest(target, { method: 'GET' }, { fetchFn, timeoutMs });
  const channelId = String(response.data?.channel_id || '');
  if (!channelId) throw discordError('Discord webhook 未返回 channel_id', { retryable: false });
  if (expectedChannelId && channelId !== String(expectedChannelId)) {
    throw discordError(`Discord webhook 指向非预期频道:${channelId}`, { retryable: false });
  }
  return {
    id: String(response.data?.id || ''),
    channelId,
    guildId: String(response.data?.guild_id || ''),
    name: String(response.data?.name || ''),
  };
}

export async function postDiscordWebhookMessage({ webhookUrl, message, expectedChannelId = '', fetchFn = globalThis.fetch, timeoutMs = 30000 }) {
  assertDiscordMessage(message);
  const target = discordWebhookUrl(webhookUrl);
  target.searchParams.set('wait', 'true');
  const response = await discordRequest(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  }, { fetchFn, timeoutMs });
  const messageId = String(response.data?.id || '');
  const channelId = String(response.data?.channel_id || '');
  if (!messageId || !channelId) {
    throw discordError('Discord webhook 返回成功但缺少 message id 或 channel id', { retryable: false });
  }
  if (expectedChannelId && channelId !== String(expectedChannelId)) {
    throw discordError(`Discord 消息落入非预期频道:${channelId}`, { retryable: false });
  }
  return { messageId, channelId };
}

export function discordWebhookUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch { throw discordError('Discord webhook URL 无效', { retryable: false }); }
  const validHost = url.hostname === 'discord.com';
  const validPath = /^\/api(?:\/v\d+)?\/webhooks\/\d{16,22}\/[A-Za-z0-9._-]{20,}$/.test(url.pathname);
  if (url.protocol !== 'https:' || !validHost || !validPath || url.username || url.password || url.search || url.hash) {
    throw discordError('Discord webhook URL 必须是官方 discord.com HTTPS webhook 地址', { retryable: false });
  }
  return url;
}

export function assertDiscordMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Discord message 必须是对象');
  if (!Array.isArray(message.embeds) || message.embeds.length < 1 || message.embeds.length > 10) {
    throw new Error('Discord message embeds 数量必须为 1-10');
  }
  if (JSON.stringify(message.allowed_mentions) !== JSON.stringify({ parse: [] })) {
    throw new Error('Discord message 必须禁用 mentions');
  }
  let total = 0;
  for (const embed of message.embeds) {
    if (String(embed.title || '').length > 256) throw new Error('Discord embed title 超限');
    if (String(embed.description || '').length > DISCORD_EMBED_DESCRIPTION_LIMIT) throw new Error('Discord embed description 超限');
    if ((embed.fields || []).length > DISCORD_EMBED_FIELD_LIMIT) throw new Error('Discord embed fields 超限');
    total += embedTextLength(embed);
    for (const field of embed.fields || []) {
      if (!field.name || String(field.name).length > 256 || !field.value || String(field.value).length > 1024) {
        throw new Error('Discord embed field 无效或超限');
      }
    }
  }
  if (total > DISCORD_EMBED_TOTAL_LIMIT) throw new Error('Discord embeds 总字符数超限');
  return message;
}

function marketSnapshotMessage(payload, coverImageUrl) {
  const fields = payload.metrics.map((metric) => ({
    name: cleanText(metric.label || metric.symbol || '—').slice(0, 256),
    value: metricValue(metric),
    inline: true,
  }));
  const sourceNotes = [...new Set(payload.metrics.map((metric) => cleanText(metric.sourceNote)).filter(Boolean))];
  const embed = {
    title: `Zen Opening Digest · ${displayDate(payload.dateKey)}`,
    description: cleanText(payload.article.preheader),
    color: DISCORD_COLOR,
    fields,
    ...(sourceNotes.length ? { footer: { text: sourceNotes.join(' ').slice(0, 2048) } } : {}),
  };
  if (/^https:\/\//i.test(coverImageUrl)) embed.image = { url: coverImageUrl };
  return { embeds: [embed] };
}

function editorialMessages(payload) {
  const chunks = splitMarkdown(payload.article.body, DISCORD_EMBED_DESCRIPTION_LIMIT);
  return chunks.map((description, index) => ({
    embeds: [{
      title: chunks.length === 1 ? 'Opening notes' : `Opening notes · ${index + 1}/${chunks.length}`,
      description,
      color: DISCORD_COLOR,
    }],
  }));
}

function optionsMessages(payload) {
  const data = payload.options.data;
  const groups = [];
  for (let index = 0; index < data.rows.length; index += 10) groups.push(data.rows.slice(index, index + 10));
  return groups.map((rows) => {
    const start = Number(rows[0]?.[0]) || 1;
    const end = Number(rows.at(-1)?.[0]) || start + rows.length - 1;
    return {
      embeds: [{
        title: `Trending options volume · ${start}–${end}`,
        description: cleanText(data.asOf),
        color: DISCORD_COLOR,
        fields: rows.map(optionField),
        footer: { text: [cleanText(data.attribution), cleanText(payload.options.kind)].filter(Boolean).join(' · ').slice(0, 2048) },
      }],
    };
  });
}

function optionField(row) {
  const [rank, ticker, name, callVolume, putVolume, totalVolume, ivx30, ivxChange] = row.map(cleanText);
  const field = {
    name: `${rank} · ${ticker} — ${name}`.slice(0, 256),
    value: `Calls ${callVolume} · Puts ${putVolume}\nVolume ${totalVolume} · IVX30 ${ivx30} · ΔIVX ${ivxChange}`,
    inline: false,
  };
  if (field.value.length > 1024) throw new Error(`Discord OIC field 超限:${rank}`);
  return field;
}

function withCommonMessageFields(message, dateKey, part, total) {
  const clone = structuredClone(message);
  clone.username = DISCORD_WEBHOOK_USERNAME;
  clone.allowed_mentions = { parse: [] };
  for (const embed of clone.embeds) {
    const partLabel = `Zen Trading · ${dateKey} · Part ${part}/${total}`;
    embed.footer = { text: [embed.footer?.text, partLabel].filter(Boolean).join(' · ').slice(0, 2048) };
  }
  assertDiscordMessage(clone);
  return clone;
}

function splitMarkdown(value, limit) {
  const normalized = cleanMarkdown(value);
  if (!normalized) return ['Editorial update unavailable for this edition.'];
  const chunks = [];
  let current = '';
  for (const block of normalized.split(/\n{2,}/)) {
    const pieces = splitLongBlock(block, limit);
    for (const piece of pieces) {
      const candidate = current ? `${current}\n\n${piece}` : piece;
      if (candidate.length <= limit) current = candidate;
      else {
        if (current) chunks.push(current);
        current = piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitLongBlock(block, limit) {
  if (block.length <= limit) return [block];
  const parts = [];
  let remaining = block;
  while (remaining.length > limit) {
    const boundary = Math.max(remaining.lastIndexOf('\n', limit), remaining.lastIndexOf(' ', limit));
    const cut = boundary >= Math.floor(limit * 0.6) ? boundary : limit;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

async function discordRequest(url, init, { fetchFn, timeoutMs }) {
  let response;
  try {
    response = await fetchWithTimeout(fetchFn, url, {
      ...init,
      headers: { 'user-agent': USER_AGENT, ...(init.headers || {}) },
    }, { timeoutMs, label: 'Discord webhook' });
  } catch (cause) {
    throw discordError(`Discord webhook 网络失败:${cause.message || cause}`, { retryable: true, cause });
  }
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) {
    const status = Number(response.status);
    const retryAfterMs = discordRetryAfterMs(response, data);
    const retryable = !Number.isInteger(status) || [408, 425, 429, 500, 502, 503, 504].includes(status);
    throw discordError(`Discord webhook 请求失败:${status || 'network'} ${cleanText(data?.message || raw).slice(0, 300)}`.trim(), {
      status, retryable, retryAfterMs,
    });
  }
  return { data, response };
}

function discordRetryAfterMs(response, data) {
  const bodySeconds = Number(data?.retry_after);
  if (Number.isFinite(bodySeconds) && bodySeconds >= 0) return Math.ceil(bodySeconds * 1000);
  const headerSeconds = Number(response.headers?.get?.('retry-after'));
  if (Number.isFinite(headerSeconds) && headerSeconds >= 0) return Math.ceil(headerSeconds * 1000);
  return 0;
}

function assertOpeningPayload(payload) {
  if (!payload || payload.schemaVersion !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(String(payload.dateKey || ''))) {
    throw new Error('Discord Opening Digest payload 无效');
  }
  if (!payload.article || !Array.isArray(payload.metrics) || payload.metrics.length !== 9) {
    throw new Error('Discord Opening Digest payload 缺少正文或九格行情');
  }
}

function metricValue(metric) {
  if (metric.unavailable || !Number.isFinite(metric.value)) return '—';
  const digits = /UST|VIX/.test(String(metric.label)) ? 2 : metric.value >= 1000 ? 0 : 2;
  const value = Number(metric.value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (!Number.isFinite(metric.changePct)) return value;
  return `${value} · ${metric.changePct >= 0 ? '+' : ''}${Number(metric.changePct).toFixed(2)}%`;
}

function embedTextLength(embed) {
  return String(embed.title || '').length
    + String(embed.description || '').length
    + String(embed.footer?.text || '').length
    + String(embed.author?.name || '').length
    + (embed.fields || []).reduce((sum, field) => sum + String(field.name || '').length + String(field.value || '').length, 0);
}

function displayDate(dateKey) {
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${dateKey}T12:00:00Z`));
}

function cleanMarkdown(value) {
  return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/[ \t]+$/gm, '').trim();
}

function cleanText(value) { return cleanMarkdown(value).replace(/\s+/g, ' ').trim(); }

function discordError(message, details = {}) {
  const error = new Error(message);
  error.stage = 'discord';
  Object.assign(error, details);
  return error;
}
