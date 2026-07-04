import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeChannel, RENDER_OPTS } from '../src/channels/wechat-draft.js';

test('RENDER_OPTS 与 wenyan-mcp 复刻一致', () => {
  assert.deepEqual(RENDER_OPTS, { theme: 'zen-trading', highlight: 'solarized-light', macStyle: true, footnote: true });
});

test('publish 调 renderAndPublish 并返回 mediaId/title', async () => {
  let calledWith;
  const channel = makeChannel({
    renderAndPublish: async (content, opts) => { calledWith = { content, opts }; return 'MEDIA-9'; },
    readArticle: async () => ({ markdown: '---\ntitle: 英伟达\n---\n正文', title: '英伟达' }),
  });
  const out = await channel.publish({ articlePath: '/x/article.md', config: { wechat: { appId: 'wx', appSecret: 's' } } });
  assert.equal(out.mediaId, 'MEDIA-9');
  assert.equal(out.title, '英伟达');
  assert.equal(calledWith.opts.theme, 'zen-trading');
  assert.equal(calledWith.opts.file, '/x/article.md');
});

test('renderAndPublish 抛错 → stage=publish', async () => {
  const channel = makeChannel({
    renderAndPublish: async () => { throw new Error('40164'); },
    readArticle: async () => ({ markdown: 'x', title: 't' }),
  });
  await assert.rejects(() => channel.publish({ articlePath: '/x/a.md', config: { wechat: {} } }), (e) => { assert.equal(e.stage, 'publish'); return true; });
});
