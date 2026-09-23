import { isDryRun } from '../config/runtime.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeWechatOpeningDigestChannel } from '../channels/wechat-opening-digest.js';
import {
  prepareOpeningDigestWechatPayload,
  translateOpeningDigestPayload,
} from '../lib/opening-digest-translation.js';
import { runWorkDir } from '../lib/run-workdir.js';

const DESTINATION = 'wechat';
const SCHEMA_VERSION = 1;

export function queueOpeningDigestWechatDelivery({ store, runId, title, payload }) {
  const envelope = { schemaVersion: SCHEMA_VERSION, openingPayload: payload };
  const payloadJson = JSON.stringify(envelope);
  const payloadSha256 = crypto.createHash('sha256').update(payloadJson).digest('hex');
  const row = store.queueDeliveryOutbox({ runId, destination: DESTINATION, title, payloadJson, payloadSha256 });
  const prior = store.listDeliveries(runId).find((item) => item.destination === DESTINATION);
  store.upsertDelivery(runId, {
    destination: DESTINATION,
    status: row.state === 'delivered' ? 'verified' : row.state === 'failed' ? 'failed' : 'pending',
    mediaId: prior?.media_id || '',
    title: prior?.title || title,
    error: row.last_error || '',
    details: { payloadSha256, attempts: Number(row.attempts || 0) },
  });
  return row;
}

export async function flushOpeningDigestWechatOutbox({
  store,
  config,
  fetchFn = globalThis.fetch,
  now = Date.now(),
  limit = 10,
  maxAttempts = 8,
  translatePayload = translateOpeningDigestPayload,
  wechatChannel = makeWechatOpeningDigestChannel(),
  onTerminalFailure,
  onDelivered,
} = {}) {
  if (isDryRun(config) || !config?.openingDigest?.wechatEnabled || typeof store?.listPendingDeliveryOutbox !== 'function') {
    return { delivered: 0, retried: 0, failed: 0 };
  }
  let delivered = 0;
  let retried = 0;
  let failed = 0;
  for (const listed of store.listPendingDeliveryOutbox({ destination: DESTINATION, now, limit })) {
    let row = listed;
    let mediaId = '';
    try {
      const run = store.getRun(row.run_id);
      if (!run || run.workflow_id !== 'opening-digest' || run.source !== 'cron') {
        throw terminalError('微信 outbox 只能投递正式 cron Opening Digest');
      }
      const customerIo = store.listDeliveries(row.run_id).find((item) => item.destination === 'customerio');
      if (!customerIo || !['delivered', 'existing'].includes(customerIo.status)) continue;
      const envelope = parsePayload(row.payload_json);
      const payload = prepareOpeningDigestWechatPayload(envelope.openingPayload);
      const artifactDir = runWorkDir(path.join(config.workDir, 'opening-digest'), row.run_id);
      const translated = await translatePayload(payload, {
        writer: config.writer,
        fetchFn,
        cacheDir: artifactDir,
        timeoutMs: config.defaultTimeoutMs,
      });
      const prior = store.listDeliveries(row.run_id).find((item) => item.destination === DESTINATION);
      mediaId = String(prior?.media_id || '');
      const remoteOperations = {
        get: (operation) => store.getRemoteOperation(row.run_id, operation),
        prepare: (entry) => store.prepareRemoteOperation({ runId: row.run_id, ...entry }),
        increment: (operation) => store.incrementRemoteOperationAttempt(row.run_id, operation),
        update: (operation, patch) => store.updateRemoteOperation(row.run_id, operation, patch),
      };
      const wechat = await wechatChannel.publish({
        payload,
        translation: translated,
        config,
        runId: row.run_id,
        existingRemoteId: mediaId,
        remoteOperations,
        onCreated: ({ remoteId, title }) => {
          mediaId = String(remoteId);
          store.upsertDelivery(row.run_id, {
            destination: DESTINATION,
            status: 'created',
            mediaId,
            title,
            details: { payloadSha256: row.payload_sha256 },
          });
        },
      });
      mediaId = wechat.mediaId;
      if (wechat.status !== 'verified') {
        throw terminalError(`微信草稿第三次回读仍不一致:${wechat.errors.join('；')}`, { remoteId: mediaId });
      }
      store.completeDeliveryOutbox(row.id);
      store.upsertDelivery(row.run_id, {
        destination: DESTINATION,
        status: 'verified',
        mediaId,
        title: wechat.title,
        details: { errors: wechat.errors, attempts: wechat.attempts, payloadSha256: row.payload_sha256 },
      });
      await appendTrace(artifactDir, {
        translation: translationTrace(translated),
        wechat: { ...wechat, html: undefined },
      });
      delivered += 1;
      // The success notice must never poison the already-completed delivery.
      try { await onDelivered?.({ row, wechat }); }
      catch (error) { console.error('[hub] WeChat delivery success notice 失败:', error?.message || error); }
    } catch (error) {
      mediaId = String(error?.remoteId || mediaId || store.listDeliveries(row.run_id)
        .find((item) => item.destination === DESTINATION)?.media_id || '');
      const current = store.getDeliveryOutbox(row.id) || row;
      if (error.stage === 'needs_review') {
        const reviewed = store.reviewDeliveryOutbox(row.id, error.message);
        store.upsertDelivery(row.run_id, { destination: DESTINATION, status: 'needs_review', mediaId, title: row.title, error: error.message });
        failed += 1;
        await onTerminalFailure?.({ row: reviewed, error, attempts: Number(current.attempts || 0) + 1 });
        continue;
      }
      const attempts = Number(current.attempts || 0) + 1;
      const retryable = error?.retryable !== false && !isWechatConfigurationError(error) && attempts < maxAttempts;
      if (retryable) {
        row = store.retryDeliveryOutbox(row.id, {
          error: error?.message || String(error),
          nextAttemptAt: Date.now() + retryDelayMs(error, attempts),
        });
        store.upsertDelivery(row.run_id, {
          destination: DESTINATION,
          status: 'pending',
          mediaId,
          title: row.title,
          error: error?.message || String(error),
          details: { attempts, payloadSha256: row.payload_sha256 },
        });
        retried += 1;
        continue;
      }
      const failedRow = store.failDeliveryOutbox(row.id, { error: error?.message || String(error) });
      store.upsertDelivery(row.run_id, {
        destination: DESTINATION,
        status: 'failed',
        mediaId,
        title: row.title,
        error: error?.message || String(error),
        details: { attempts, payloadSha256: row.payload_sha256 },
      });
      const artifactDir = runWorkDir(path.join(config.workDir, 'opening-digest'), row.run_id);
      await appendTrace(artifactDir, { wechat: { status: 'failed', mediaId, error: error?.message || String(error), attempts } });
      failed += 1;
      await onTerminalFailure?.({ row: failedRow, error, attempts });
    }
  }
  return { delivered, retried, failed };
}

function parsePayload(value) {
  let payload;
  try { payload = JSON.parse(value); } catch { throw terminalError('微信 outbox payload JSON 损坏'); }
  if (payload?.schemaVersion !== SCHEMA_VERSION || !payload.openingPayload?.article || !payload.openingPayload?.dateKey) {
    throw terminalError('微信 outbox payload 结构无效');
  }
  return payload;
}

function retryDelayMs(error, attempts) {
  if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0) {
    return Math.max(1000, Math.min(error.retryAfterMs, 15 * 60 * 1000));
  }
  return Math.min(5 * 60 * 1000, 5000 * (2 ** Math.min(attempts - 1, 6)));
}

function terminalError(message, details = {}) {
  const error = new Error(message);
  error.retryable = false;
  Object.assign(error, details);
  return error;
}

function isWechatConfigurationError(error) {
  return /(?:errcode["':\s]+(?:40001|40013|40125|40164|48001)\b|invalid appid|invalid appsecret|api unauthorized|ip not in whitelist)/i
    .test(String(error?.message || error || ''));
}

function translationTrace(translated) {
  return {
    model: translated.model,
    payloadHash: translated.payloadHash,
    blockCount: translated.blockCount,
    repairs: translated.repairs,
    fallbacks: translated.fallbacks || [],
    invariants: { blockIdsAndOrder: true, numbersTickersTimesAndBrands: true, sourceLinksRemoved: true },
  };
}

async function appendTrace(artifactDir, metadata) {
  const tracePath = path.join(artifactDir, 'research-trace.json');
  try {
    let trace = {};
    try { trace = JSON.parse(await fs.readFile(tracePath, 'utf8')); } catch {}
    trace.openingDigestDelivery = {
      ...(trace.openingDigestDelivery || {}),
      ...metadata,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(tracePath, `${JSON.stringify(trace, null, 2)}\n`, { mode: 0o600 });
  } catch {}
}
