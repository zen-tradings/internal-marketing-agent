import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkArticle } from '../src/lib/gate.js';

const CLEAN_MD = [
  '---',
  'title: 干净的文章',
  '---',
  '正文内容,符合规范。',
  '',
].join('\n');

test('干净文章零 errors 零 warnings', () => {
  const { errors, warnings } = checkArticle(CLEAN_MD);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('errors: frontmatter 缺 title', () => {
  const { errors } = checkArticle('---\nfoo: bar\n---\n正文');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /title/);
});

test('errors: 完全无 frontmatter 也算缺 title', () => {
  const { errors } = checkArticle('没有 frontmatter 的正文');
  assert.ok(errors.some((e) => /title/.test(e)));
});

test('投资建议类词汇(买入/卖出/目标价等)不再拦截:分析师正文引用评级/目标价属正常内容', () => {
  const md = '---\ntitle: T\n---\n华尔街共识目标价上调,多家机构给出买入评级,部分转为卖出。';
  const { errors, warnings } = checkArticle(md);
  assert.equal(errors.length, 0);
  assert.equal(warnings.some((w) => /敏感词/.test(w)), false);
});

test('errors: 疑似 OpenRouter 密钥泄漏', () => {
  const md = '---\ntitle: T\n---\n配置为 sk-or-abcdefghij1234567890';
  const { errors } = checkArticle(md);
  assert.ok(errors.some((e) => /密钥泄漏/.test(e)));
});

test('errors: 疑似 Slack bot token 泄漏', () => {
  const md = '---\ntitle: T\n---\ntoken: xoxb-1234567890-abcdefghij';
  const { errors } = checkArticle(md);
  assert.ok(errors.some((e) => /密钥泄漏/.test(e)));
});

test('errors: 疑似 Slack app/user token(xoxa/xoxp)泄漏', () => {
  for (const prefix of ['xoxa', 'xoxp']) {
    const md = `---\ntitle: T\n---\ntoken: ${prefix}-1234567890-abcdefghij`;
    const { errors } = checkArticle(md);
    assert.ok(errors.some((e) => /密钥泄漏/.test(e)), `${prefix} 应命中`);
  }
});

test('errors: 短字符串不误判为密钥(长度不足)', () => {
  const md = '---\ntitle: T\n---\n短的 sk-or-abc 不算密钥';
  const { errors } = checkArticle(md);
  assert.equal(errors.some((e) => /密钥泄漏/.test(e)), false);
});

test('errors: 含本地路径 /Users/', () => {
  const md = '---\ntitle: T\n---\n生成文件位于 /Users/foo/cover.png';
  const { errors } = checkArticle(md);
  assert.ok(errors.some((e) => /本地路径/.test(e)));
});

test('系统生成的 cover frontmatter 本地路径允许重试,正文路径仍拦截', () => {
  const coverOnly = '---\ntitle: T\ncover: /Users/zen/cover.png\n---\n正文';
  assert.equal(checkArticle(coverOnly).errors.some((e) => /本地路径/.test(e)), false);

  const bodyPath = '---\ntitle: T\ncover: /Users/zen/cover.png\n---\n正文引用 /Users/secret.txt';
  assert.equal(checkArticle(bodyPath).errors.some((e) => /本地路径/.test(e)), true);
});

test('errors: PDF 整页图片的变体路径均拒绝发布', () => {
  const md = '---\ntitle: T\n---\n![原文页](assets/source_page_2.jpg)';
  const { errors } = checkArticle(md);
  assert.ok(errors.some((e) => /PDF 整页图片/.test(e)));
});

test('warnings: 含中文破折号——', () => {
  const md = '---\ntitle: T\n---\n正文含破折号——用法。';
  const { warnings } = checkArticle(md);
  assert.ok(warnings.some((w) => /破折号/.test(w)));
});

test('直译工作流不触发中文破折号风格提醒', () => {
  const md = '---\ntitle: T\n---\n忠实译文保留破折号——以及金额 $12。';
  const { errors, warnings } = checkArticle(md, { workflowMode: 'translation' });
  assert.equal(errors.length, 0);
  assert.equal(warnings.some((w) => /破折号/.test(w)), false);
});

test('美元符号后跟数字不再触发风格提醒', () => {
  const md = '---\ntitle: T\n---\n营收达 $12 亿美元。';
  const { warnings } = checkArticle(md);
  assert.equal(warnings.some((w) => /美元符号/.test(w)), false);
});

test('不再要求固定结尾板块:缺结尾板块不产生 warning', () => {
  const md = '---\ntitle: T\n---\n正文没有固定结尾。';
  const { warnings } = checkArticle(md);
  assert.equal(warnings.some((w) => /结尾板块|ZEN TRADING/.test(w)), false);
});

test('errors 与 warnings 互不干扰:同时命中多类问题时分别出现', () => {
  const md = '---\nfoo: bar\n---\n正文含破折号——,还有 /Users/x 路径,金额 $5 亿美元。';
  const { errors, warnings } = checkArticle(md);
  assert.ok(errors.some((e) => /title/.test(e)));
  assert.ok(errors.some((e) => /本地路径/.test(e)));
  assert.ok(warnings.some((w) => /破折号/.test(w)));
  assert.equal(warnings.some((w) => /美元符号/.test(w)), false);
});

test('信息具体可读:破折号 warning 提示规范要求', () => {
  const md = '---\ntitle: T\n---\n正文含破折号——用法。';
  const { warnings } = checkArticle(md);
  const w = warnings.find((x) => /破折号/.test(x));
  assert.match(w, /逗号或冒号/);
});

test('公众号版式门禁:代码围栏和四空格缩进拦截,不可读宽表降为提醒', () => {
  const md = '---\ntitle: T\n---\n```text\nx\n```\n    indented\n|报告期|营业收入（亿元）|同比增速|毛利率|净利润/归母净利润（亿元）|\n|---|---|---|---|---|';
  const { errors, warnings } = checkArticle(md);
  assert.ok(errors.some((error) => /代码围栏/.test(error)));
  assert.ok(errors.some((error) => /四空格缩进/.test(error)));
  assert.equal(errors.some((error) => /移动端宽表/.test(error)), false);
  assert.ok(warnings.some((warning) => /宽表/.test(warning)));
});

test('公众号版式门禁:显式 HTML pre 中的原文代码缩进不误判为 Markdown 代码卡片', () => {
  const { errors } = checkArticle(`---
title: 原文直译
---
<pre><code>{
    "criterion_number": 1
}</code></pre>`);
  assert.ok(!errors.some((error) => /四空格缩进/.test(error)));
});

test('公众号版式门禁:PDF 整页截图禁止进入正文', () => {
  const md = '---\ntitle: T\n---\n![原文第 2 页](assets/source-page-2.png)';
  const { errors } = checkArticle(md);
  assert.ok(errors.some((error) => /PDF 整页截图/.test(error)));
});

test('公众号版式门禁:内容紧凑的五列表可直接通过', () => {
  const md = '---\ntitle: T\n---\n|Q|Rev|GM|OM|EPS|\n|---|---|---|---|---|\n|Q1|10|20%|8%|1.2|';
  const { errors } = checkArticle(md);
  assert.equal(errors.some((error) => /移动端宽表/.test(error)), false);
});
