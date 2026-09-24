import { ChannelResult } from '../lib/publication-contracts.js';
import { remoteOperationsFor } from '../lib/remote-operation.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { isDryRun } from '../config/runtime.js';
import { deliverOrQueueNotification } from './notification-outbox.js';
import { queueDiscordDelivery } from './delivery-outbox.js';
import { queueOpeningDigestWechatDelivery } from './opening-digest-wechat-outbox.js';
import { formatQdiiSlackMessages, qdiiSourcesForWriter } from './qdii.js';
import { runWorkDir, workflowForRun } from '../lib/run-workdir.js';
import { assertFixedDraftTemplate } from '../lib/draft-template.js';
import { cancellationErrorFromSignal, isTaskCancelled, throwIfTaskCancelled } from '../lib/task-cancellation.js';

export async function runWithRetry(
  fn,
  retries = 0,
  retryDelayMs = 0,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  signal,
  shouldRetry,
) {
  let last;
  for (let i = 0; i <= retries; i++) {
    throwIfTaskCancelled(signal);
    try { return await fn(); }
    catch (e) {
      if (isTaskCancelled(e, signal)) throw cancellationErrorFromSignal(signal);
      last = e;
      const retryAllowed = typeof shouldRetry !== 'function' || shouldRetry(e);
      if (i < retries && retryAllowed) {
        console.error(`[hub] 执行失败,准备第 ${i + 2}/${retries + 1} 次尝试:${e?.message || e}`);
        if (retryDelayMs > 0) await sleepWithCancellation(sleep, retryDelayMs, signal);
      } else {
        break;
      }
    }
  }
  throw last;
}

export function openingDigestPublishContext(run) {
  const correction = run?.workflowId === 'opening-digest' && run?.source === 'cron'
    ? /^opening-digest-(correction-\d{4}-\d{2}-\d{2})$/.exec(String(run.id || ''))
    : null;
  if (correction) return { source: 'cron', acceptanceId: '', correctionId: correction[1] };
  if (run?.workflowId !== 'opening-digest' || run?.source !== 'slack') {
    return { source: run?.source, acceptanceId: '', correctionId: '' };
  }
  const raw = String(run.id || '');
  const normalized = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const acceptanceId = /^[a-z0-9-]{8,80}$/.test(normalized)
    ? normalized
    : `slack-${normalized.slice(0, 54) || 'run'}-${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12)}`.slice(0, 80);
  return { source: 'acceptance', acceptanceId, correctionId: '' };
}

// Queue-handler factory with injectable store, runner, and channels for unit tests.
// The closure retains the deps object itself rather than destructured locals. start() assigns notifier later,
// after registerSlack, so retain the original read-current-value-at-call-time behavior.
export function makeHandler(deps) {
  const { store, runWriter, workflows, channels, config } = deps;
  return async function handler(run, { signal, setPhase = () => {} } = {}) {
    let notify = {};
    let writerAttempt = 0;
    let runtimeWorkflow;
    try {
      throwIfTaskCancelled(signal);
      const persisted = store.getRun(run.id);
      if (!persisted) throw stageError('config', `任务记录不存在:${run.id}`);
      try {
        notify = JSON.parse(persisted.notify_json || '{}');
        if (!notify || typeof notify !== 'object' || Array.isArray(notify)) throw new Error('notify_json 不是对象');
      } catch (error) {
        throw stageError('config', `任务通知配置损坏:${error.message}`);
      }
      const wf = workflows[run.workflowId];
      if (!wf) throw stageError('config', `未知工作流:${run.workflowId}`);
      runtimeWorkflow = wf.workDir ? workflowForRun(wf, run.id) : wf;
      store.setStatus(run.id, 'running', { startedAt: Date.now(), stage: null, error: null, nextRetryAt: null });
      setPhase('generate');

      const qdiiPlan = notify.qdiiPlan?.qdii ? notify.qdiiPlan : null;
      if (runtimeWorkflow.mode === 'qdii-query') {
        if (persisted.slack_response_ts) {
          store.setOutputKind?.(run.id, 'slack-response');
          store.setStatus(run.id, 'done', {
            title: persisted.title || 'QDII holdings response',
            finishedAt: Date.now(),
          });
          return;
        }
        const payload = await deps.runQdiiQuery({
          input: run.input,
          taskPlan: qdiiPlan,
          config,
          workDir: runtimeWorkflow.workDir,
          signal,
          onProgress: (progress) => notifyBestEffort(deps.notifier, 'progress', notify, progress),
        });
        if (!payload.results.length) throw stageError('generate', payload.failures.map((item) => `${item.code}: ${item.error}`).join('; ') || '未取得可用 QDII 持仓');
        setPhase('respond');
        const delivered = await deliverOrQueueNotification({
          store, notifier: deps.notifier, runId: run.id, method: 'respond', notify,
          payload: { messages: formatQdiiSlackMessages(payload, { language: payload.taskPlan?.language || payload.query?.language }) },
        });
        store.setOutputKind?.(run.id, 'slack-response');
        if (delivered.result?.responseTs) store.setSlackResponseTs?.(run.id, delivered.result.responseTs);
        store.setStatus(run.id, 'done', {
          title: `QDII holdings: ${payload.results.map((item) => item.code).join(', ')}`,
          finishedAt: Date.now(),
        });
        return;
      }

      let qdiiPayload;
      if (qdiiPlan) {
        qdiiPayload = await deps.runQdiiQuery({
          input: run.input,
          taskPlan: qdiiPlan,
          config,
          workDir: runtimeWorkflow.workDir,
          signal,
          onProgress: (progress) => notifyBestEffort(deps.notifier, 'progress', notify, progress),
        });
        if (!qdiiPayload.results.length) throw stageError('generate', qdiiPayload.failures.map((item) => `${item.code}: ${item.error}`).join('; ') || '未取得可用 QDII 持仓');
        if (qdiiPlan.dualReply && !persisted.slack_response_ts) {
          setPhase('respond');
          const delivered = await deliverOrQueueNotification({
            store, notifier: deps.notifier, runId: run.id, method: 'respond', notify,
            payload: { messages: formatQdiiSlackMessages(qdiiPayload, { language: qdiiPayload.taskPlan?.language || qdiiPayload.query?.language }) },
          });
          if (delivered.result?.responseTs) store.setSlackResponseTs?.(run.id, delivered.result.responseTs);
        }
        store.setOutputKind?.(run.id, qdiiPlan.dualReply ? 'draft-with-slack-summary' : 'draft');
        setPhase('generate');
      }

      const publicationJournal = {
        get: () => store.getPublication?.(run.id),
        prepare: payload => store.preparePublication(run.id, payload),
        confirm: id => store.confirmPublication(run.id, id),
      };
      const { title, mediaId, sourceCount, completeness, deliveryWarnings = [] } = await (async () => {
        throwIfTaskCancelled(signal);
        // A media_id proves a prior retry or restart republish succeeded; skip regeneration/publication to avoid duplicates.
        const existing = store.getRun(run.id);
        if (!isDryRun(config) && publicationJournal.get()) {
          setPhase('publish');
          return channels[runtimeWorkflow.channel].publish({ config, publicationJournal,
            remoteOperations: remoteOperationsFor(store, run.id), runId: run.id,
            onCreated: ({ remoteId }) => store.setRemoteId(run.id, remoteId) });
        }
        if (existing.media_id) {
          setPhase('published');
          return { title: existing.title, mediaId: existing.media_id };
        }

        let resumeFromCheckpoint;
        const res = await runWithRetry(async () => {
          resumeFromCheckpoint = Boolean(run.restored || writerAttempt > 0);
          writerAttempt += 1;
          const generated = await runWriter({
            workflow: runtimeWorkflow,
            input: run.input,
            config,
            taskContext: {
              promptRevision: notify.promptRevision,
              threadKey: notify.threadKey,
              attachments: notify.attachments,
              resolvedClarification: notify.resolvedClarification,
              routeReason: notify.routeReason,
              modelProfile: notify.modelProfile,
              modelRouteReason: notify.modelRouteReason,
              ...(runtimeWorkflow.id === 'opening-digest' ? {
                openingDigestHistory: {
                  recordCapture: (entry) => store.recordOpeningDigestOicCapture?.(entry),
                  listHistory: (options) => store.listOpeningDigestIvHistory?.(options),
                  listEditorialHistory: (options) => store.listOpeningDigestEditorialHistory?.(options) || [],
                },
              } : {}),
              ...(qdiiPayload ? {
                qdiiPayload,
                qdiiSources: qdiiSourcesForWriter(qdiiPayload),
              } : {}),
            },
            onProgress: (progress) => notifyBestEffort(deps.notifier, 'progress', notify, progress),
            resumeFromCheckpoint,
            signal,
          });
          if (!generated.ok && !generated.needsInput) throw stageError('generate', generated.stderr);
          return generated;
        }, runtimeWorkflow.retries, runtimeWorkflow.retryDelayMs, undefined, signal, runtimeWorkflow.shouldRetry);
        if (res.needsInput) {
          const err = stageError('needs_input', res.stderr || res.clarification?.question || '任务需要用户确认');
          err.needsInput = true;
          err.details = res.clarification || { question: err.message };
          throw err;
        }
        if (!res.ok) { const err = new Error(res.stderr); err.stage = 'generate'; throw err; }
        throwIfTaskCancelled(signal);
        if (runtimeWorkflow.id !== 'opening-digest' && Array.isArray(res.warnings) && res.warnings.length) {
          const highRiskRetained = res.warnings
            .filter((item) => /保留待人工复核\([^/]+\/high\//.test(item)).length;
          const warningHeading = runtimeWorkflow.mode === 'translation'
            ? `直译有 ${res.completeness?.reviewRequiredCount || res.warnings.length} 个译块需人工复核，已按策略创建草稿:`
            : runtimeWorkflow.id === 'macro' && highRiskRetained
              ? `宏观事实审计提醒 ${res.warnings.length} 项，其中 ${highRiskRetained} 项高风险推断/表述已保留，不阻断草稿，请人工复核:`
              : `事实审计报告 ${res.warnings.length} 项（含自动修复与保留待复核）:`;
          const shownWarnings = res.warnings.slice(0, 6).map((item) => `• ${item}`);
          if (res.warnings.length > shownWarnings.length) {
            shownWarnings.push(`• 其余 ${res.warnings.length - shownWarnings.length} 项见 research-trace.json`);
          }
          await notifyBestEffort(
            deps.notifier,
            'warn',
            notify,
            `${warningHeading}\n${shownWarnings.join('\n')}`,
          );
        }

        // With HUB_DRY_RUN enabled, force every declared workflow channel to mock for local/CI end-to-end rehearsal
        // without touching the live WeChat API. Use strict truthiness so 0, false, and empty strings do not enable it.
        const DRY = isDryRun(config);
        const channelId = DRY ? 'mock' : runtimeWorkflow.channel;
        const channel = channels[channelId];
        if (!channel?.publish) throw stageError('config', `未知发布渠道:${channelId || '(empty)'}`);
        if (!channel.skipTemplateCheck) assertFixedDraftTemplate(channelId, channel);
        if (runtimeWorkflow.mode === 'translation' && deps.notifier?.progress) {
          await notifyBestEffort(deps.notifier, 'progress', notify, {
            stage: 'draft',
            message: res.completeness?.reviewRequiredCount
              ? (DRY
                ? '结构完整性通过且存在待复核译块，正在生成 dry-run 草稿结果'
                : '结构完整性通过且存在待复核译块，正在创建微信公众号草稿')
              : (DRY
                ? '严格等价与完整性校验通过，正在生成 dry-run 草稿结果'
                : '严格等价与完整性校验通过，正在创建微信公众号草稿'),
            completed: 1,
            total: 1,
          });
        }
        setPhase('publish');
        throwIfTaskCancelled(signal);
        const publishContext = openingDigestPublishContext(run);
        const { mediaId, title, deliveryWarnings = [] } = await channel.publish({
          publicationJournal,
          articlePath: res.articlePath,
          config,
          workflow: runtimeWorkflow,
          notify,
          notifier: deps.notifier,
          runId: run.id,
          createdAt: persisted.created_at,
          existingRemoteId: store.getRun(run.id)?.remote_id || '',
          existingDeliveries: store.listDeliveries?.(run.id) || [],
          onCreated: ({ remoteId }) => store.setRemoteId(run.id, remoteId),
          remoteOperations: {
            get: (operation) => store.getRemoteOperation?.(run.id, operation),
            prepare: (entry) => store.prepareRemoteOperation?.({ runId: run.id, ...entry }),
            increment: (operation) => store.incrementRemoteOperationAttempt?.(run.id, operation),
            update: (operation, patch) => store.updateRemoteOperation?.(run.id, operation, patch),
          },
          onDelivery: (delivery) => store.upsertDelivery?.(run.id, delivery),
          onDeferredDelivery: (delivery) => {
            if (delivery.destination === 'discord') return queueDiscordDelivery({ store, runId: run.id, ...delivery });
            if (delivery.destination === 'wechat') return queueOpeningDigestWechatDelivery({ store, runId: run.id, ...delivery });
            throw new Error(`未知持久投递 destination:${delivery.destination}`);
          },
          resumeFromCheckpoint,
          contentPolicy: res.contentPolicy || {},
          signal,
          contentMode: res.contentMode,
          source: publishContext.source,
          acceptanceId: publishContext.acceptanceId,
          correctionId: publishContext.correctionId,
        });
        ChannelResult.parse({ mediaId, title });
        store.setMediaId(run.id, mediaId, title); // Persist immediately after publish to support the idempotency check above.
        if (runtimeWorkflow.id === 'opening-digest' && publishContext.source === 'cron' && res.openingDigestEditorialState) {
          try {
            store.recordOpeningDigestEditorialEdition?.({
              ...res.openingDigestEditorialState,
              runId: run.id,
              publishedAt: Date.now(),
            });
          } catch (error) {
            appendOpeningHistoryDiagnostic(res.researchTracePath, error);
          }
        }
        setPhase('published');
        return { mediaId, title, sourceCount: res.sources?.length || 0, completeness: res.completeness, deliveryWarnings };
      })();
      store.setStatus(run.id, 'done', { title, mediaId, finishedAt: Date.now() });
      await deliverOrQueueNotification({
        store, notifier: deps.notifier, runId: run.id, method: 'success', notify,
        payload: { title, mediaId, channelId: runtimeWorkflow.channel, sourceCount, completeness },
      });
      for (const warning of deliveryWarnings) {
        if (deps.notifier) await notifyBestEffort(deps.notifier, 'warn', notify, warning);
      }
      if (runtimeWorkflow.id === 'opening-digest' && openingDigestPublishContext(run).source === 'cron') {
        await deps.kickDeliveryOutbox?.();
      }
    } catch (e) {
      const emailConfirmed = store.getRemoteOperation?.(run.id, 'deliver-opening-email')?.state === 'confirmed';
      if (store.getRun(run.id)?.media_id || emailConfirmed) {
        store.setStatus(run.id, 'done', { finishedAt: Date.now() });
        await deliverOrQueueNotification({ store, notifier: deps.notifier, runId: run.id,
          method: 'warn:recovery', notify, payload: `发布已成功，本地收尾需要核对:${e.message}` });
        return;
      }
      if (e.stage === 'needs_review') {
        store.setStatus(run.id, 'needs_review', { stage: 'needs_review', error: e.message, finishedAt: Date.now() });
        await deliverOrQueueNotification({ store, notifier: deps.notifier, runId: run.id,
          method: 'needsReview', notify, payload: { error: e.message, runId: run.id } });
        return;
      }
      if (isTaskCancelled(e, signal)) {
        const cleanup = cleanupRunArtifacts(workflows, run);
        store.setStatus(run.id, 'cancelled', {
          stage: 'cancelled',
          error: cancellationErrorFromSignal(signal).message,
          finishedAt: Date.now(),
        });
        await deliverOrQueueNotification({
          store, notifier: deps.notifier, runId: run.id, method: 'cancelled', notify,
          payload: { runId: run.id, cleaned: cleanup.cleaned, cleanupError: cleanup.error },
        });
        return;
      }
      if (e.needsInput || e.stage === 'needs_input') {
        const cleanup = cleanupRunArtifacts(workflows, run, { preserveResearchTrace: true });
        store.setStatus(run.id, 'needs_input', {
          stage: 'needs_input',
          error: e.message,
          finishedAt: Date.now(),
        });
        if (notify.threadKey) {
          try {
            store.setSlackClarification?.(notify.threadKey, {
              runId: run.id,
              question: e.details?.question || e.message,
              details: e.details || {},
              cleaned: cleanup.cleaned,
              createdAt: Date.now(),
            });
          } catch (storeError) {
            console.error('[hub] 澄清上下文写入失败:', storeError?.message || storeError);
          }
        }
        await deliverOrQueueNotification({
          store, notifier: deps.notifier, runId: run.id, method: 'needsInput', notify,
          payload: { question: e.details?.question || e.message, details: e.details || {} },
        });
        return;
      }
      const stage = e.stage || 'publish';
      store.setStatus(run.id, 'failed', { stage, error: e.message, finishedAt: Date.now() });
      await deliverOrQueueNotification({
        store, notifier: deps.notifier, runId: run.id, method: 'failure', notify,
        payload: { stage, error: e.message },
      });
    }
  };
}

function appendOpeningHistoryDiagnostic(tracePath, error) {
  if (!tracePath) return;
  try {
    const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
    trace.openingDigestEditorialHistory ||= {};
    trace.openingDigestEditorialHistory.persistenceDiagnostic = `Opening Digest editorial history 写入失败:${error?.message || error}`.slice(0, 600);
    fs.writeFileSync(tracePath, `${JSON.stringify(trace, null, 2)}\n`, { mode: 0o600 });
  } catch {}
}

async function sleepWithCancellation(sleep, ms, signal) {
  if (!signal) return sleep(ms);
  throwIfTaskCancelled(signal);
  let onAbort;
  try {
    await Promise.race([
      Promise.resolve().then(() => sleep(ms)),
      new Promise((_, reject) => {
        onAbort = () => reject(cancellationErrorFromSignal(signal));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export function cleanupRunArtifacts(workflows, run, { preserveResearchTrace = false } = {}) {
  const workflow = workflows?.[run?.workflowId];
  if (!workflow?.workDir || !run?.id) return { cleaned: false };
  const artifactDir = runWorkDir(workflow.workDir, run.id);
  try {
    if (preserveResearchTrace && fs.existsSync(artifactDir)) {
      for (const entry of fs.readdirSync(artifactDir)) {
        if (entry === 'research-trace.json') continue;
        fs.rmSync(`${artifactDir}/${entry}`, { recursive: true, force: true });
      }
      return { cleaned: true, artifactDir, preserved: ['research-trace.json'] };
    }
    fs.rmSync(artifactDir, { recursive: true, force: true });
    return { cleaned: true, artifactDir };
  } catch (error) {
    console.error(`[hub] 已取消任务目录清理失败:${artifactDir}:${error?.message || error}`);
    return { cleaned: false, artifactDir, error: error?.message || String(error) };
  }
}

function stageError(stage, message) {
  const error = new Error(message);
  error.stage = stage;
  return error;
}

async function notifyBestEffort(notifier, method, notify, payload) {
  try { return await notifier?.[method]?.(notify, payload); }
  catch (error) {
    console.error(`[hub] notifier.${method} 失败(已忽略):`, error?.message || error);
    return undefined;
  }
}
