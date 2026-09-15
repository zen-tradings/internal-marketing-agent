import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/index.js';
import { runWriter } from '../src/core/runner.js';
import { openStore } from '../src/core/store.js';
import { runWorkDir } from '../src/lib/run-workdir.js';
import { makeChannel } from '../src/channels/customerio-opening-digest.js';
import { createWechatApi } from '../src/channels/wechat-opening-digest.js';
import { OPENING_DIGEST_TRANSLATION_VERSION } from '../src/lib/opening-digest-translation.js';
import openingDigest from '../src/workflows/opening-digest.js';
import { easternDateKey } from '../src/lib/us-equity-calendar.js';

const RECOVERABLE_ERROR = /^Opening Digest 中文直译硬校验失败:/;
const COMPACT_REFERENCE_MARKER = /【\s*\d+(?:\s*[-–—,，、;；]\s*\d+)*\s*】/;
const REQUIRED_ARTIFACTS = [
  'article.md',
  'article.md.opening-digest-state.json',
  'opening-digest-universe.json',
  'research-trace.json',
];

export async function retryOpeningDigestWechat({
  runId,
  dbPath,
  workDir,
  config,
  publish = (args) => makeChannel().publish(args),
} = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{5,100}$/.test(String(runId || ''))) {
    throw new Error('run-id 格式无效');
  }
  if (!dbPath || !fs.existsSync(dbPath)) throw new Error(`任务数据库不存在:${dbPath || '(empty)'}`);
  if (!workDir) throw new Error('缺少 WORK_DIR');
  if (!config?.openingDigest?.wechatEnabled) {
    throw new Error('OPENING_DIGEST_WECHAT_ENABLED=true 才能补建微信草稿');
  }

  const store = openStore(dbPath);
  const run = store.getRun(runId);
  if (!run) throw new Error(`任务不存在:${runId}`);
  if (run.workflow_id !== 'opening-digest' || run.source !== 'cron') {
    throw new Error('只允许恢复正式 cron 的 opening-digest 微信派生稿');
  }
  if (run.status !== 'done' || run.error) throw new Error(`任务终态不可恢复:${run.status}`);
  if (store.listByStatus('running').length || store.listByStatus('queued').length) {
    throw new Error('队列非空，拒绝与主服务任务并行补建微信草稿');
  }

  const newsletterId = Number(run.remote_id);
  const expectedCustomerIoId = `customerio-newsletter:${newsletterId}`;
  if (!Number.isInteger(newsletterId) || newsletterId <= 0
    || run.media_id !== expectedCustomerIoId
    || !/^\d{4}-\d{2}-\d{2}$/.test(String(run.schedule_key || ''))) {
    throw new Error('Opening Digest 邮件身份或日期无效，拒绝补建微信稿');
  }

  const deliveries = store.listDeliveries(runId);
  const customerio = deliveries.find((item) => item.destination === 'customerio');
  const wechat = deliveries.find((item) => item.destination === 'wechat');
  if (!customerio || !['delivered', 'existing'].includes(customerio.status)
    || customerio.media_id !== expectedCustomerIoId) {
    throw new Error('Customer.io 邮件没有已成功投递记录，拒绝补建微信稿');
  }
  if (!wechat || wechat.status !== 'failed' || wechat.media_id
    || !RECOVERABLE_ERROR.test(String(wechat.error || ''))) {
    throw new Error('微信派生稿不是可安全恢复的翻译门禁失败，拒绝重试');
  }

  const sourceDir = runWorkDir(path.join(path.resolve(workDir), 'opening-digest'), runId);
  for (const filename of REQUIRED_ARTIFACTS) {
    if (!fs.existsSync(path.join(sourceDir, filename))) {
      throw new Error(`Opening Digest 恢复缺少同源产物:${filename}`);
    }
  }

  const recoveryConfig = {
    ...config,
    discord: { ...(config.discord || {}), openingDigestEnabled: false },
  };
  const result = await publish({
    articlePath: path.join(sourceDir, 'article.md'),
    config: recoveryConfig,
    workflow: openingDigest,
    source: 'cron',
    existingRemoteId: String(newsletterId),
    existingDeliveries: deliveries,
    onCreated: () => { throw new Error('恢复过程中不应创建新的 Customer.io 邮件'); },
    onDelivery: () => {},
    onDeferredDelivery: undefined,
  });
  const recovered = result?.deliveries?.find((item) => item.destination === 'wechat');
  if (!recovered?.mediaId) throw new Error('微信恢复未返回 media_id');
  store.upsertDelivery(runId, recovered);
  if (recovered.status !== 'verified') {
    throw new Error(`微信恢复未通过回读:${recovered.status}`);
  }
  return {
    runId,
    newsletterId,
    mediaId: recovered.mediaId,
    title: recovered.title,
    status: recovered.status,
    sourceDir,
  };
}

export async function repairOpeningDigestWechat({
  runId,
  dbPath,
  workDir,
  config,
  now = () => new Date(),
  generate = runWriter,
  publish = (args) => makeChannel().publish(args),
} = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{5,100}$/.test(String(runId || ''))) {
    throw new Error('run-id 格式无效');
  }
  if (!dbPath || !fs.existsSync(dbPath)) throw new Error(`任务数据库不存在:${dbPath || '(empty)'}`);
  if (!workDir) throw new Error('缺少 WORK_DIR');
  if (!config?.openingDigest?.wechatEnabled) {
    throw new Error('OPENING_DIGEST_WECHAT_ENABLED=true 才能纠错微信草稿');
  }

  const store = openStore(dbPath);
  const run = store.getRun(runId);
  if (!run || run.workflow_id !== 'opening-digest' || run.source !== 'cron'
    || run.status !== 'done' || run.error) {
    throw new Error('只允许纠错已完成的正式 cron Opening Digest');
  }
  if (run.schedule_key !== easternDateKey(now())) {
    throw new Error('微信纠错只允许处理当前美东交易日的正式稿');
  }
  if (store.listByStatus('running').length || store.listByStatus('queued').length) {
    throw new Error('队列非空，拒绝与主服务任务并行纠错微信草稿');
  }
  const outbox = store.deliveryOutboxStats();
  if (outbox.pending || outbox.failed) {
    throw new Error(`delivery outbox 非空或有失败，拒绝纠错:${JSON.stringify(outbox)}`);
  }

  const newsletterId = Number(run.remote_id);
  const expectedCustomerIoId = `customerio-newsletter:${newsletterId}`;
  const deliveries = store.listDeliveries(runId);
  const customerio = deliveries.find((item) => item.destination === 'customerio');
  const wechat = deliveries.find((item) => item.destination === 'wechat');
  if (!Number.isInteger(newsletterId) || newsletterId <= 0
    || run.media_id !== expectedCustomerIoId
    || !customerio || !['delivered', 'existing'].includes(customerio.status)
    || customerio.media_id !== expectedCustomerIoId) {
    throw new Error('Customer.io 正式邮件身份无效，拒绝纠错微信草稿');
  }
  if (!wechat || wechat.status !== 'verified' || !wechat.media_id) {
    throw new Error('微信纠错要求已有 verified 草稿和 media_id');
  }

  const sourceDir = runWorkDir(path.join(path.resolve(workDir), 'opening-digest'), runId);
  const sourceTracePath = path.join(sourceDir, 'research-trace.json');
  const sourceTrace = readJson(sourceTracePath, '原始研究轨迹');
  if (sourceTrace.contentMode !== 'data-only'
    || !/(?:OpenRouter completion failed|OpenRouter returned empty content|OpenRouter returned malformed JSON response|OpenRouter completion timed out)/i.test(String(sourceTrace.fallbackReason || ''))) {
    throw new Error('原稿不是正文模型技术失败产生的数据占位稿，拒绝自动改写 verified 草稿');
  }

  const repairsDir = path.join(sourceDir, 'repairs');
  fs.mkdirSync(repairsDir, { recursive: true, mode: 0o700 });
  const repairDir = fs.mkdtempSync(path.join(repairsDir, 'wechat-editorial-'));
  const workflow = { ...openingDigest, workDir: repairDir };
  const generated = await generate({
    workflow,
    input: run.input,
    config,
    taskContext: {
      openingDigestHistory: {
        listHistory: (options) => store.listOpeningDigestIvHistory?.(options),
        listEditorialHistory: (options) => store.listOpeningDigestEditorialHistory?.(options) || [],
      },
    },
  });
  if (!generated?.ok || generated.contentMode !== 'editorial') {
    throw new Error(`微信纠错未生成完整 editorial 稿:${generated?.stderr || generated?.contentMode || 'unknown'}`);
  }
  const correctedArticle = fs.readFileSync(generated.articlePath, 'utf8');
  if (/Opening data, read unavailable|Editorial update unavailable for this edition/i.test(correctedArticle)) {
    throw new Error('微信纠错仍生成技术占位正文，拒绝更新远端草稿');
  }

  const repairConfig = {
    ...config,
    discord: { ...(config.discord || {}), openingDigestEnabled: false },
  };
  const result = await publish({
    articlePath: generated.articlePath,
    config: repairConfig,
    workflow,
    source: 'wechat-repair',
    contentMode: 'editorial',
    existingRemoteId: String(newsletterId),
    existingDeliveries: deliveries,
  });
  const corrected = result?.deliveries?.find((item) => item.destination === 'wechat');
  if (!corrected?.mediaId || corrected.mediaId !== wechat.media_id || corrected.status !== 'verified') {
    throw new Error(`微信纠错没有在同一个草稿完成 verified 回读:${JSON.stringify(corrected || null)}`);
  }
  const priorDetails = parseDetails(wechat.details_json);
  store.upsertDelivery(runId, {
    destination: 'wechat',
    status: 'verified',
    mediaId: corrected.mediaId,
    title: corrected.title,
    details: {
      ...priorDetails,
      correctedFromTechnicalFallback: true,
      priorTitle: wechat.title || '',
      repairDir,
      repairTracePath: generated.researchTracePath,
      attempts: corrected.details?.attempts || [],
    },
  });
  sourceTrace.openingDigestDelivery = {
    ...(sourceTrace.openingDigestDelivery || {}),
    wechatRepair: {
      status: 'verified',
      mediaId: corrected.mediaId,
      priorTitle: wechat.title || '',
      title: corrected.title,
      repairDir,
      repairTracePath: generated.researchTracePath,
      updatedAt: new Date().toISOString(),
    },
  };
  fs.writeFileSync(sourceTracePath, `${JSON.stringify(sourceTrace, null, 2)}\n`, { mode: 0o600 });
  return {
    runId,
    newsletterId,
    mediaId: corrected.mediaId,
    title: corrected.title,
    status: corrected.status,
    repairDir,
    repairTracePath: generated.researchTracePath,
  };
}

export async function repairOpeningDigestWechatReferences({
  runId,
  dbPath,
  workDir,
  config,
  now = () => new Date(),
  publish = (args) => makeChannel().publish(args),
} = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{5,100}$/.test(String(runId || ''))) {
    throw new Error('run-id 格式无效');
  }
  if (!dbPath || !fs.existsSync(dbPath)) throw new Error(`任务数据库不存在:${dbPath || '(empty)'}`);
  if (!workDir) throw new Error('缺少 WORK_DIR');
  if (!config?.openingDigest?.wechatEnabled) {
    throw new Error('OPENING_DIGEST_WECHAT_ENABLED=true 才能纠错微信草稿');
  }

  const store = openStore(dbPath);
  const run = store.getRun(runId);
  if (!run || run.workflow_id !== 'opening-digest' || run.source !== 'cron'
    || run.status !== 'done' || run.error) {
    throw new Error('只允许纠错已完成的正式 cron Opening Digest');
  }
  if (run.schedule_key !== easternDateKey(now())) {
    throw new Error('微信引用纠错只允许处理当前美东交易日的正式稿');
  }
  if (store.listByStatus('running').length || store.listByStatus('queued').length) {
    throw new Error('队列非空，拒绝与主服务任务并行纠错微信草稿');
  }
  const outbox = store.deliveryOutboxStats();
  if (outbox.pending || outbox.failed) {
    throw new Error(`delivery outbox 非空或有失败，拒绝纠错:${JSON.stringify(outbox)}`);
  }

  const newsletterId = Number(run.remote_id);
  const expectedCustomerIoId = `customerio-newsletter:${newsletterId}`;
  const deliveries = store.listDeliveries(runId);
  const customerio = deliveries.find((item) => item.destination === 'customerio');
  const wechat = deliveries.find((item) => item.destination === 'wechat');
  if (!Number.isInteger(newsletterId) || newsletterId <= 0
    || run.media_id !== expectedCustomerIoId
    || !customerio || !['delivered', 'existing'].includes(customerio.status)
    || customerio.media_id !== expectedCustomerIoId) {
    throw new Error('Customer.io 正式邮件身份无效，拒绝纠错微信草稿');
  }
  if (!wechat || wechat.status !== 'verified' || !wechat.media_id) {
    throw new Error('微信引用纠错要求已有 verified 草稿和 media_id');
  }

  const sourceDir = runWorkDir(path.join(path.resolve(workDir), 'opening-digest'), runId);
  const articlePath = path.join(sourceDir, 'article.md');
  const sourceTracePath = path.join(sourceDir, 'research-trace.json');
  for (const filename of REQUIRED_ARTIFACTS) {
    if (!fs.existsSync(path.join(sourceDir, filename))) {
      throw new Error(`Opening Digest 引用纠错缺少同源产物:${filename}`);
    }
  }
  const cachedTranslation = readJson(path.join(sourceDir, 'opening-digest-zh-CN.json'), '原始中文译文缓存');
  const leaked = (cachedTranslation.translations || []).some((unit) => (
    COMPACT_REFERENCE_MARKER.test(String(unit?.source || ''))
      || COMPACT_REFERENCE_MARKER.test(String(unit?.text || ''))
  ));
  if (!leaked) throw new Error('原中文稿未发现纯编号证据标记，拒绝执行引用纠错');

  const repairConfig = {
    ...config,
    discord: { ...(config.discord || {}), openingDigestEnabled: false },
  };
  const result = await publish({
    articlePath,
    config: repairConfig,
    workflow: openingDigest,
    source: 'wechat-repair',
    contentMode: 'editorial',
    existingRemoteId: String(newsletterId),
    existingDeliveries: deliveries,
  });
  const corrected = result?.deliveries?.find((item) => item.destination === 'wechat');
  if (!corrected?.mediaId || corrected.mediaId !== wechat.media_id || corrected.status !== 'verified') {
    throw new Error(`微信引用纠错没有在同一个草稿完成 verified 回读:${JSON.stringify(corrected || null)}`);
  }
  const priorDetails = parseDetails(wechat.details_json);
  store.upsertDelivery(runId, {
    destination: 'wechat',
    status: 'verified',
    mediaId: corrected.mediaId,
    title: corrected.title,
    details: {
      ...priorDetails,
      correctedReferenceLeak: true,
      attempts: corrected.details?.attempts || [],
    },
  });
  const sourceTrace = readJson(sourceTracePath, '原始研究轨迹');
  sourceTrace.openingDigestDelivery = {
    ...(sourceTrace.openingDigestDelivery || {}),
    wechatReferenceRepair: {
      status: 'verified',
      mediaId: corrected.mediaId,
      title: corrected.title,
      updatedAt: new Date().toISOString(),
    },
  };
  fs.writeFileSync(sourceTracePath, `${JSON.stringify(sourceTrace, null, 2)}\n`, { mode: 0o600 });
  return {
    runId,
    newsletterId,
    mediaId: corrected.mediaId,
    title: corrected.title,
    status: corrected.status,
    sourceDir,
  };
}

export async function recreateMissingOpeningDigestWechat({
  runId,
  dbPath,
  workDir,
  config,
  now = () => new Date(),
  readExistingDraft = async ({ mediaId }) => {
    const api = createWechatApi({ timeoutMs: config.wechat.timeoutMs });
    const token = await api.getAccessToken(config.wechat.appId, config.wechat.appSecret);
    return api.getDraft(token, mediaId);
  },
  publish = (args) => makeChannel().publish(args),
} = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{5,100}$/.test(String(runId || ''))) {
    throw new Error('run-id 格式无效');
  }
  if (!dbPath || !fs.existsSync(dbPath)) throw new Error(`任务数据库不存在:${dbPath || '(empty)'}`);
  if (!workDir) throw new Error('缺少 WORK_DIR');
  if (!config?.openingDigest?.wechatEnabled) {
    throw new Error('OPENING_DIGEST_WECHAT_ENABLED=true 才能重建微信草稿');
  }

  const store = openStore(dbPath);
  const run = store.getRun(runId);
  if (!run || run.workflow_id !== 'opening-digest' || run.source !== 'cron'
    || run.status !== 'done' || run.error) {
    throw new Error('只允许重建已完成的正式 cron Opening Digest');
  }
  if (run.schedule_key !== easternDateKey(now())) {
    throw new Error('微信草稿重建只允许处理当前美东交易日的正式稿');
  }
  if (store.listByStatus('running').length || store.listByStatus('queued').length) {
    throw new Error('队列非空，拒绝与主服务任务并行重建微信草稿');
  }
  const outbox = store.deliveryOutboxStats();
  if (outbox.pending || outbox.failed) {
    throw new Error(`delivery outbox 非空或有失败，拒绝重建:${JSON.stringify(outbox)}`);
  }

  const newsletterId = Number(run.remote_id);
  const expectedCustomerIoId = `customerio-newsletter:${newsletterId}`;
  const deliveries = store.listDeliveries(runId);
  const customerio = deliveries.find((item) => item.destination === 'customerio');
  const wechat = deliveries.find((item) => item.destination === 'wechat');
  if (!Number.isInteger(newsletterId) || newsletterId <= 0
    || run.media_id !== expectedCustomerIoId
    || !customerio || !['delivered', 'existing'].includes(customerio.status)
    || customerio.media_id !== expectedCustomerIoId) {
    throw new Error('Customer.io 正式邮件身份无效，拒绝重建微信草稿');
  }
  if (!wechat || wechat.status !== 'verified' || !wechat.media_id) {
    throw new Error('微信草稿重建要求数据库已有 verified 草稿和 media_id');
  }

  const sourceDir = runWorkDir(path.join(path.resolve(workDir), 'opening-digest'), runId);
  const articlePath = path.join(sourceDir, 'article.md');
  const sourceTracePath = path.join(sourceDir, 'research-trace.json');
  for (const filename of REQUIRED_ARTIFACTS) {
    if (!fs.existsSync(path.join(sourceDir, filename))) {
      throw new Error(`Opening Digest 草稿重建缺少同源产物:${filename}`);
    }
  }
  const cachedTranslation = readJson(path.join(sourceDir, 'opening-digest-zh-CN.json'), '当前中文译文缓存');
  if (cachedTranslation.schemaVersion !== OPENING_DIGEST_TRANSLATION_VERSION
    || (cachedTranslation.translations || []).some((unit) => (
      COMPACT_REFERENCE_MARKER.test(String(unit?.source || ''))
        || COMPACT_REFERENCE_MARKER.test(String(unit?.text || ''))
    ))) {
    throw new Error('当前中文译文缓存未通过引用净化版本门禁，拒绝重建');
  }
  const sourceTrace = readJson(sourceTracePath, '原始研究轨迹');
  if (!/40007:\s*invalid media_id/i.test(String(sourceTrace.openingDigestDelivery?.wechat?.error || ''))) {
    throw new Error('研究轨迹没有记录原草稿 media_id 失效，拒绝创建替代稿');
  }
  try {
    await readExistingDraft({ mediaId: wechat.media_id });
    throw new Error('原微信草稿仍可回读，拒绝创建重复草稿');
  } catch (error) {
    if (!/40007:\s*invalid media_id/i.test(String(error?.message || error))) throw error;
  }

  const repairConfig = {
    ...config,
    discord: { ...(config.discord || {}), openingDigestEnabled: false },
  };
  const result = await publish({
    articlePath,
    config: repairConfig,
    workflow: openingDigest,
    source: 'manual',
    contentMode: 'editorial',
    existingRemoteId: String(newsletterId),
    existingDeliveries: deliveries.filter((item) => item.destination !== 'wechat'),
  });
  const recreated = result?.deliveries?.find((item) => item.destination === 'wechat');
  if (!recreated?.mediaId || recreated.mediaId === wechat.media_id || recreated.status !== 'verified') {
    throw new Error(`微信替代草稿未完成 verified 回读:${JSON.stringify(recreated || null)}`);
  }
  store.upsertDelivery(runId, {
    destination: 'wechat',
    status: 'verified',
    mediaId: recreated.mediaId,
    title: recreated.title,
    details: {
      recreatedAfterMissingRemoteId: wechat.media_id,
      attempts: recreated.details?.attempts || [],
    },
  });
  store.updateRemoteOperation(runId, 'create-opening-digest-wechat', {
    state: 'confirmed',
    remoteId: recreated.mediaId,
    lastError: `replaced missing media_id:${wechat.media_id}`,
  });
  sourceTrace.openingDigestDelivery = {
    ...(sourceTrace.openingDigestDelivery || {}),
    wechat: {
      status: 'verified',
      mediaId: recreated.mediaId,
      title: recreated.title,
      recreatedAfterMissingRemoteId: wechat.media_id,
    },
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(sourceTracePath, `${JSON.stringify(sourceTrace, null, 2)}\n`, { mode: 0o600 });
  return {
    runId,
    newsletterId,
    mediaId: recreated.mediaId,
    replacedMediaId: wechat.media_id,
    title: recreated.title,
    status: recreated.status,
    sourceDir,
  };
}

function readJson(filename, label) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) { throw new Error(`${label}缺失或损坏:${error.message}`); }
}

function parseDetails(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const config = loadConfig(process.env);
    const repairVerified = process.argv[2] === '--repair-verified';
    const repairReferences = process.argv[2] === '--repair-references';
    const recreateMissing = process.argv[2] === '--recreate-missing';
    const operation = repairVerified ? repairOpeningDigestWechat
      : repairReferences ? repairOpeningDigestWechatReferences
        : recreateMissing ? recreateMissingOpeningDigestWechat : retryOpeningDigestWechat;
    const result = await operation({
      runId: repairVerified || repairReferences || recreateMissing ? process.argv[3] : process.argv[2],
      dbPath: config.dbPath,
      workDir: config.workDir,
      config,
    });
    console.log(JSON.stringify({ ok: true, ...result }));
  } catch (error) {
    console.error(`Opening Digest 微信补建失败:${error.message}`);
    process.exitCode = 1;
  }
}
