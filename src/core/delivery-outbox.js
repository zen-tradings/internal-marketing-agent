import crypto from 'node:crypto';
import {
  inspectDiscordWebhook,
  postDiscordWebhookMessage,
} from '../channels/discord-opening-digest.js';

const DESTINATION = 'discord';

export function queueDiscordDelivery({ store, runId, title, payload }) {
  const payloadJson = JSON.stringify(payload);
  const payloadSha256 = crypto.createHash('sha256').update(payloadJson).digest('hex');
  const row = store.queueDeliveryOutbox({
    runId,
    destination: DESTINATION,
    title,
    payloadJson,
    payloadSha256,
  });
  const messageIds = parseJsonArray(row.message_ids_json);
  store.upsertDelivery(runId, {
    destination: DESTINATION,
    status: row.state === 'delivered' ? 'delivered' : row.state === 'failed' ? 'failed' : 'pending',
    mediaId: messageIds[0] ? `discord-message:${messageIds[0]}` : '',
    title,
    error: row.last_error || '',
    details: { messageIds, messageCount: payload.messages.length, nextMessageIndex: Number(row.next_message_index || 0) },
  });
  return row;
}

export async function flushDiscordDeliveryOutbox({
  store,
  config,
  fetchFn = globalThis.fetch,
  now = Date.now(),
  limit = 10,
  onTerminalFailure,
} = {}) {
  const discord = config?.discord || {};
  if (!discord.openingDigestEnabled || typeof store?.listPendingDeliveryOutbox !== 'function') {
    return { delivered: 0, retried: 0, failed: 0, messages: 0 };
  }
  let delivered = 0;
  let retried = 0;
  let failed = 0;
  let messages = 0;
  for (const listed of store.listPendingDeliveryOutbox({ destination: DESTINATION, now, limit })) {
    let row = listed;
    try {
      const run = store.getRun(row.run_id);
      if (!run || run.workflow_id !== 'opening-digest' || run.source !== 'cron') {
        throw terminalError('Discord outbox 只能投递正式 cron Opening Digest');
      }
      const customerIo = store.listDeliveries(row.run_id).find((item) => item.destination === 'customerio');
      if (!customerIo || !['delivered', 'existing'].includes(customerIo.status)) continue;
      const payload = parsePayload(row.payload_json);
      await inspectDiscordWebhook({
        webhookUrl: discord.webhookUrl,
        expectedChannelId: discord.expectedChannelId,
        fetchFn,
        timeoutMs: discord.timeoutMs,
      });
      while (Number(row.next_message_index) < payload.messages.length) {
        const index = Number(row.next_message_index);
        const result = await postDiscordWebhookMessage({
          webhookUrl: discord.webhookUrl,
          message: payload.messages[index],
          expectedChannelId: discord.expectedChannelId,
          fetchFn,
          timeoutMs: discord.timeoutMs,
        });
        row = store.advanceDeliveryOutbox(row.id, { messageId: result.messageId });
        messages += 1;
      }
      const messageIds = parseJsonArray(row.message_ids_json);
      store.completeDeliveryOutbox(row.id);
      store.upsertDelivery(row.run_id, {
        destination: DESTINATION,
        status: 'delivered',
        mediaId: messageIds[0] ? `discord-message:${messageIds[0]}` : '',
        title: row.title,
        details: { messageIds, messageCount: payload.messages.length },
      });
      delivered += 1;
    } catch (error) {
      const current = store.getDeliveryOutbox(row.id) || row;
      const attempts = Number(current.attempts || 0) + 1;
      const retryable = error?.retryable !== false && attempts < Number(discord.maxAttempts || 8);
      if (retryable) {
        store.retryDeliveryOutbox(row.id, {
          error: error?.message || String(error),
          nextAttemptAt: Date.now() + retryDelayMs(error, attempts),
        });
        store.upsertDelivery(row.run_id, {
          destination: DESTINATION,
          status: 'pending',
          title: row.title,
          error: error?.message || String(error),
          details: {
            messageIds: parseJsonArray(current.message_ids_json),
            nextMessageIndex: Number(current.next_message_index || 0),
            attempts,
          },
        });
        retried += 1;
        continue;
      }
      const failedRow = store.failDeliveryOutbox(row.id, { error: error?.message || String(error) });
      const messageIds = parseJsonArray(failedRow.message_ids_json);
      store.upsertDelivery(row.run_id, {
        destination: DESTINATION,
        status: 'failed',
        mediaId: messageIds[0] ? `discord-message:${messageIds[0]}` : '',
        title: row.title,
        error: error?.message || String(error),
        details: { messageIds, nextMessageIndex: Number(failedRow.next_message_index || 0), attempts },
      });
      failed += 1;
      await onTerminalFailure?.({ row: failedRow, error, attempts });
    }
  }
  return { delivered, retried, failed, messages };
}

function parsePayload(value) {
  let payload;
  try { payload = JSON.parse(value); }
  catch { throw terminalError('Discord outbox payload JSON 损坏'); }
  if (payload?.schemaVersion !== 1 || !Array.isArray(payload.messages) || !payload.messages.length) {
    throw terminalError('Discord outbox payload 结构无效');
  }
  return payload;
}

function retryDelayMs(error, attempts) {
  if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0) {
    return Math.max(1000, Math.min(error.retryAfterMs, 15 * 60 * 1000));
  }
  return Math.min(5 * 60 * 1000, 5000 * (2 ** Math.min(attempts - 1, 6)));
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
}

function terminalError(message) {
  const error = new Error(message);
  error.retryable = false;
  return error;
}
