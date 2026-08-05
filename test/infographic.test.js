import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildInfographicPlan,
  generateArticleInfographics,
  insertInfographicImage,
  parseInfographicPlan,
  stripGeneratedInfographics,
} from '../src/lib/infographic.js';

const ARTICLE = `---
title: 测试文章
---

## 行业背景

第一段正文,介绍行业整体情况与发展阶段。

## 产业链结构

上游是原材料,中游是制造,下游是渠道。

## 风险提示

需求不及预期。
`;

test('stripGeneratedInfographics 只剥离生成图,保留普通图片与正文', () => {
  const md = `${ARTICLE}\n![文章配图](/srv/zen/wechat/runs/r1/infographic-1.png)\n\n![原文图](https://example.com/a.png)\n`;
  const out = stripGeneratedInfographics(md);
  assert.ok(!out.includes('infographic-1.png'));
  assert.ok(out.includes('https://example.com/a.png'));
  assert.ok(out.includes('## 产业链结构'));
});

test('stripGeneratedInfographics 相对路径命名同样剥离', () => {
  const md = '正文\n\n![图](infographic-2.png)\n\n结尾';
  const out = stripGeneratedInfographics(md);
  assert.ok(!out.includes('infographic-2.png'));
  assert.ok(out.includes('结尾'));
});

test('insertInfographicImage 标题锚点插在标题行之后', () => {
  const out = insertInfographicImage(ARTICLE, {
    anchor: '产业链结构',
    imagePath: '/tmp/infographic-1.png',
    alt: '产业链',
  });
  assert.match(out, /## 产业链结构\n\n!\[产业链\]\(\/tmp\/infographic-1\.png\)\n\n上游是原材料/);
});

test('insertInfographicImage 段落锚点插在段落结束之后', () => {
  const out = insertInfographicImage(ARTICLE, {
    anchor: '上游是原材料,中游是制造',
    imagePath: '/tmp/infographic-1.png',
    alt: '链条',
  });
  assert.match(out, /下游是渠道。\n\n!\[链条\]\(\/tmp\/infographic-1\.png\)\n\n## 风险提示/);
});

test('insertInfographicImage 锚点缺失返回 null', () => {
  const out = insertInfographicImage(ARTICLE, {
    anchor: '文章里不存在的一句话',
    imagePath: '/tmp/infographic-1.png',
    alt: '缺失',
  });
  assert.equal(out, null);
});

test('parseInfographicPlan 解析围栏 JSON 并剔除非法项', () => {
  const content = '```json\n{"infographics":['
    + '{"anchor":"产业链结构","alt":"产业链","syntax":"infographic list-grid-simple\\ndata\\n  items\\n    - label 上游\\n      icon ant-design:x\\n"},'
    + '{"anchor":"","alt":"坏","syntax":"infographic list-grid-simple\\ndata\\n  items\\n    - label x\\n"},'
    + '{"anchor":"风险提示","alt":"坏语法","syntax":"随便写的"}'
    + ']}\n```';
  const plan = parseInfographicPlan(content, 5);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].anchor, '产业链结构');
  assert.ok(!/icon\s/.test(plan[0].syntax));
});

test('parseInfographicPlan 非法 JSON 返回 null,超限截断到 maxImages', () => {
  assert.equal(parseInfographicPlan('not json'), null);
  const item = '{"anchor":"产业链结构","alt":"a","syntax":"infographic list-grid-simple\\ndata\\n  items\\n    - label x\\n"}';
  const plan = parseInfographicPlan(`{"infographics":[${item},${item},${item}]}`, 2);
  assert.equal(plan.length, 2);
});

test('buildInfographicPlan 无凭据或请求失败返回 null', async () => {
  assert.equal(await buildInfographicPlan({ title: 't', markdown: 'm', writer: {} }), null);
  const failFetch = async () => ({ ok: false, status: 500 });
  const out = await buildInfographicPlan({
    title: 't',
    markdown: 'm',
    writer: { openrouterApiKey: 'k', model: 'm' },
    fetchFn: failFetch,
  });
  assert.equal(out, null);
});

test('buildInfographicPlan 正常响应解析为计划', async () => {
  const okFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: '{"infographics":[{"anchor":"产业链结构","alt":"产业链","syntax":"infographic list-grid-simple\\ndata\\n  items\\n    - label 上游\\n"}]}' } }],
    }),
  });
  const plan = await buildInfographicPlan({
    title: 't',
    markdown: 'm',
    writer: { openrouterApiKey: 'k', model: 'm' },
    fetchFn: okFetch,
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].alt, '产业链');
});

function fakeSpawnSuccess({ createFile = true } = {}) {
  const calls = [];
  const spawnFn = (cmd, args) => {
    calls.push({ cmd, args });
    const emitter = new EventEmitter();
    process.nextTick(async () => {
      if (createFile) {
        try { await fs.writeFile(args[2], 'png'); } catch {}
      }
      emitter.emit('close', createFile ? 0 : 1);
    });
    return emitter;
  };
  return { calls, spawnFn };
}

const PLAN = [{
  anchor: '产业链结构',
  alt: '产业链',
  syntax: 'infographic list-grid-simple\ndata\n  items\n    - label 上游\n    - label 中游\n    - label 下游\n',
}];

test('generateArticleInfographics 渲染成功时插入图片并返回图片列表', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-infographic-out-'));
  const { calls, spawnFn } = fakeSpawnSuccess();
  const result = await generateArticleInfographics({
    title: '测试文章',
    markdown: ARTICLE,
    outDir,
    writer: {},
    spawnFn,
    buildPlanFn: async () => PLAN,
    keepTemp: true,
  });
  assert.equal(result.warnings.length, 0);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0], path.join(outDir, 'infographic-1.png'));
  assert.match(result.markdown, /## 产业链结构\n\n!\[产业链\]\(/);
  assert.equal(calls[0].cmd, process.execPath);
  assert.match(calls[0].args[0], /infographic-generator\/render\.mjs$/);
  const data = JSON.parse(await fs.readFile(calls[0].args[1], 'utf-8'));
  assert.match(data.syntax, /^infographic list-grid-simple/);
});

test('generateArticleInfographics 渲染失败降级为告警且不改正文', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-infographic-out-'));
  const { spawnFn } = fakeSpawnSuccess({ createFile: false });
  const result = await generateArticleInfographics({
    title: '测试文章',
    markdown: ARTICLE,
    outDir,
    writer: {},
    spawnFn,
    buildPlanFn: async () => PLAN,
  });
  assert.equal(result.images.length, 0);
  assert.equal(result.markdown, ARTICLE);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /渲染失败/);
});

test('generateArticleInfographics 锚点缺失跳过该图', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-infographic-out-'));
  const { spawnFn } = fakeSpawnSuccess();
  const result = await generateArticleInfographics({
    title: '测试文章',
    markdown: ARTICLE,
    outDir,
    writer: {},
    spawnFn,
    buildPlanFn: async () => [{ ...PLAN[0], anchor: '不存在的锚点文本' }],
  });
  assert.equal(result.images.length, 0);
  assert.equal(result.markdown, ARTICLE);
  assert.match(result.warnings[0], /锚点定位失败/);
});

test('generateArticleInfographics 规划失败与空计划都不阻断', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-infographic-out-'));
  const failed = await generateArticleInfographics({
    title: 't', markdown: ARTICLE, outDir, writer: {},
    buildPlanFn: async () => { throw new Error('boom'); },
  });
  assert.equal(failed.markdown, ARTICLE);
  assert.match(failed.warnings[0], /规划失败/);

  const empty = await generateArticleInfographics({
    title: 't', markdown: ARTICLE, outDir, writer: {},
    buildPlanFn: async () => [],
  });
  assert.equal(empty.markdown, ARTICLE);
  assert.equal(empty.warnings.length, 0);
});
