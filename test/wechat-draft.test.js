import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeChannel,
  RENDER_OPTS,
  WECHAT_TEMPLATE_ID,
} from '../src/channels/wechat-draft.js';

// 合规、无破折号/美元符号的完整文章,门禁应零 errors/零 warnings,
// 避免门禁的 notifier.warn 调用干扰各测试对 warned 数组长度/内容的断言。
const VALID_MD = [
  '---',
  'title: 测试标题',
  '---',
  '正文内容,符合规范。',
  '',
].join('\n');

const stubCover = { generateCover: async () => '/x/cover.png', writeArticle: async () => {} };

test('RENDER_OPTS 固定为普通微信公众号版式', () => {
  assert.deepEqual(RENDER_OPTS, { theme: 'zen-trading', highlight: 'solarized-light', macStyle: false, footnote: false });
  assert.equal(Object.isFrozen(RENDER_OPTS), true);
  const channel = makeChannel();
  assert.equal(channel.templateId, WECHAT_TEMPLATE_ID);
  assert.equal(channel.templateLocked, true);
});

test('publish 调 renderAndPublish 并返回 mediaId/title', async () => {
  let calledWith;
  const channel = makeChannel({
    ...stubCover,
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
    ...stubCover,
    renderAndPublish: async () => { throw new Error('40164'); },
    readArticle: async () => ({ markdown: VALID_MD, title: 't' }),
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

test('微信发布不再检查公网 IP 或调用旧出口钩子', async () => {
  let renderCalled = false;
  const channel = makeChannel({
    ...stubCover,
    readArticle: async () => ({ markdown: VALID_MD, title: 't' }),
    assertExpectedEgress: async () => { throw new Error('旧钩子不应调用'); },
    renderAndPublish: async () => { renderCalled = true; return 'MEDIA-X'; },
  });
  const result = await channel.publish({
    articlePath: '/x/a.md',
    config: { wechat: { appId: 'wx', appSecret: 's' }, egress: { enabled: true } },
  });
  assert.equal(renderCalled, true);
  assert.equal(result.mediaId, 'MEDIA-X');
});

test('publish 成功后恢复 process.env 的原值', async () => {
  const prevAppId = process.env.WECHAT_APP_ID;
  const prevAppSecret = process.env.WECHAT_APP_SECRET;
  const channel = makeChannel({
    ...stubCover,
    renderAndPublish: async () => 'MEDIA-9',
    readArticle: async () => ({ markdown: VALID_MD, title: 't' }),
  });
  await channel.publish({ articlePath: '/x/a.md', config: { wechat: { appId: 'wx', appSecret: 's' } } });
  assert.equal(process.env.WECHAT_APP_ID, prevAppId);
  assert.equal(process.env.WECHAT_APP_SECRET, prevAppSecret);
});

test('publish 前先生成封面并写入 frontmatter(传给 renderAndPublish 前文件已含 cover)', async () => {
  let writtenMarkdown;
  let generateCoverArgs;
  const channel = makeChannel({
    generateCover: async (args) => { generateCoverArgs = args; return '/out/cover.png'; },
    writeArticle: async (p, content) => { writtenMarkdown = content; },
    renderAndPublish: async () => 'MEDIA-9',
    readArticle: async () => ({ markdown: '---\ntitle: T\n---\n正文', title: 'T' }),
  });
  const out = await channel.publish({ articlePath: '/out/article.md', config: { wechat: { appId: 'wx', appSecret: 's' } } });
  assert.equal(out.mediaId, 'MEDIA-9');
  assert.equal(generateCoverArgs.title, 'T');
  assert.equal(generateCoverArgs.outDir, '/out');
  assert.match(writtenMarkdown, /cover:\s*\/out\/cover\.png/);
});

test('frontmatter 已有 cover 时替换为本次生成的新封面', async () => {
  let writtenMarkdown;
  const channel = makeChannel({
    generateCover: async () => '/out/new-cover.png',
    writeArticle: async (p, content) => { writtenMarkdown = content; },
    renderAndPublish: async () => 'MEDIA-9',
    readArticle: async () => ({ markdown: '---\ntitle: T\ncover: /old.png\n---\n正文', title: 'T' }),
  });
  await channel.publish({ articlePath: '/out/article.md', config: { wechat: { appId: 'wx', appSecret: 's' } } });
  assert.match(writtenMarkdown, /cover:\s*\/out\/new-cover\.png/);
  assert.doesNotMatch(writtenMarkdown, /\/old\.png/);
});

test('封面生成失败 → notifier.warn 告警,抛错 stage=cover,不调用 renderAndPublish', async () => {
  const warned = [];
  const notifier = { warn: async (notify, msg) => warned.push({ notify, msg }) };
  const notify = { channel: 'C', ts: '1' };
  let renderCalled = false;
  const channel = makeChannel({
    generateCover: async () => { throw new Error('Chrome 未安装'); },
    renderAndPublish: async () => { renderCalled = true; return 'MEDIA-9'; },
    readArticle: async () => ({ markdown: VALID_MD, title: 't' }),
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
    readArticle: async () => ({ markdown: VALID_MD, title: 't' }),
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
    readArticle: async () => ({ markdown: VALID_MD, title: 't' }),
  });
  await assert.rejects(
    () => channel.publish({ articlePath: '/x/a.md', config: { wechat: { appId: 'wx', appSecret: 's' } }, notify, notifier }),
    (e) => { assert.equal(e.stage, 'cover'); return true; }
  );
});

// ---- 门禁(gate)接线 ----

test('门禁 errors 命中 → notifier.warn 汇总告警,抛错 stage=gate,不调用 injectFixedImages/generateCover/renderAndPublish', async () => {
  const warned = [];
  const notifier = { warn: async (notify, msg) => warned.push({ notify, msg }) };
  const notify = { channel: 'C', ts: '1' };
  let injectCalled = false;
  let coverCalled = false;
  let renderCalled = false;
  const channel = makeChannel({
    readArticle: async () => ({ markdown: '无 frontmatter 的正文', title: 't' }),
    injectFixedImages: (md) => { injectCalled = true; return { markdown: md, skipped: [] }; },
    generateCover: async () => { coverCalled = true; return '/x/cover.png'; },
    writeArticle: async () => {},
    renderAndPublish: async () => { renderCalled = true; return 'MEDIA-9'; },
  });
  await assert.rejects(
    () => channel.publish({ articlePath: '/x/a.md', config: { wechat: { appId: 'wx', appSecret: 's' } }, notify, notifier }),
    (e) => { assert.equal(e.stage, 'gate'); return true; }
  );
  assert.equal(injectCalled, false);
  assert.equal(coverCalled, false);
  assert.equal(renderCalled, false);
  assert.equal(warned.length, 1);
  assert.match(warned[0].msg, /门禁拦截/);
  assert.match(warned[0].msg, /title/);
});

test('门禁 errors 命中且未传 notifier/notify → 仍抛错 stage=gate,不崩溃', async () => {
  const channel = makeChannel({
    readArticle: async () => ({ markdown: '无 frontmatter 的正文', title: 't' }),
    renderAndPublish: async () => 'MEDIA-9',
  });
  await assert.rejects(
    () => channel.publish({ articlePath: '/x/a.md', config: { wechat: { appId: 'wx', appSecret: 's' } } }),
    (e) => { assert.equal(e.stage, 'gate'); return true; }
  );
});

test('门禁 warnings 命中 → notifier.warn 告警后继续发布(不阻断)', async () => {
  const warned = [];
  const notifier = { warn: async (notify, msg) => warned.push({ notify, msg }) };
  const notify = { channel: 'C', ts: '1' };
  const mdWithDash = '---\ntitle: T\n---\n正文含破折号——用法。\n\nZEN TRADING STRATEGIES\n板块模型 · 量化策略 · 前沿解读\n本文为研究用途,不构成任何投资建议。\n';
  const channel = makeChannel({
    ...stubCover,
    readArticle: async () => ({ markdown: mdWithDash, title: 'T' }),
    renderAndPublish: async () => 'MEDIA-9',
  });
  const out = await channel.publish({ articlePath: '/x/a.md', config: { wechat: { appId: 'wx', appSecret: 's' } }, notify, notifier });
  assert.equal(out.mediaId, 'MEDIA-9');
  assert.equal(warned.length, 1);
  assert.match(warned[0].msg, /门禁提醒/);
  assert.match(warned[0].msg, /破折号/);
});

test('不可读宽表在门禁前自动拆分并写回,随后继续发布', async () => {
  const warned = [];
  const writes = [];
  let gateInput;
  const markdown = [
    '---', 'title: T', '---',
    '| 报告期 | 营业收入（亿元） | 同比增速 | 毛利率 | 净利润/归母净利润（亿元） |',
    '|---|---:|---:|---:|---:|',
    '| 2025年 | 617.99 | 155.60% | 41.02% | 18.75 |',
  ].join('\n');
  const channel = makeChannel({
    generateCover: async () => '/out/cover.png',
    readArticle: async () => ({ markdown, title: 'T' }),
    writeArticle: async (path, content) => writes.push(content),
    checkArticle: (md) => { gateInput = md; return { errors: [], warnings: [] }; },
    injectFixedImages: (md) => ({ markdown: md, skipped: [] }),
    renderAndPublish: async () => 'MEDIA-WIDE',
  });
  const out = await channel.publish({
    articlePath: '/out/article.md',
    config: { wechat: { appId: 'wx', appSecret: 's' } },
    notify: { channel: 'C', ts: '1' },
    notifier: { warn: async (notify, message) => warned.push(message) },
  });
  assert.equal(out.mediaId, 'MEDIA-WIDE');
  assert.match(gateInput, /\| 报告期 \| 净利润\/归母净利润（亿元） \|/);
  assert.ok(writes.some((content) => content.includes('| 报告期 | 净利润/归母净利润（亿元） |')));
  assert.ok(warned.some((message) => /自动将 1 个宽表拆为 2 个/.test(message)));
});

test('重试时系统写入的 cover 与固定图本地路径不触发门禁,正文路径仍由门禁检查', async () => {
  const retriedMarkdown = [
    '---',
    'title: T',
    'cover: /Users/zen/cover.png',
    '---',
    '![Zen Trading](/Users/zen/header.gif)',
    '正文内容。',
    '![Zen Trading 社群](/Users/zen/footer.png)',
  ].join('\n');
  const channel = makeChannel({
    ...stubCover,
    readArticle: async () => ({ markdown: retriedMarkdown, title: 'T' }),
    injectFixedImages: (md) => ({ markdown: md, skipped: [] }),
    renderAndPublish: async () => 'MEDIA-RETRY',
  });
  const out = await channel.publish({
    articlePath: '/x/a.md',
    config: { wechat: { appId: 'wx', appSecret: 's' }, assets: { headerImage: '/Users/zen/header.gif', footerImage: '/Users/zen/footer.png' } },
  });
  assert.equal(out.mediaId, 'MEDIA-RETRY');
});

// ---- 固定头尾图注入(assets)接线 ----

test('注入头尾图后写回 article.md,渲染前 markdown 已含固定图,generateCover 收到注入后的 markdown', async () => {
  let writtenMarkdown;
  let generateCoverArgs;
  const channel = makeChannel({
    generateCover: async (args) => { generateCoverArgs = args; return '/out/cover.png'; },
    writeArticle: async (p, content) => { writtenMarkdown = content; },
    renderAndPublish: async () => 'MEDIA-9',
    readArticle: async () => ({ markdown: VALID_MD, title: 't' }),
    injectFixedImages: (md) => ({ markdown: `${md}\n![Zen Trading 社群](/abs/footer.png)\n`, skipped: [] }),
  });
  const out = await channel.publish({
    articlePath: '/out/article.md',
    config: { wechat: { appId: 'wx', appSecret: 's' }, assets: { headerImage: '/abs/header.gif', footerImage: '/abs/footer.png' } },
  });
  assert.equal(out.mediaId, 'MEDIA-9');
  assert.match(generateCoverArgs.markdown, /\/abs\/footer\.png/);
  assert.match(writtenMarkdown, /\/abs\/footer\.png/); // 最终写回文件含 cover + 固定图
});

test('固定图缺失(skipped 非空) → notifier.warn 告警,流程继续', async () => {
  const warned = [];
  const notifier = { warn: async (notify, msg) => warned.push({ notify, msg }) };
  const notify = { channel: 'C', ts: '1' };
  const channel = makeChannel({
    ...stubCover,
    renderAndPublish: async () => 'MEDIA-9',
    readArticle: async () => ({ markdown: VALID_MD, title: 't' }),
    injectFixedImages: (md) => ({ markdown: md, skipped: ['/abs/missing-header.gif'] }),
  });
  const out = await channel.publish({ articlePath: '/x/a.md', config: { wechat: { appId: 'wx', appSecret: 's' } }, notify, notifier });
  assert.equal(out.mediaId, 'MEDIA-9');
  assert.equal(warned.length, 1);
  assert.match(warned[0].msg, /固定头尾图缺失/);
  assert.match(warned[0].msg, /missing-header\.gif/);
});

test('injectFixedImages 未产生变化时不调用 writeArticle(仅 generateCover 阶段写一次)', async () => {
  let writeCount = 0;
  const channel = makeChannel({
    generateCover: async () => '/out/cover.png',
    writeArticle: async () => { writeCount += 1; },
    renderAndPublish: async () => 'MEDIA-9',
    readArticle: async () => ({ markdown: VALID_MD, title: 't' }),
    injectFixedImages: (md) => ({ markdown: md, skipped: [] }), // 无变化
  });
  const out = await channel.publish({ articlePath: '/out/article.md', config: { wechat: { appId: 'wx', appSecret: 's' } } });
  assert.equal(out.mediaId, 'MEDIA-9');
  assert.equal(writeCount, 1); // 只有 cover 那次写入
});
