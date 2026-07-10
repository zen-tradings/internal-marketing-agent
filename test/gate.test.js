import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkArticle } from '../src/lib/gate.js';

const CLEAN_MD = [
  '---',
  'title: 干净的文章',
  '---',
  '正文内容,符合规范。',
  '',
  'ZEN TRADING STRATEGIES',
  '板块模型 · 量化策略 · 前沿解读',
  '本文为研究用途,不构成任何投资建议。',
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

test('warnings: 含中文破折号——', () => {
  const md = '---\ntitle: T\n---\n正文含破折号——用法。';
  const { warnings } = checkArticle(md);
  assert.ok(warnings.some((w) => /破折号/.test(w)));
});

test('warnings: 含美元符号后跟数字', () => {
  const md = '---\ntitle: T\n---\n营收达 $12 亿美元。';
  const { warnings } = checkArticle(md);
  assert.ok(warnings.some((w) => /美元符号/.test(w)));
});

test('warnings: 美元符号后不跟数字不命中', () => {
  const md = '---\ntitle: T\n---\n价格用 $ 符号表示,不接数字。';
  const { warnings } = checkArticle(md);
  assert.equal(warnings.some((w) => /美元符号/.test(w)), false);
});

test('warnings: 缺固定结尾板块「ZEN TRADING STRATEGIES」', () => {
  const md = '---\ntitle: T\n---\n正文没有固定结尾。';
  const { warnings } = checkArticle(md);
  assert.ok(warnings.some((w) => /ZEN TRADING STRATEGIES/.test(w)));
});

test('warnings: 含固定结尾板块则不命中该项', () => {
  const { warnings } = checkArticle(CLEAN_MD);
  assert.equal(warnings.some((w) => /ZEN TRADING STRATEGIES/.test(w)), false);
});

test('errors 与 warnings 互不干扰:同时命中多类问题时都各自出现', () => {
  const md = '---\nfoo: bar\n---\n正文提到买入,含破折号——,也没有结尾板块,还有 /Users/x 路径,金额 $5 亿美元。';
  const { errors, warnings } = checkArticle(md);
  assert.ok(errors.some((e) => /title/.test(e)));
  assert.ok(errors.some((e) => /本地路径/.test(e)));
  assert.ok(warnings.some((w) => /破折号/.test(w)));
  assert.ok(warnings.some((w) => /美元符号/.test(w)));
  assert.ok(warnings.some((w) => /ZEN TRADING STRATEGIES/.test(w)));
});

test('信息具体可读:破折号 warning 提示规范要求', () => {
  const md = '---\ntitle: T\n---\n正文含破折号——用法。';
  const { warnings } = checkArticle(md);
  const w = warnings.find((x) => /破折号/.test(x));
  assert.match(w, /逗号或冒号/);
});
