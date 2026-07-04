import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertMainProcessDirect } from '../src/index.js';

test('主进程带代理变量时报错', () => {
  assert.throws(() => assertMainProcessDirect({ https_proxy: 'http://p' }), /主进程不得设置代理/);
});
test('主进程无代理变量通过', () => {
  assert.doesNotThrow(() => assertMainProcessDirect({}));
});
