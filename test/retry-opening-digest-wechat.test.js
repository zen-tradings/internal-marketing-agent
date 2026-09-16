import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/core/store.js';
import { runWorkDir } from '../src/lib/run-workdir.js';
import { OPENING_DIGEST_TRANSLATION_VERSION } from '../src/lib/opening-digest-translation.js';
import {
  recreateMissingOpeningDigestWechat,
  repairOpeningDigestWechat,
  repairOpeningDigestWechatReferences,
  retryOpeningDigestWechat,
} from '../scripts/retry-opening-digest-wechat.mjs';

function fixture({ wechatError = 'Opening Digest 中文直译硬校验失败:body-3(URL 不一致)' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-opening-wechat-'));
  const dbPath = path.join(root, 'runs.db');
  const workDir = path.join(root, 'work');
  const runId = '1788876900013-umab4';
  const store = openStore(dbPath);
  store.createRun({
    id: runId,
    workflowId: 'opening-digest',
    source: 'cron',
    input: 'opening',
    notify: {},
    scheduleKey: '2026-09-08',
  });
  store.setRemoteId(runId, '66');
  store.upsertDelivery(runId, {
    destination: 'customerio', status: 'delivered',
    mediaId: 'customerio-newsletter:66', title: 'Zen Opening Digest · 2026-09-08',
  });
  store.upsertDelivery(runId, {
    destination: 'wechat', status: 'failed', error: wechatError,
  });
  store.setStatus(runId, 'done', {
    mediaId: 'customerio-newsletter:66',
    title: 'Zen Opening Digest · 2026-09-08',
    finishedAt: Date.now(),
  });
  const sourceDir = runWorkDir(path.join(workDir, 'opening-digest'), runId);
  fs.mkdirSync(sourceDir, { recursive: true });
  for (const filename of [
    'article.md',
    'article.md.opening-digest-state.json',
    'opening-digest-universe.json',
    'research-trace.json',
  ]) fs.writeFileSync(path.join(sourceDir, filename), filename.endsWith('.md') ? '# article' : '{}');
  return {
    root, dbPath, workDir, runId, store, sourceDir,
    config: { openingDigest: { wechatEnabled: true }, discord: { openingDigestEnabled: true } },
  };
}

test('受限命令只复用成功邮件和同源产物补建正式微信稿', async (t) => {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  let input;
  const result = await retryOpeningDigestWechat({
    ...value,
    publish: async (args) => {
      input = args;
      return { deliveries: [{
        destination: 'wechat', status: 'verified', mediaId: 'wx-recovered',
        title: '油价与 AI 拉锯（日报· 2026-09-08）', details: { attempts: [{ status: 'verified' }] },
      }] };
    },
  });
  assert.equal(result.mediaId, 'wx-recovered');
  assert.equal(input.existingRemoteId, '66');
  assert.equal(input.source, 'cron');
  assert.equal(input.config.discord.openingDigestEnabled, false);
  assert.equal(input.articlePath, path.join(value.sourceDir, 'article.md'));
  const delivery = value.store.listDeliveries(value.runId).find((item) => item.destination === 'wechat');
  assert.equal(delivery.status, 'verified');
  assert.equal(delivery.media_id, 'wx-recovered');
  assert.equal(value.store.getRun(value.runId).media_id, 'customerio-newsletter:66');
});

test('受限命令拒绝非翻译门禁失败、已有微信 media_id 和非空队列', async (t) => {
  const wrongError = fixture({ wechatError: '微信 draft/add 网络失败' });
  t.after(() => fs.rmSync(wrongError.root, { recursive: true, force: true }));
  await assert.rejects(retryOpeningDigestWechat({
    ...wrongError,
    publish: async () => { throw new Error('不应调用'); },
  }), /不是可安全恢复的翻译门禁失败/);

  const existing = fixture();
  t.after(() => fs.rmSync(existing.root, { recursive: true, force: true }));
  existing.store.upsertDelivery(existing.runId, {
    destination: 'wechat', status: 'failed', mediaId: 'wx-existing',
    error: 'Opening Digest 中文直译硬校验失败:body-3',
  });
  await assert.rejects(retryOpeningDigestWechat({
    ...existing,
    publish: async () => { throw new Error('不应调用'); },
  }), /不是可安全恢复的翻译门禁失败/);

  const busy = fixture();
  t.after(() => fs.rmSync(busy.root, { recursive: true, force: true }));
  busy.store.createRun({ id: 'another-queued-run', workflowId: 'wechat', source: 'slack', input: 'x', notify: {} });
  await assert.rejects(retryOpeningDigestWechat({
    ...busy,
    publish: async () => { throw new Error('不应调用'); },
  }), /队列非空/);
});

test('正文模型技术失败可重新生成并只更新同一个 verified 微信草稿', async (t) => {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  value.store.upsertDelivery(value.runId, {
    destination: 'wechat',
    status: 'verified',
    mediaId: 'wx-existing',
    title: '开盘数据，读取不可用（日报· 2026-09-08）',
    details: { attempts: [{ status: 'verified' }] },
  });
  fs.writeFileSync(path.join(value.sourceDir, 'research-trace.json'), JSON.stringify({
    contentMode: 'data-only',
    fallbackReason: 'OpenRouter completion failed: 400 Reasoning is mandatory and cannot be disabled',
    openingDigestDelivery: {},
  }));
  let publishInput;
  const result = await repairOpeningDigestWechat({
    ...value,
    now: () => new Date('2026-09-08T15:00:00.000Z'),
    generate: async ({ workflow }) => {
      const articlePath = path.join(workflow.workDir, 'article.md');
      const tracePath = path.join(workflow.workDir, 'research-trace.json');
      fs.writeFileSync(articlePath, '---\ntitle: Zen Opening Digest\nheadline: AI pressure meets rates\npreheader: Corrected read.\nedition: 2026-09-08\n---\nA complete evidence-bound editorial read.');
      fs.writeFileSync(tracePath, JSON.stringify({ contentMode: 'editorial' }));
      return { ok: true, contentMode: 'editorial', articlePath, researchTracePath: tracePath };
    },
    publish: async (input) => {
      publishInput = input;
      return { deliveries: [{
        destination: 'wechat', status: 'verified', mediaId: 'wx-existing',
        title: 'AI承压叠加利率（日报· 2026-09-08）', details: { attempts: [{ status: 'verified', updated: true }] },
      }] };
    },
  });
  assert.equal(result.mediaId, 'wx-existing');
  assert.equal(publishInput.source, 'wechat-repair');
  assert.equal(publishInput.existingRemoteId, '66');
  assert.equal(publishInput.config.discord.openingDigestEnabled, false);
  const delivery = value.store.listDeliveries(value.runId).find((item) => item.destination === 'wechat');
  assert.equal(delivery.status, 'verified');
  assert.equal(delivery.media_id, 'wx-existing');
  assert.equal(JSON.parse(delivery.details_json).correctedFromTechnicalFallback, true);
  const sourceTrace = JSON.parse(fs.readFileSync(path.join(value.sourceDir, 'research-trace.json'), 'utf8'));
  assert.equal(sourceTrace.openingDigestDelivery.wechatRepair.mediaId, 'wx-existing');
});

test('纯编号引用泄漏可净化并只更新当天同一个 verified 微信草稿', async (t) => {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  value.store.upsertDelivery(value.runId, {
    destination: 'wechat',
    status: 'verified',
    mediaId: 'wx-existing',
    title: '收益率承压（日报· 2026-09-08）',
    details: { attempts: [{ status: 'verified' }] },
  });
  fs.writeFileSync(path.join(value.sourceDir, 'opening-digest-zh-CN.json'), JSON.stringify({
    schemaVersion: 19,
    translations: [{ id: 'body-1', source: 'Yield pressure【5】.', text: '收益率承压【5】。' }],
  }));
  let publishInput;
  const result = await repairOpeningDigestWechatReferences({
    ...value,
    now: () => new Date('2026-09-08T15:00:00.000Z'),
    publish: async (input) => {
      publishInput = input;
      return { deliveries: [{
        destination: 'wechat', status: 'verified', mediaId: 'wx-existing',
        title: '收益率承压（日报· 2026-09-08）', details: { attempts: [{ status: 'verified', updated: true }] },
      }] };
    },
  });
  assert.equal(result.mediaId, 'wx-existing');
  assert.equal(publishInput.source, 'wechat-repair');
  assert.equal(publishInput.existingRemoteId, '66');
  assert.equal(publishInput.config.discord.openingDigestEnabled, false);
  const delivery = value.store.listDeliveries(value.runId).find((item) => item.destination === 'wechat');
  assert.equal(delivery.status, 'verified');
  assert.equal(JSON.parse(delivery.details_json).correctedReferenceLeak, true);
  const sourceTrace = JSON.parse(fs.readFileSync(path.join(value.sourceDir, 'research-trace.json'), 'utf8'));
  assert.equal(sourceTrace.openingDigestDelivery.wechatReferenceRepair.mediaId, 'wx-existing');
});

test('已确认远端删除的当天草稿可用净化缓存安全重建一次', async (t) => {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  value.store.upsertDelivery(value.runId, {
    destination: 'wechat', status: 'verified', mediaId: 'wx-missing',
    title: '收益率承压（日报· 2026-09-08）',
  });
  fs.writeFileSync(path.join(value.sourceDir, 'opening-digest-zh-CN.json'), JSON.stringify({
    schemaVersion: OPENING_DIGEST_TRANSLATION_VERSION,
    translations: [{ id: 'body-1', source: 'Yield pressure.', text: '收益率承压。' }],
  }));
  fs.writeFileSync(path.join(value.sourceDir, 'research-trace.json'), JSON.stringify({
    openingDigestDelivery: { wechat: { status: 'failed', error: '微信 draft/get 暂不可用:40007: invalid media_id hint' } },
  }));
  value.store.prepareRemoteOperation({
    runId: value.runId,
    operation: 'create-opening-digest-wechat',
    operationKey: `wechat:opening-digest:create:v1:${value.runId}`,
    payloadSha256: 'old-payload',
  });
  value.store.updateRemoteOperation(value.runId, 'create-opening-digest-wechat', {
    state: 'confirmed', remoteId: 'wx-missing',
  });
  let publishInput;
  const result = await recreateMissingOpeningDigestWechat({
    ...value,
    now: () => new Date('2026-09-08T15:00:00.000Z'),
    readExistingDraft: async () => { throw new Error('40007: invalid media_id hint'); },
    publish: async (input) => {
      publishInput = input;
      return { deliveries: [{
        destination: 'wechat', status: 'verified', mediaId: 'wx-recreated',
        title: '收益率承压（日报· 2026-09-08）', details: { attempts: [{ status: 'verified' }] },
      }] };
    },
  });
  assert.equal(result.mediaId, 'wx-recreated');
  assert.equal(result.replacedMediaId, 'wx-missing');
  assert.equal(publishInput.source, 'manual');
  assert.equal(publishInput.existingRemoteId, '66');
  assert.equal(publishInput.existingDeliveries.some((item) => item.destination === 'wechat'), false);
  const delivery = value.store.listDeliveries(value.runId).find((item) => item.destination === 'wechat');
  assert.equal(delivery.media_id, 'wx-recreated');
  assert.equal(JSON.parse(delivery.details_json).recreatedAfterMissingRemoteId, 'wx-missing');
  assert.equal(value.store.getRemoteOperation(value.runId, 'create-opening-digest-wechat').remote_id, 'wx-recreated');
});
