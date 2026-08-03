import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier } from '../src/core/notifier.js';

test('success/failure 文案带关键信息', async () => {
  const sent = [];
  const n = createNotifier(async (m) => sent.push(m));
  await n.success({ channel: 'C', ts: '1' }, { title: '英伟达财报', mediaId: 'M123' });
  await n.progress({ channel: 'C', ts: '1' }, { message: '全文翻译进度 2/8' });
  await n.failure({ channel: 'C', ts: '1' }, { stage: 'publish', error: '40164 whitelist' });
  await n.cancelled({ channel: 'C', ts: '1' }, { runId: 'R1', cleaned: true });
  assert.match(sent[0].text, /✅/);
  assert.match(sent[0].text, /英伟达财报/);
  assert.match(sent[0].text, /M123/);
  assert.equal(sent[0].thread_ts, '1');
  assert.match(sent[1].text, /⏳/);
  assert.match(sent[1].text, /2\/8/);
  assert.match(sent[2].text, /❌/);
  assert.match(sent[2].text, /publish/);
  assert.match(sent[2].text, /40164/);
  assert.match(sent[3].text, /任务已停止/);
  assert.match(sent[3].text, /未完成文件已清理/);
});

test('直译成功通知只在 PDF 有页级记录时报告真实覆盖页数', async () => {
  const sent = [];
  const n = createNotifier(async (message) => sent.push(message));
  await n.success({ channel: 'C', ts: '1' }, {
    title: 'PDF 直译',
    mediaId: 'M-PDF',
    completeness: { errors: [], pagesProcessed: 37, pagesFound: Array.from({ length: 37 }) },
  });
  await n.success({ channel: 'C', ts: '1' }, {
    title: 'HTML 直译',
    mediaId: 'M-HTML',
    completeness: { errors: [] },
  });
  assert.match(sent[0].text, /覆盖页码 37 页/);
  assert.doesNotMatch(sent[1].text, /覆盖页码 0 页/);
  assert.match(sent[1].text, /完整性:通过/);
});

test('入队回执显示 Prompt 修订、精确实体、链接数量与完整要求，澄清消息只问一个问题', async () => {
  const sent = [];
  const n = createNotifier(async (message) => sent.push(message));
  await n.ack({
    channel: 'C',
    ts: '1',
    routeLabel: '原创分析 → 微信草稿箱',
    promptRevision: 3,
    promptEntities: ['Opus 5', 'Kimi K2'],
    userUrlCount: 1,
    freshnessRequirement: '最新信息',
  }, 'please compare Opus 5 and Kimi K2 using https://example.com/source');
  await n.needsInput({ channel: 'C', ts: '1' }, {
    question: '请确认 Opus 5 的官方发布链接。',
    details: { conflicts: [{ description: '用户链接与官方页面的型号不同' }] },
  });
  assert.match(sent[0].text, /Prompt 修订:3/);
  assert.match(sent[0].text, /Opus 5、Kimi K2/);
  assert.match(sent[0].text, /用户链接:1/);
  assert.match(sent[0].text, /完整要求/);
  assert.match(sent[1].text, /需要确认/);
  assert.match(sent[1].text, /用户链接与官方页面的型号不同/);
  assert.match(sent[1].text, /请确认 Opus 5/);
});
