import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeChannel, RENDER_OPTS } from '../src/channels/wechat-draft.js';

const stubCover = { generateCover: async () => '/x/cover.png', writeArticle: async () => {} };

test('RENDER_OPTS 与 wenyan-mcp 复刻一致', () => {
  assert.deepEqual(RENDER_OPTS, { theme: 'zen-trading', highlight: 'solarized-light', macStyle: true, footnote: true });
});

test('publish 调 renderAndPublish 并返回 mediaId/title', async () => {
  let calledWith;
  const channel = makeChannel({
    ...stubCover,
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
    ...stubCover,
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
    ...stubCover,
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
    ...stubCover,
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
    ...stubCover,
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
    ...stubCover,
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
    ...stubCover,
    renderAndPublish: async () => 'MEDIA-9',
    readArticle: async () => ({ markdown: 'x', title: 't' }),
    injectFollowCard: async () => { throw new Error('40001'); },
  });
  const out = await channel.publish({ articlePath: '/x/a.md', config: { wechat: { appId: 'wx', appSecret: 's' } }, notify, notifier });
  assert.equal(out.mediaId, 'MEDIA-9');
  assert.equal(out.title, 't');
});

test('publish 前先生成封面并写入 frontmatter(传给 renderAndPublish 前文件已含 cover)', async () => {
  let writtenMarkdown;
  let generateCoverArgs;
  const channel = makeChannel({
    generateCover: async (args) => { generateCoverArgs = args; return '/out/cover.png'; },
    writeArticle: async (p, content) => { writtenMarkdown = content; },
    renderAndPublish: async () => 'MEDIA-9',
    readArticle: async () => ({ markdown: '---\ntitle: T\n---\n正文', title: 'T' }),
    injectFollowCard: async () => {},
  });
  const out = await channel.publish({ articlePath: '/out/article.md', config: { wechat: { appId: 'wx', appSecret: 's' } } });
  assert.equal(out.mediaId, 'MEDIA-9');
  assert.equal(generateCoverArgs.title, 'T');
  assert.equal(generateCoverArgs.outDir, '/out');
  assert.match(writtenMarkdown, /cover:\s*\/out\/cover\.png/);
});

test('frontmatter 已有 cover 时不重复写文件', async () => {
  let writeCalled = false;
  const channel = makeChannel({
    generateCover: async () => '/out/new-cover.png',
    writeArticle: async () => { writeCalled = true; },
    renderAndPublish: async () => 'MEDIA-9',
    readArticle: async () => ({ markdown: '---\ntitle: T\ncover: /old.png\n---\n正文', title: 'T' }),
    injectFollowCard: async () => {},
  });
  await channel.publish({ articlePath: '/out/article.md', config: { wechat: { appId: 'wx', appSecret: 's' } } });
  assert.equal(writeCalled, false);
});

test('封面生成失败 → notifier.warn 告警,抛错 stage=cover,不调用 renderAndPublish', async () => {
  const warned = [];
  const notifier = { warn: async (notify, msg) => warned.push({ notify, msg }) };
  const notify = { channel: 'C', ts: '1' };
  let renderCalled = false;
  const channel = makeChannel({
    generateCover: async () => { throw new Error('Chrome 未安装'); },
    renderAndPublish: async () => { renderCalled = true; return 'MEDIA-9'; },
    readArticle: async () => ({ markdown: 'x', title: 't' }),
  });
  await assert.rejects(
    () => channel.publish({ articlePath: '/x/a.md', config: { wechat: { appId: 'wx', appSecret: 's' } }, notify, notifier }),
    (e) => { assert.equal(e.stage, 'cover'); return true; }
  );
  assert.equal(renderCalled, false);
  assert.equal(warned.length, 1);
  assert.match(warned[0].msg, /封面生成失败/);
  assert.match(warned[0].msg, /Chrome 未安装/);
});

test('封面生成失败且未传 notifier/notify → 仍抛错 stage=cover,不崩溃', async () => {
  const channel = makeChannel({
    generateCover: async () => { throw new Error('生成器退出码非0'); },
    renderAndPublish: async () => 'MEDIA-9',
    readArticle: async () => ({ markdown: 'x', title: 't' }),
  });
  await assert.rejects(
    () => channel.publish({ articlePath: '/x/a.md', config: { wechat: { appId: 'wx', appSecret: 's' } } }),
    (e) => { assert.equal(e.stage, 'cover'); return true; }
  );
});

test('notifier.warn 本身抛错 → 不掩盖 stage=cover 错误', async () => {
  const notifier = { warn: async () => { throw new Error('Slack 网络错误'); } };
  const notify = { channel: 'C', ts: '1' };
  const channel = makeChannel({
    generateCover: async () => { throw new Error('封面生成器崩溃'); },
    renderAndPublish: async () => 'MEDIA-9',
    readArticle: async () => ({ markdown: 'x', title: 't' }),
  });
  await assert.rejects(
    () => channel.publish({ articlePath: '/x/a.md', config: { wechat: { appId: 'wx', appSecret: 's' } }, notify, notifier }),
    (e) => { assert.equal(e.stage, 'cover'); return true; }
  );
});
