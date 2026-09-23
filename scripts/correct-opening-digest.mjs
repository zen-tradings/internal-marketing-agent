// One-off, reviewable correction to an already sent formal Opening Digest.
// The correction has its own durable journal and run directory; it never
// starts a second Slack consumer or modifies the original publication.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config/index.js';
import { openStore } from '../src/core/store.js';
import { runWriter } from '../src/core/runner.js';
import { makeChannel } from '../src/channels/customerio-opening-digest.js';
import { flushDiscordDeliveryOutbox } from '../src/core/delivery-outbox.js';
import { flushOpeningDigestWechatOutbox } from '../src/core/opening-digest-wechat-outbox.js';
import { remoteOperationsFor } from '../src/lib/remote-operation.js';
import { runWorkDir } from '../src/lib/run-workdir.js';
import { easternDateKey } from '../src/lib/us-equity-calendar.js';
import openingDigest from '../src/workflows/opening-digest.js';

const [mode, originalRunId, correctionId, briefFile] = process.argv.slice(2);
if (!['prepare', 'send'].includes(mode) || !/^[\w-]{12,80}$/.test(originalRunId || '')
  || !/^[1-9]\d?$/.test(correctionId || '') || (mode === 'prepare' && !briefFile)) {
  throw new Error('Usage: correct-opening-digest.mjs prepare|send ORIGINAL_RUN_ID CORRECTION_NUMBER [BRIEF_FILE]');
}
const config = loadConfig(process.env);
if (config.dryRun) throw new Error('更正版不允许演练数据库或演练渠道');
const original = readOriginal(config.dbPath, originalRunId);
const dateKey = easternDateKey(new Date(original.created_at));
if (dateKey !== easternDateKey(new Date())) throw new Error('更正版只允许在原日报的美东日期发送');
const runId = `opening-digest-correction-${dateKey}-${correctionId}`;
const artifactDir = runWorkDir(path.join(config.workDir, 'opening-digest'), runId);
const articlePath = path.join(artifactDir, 'article.md');
const correctionDbPath = `${config.dbPath}.opening-corrections.db`;
const store = openStore(correctionDbPath);
try {
  let run = store.getRun(runId);
  if (!run) {
    store.createRun({ id: runId, workflowId: 'opening-digest', source: 'cron',
      input: `Correction ${correctionId} to ${originalRunId}`, notify: {}, scheduleKey: `${dateKey}-correction-${correctionId}` });
    run = store.getRun(runId);
  }
  if (run.source !== 'cron' || run.workflow_id !== 'opening-digest') throw new Error('更正版运行记录身份不一致');

  if (mode === 'prepare') {
    if (store.getPublication(runId) || run.media_id) throw new Error('更正版已冻结或发送，不允许重新生成');
    fs.mkdirSync(artifactDir, { recursive: true });
    const brief = fs.readFileSync(briefFile, 'utf8');
    if (brief.length < 100 || brief.length > 30000) throw new Error('核验意见长度不在允许范围');
    fs.writeFileSync(path.join(artifactDir, 'correction-brief.txt'), brief, { mode: 0o600 });
    store.setStatus(runId, 'running', { startedAt: Date.now(), stage: 'generate' });
    const workflow = Object.create(openingDigest);
    Object.defineProperty(workflow, 'workDir', { value: artifactDir });
    const generated = await runWriter({
      workflow, config,
      input: `${openingDigest.cronInput}\n\nThis is a correction to an already sent edition. Follow the verified correction brief below, use its links as research leads, and write a fresh opening-hour edition. The brief itself is a review instruction, not a source. Mark the visible headline and lead as a correction.\n\n${brief}`,
    });
    if (!generated.ok) throw new Error(generated.stderr || '更正版生成失败');
    fs.writeFileSync(path.join(artifactDir, 'correction-meta.json'), `${JSON.stringify({
      originalRunId, correctionId, dateKey, preparedAt: new Date().toISOString(),
      articlePath: generated.articlePath, tracePath: generated.researchTracePath,
    }, null, 2)}\n`, { mode: 0o600 });
    store.setStatus(runId, 'needs_input', { stage: 'review', error: '更正版待事实和归因复核' });
    console.log(JSON.stringify({ status: 'prepared', runId, articlePath, tracePath: generated.researchTracePath }));
  } else {
    const meta = JSON.parse(fs.readFileSync(path.join(artifactDir, 'correction-meta.json'), 'utf8'));
    if (meta.originalRunId !== originalRunId || meta.correctionId !== correctionId || meta.dateKey !== dateKey) {
      throw new Error('更正版元数据与原日报不一致');
    }
    const article = fs.readFileSync(articlePath, 'utf8');
    if (!/^headline:\s*Correction\b/im.test(article)
      || !/Correction notice:/i.test(article)
      || !new RegExp(`^edition: ${dateKey}$`, 'm').test(article)) {
      throw new Error('更正版缺少明确的 Correction 标识或日期');
    }
    if (dateKey === '2026-09-23' && (!/\b58\.4\b/.test(article)
      || /\b(?:hard data|PMI[^\n.]*53\.6|Barr[^\n.]*later today)\b/i.test(article)
      || !/\b(?:denied|disputed|rejected)\b/i.test(article))) {
      throw new Error('9 月 23 日更正版缺少 PMI、伊朗否认或 Barr 已讲话后的必要修订');
    }
    store.setStatus(runId, 'running', { startedAt: Date.now(), stage: 'publish' });
    const channel = makeChannel();
    const publicationJournal = {
      get: () => store.getPublication(runId),
      prepare: payload => store.preparePublication(runId, payload),
      confirm: id => store.confirmPublication(runId, id),
    };
    const result = await channel.publish({
      publicationJournal, remoteOperations: remoteOperationsFor(store, runId), runId,
      articlePath, config, source: 'cron', correctionId,
      contentMode: 'editorial',
      onCreated: ({ remoteId }) => store.setRemoteId(runId, remoteId),
    });
    const discord = await flushDiscordDeliveryOutbox({ store, config });
    const wechat = await flushOpeningDigestWechatOutbox({ store, config });
    store.markNotificationSentByRun(runId, 'success'); // This one-off has no Slack consumer; the CLI result is its receipt.
    console.log(JSON.stringify({ status: 'published', runId, mediaId: result.mediaId,
      deliveries: store.listDeliveries(runId).map(({ destination, status, media_id }) => ({ destination, status, mediaId: media_id })),
      discord, wechat }));
  }
} catch (error) {
  store.setStatus(runId, error.stage === 'needs_review' ? 'needs_review' : 'failed', {
    stage: error.stage || mode, error: error.message, finishedAt: Date.now(),
  });
  throw error;
} finally {
  store.close();
}

function readOriginal(dbPath, runId) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    if (row?.workflow_id !== 'opening-digest' || row?.source !== 'cron' || row?.status !== 'done' || !row.media_id) {
      throw new Error('原日报不是已发送的正式 Opening Digest');
    }
    const delivered = db.prepare("SELECT 1 FROM run_deliveries WHERE run_id = ? AND destination = 'customerio' AND status = 'delivered'").get(runId);
    if (!delivered) throw new Error('原日报 Customer.io 发送记录未确认');
    return row;
  } finally { db.close(); }
}
