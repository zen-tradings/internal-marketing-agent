import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runClaude } from '../src/core/runner.js';

function fakeSpawn(behavior) {
  return (bin, args, opts) => {
    const cp = new EventEmitter();
    cp.stdout = new EventEmitter();
    cp.stderr = new EventEmitter();
    cp.kill = () => cp.emit('close', 137);
    cp._args = args; cp._opts = opts;
    queueMicrotask(() => behavior(cp, opts));
    return cp;
  };
}

test('成功:退出码0且 article.md 存在', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
  const wf = { workDir: dir, allowedTools: ['mcp__exa__web_search_exa'], timeoutMs: 1000,
    promptTemplate: (t) => `写:${t}` };
  const spawnFn = fakeSpawn((cp) => {
    fs.writeFileSync(path.join(dir, 'article.md'), '---\ntitle: T\n---\n正文');
    cp.emit('close', 0);
  });
  const r = await runClaude({ workflow: wf, input: '英伟达', config: { claudeBin: 'claude', proxy: { https: 'http://p', noProxy: 'weixin.qq.com' } }, spawnFn });
  assert.equal(r.ok, true);
  assert.ok(r.articlePath.endsWith('article.md'));
});

test('代理只进子进程 env,且带 no_proxy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
  let seenEnv;
  const wf = { workDir: dir, allowedTools: [], timeoutMs: 1000, promptTemplate: () => 'x' };
  const spawnFn = fakeSpawn((cp, opts) => { seenEnv = opts.env; cp.emit('close', 1); });
  await runClaude({ workflow: wf, input: 'x', config: { claudeBin: 'c', proxy: { https: 'http://p', http: '', all: '', noProxy: 'weixin.qq.com' } }, spawnFn });
  assert.equal(seenEnv.https_proxy, 'http://p');
  assert.equal(seenEnv.no_proxy, 'weixin.qq.com');
});

test('无 article.md → ok:false', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
  const wf = { workDir: dir, allowedTools: [], timeoutMs: 1000, promptTemplate: () => 'x' };
  const spawnFn = fakeSpawn((cp) => cp.emit('close', 0));
  const r = await runClaude({ workflow: wf, input: 'x', config: { claudeBin: 'c', proxy: {} }, spawnFn });
  assert.equal(r.ok, false);
});
