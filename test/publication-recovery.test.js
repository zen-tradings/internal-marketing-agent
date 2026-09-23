import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/core/store.js';
import { performRemoteOperation, remoteOperationsFor } from '../src/lib/remote-operation.js';
import { makeChannel } from '../src/channels/customerio-opening-digest.js';
import { makeHandler } from '../src/index.js';
import { mergeSlackThreadMessages, buildSlackThreadInput } from '../src/triggers/slack.js';
import { queueDiscordDelivery, flushDiscordDeliveryOutbox } from '../src/core/delivery-outbox.js';

function storeFor(id = 'run', workflowId = 'opening-digest') {
  const store = openStore(':memory:');
  store.createRun({ id, workflowId, source: 'cron', input: 'fixture', notify: { channel: 'C-test' } });
  store.setStatus(id, 'running');
  return store;
}

test('ambiguous remote writes are recorded and never blindly repeated after restart', async (t) => {
  const store = storeFor(); t.after(() => store.close());
  let creates = 0;
  const args = { operations: remoteOperationsFor(store, 'run'), runId: 'run', operation: 'create', payload: { title: 'fixture' },
    create: async () => { creates++; throw new Error('accepted remotely then disconnected'); } };
  await assert.rejects(performRemoteOperation(args), e => e.stage === 'needs_review');
  await assert.rejects(performRemoteOperation(args), e => e.stage === 'needs_review');
  assert.equal(creates, 1);
  assert.equal(store.getRemoteOperation('run', 'create').state, 'needs_review');
  assert.equal(await performRemoteOperation({ ...args, recover: async () => 'remote-id' }), 'remote-id');
  assert.equal(creates, 1);
});

function frozenBundle() {
  return { schemaVersion: 1, name: 'Zen Opening Digest · 2026-09-23', scheduledAt: null, timezone: 'America/New_York', existingRemoteId: null,
    email: { name: 'Zen Opening Digest · 2026-09-23', body: '<p>Frozen content</p>', subscription_topic_id: 3,
      recipients: { and: [{ or: [{ segment: { id: 19 } }] }] } },
    destinations: [{ destination: 'discord', title: 'frozen', payload: { schemaVersion: 1, messages: [{ embeds: [{ description: 'frozen' }], allowed_mentions: { parse: [] } }] } }],
  };
}

const config = { dryRun: false, customerio: { appApiKey: 'fixture', from: 'Zen Trading <support@zentradings.com>', baseUrl: 'https://fixture.invalid', timeoutMs: 100 },
  openingDigest: { enabled: true, segmentId: 19, subscriptionTopicId: 3 } };

function journal(store, confirm = id => store.confirmPublication('run', id)) {
  return { get: () => store.getPublication('run'), prepare: payload => store.preparePublication('run', payload), confirm };
}

test('crash after email accepted resumes frozen content and atomically activates children', async (t) => {
  const store = storeFor(); t.after(() => store.close());
  store.preparePublication('run', frozenBundle());
  let creates = 0, sends = 0;
  const remote = { id: 41, name: frozenBundle().name, recipient_segment_ids: [19], subscription_topic_id: 3 };
  const channel = makeChannel({ readArticle: async () => { throw new Error('must not regenerate or reread source'); }, sleep: async () => {},
    fetchFn: async (url, init) => {
      if (init.method === 'GET') return Response.json({ newsletter: remote });
      if (url.endsWith('/send')) { sends++; remote.sent_at = 1; return Response.json({}); }
      creates++; return Response.json({ newsletter: { id: 41 } });
    } });
  const args = { config, runId: 'run', remoteOperations: remoteOperationsFor(store, 'run'), publicationJournal: journal(store, () => { throw new Error('simulated crash before local commit'); }) };
  await assert.rejects(channel.publish(args), /simulated crash/);
  assert.equal(store.deliveryOutboxStats().pending, 0);
  store.markInterrupted();
  assert.equal(store.recoverPublications(), 1);
  const result = await channel.publish({ ...args, publicationJournal: journal(store) });
  assert.equal(result.mediaId, 'customerio-newsletter:41');
  assert.equal(creates, 1); assert.equal(sends, 1);
  assert.equal(store.getRun('run').status, 'done');
  assert.equal(store.deliveryOutboxStats().pending, 1);
  assert.equal(store.listPendingNotifications().length, 1);
  await channel.publish({ ...args, publicationJournal: journal(store) });
  assert.equal(sends, 1); assert.equal(store.deliveryOutboxStats().pending, 1);
});

test('unconfirmed email send is not repeated and children stay dormant', async (t) => {
  const store = storeFor(); t.after(() => store.close()); store.preparePublication('run', frozenBundle());
  let sends = 0;
  const channel = makeChannel({ sleep: async () => {}, fetchFn: async (url, init) => {
    if (init.method === 'GET') return Response.json({ newsletter: { id: 42, name: frozenBundle().name, recipient_segment_ids: [19], subscription_topic_id: 3 } });
    if (url.endsWith('/send')) { sends++; throw new Error('socket timeout'); }
    return Response.json({ newsletter: { id: 42 } });
  } });
  const args = { config, runId: 'run', remoteOperations: remoteOperationsFor(store, 'run'), publicationJournal: journal(store) };
  await assert.rejects(channel.publish(args), e => e.stage === 'needs_review');
  await assert.rejects(channel.publish(args), e => e.stage === 'needs_review');
  assert.equal(sends, 1); assert.equal(store.deliveryOutboxStats().pending, 0);
});

test('publication errors do not restart generation and review notification is durable', async (t) => {
  const store = storeFor('run', 'translate'); t.after(() => store.close());
  let generated = 0, published = 0;
  const handler = makeHandler({ store, config: { dryRun: false }, workflows: { translate: { channel: 'fake', retries: 3, retryDelayMs: 0 } },
    runWriter: async () => { generated++; return { ok: true, articlePath: 'unused' }; },
    channels: { fake: { skipTemplateCheck: true, publish: async () => { published++; throw Object.assign(new Error('unconfirmed'), { stage: 'needs_review' }); } } } });
  await handler({ id: 'run', workflowId: 'translate' });
  assert.equal(generated, 1); assert.equal(published, 1);
  assert.equal(store.getRun('run').status, 'needs_review');
  assert.equal(store.listPendingNotifications()[0].method, 'needsReview');
});

test('retention keeps pending notifications, deliveries and unresolved operations', async (t) => {
  const store = storeFor(); t.after(() => store.close());
  store.setStatus('run', 'done', { finishedAt: 1 });
  store.queueNotification({ runId: 'run', method: 'success', payload: {}, notify: {} });
  assert.equal(store.listPrunableRuns(2).length, 0); assert.equal(store.deletePrunableRun('run', 2), 0);
  store.markNotificationSent(store.listPendingNotifications()[0].id);
  const operations = remoteOperationsFor(store, 'run');
  operations.prepare({ operation: 'unresolved', operationKey: 'test-key', payloadSha256: 'hash' });
  assert.equal(store.prune({ runBefore: 2 }).runs, 0);
  operations.update('unresolved', { state: 'confirmed', remoteId: 'id' });
  store.queueDeliveryOutbox({ runId: 'run', destination: 'discord', payloadJson: '{}', payloadSha256: 'hash' });
  assert.equal(store.listPrunableRuns(2).length, 0);
  store.completeDeliveryOutbox(store.listPendingDeliveryOutbox({ destination: 'discord' })[0].id);
  assert.equal(store.deletePrunableRun('run', 2), 1);
});

test('long threads keep the original task and attachments', () => {
  let messages = [{ ts: '1', text: 'Only translate pages 1-2', attachments: [{ id: 'file' }] }];
  for (let i = 2; i <= 30; i++) messages = mergeSlackThreadMessages(messages, { ts: String(i), text: `followup ${i}` });
  assert.equal(messages.length, 12);
  assert.equal(messages[0].attachments[0].id, 'file');
  assert.match(buildSlackThreadInput(messages), /^Only translate pages 1-2/);
});

test('Discord unknown POST result enters review and cannot be posted again', async (t) => {
  const store = storeFor(); t.after(() => store.close());
  store.upsertDelivery('run', { destination: 'customerio', status: 'delivered' });
  queueDiscordDelivery({ store, runId: 'run', title: 'test', payload: frozenBundle().destinations[0].payload });
  let posts = 0;
  const args = { store, config: { dryRun: false, discord: { openingDigestEnabled: true, webhookUrl: 'https://discord.com/api/webhooks/1234567890123456/abcdefghijklmnopqrst' } }, fetchFn: async (_url, init) => {
    if (init.method === 'GET') return Response.json({ channel_id: 'C-test' });
    posts++; throw new Error('response lost');
  } };
  await flushDiscordDeliveryOutbox(args); await flushDiscordDeliveryOutbox({ ...args, now: Number.MAX_SAFE_INTEGER });
  assert.equal(posts, 1);
  assert.equal(store.listDeliveries('run').find(r => r.destination === 'discord').status, 'needs_review');
});
