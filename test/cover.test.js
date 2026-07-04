import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureFrontmatterCover, generateCover } from '../src/lib/cover.js';

test('无 cover 时插入', () => {
  const out = ensureFrontmatterCover('---\ntitle: T\n---\n正文', '/tmp/c.png');
  assert.match(out, /cover:\s*\/tmp\/c\.png/);
  assert.match(out, /title: T/);
});

test('已有 cover 时不重复插入', () => {
  const src = '---\ntitle: T\ncover: /old.png\n---\n正文';
  assert.equal(ensureFrontmatterCover(src, '/new.png'), src);
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
