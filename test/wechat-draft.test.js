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
    injectFollowCard: async () => {},
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

test('publish 成功后调用 injectFollowCard(传 config/mediaId)', async () => {
  let calledWith;
  const channel = makeChannel({
    renderAndPublish: async () => 'MEDIA-9',
    readArticle: async () => ({ markdown: 'x', title: 't' }),
    injectFollowCard: async (args) => { calledWith = args; },
  });
  const config = { wechat: { appId: 'wx', appSecret: 's' } };
  const out = await channel.publish({ articlePath: '/x/a.md', config });
  assert.equal(out.mediaId, 'MEDIA-9');
  assert.equal(calledWith.mediaId, 'MEDIA-9');
  assert.equal(calledWith.config, config);
});

test('injectFollowCard 失败 → 不阻断发布,调用 notifier.warn 告警', async () => {
  const warned = [];
  const notifier = { warn: async (notify, msg) => warned.push({ notify, msg }) };
  const notify = { channel: 'C', ts: '1' };
  const channel = makeChannel({
    renderAndPublish: async () => 'MEDIA-9',
    readArticle: async () => ({ markdown: 'x', title: 't' }),
    injectFollowCard: async () => { const e = new Error('40001'); e.stage = 'card'; throw e; },
  });
  const out = await channel.publish({ articlePath: '/x/a.md', config: { wechat: { appId: 'wx', appSecret: 's' } }, notify, notifier });
  assert.equal(out.mediaId, 'MEDIA-9');
  assert.equal(warned.length, 1);
  assert.equal(warned[0].notify, notify);
  assert.match(warned[0].msg, /名片注入失败/);
  assert.match(warned[0].msg, /40001/);
});

test('injectFollowCard 失败但未传 notifier/notify → 静默继续,不抛错', async () => {
  const channel = makeChannel({
    renderAndPublish: async () => 'MEDIA-9',
    readArticle: async () => ({ markdown: 'x', title: 't' }),
    injectFollowCard: async () => { throw new Error('网络错误'); },
  });
  const out = await channel.publish({ articlePath: '/x/a.md', config: { wechat: { appId: 'wx', appSecret: 's' } } });
  assert.equal(out.mediaId, 'MEDIA-9');
});

test('publish 成功后恢复 process.env 的原值', async () => {
  const prevAppId = process.env.WECHAT_APP_ID;
  const prevAppSecret = process.env.WECHAT_APP_SECRET;
  const channel = makeChannel({
    renderAndPublish: async () => 'MEDIA-9',
    readArticle: async () => ({ markdown: 'x', title: 't' }),
    injectFollowCard: async () => {},
  });
  await channel.publish({ articlePath: '/x/a.md', config: { wechat: { appId: 'wx', appSecret: 's' } } });
  assert.equal(process.env.WECHAT_APP_ID, prevAppId);
  assert.equal(process.env.WECHAT_APP_SECRET, prevAppSecret);
});

test('injectFollowCard 和 notifier.warn 都抛错 → publish 仍返回 mediaId/title,不标记 stage=publish', async () => {
  const notifier = { warn: async () => { throw new Error('Slack 网络错误'); } };
  const notify = { channel: 'C', ts: '1' };
  const channel = makeChannel({
    renderAndPublish: async () => 'MEDIA-9',
    readArticle: async () => ({ markdown: 'x', title: 't' }),
    injectFollowCard: async () => { throw new Error('40001'); },
  });
  const out = await channel.publish({ articlePath: '/x/a.md', config: { wechat: { appId: 'wx', appSecret: 's' } }, notify, notifier });
  assert.equal(out.mediaId, 'MEDIA-9');
  assert.equal(out.title, 't');
});
