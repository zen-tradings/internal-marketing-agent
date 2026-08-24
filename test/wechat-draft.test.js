import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeChannel,
  RENDER_OPTS,
  WECHAT_TEMPLATE_ID,
  WECHAT_THEME_PATH,
} from '../src/channels/wechat-draft.js';

// 合规、无破折号的完整文章,门禁应零 errors/零 warnings,
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
  assert.deepEqual(RENDER_OPTS, {
    theme: 'zen-trading',
    customTheme: WECHAT_THEME_PATH,
    highlight: 'solarized-light',
    macStyle: false,
    footnote: false,
  });
  assert.match(WECHAT_THEME_PATH, /assets\/zen-trading\.css$/);
  assert.equal(Object.isFrozen(RENDER_OPTS), true);
  const channel = makeChannel();
  assert.equal(channel.templateId, WECHAT_TEMPLATE_ID);
  assert.equal(channel.templateLocked, true);
});

test('publish 调 renderAndPublish 并传入固定尾图后返回 mediaId/title', async () => {
  let calledWith;
  const channel = makeChannel({
    ...stubCover,
    renderAndPublish: async (content, opts) => { calledWith = { content, opts }; return 'MEDIA-9'; },
    readArticle: async () => ({ markdown: '---\ntitle: 英伟达\n---\n正文', title: '英伟达' }),
  });
  const out = await channel.publish({
    articlePath: '/x/article.md',
    config: {
      wechat: { appId: 'wx', appSecret: 's' },
      assets: { surveyImage: '/assets/survey.jpg', footerImage: '/assets/footer.png' },
    },
  });
  assert.equal(out.mediaId, 'MEDIA-9');
  assert.equal(out.title, '英伟达');
  assert.equal(calledWith.opts.theme, 'zen-trading');
  assert.equal(calledWith.opts.file, '/x/article.md');
  assert.equal(calledWith.opts.finalSurveyPath, '/assets/survey.jpg');
  assert.equal(calledWith.opts.finalFooterPath, '/assets/footer.png');
  assert.equal(calledWith.opts.stripHeadingOrdinals, true);
  assert.equal(calledWith.opts.appId, 'wx');
  assert.equal(calledWith.opts.appSecret, 's');
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

test('publish 显式传递凭据且不修改 process.env', async () => {
  const prevAppId = process.env.WECHAT_APP_ID;
  const prevAppSecret = process.env.WECHAT_APP_SECRET;
  const channel = makeChannel({
    ...stubCover,
    renderAndPublish: async (_content, options) => {
      assert.equal(options.appId, 'wx');
      assert.equal(options.appSecret, 's');
      return 'MEDIA-9';
    },
    readArticle: async () => ({ markdown: VALID_MD, title: 't' }),
  });
  await channel.publish({ articlePath: '/x/a.md', config: { wechat: { appId: 'wx', appSecret: 's' } } });
  assert.equal(process.env.WECHAT_APP_ID, prevAppId);
  assert.equal(process.env.WECHAT_APP_SECRET, prevAppSecret);
});

test('publish 成功立即持久化 remote id，恢复时校验远端标题且不重复发布', async () => {
  const created = [];
  let publishCalls = 0;
  const channel = makeChannel({
    ...stubCover,
    renderAndPublish: async () => { publishCalls += 1; return 'WX-41'; },
    recoverDraft: async () => ({ news_item: [{ title: '测试标题' }] }),
    readArticle: async () => ({ markdown: VALID_MD, title: '测试标题' }),
  });
  await channel.publish({
    articlePath: '/x/a.md', config: { wechat: { appId: 'wx', appSecret: 's', timeoutMs: 30000 } },
    onCreated: (value) => created.push(value),
  });
  const recovered = await channel.publish({
    articlePath: '/x/a.md', config: { wechat: { appId: 'wx', appSecret: 's', timeoutMs: 30000 } },
    existingRemoteId: 'WX-41',
  });
  assert.equal(publishCalls, 1);
  assert.deepEqual(created, [{ remoteId: 'WX-41', title: '测试标题' }]);
  assert.deepEqual(recovered, { mediaId: 'WX-41', title: '测试标题' });
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

test('直译工作流跳过中文破折号提醒并继续发布', async () => {
  const warned = [];
  let renderOptions;
  const notifier = { warn: async (notify, msg) => warned.push({ notify, msg }) };
  const notify = { channel: 'C', ts: '1' };
  const channel = makeChannel({
    ...stubCover,
    readArticle: async () => ({
      markdown: '---\ntitle: T\n---\n忠实译文保留原句中的破折号——不做风格改写。',
      title: 'T',
    }),
    renderAndPublish: async (_content, opts) => { renderOptions = opts; return 'MEDIA-TRANSLATION'; },
  });
  const out = await channel.publish({
    articlePath: '/x/a.md',
    config: { wechat: { appId: 'wx', appSecret: 's' } },
    workflow: { mode: 'translation' },
    notify,
    notifier,
  });
  assert.equal(out.mediaId, 'MEDIA-TRANSLATION');
  assert.equal(warned.length, 0);
  assert.equal(renderOptions.stripHeadingOrdinals, false);
});

test('用户授权代码时先把四空格块规范为围栏并把策略传给 gate', async () => {
  const writes = [];
  const warnings = [];
  let gateInput;
  let gateOptions;
  const markdown = '---\ntitle: T\n---\n\n示例：\n\n    def run():\n        return 1';
  const channel = makeChannel({
    generateCover: async () => '/out/cover.png',
    readArticle: async () => ({ markdown, title: 'T' }),
    writeArticle: async (filename, content) => writes.push(content),
    checkArticle: (value, options) => {
      gateInput = value;
      gateOptions = options;
      return { errors: [], warnings: [] };
    },
    injectFixedImages: (value) => ({ markdown: value, skipped: [] }),
    renderAndPublish: async () => 'MEDIA-CODE',
  });
  const out = await channel.publish({
    articlePath: '/out/article.md',
    config: { wechat: { appId: 'wx', appSecret: 's' } },
    contentPolicy: { allow_code_blocks: true, source: 'explicit-user-request' },
    notify: { channel: 'C', ts: '1' },
    notifier: { warn: async (notify, message) => warnings.push(message) },
  });
  assert.equal(out.mediaId, 'MEDIA-CODE');
  assert.match(gateInput, /```text\ndef run\(\):\n    return 1\n```/);
  assert.equal(gateOptions.contentPolicy.allow_code_blocks, true);
  assert.ok(writes.some((content) => content.includes('```text')));
  assert.ok(warnings.some((message) => /四空格缩进代码块/.test(message)));
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
    '![Zen Trading 内容调研问卷](/Users/zen/survey.jpg)',
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
    config: { wechat: { appId: 'wx', appSecret: 's' }, assets: { headerImage: '/Users/zen/header.gif', surveyImage: '/Users/zen/survey.jpg', footerImage: '/Users/zen/footer.png' } },
  });
  assert.equal(out.mediaId, 'MEDIA-RETRY');
});

// ---- 固定头图与 HTML 尾图接线 ----

test('Markdown 只注入头图,渲染参数按顺序携带调研图与社群封底', async () => {
  let writtenMarkdown;
  let generateCoverArgs;
  let renderOptions;
  const channel = makeChannel({
    generateCover: async (args) => { generateCoverArgs = args; return '/out/cover.png'; },
    writeArticle: async (p, content) => { writtenMarkdown = content; },
    renderAndPublish: async (content, options) => { renderOptions = options; return 'MEDIA-9'; },
    readArticle: async () => ({ markdown: VALID_MD, title: 't' }),
    injectFixedImages: (md, options) => {
      assert.equal(options.headerPath, '/abs/header.gif');
      assert.equal(options.footerPath, undefined);
      return { markdown: `${md}\n![Zen Trading](/abs/header.gif)\n`, skipped: [] };
    },
  });
  const out = await channel.publish({
    articlePath: '/out/article.md',
    config: { wechat: { appId: 'wx', appSecret: 's' }, assets: { headerImage: '/abs/header.gif', surveyImage: '/abs/survey.jpg', footerImage: '/abs/footer.png' } },
  });
  assert.equal(out.mediaId, 'MEDIA-9');
  assert.match(generateCoverArgs.markdown, /\/abs\/header\.gif/);
  assert.match(writtenMarkdown, /\/abs\/header\.gif/);
  assert.doesNotMatch(writtenMarkdown, /\/abs\/(?:survey\.jpg|footer\.png)/);
  assert.equal(renderOptions.finalSurveyPath, '/abs/survey.jpg');
  assert.equal(renderOptions.finalFooterPath, '/abs/footer.png');
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
  assert.match(warned[0].msg, /固定头图缺失/);
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

test('写作任务生成信息图:插入正文并提醒人工复核', async () => {
  let plannedWith;
  const writes = [];
  const warned = [];
  const channel = makeChannel({
    ...stubCover,
    writeArticle: async (p, md) => { writes.push({ p, md }); },
    renderAndPublish: async () => 'MEDIA-IG',
    readArticle: async () => ({ markdown: VALID_MD, title: '测试标题' }),
    generateArticleInfographics: async (args) => {
      plannedWith = args;
      return {
        markdown: `${VALID_MD}![产业链](/x/infographic-1.png)\n`,
        images: ['/x/infographic-1.png'],
        warnings: [],
      };
    },
  });
  const out = await channel.publish({
    articlePath: '/x/article.md',
    config: {
      wechat: { appId: 'wx', appSecret: 's' },
      infographic: { enabled: true, maxImages: 2 },
      writer: { openrouterApiKey: 'k', model: 'm' },
    },
    workflow: { mode: 'analysis' },
    notifier: { warn: async (_n, msg) => { warned.push(msg); } },
    notify: { channel: 'C1' },
  });
  assert.equal(out.mediaId, 'MEDIA-IG');
  assert.equal(plannedWith.outDir, '/x');
  assert.equal(plannedWith.infographic.maxImages, 2);
  assert.ok(writes.some(({ md }) => md.includes('infographic-1.png')));
  assert.ok(warned.some((msg) => msg.includes('信息图') && msg.includes('人工复核')));
});

test('直译任务不生成信息图', async () => {
  let called = false;
  const channel = makeChannel({
    ...stubCover,
    renderAndPublish: async () => 'MEDIA-TR',
    readArticle: async () => ({ markdown: VALID_MD, title: 't' }),
    generateArticleInfographics: async () => { called = true; return { markdown: VALID_MD, images: [], warnings: [] }; },
  });
  const out = await channel.publish({
    articlePath: '/x/article.md',
    config: {
      wechat: { appId: 'wx', appSecret: 's' },
      infographic: { enabled: true },
    },
    workflow: { mode: 'translation' },
  });
  assert.equal(out.mediaId, 'MEDIA-TR');
  assert.equal(called, false);
});

test('信息图告警不阻断发布;重试稿中的生成图先剥离再门禁', async () => {
  let gateMarkdown = '';
  const warned = [];
  const stale = `${VALID_MD}![文章配图](/x/infographic-1.png)\n`;
  const channel = makeChannel({
    ...stubCover,
    renderAndPublish: async () => 'MEDIA-RE',
    readArticle: async () => ({ markdown: stale, title: 't' }),
    checkArticle: (md) => { gateMarkdown = md; return { errors: [], warnings: [] }; },
    generateArticleInfographics: async () => ({
      markdown: stale,
      images: [],
      warnings: ['第 1 张信息图渲染失败,已跳过:boom'],
    }),
  });
  const out = await channel.publish({
    articlePath: '/x/article.md',
    config: {
      wechat: { appId: 'wx', appSecret: 's' },
      infographic: { enabled: true },
    },
    workflow: { mode: 'analysis' },
    notifier: { warn: async (_n, msg) => { warned.push(msg); } },
    notify: { channel: 'C1' },
  });
  assert.equal(out.mediaId, 'MEDIA-RE');
  assert.ok(!gateMarkdown.includes('infographic-1.png'));
  assert.ok(warned.some((msg) => msg.includes('渲染失败')));
});
