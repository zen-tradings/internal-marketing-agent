import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertDiscordMessage,
  discordWebhookUrl,
  inspectDiscordWebhook,
  postDiscordWebhookMessage,
  renderDiscordOpeningDigest,
} from '../src/channels/discord-opening-digest.js';

const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_1234567890';

function payload(body = "## Today's catalysts\n- [NVIDIA](https://example.com/nvda) moved on a verified catalyst.\n\n## Market read\nBreadth remains the validation condition.") {
  return {
    schemaVersion: 2,
    dateKey: '2026-08-10',
    article: { title: 'Zen Opening Digest', headline: 'Rates test market conviction', preheader: 'Market signals and catalysts.', body },
    editorial: { stance: 'neutral', confidence: 'medium', changeSummary: 'Initial baseline.' },
    metrics: ['SPY', 'QQQ', 'IWM', 'VIX', '2Y UST', '10Y UST', 'DXY', 'WTI', 'Gold']
      .map((label, index) => ({ label, value: 100 + index, changePct: index % 2 ? -1 : 1 })),
    options: {
      kind: 'Opening',
      data: {
        asOf: 'As of 10 Aug 2026, 10:15:00 EDT',
        attribution: 'Data provided by IVolatility',
        rows: Array.from({ length: 20 }, (_, index) => [
          String(index + 1), `T${index + 1}`, `Company ${index + 1}`,
          '50.00 %', '50.00 %', String(1_000_000 - index), '20.00', index % 2 ? '-0.10' : '0.10',
        ]),
      },
    },
  };
}

function response(data, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key) => headers[String(key).toLowerCase()] || '' },
    async text() { return typeof data === 'string' ? data : JSON.stringify(data); },
  };
}

test('Discord Opening Digest 保留完整英文正文、九格行情和 OIC 20 行并禁用 mentions', () => {
  const messages = renderDiscordOpeningDigest(payload(), { coverImageUrl: 'https://assets.example/cover.png' });
  assert.equal(messages.length, 4);
  for (const message of messages) assert.equal(assertDiscordMessage(message), message);
  assert.deepEqual(messages[0].allowed_mentions, { parse: [] });
  assert.equal(messages[0].embeds[0].fields.length, 9);
  assert.equal(messages[0].embeds[0].image.url, 'https://assets.example/cover.png');
  assert.match(messages[1].embeds[0].description, /https:\/\/example\.com\/nvda/);
  assert.equal(messages[2].embeds[0].fields.length, 10);
  assert.equal(messages[3].embeds[0].fields.length, 10);
  const serialized = JSON.stringify(messages);
  assert.match(serialized, /1 · T1 — Company 1/);
  assert.match(serialized, /20 · T20 — Company 20/);
  assert.ok(messages.every((message, index) => message.embeds.every((embed) => embed.footer.text.includes(`Part ${index + 1}/4`))));
});

test('Discord 正文超限时按段拆帖而不截断内容', () => {
  const body = `## Long section\n${'A'.repeat(9000)}`;
  const messages = renderDiscordOpeningDigest({ ...payload(body), options: null });
  const editorial = messages.slice(1).map((message) => message.embeds[0].description).join('');
  assert.equal(editorial.replace('## Long section\n', '').length, 9000);
  assert.ok(messages.length >= 4);
  assert.ok(messages.slice(1).every((message) => message.embeds[0].description.length <= 4096));
});

test('Discord webhook 只允许官方 HTTPS URL，可只读校验 channel id', async () => {
  assert.equal(discordWebhookUrl(WEBHOOK).hostname, 'discord.com');
  assert.throws(() => discordWebhookUrl('https://example.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz'), /官方/);
  assert.throws(() => discordWebhookUrl(`${WEBHOOK}?wait=true`), /官方/);
  const calls = [];
  const inspected = await inspectDiscordWebhook({
    webhookUrl: WEBHOOK,
    expectedChannelId: '987654321098765432',
    fetchFn: async (url, init) => {
      calls.push({ url: String(url), init });
      return response({ id: '1', guild_id: '2', channel_id: '987654321098765432', name: 'Zen' });
    },
  });
  assert.equal(inspected.channelId, '987654321098765432');
  assert.equal(calls[0].init.method, 'GET');
  await assert.rejects(inspectDiscordWebhook({
    webhookUrl: WEBHOOK,
    expectedChannelId: '111111111111111111',
    fetchFn: async () => response({ id: '1', channel_id: '987654321098765432' }),
  }), /非预期频道/);
});

test('Discord POST 使用 wait=true 取得 message id，429 暴露 Retry-After 供 outbox 调度', async () => {
  const message = renderDiscordOpeningDigest({ ...payload(), options: null })[0];
  let request;
  const sent = await postDiscordWebhookMessage({
    webhookUrl: WEBHOOK,
    expectedChannelId: '987654321098765432',
    message,
    fetchFn: async (url, init) => {
      request = { url: String(url), init };
      return response({ id: '555', channel_id: '987654321098765432' });
    },
  });
  assert.deepEqual(sent, { messageId: '555', channelId: '987654321098765432' });
  assert.match(request.url, /\?wait=true$/);
  assert.deepEqual(JSON.parse(request.init.body).allowed_mentions, { parse: [] });

  await assert.rejects(postDiscordWebhookMessage({
    webhookUrl: WEBHOOK,
    message,
    fetchFn: async () => response({ message: 'rate limited', retry_after: 1.25 }, 429),
  }), (error) => error.retryable === true && error.retryAfterMs === 1250);
});
