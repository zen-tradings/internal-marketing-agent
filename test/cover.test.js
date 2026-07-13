import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureFrontmatterCover, generateCover, buildCoverData } from '../src/lib/cover.js';

test('无 cover 时插入', () => {
  const out = ensureFrontmatterCover('---\ntitle: T\n---\n正文', '/tmp/c.png');
  assert.match(out, /cover:\s*\/tmp\/c\.png/);
  assert.match(out, /title: T/);
});

test('已有 cover 时替换为新 cover', () => {
  const src = '---\ntitle: T\ncover: /old.png\n---\n正文';
  const out = ensureFrontmatterCover(src, '/new.png');
  assert.match(out, /cover:\s*\/new\.png/);
  assert.doesNotMatch(out, /\/old\.png/);
  assert.match(out, /title: T/);
});

test('无 frontmatter 时补全整段 frontmatter', () => {
  const out = ensureFrontmatterCover('正文,无 frontmatter', '/tmp/c.png');
  assert.match(out, /^---\ncover: \/tmp\/c\.png\n---\n正文/);
});

async function setupFakeGenerator() {
  const generatorDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-cover-gen-'));
  await fs.mkdir(path.join(generatorDir, 'samples'), { recursive: true });
  await fs.writeFile(
    path.join(generatorDir, 'samples', 'example.json'),
    JSON.stringify({ title: '示例标题', tag: '事件驱动', bullets: [] }, null, 2)
  );
  return generatorDir;
}

test('generateCover 写 data.json(以 example.json 为默认值,覆盖 title)并调用生成器,成功时解析出封面绝对路径', async () => {
  const generatorDir = await setupFakeGenerator();
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-cover-out-'));

  let calledArgs;
  const spawnFn = (cmd, args, opts) => {
    calledArgs = { cmd, args, opts };
    const emitter = new EventEmitter();
    process.nextTick(() => emitter.emit('close', 0));
    return emitter;
  };

  const outPath = await generateCover({ title: '我的封面标题', outDir, generatorDir, spawnFn });

  assert.equal(outPath, path.resolve(outDir, 'cover.png'));
  assert.equal(calledArgs.cmd, process.execPath);
  assert.equal(calledArgs.args[0], path.join(generatorDir, 'render.mjs'));
  assert.equal(calledArgs.args[2], path.join(outDir, 'cover.png'));
  assert.equal(calledArgs.opts.cwd, generatorDir);

  const dataPath = calledArgs.args[1];
  const written = JSON.parse(await fs.readFile(dataPath, 'utf-8'));
  assert.equal(written.title, '我的封面标题');
  assert.equal(written.tag, '事件驱动'); // 沿用 example.json 默认值
});

test('生成器退出码非 0 → 拒绝并带 stage=cover', async () => {
  const generatorDir = await setupFakeGenerator();
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-cover-out-'));
  const spawnFn = () => {
    const emitter = new EventEmitter();
    process.nextTick(() => emitter.emit('close', 1));
    return emitter;
  };

  await assert.rejects(
    () => generateCover({ title: 'T', outDir, generatorDir, spawnFn }),
    (e) => { assert.equal(e.stage, 'cover'); return true; }
  );
});

test('spawn 触发 error 事件 → 拒绝并带 stage=cover', async () => {
  const generatorDir = await setupFakeGenerator();
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-cover-out-'));
  const spawnFn = () => {
    const emitter = new EventEmitter();
    process.nextTick(() => emitter.emit('error', new Error('ENOENT')));
    return emitter;
  };

  await assert.rejects(
    () => generateCover({ title: 'T', outDir, generatorDir, spawnFn }),
    (e) => { assert.equal(e.stage, 'cover'); return true; }
  );
});

test('example.json 缺失/不可读 → 拒绝并带 stage=cover', async () => {
  const generatorDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-cover-nogen-'));
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-cover-out-'));

  await assert.rejects(
    () => generateCover({ title: 'T', outDir, generatorDir, spawnFn: () => new EventEmitter() }),
    (e) => { assert.equal(e.stage, 'cover'); return true; }
  );
});

// ---- buildCoverData ----

const VALID_WRITER = { openrouterApiKey: 'or-key', model: 'qwen/x', baseUrl: 'https://openrouter.ai/api/v1' };

function validPayload(overrides = {}) {
  return {
    tag: '事件驱动',
    title: '英伟达业绩超预期',
    key_takeaway: '营收环比增长超市场预期',
    chain: {
      direction: 'up',
      stages: [
        { kicker: '01', nm: 'NVDA', sub: '业绩超预期' },
        { kicker: '02', nm: 'AI 需求', sub: '持续旺盛' },
      ],
    },
    bullets: [
      { ic: '1', tx: '营收 <b>260亿</b> 美元' },
      { ic: '2', tx: '毛利率 <b>75%</b>' },
      { ic: '3', tx: '指引 <b>上调</b>' },
    ],
    source: '来源：公开资料 · 截至 2026-07',
    ...overrides,
  };
}

function jsonFetch(content) {
  return async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
}

test('buildCoverData: 正常 JSON → 返回归一化后的封面数据', async () => {
  const payload = validPayload();
  const data = await buildCoverData({ title: 'X', markdown: 'Y', writer: VALID_WRITER, fetchFn: jsonFetch(JSON.stringify(payload)) });
  assert.equal(data.tag, payload.tag);
  assert.equal(data.title, payload.title);
  assert.equal(data.key_takeaway, payload.key_takeaway);
  assert.equal(data.chain.direction, 'up');
  assert.equal(data.chain.stages.length, 2);
  assert.equal(data.bullets.length, 3);
  assert.equal(data.source, payload.source);
});

test('buildCoverData: 容忍 ```json 围栏', async () => {
  const payload = validPayload();
  const content = '```json\n' + JSON.stringify(payload) + '\n```';
  const data = await buildCoverData({ title: 'X', markdown: 'Y', writer: VALID_WRITER, fetchFn: jsonFetch(content) });
  assert.equal(data.tag, payload.tag);
  assert.equal(data.title, payload.title);
});

test('buildCoverData: JSON.parse 失败 → 返回 null,不抛错', async () => {
  const data = await buildCoverData({ title: 'X', markdown: 'Y', writer: VALID_WRITER, fetchFn: jsonFetch('这不是 JSON,是模型的解释文字') });
  assert.equal(data, null);
});

test('buildCoverData: HTTP 非 2xx → 返回 null', async () => {
  const fetchFn = async () => ({ ok: false, status: 500, statusText: 'Server Error', json: async () => ({}) });
  const data = await buildCoverData({ title: 'X', markdown: 'Y', writer: VALID_WRITER, fetchFn });
  assert.equal(data, null);
});

test('buildCoverData: 响应缺 choices[0].message.content → 返回 null', async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({ choices: [] }) });
  const data = await buildCoverData({ title: 'X', markdown: 'Y', writer: VALID_WRITER, fetchFn });
  assert.equal(data, null);
});

test('buildCoverData: 缺关键字段(chain)→ 返回 null', async () => {
  const payload = validPayload();
  delete payload.chain;
  const data = await buildCoverData({ title: 'X', markdown: 'Y', writer: VALID_WRITER, fetchFn: jsonFetch(JSON.stringify(payload)) });
  assert.equal(data, null);
});

test('buildCoverData: bullets 少于 3 个 → 返回 null', async () => {
  const payload = validPayload({ bullets: [{ ic: '1', tx: 'x' }] });
  const data = await buildCoverData({ title: 'X', markdown: 'Y', writer: VALID_WRITER, fetchFn: jsonFetch(JSON.stringify(payload)) });
  assert.equal(data, null);
});

test('buildCoverData: tag 不在枚举内 → 返回 null', async () => {
  const payload = validPayload({ tag: '非法标签' });
  const data = await buildCoverData({ title: 'X', markdown: 'Y', writer: VALID_WRITER, fetchFn: jsonFetch(JSON.stringify(payload)) });
  assert.equal(data, null);
});

test('buildCoverData: title 超过 30 字时截断为 22 字而非失败', async () => {
  const longTitle = '标'.repeat(35);
  const payload = validPayload({ title: longTitle });
  const data = await buildCoverData({ title: 'X', markdown: 'Y', writer: VALID_WRITER, fetchFn: jsonFetch(JSON.stringify(payload)) });
  assert.notEqual(data, null);
  assert.equal(data.title, longTitle.slice(0, 22));
  assert.equal(data.title.length, 22);
});

test('buildCoverData: key_takeaway 超过 35 字时截断为 25 字而非失败', async () => {
  const longTakeaway = '论'.repeat(40);
  const payload = validPayload({ key_takeaway: longTakeaway });
  const data = await buildCoverData({ title: 'X', markdown: 'Y', writer: VALID_WRITER, fetchFn: jsonFetch(JSON.stringify(payload)) });
  assert.notEqual(data, null);
  assert.equal(data.key_takeaway, longTakeaway.slice(0, 25));
  assert.equal(data.key_takeaway.length, 25);
});

test('buildCoverData: writer 缺 apiKey 或 model → 直接返回 null,不发请求', async () => {
  let called = false;
  const fetchFn = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const data1 = await buildCoverData({ title: 'X', markdown: 'Y', writer: { model: 'm' }, fetchFn });
  const data2 = await buildCoverData({ title: 'X', markdown: 'Y', writer: { openrouterApiKey: 'k' }, fetchFn });
  assert.equal(data1, null);
  assert.equal(data2, null);
  assert.equal(called, false);
});

test('buildCoverData: fetchFn 抛出网络错误 → 返回 null,不抛错', async () => {
  const fetchFn = async () => { throw new Error('network down'); };
  const data = await buildCoverData({ title: 'X', markdown: 'Y', writer: VALID_WRITER, fetchFn });
  assert.equal(data, null);
});

test('buildCoverData: 请求携带 model/temperature 0/鉴权与 OpenRouter 头,与 runner 调用方式一致', async () => {
  let capturedUrl, capturedOpts;
  const payload = validPayload();
  const fetchFn = async (url, opts) => {
    capturedUrl = url;
    capturedOpts = opts;
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }) };
  };
  const writer = { ...VALID_WRITER, httpReferer: 'https://zentradings.com', appTitle: 'Zen Content Hub' };
  await buildCoverData({ title: 'X', markdown: 'Y', writer, fetchFn });
  assert.equal(capturedUrl, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(capturedOpts.headers.Authorization, 'Bearer or-key');
  assert.equal(capturedOpts.headers['HTTP-Referer'], 'https://zentradings.com');
  assert.equal(capturedOpts.headers['X-OpenRouter-Title'], 'Zen Content Hub');
  const body = JSON.parse(capturedOpts.body);
  assert.equal(body.model, 'qwen/x');
  assert.equal(body.max_tokens, 1200);
  assert.deepEqual(body.reasoning, { effort: 'none', exclude: true });
  assert.equal(body.temperature, 0);
});

// ---- generateCover:内容驱动封面 + 回退 ----

test('generateCover: markdown+writer 且 buildDataFn 返回内容 → 深合并模型数据,模型缺的字段保留示例默认', async () => {
  const generatorDir = await setupFakeGenerator();
  await fs.writeFile(
    path.join(generatorDir, 'samples', 'example.json'),
    JSON.stringify({ title: '示例标题', tag: '事件驱动', bullets: [], palette: 'warm-default' }, null, 2)
  );
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-cover-out-'));

  let calledArgs;
  const spawnFn = (cmd, args, opts) => {
    calledArgs = { cmd, args, opts };
    const emitter = new EventEmitter();
    process.nextTick(() => emitter.emit('close', 0));
    return emitter;
  };

  const builtData = validPayload({ tag: '周报', title: '周报封面标题' });
  const buildDataFn = async () => builtData;

  const outPath = await generateCover({
    title: '文章标题', outDir, generatorDir, spawnFn, markdown: '正文', writer: { openrouterApiKey: 'k', model: 'm' }, buildDataFn,
  });
  assert.equal(outPath, path.resolve(outDir, 'cover.png'));

  const dataPath = calledArgs.args[1];
  const written = JSON.parse(await fs.readFile(dataPath, 'utf-8'));
  assert.equal(written.tag, '周报'); // 来自模型,覆盖示例默认
  assert.equal(written.title, '周报封面标题'); // 模型标题覆盖了文章标题参数和示例标题
  assert.equal(written.palette, 'warm-default'); // 示例独有字段(模型未提供)保留
  assert.equal(written.bullets.length, 3);
});

test('generateCover: buildDataFn 返回 null → 回退到示例+文章标题(既有行为)', async () => {
  const generatorDir = await setupFakeGenerator();
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-cover-out-'));

  let calledArgs;
  const spawnFn = (cmd, args, opts) => {
    calledArgs = { cmd, args, opts };
    const emitter = new EventEmitter();
    process.nextTick(() => emitter.emit('close', 0));
    return emitter;
  };

  await generateCover({
    title: '回退标题', outDir, generatorDir, spawnFn, markdown: '正文', writer: { openrouterApiKey: 'k', model: 'm' }, buildDataFn: async () => null,
  });

  const dataPath = calledArgs.args[1];
  const written = JSON.parse(await fs.readFile(dataPath, 'utf-8'));
  assert.equal(written.title, '回退标题');
  assert.equal(written.tag, '事件驱动'); // 示例默认值
});

test('generateCover: buildDataFn 抛错 → 不影响封面生成,回退到示例+标题', async () => {
  const generatorDir = await setupFakeGenerator();
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-cover-out-'));
  const spawnFn = () => {
    const emitter = new EventEmitter();
    process.nextTick(() => emitter.emit('close', 0));
    return emitter;
  };

  const outPath = await generateCover({
    title: 'T', outDir, generatorDir, spawnFn, markdown: '正文', writer: { openrouterApiKey: 'k', model: 'm' },
    buildDataFn: async () => { throw new Error('OpenRouter 超时'); },
  });
  assert.equal(outPath, path.resolve(outDir, 'cover.png'));
});

test('generateCover: 缺 markdown 或 writer 时不调用 buildDataFn,直接走示例+标题', async () => {
  const generatorDir = await setupFakeGenerator();
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-cover-out-'));
  const spawnFn = () => {
    const emitter = new EventEmitter();
    process.nextTick(() => emitter.emit('close', 0));
    return emitter;
  };
  let called = false;
  const buildDataFn = async () => { called = true; return null; };

  await generateCover({ title: 'T', outDir, generatorDir, spawnFn, buildDataFn }); // 无 markdown/writer
  assert.equal(called, false);
});
