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
  await assert.rejects(() => channel.publish({ articlePath: '/x/a.md', config: { wechat: { appId: 'wx', appSecret: 's' } } }), (e) => { assert.equal(e.stage, 'publish'); return true; });
});

test('readArticle 抛错 → stage=render', async () => {
  const channel = makeChannel({
    renderAndPublish: async () => 'MEDIA-X',
    readArticle: async () => { throw new Error('文件不存在'); },
  });
  await assert.rejects(
    () => channel.publish({ articlePath: '/x/missing.md', config: { wechat: { appId: 'wx', appSecret: 's' } } }),
    (e) => { assert.equal(e.stage, 'render'); return true; }
  );
});

test('缺失微信凭据 → stage=publish 且不调用 renderAndPublish', async () => {
  let called = false;
  const channel = makeChannel({
    renderAndPublish: async () => { called = true; return 'MEDIA-X'; },
    readArticle: async () => ({ markdown: 'x', title: 't' }),
  });
  await assert.rejects(
    () => channel.publish({ articlePath: '/x/a.md', config: { wechat: {} } }),
    (e) => { assert.equal(e.stage, 'publish'); return true; }
  );
  assert.equal(called, false);
});

test('publish 成功后恢复 process.env 的原值', async () => {
  const prevAppId = process.env.WECHAT_APP_ID;
  const prevAppSecret = process.env.WECHAT_APP_SECRET;
  const channel = makeChannel({
    renderAndPublish: async () => 'MEDIA-9',
    readArticle: async () => ({ markdown: 'x', title: 't' }),
  });
  await channel.publish({ articlePath: '/x/a.md', config: { wechat: { appId: 'wx', appSecret: 's' } } });
  assert.equal(process.env.WECHAT_APP_ID, prevAppId);
  assert.equal(process.env.WECHAT_APP_SECRET, prevAppSecret);
});
