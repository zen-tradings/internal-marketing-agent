import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier } from '../src/core/notifier.js';

test('success/failure 文案带关键信息', async () => {
  const sent = [];
  const n = createNotifier(async (m) => sent.push(m));
  await n.success({ channel: 'C', ts: '1' }, { title: '英伟达财报', mediaId: 'M123' });
  await n.progress({ channel: 'C', ts: '1' }, { message: '全文翻译进度 2/8' });
  await n.failure({ channel: 'C', ts: '1' }, { stage: 'publish', error: '40164 whitelist' });
  assert.match(sent[0].text, /✅/);
  assert.match(sent[0].text, /英伟达财报/);
  assert.match(sent[0].text, /M123/);
  assert.equal(sent[0].thread_ts, '1');
  assert.match(sent[1].text, /⏳/);
  assert.match(sent[1].text, /2\/8/);
  assert.match(sent[2].text, /❌/);
  assert.match(sent[2].text, /publish/);
  assert.match(sent[2].text, /40164/);
});
