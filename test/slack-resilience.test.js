import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientSocketModeError } from '../src/lib/slack-resilience.js';

test('识别 socket-mode finity 的 server explicit disconnect 崩溃', () => {
  const err = new Error("Unhandled event 'server explicit disconnect' in state 'connecting'.");
  err.stack = `Error: ${err.message}\n    at StateMachine.handleUnhandledEvent (/x/node_modules/finity/lib/core/StateMachine.js:76:13)\n    at SocketModeClient.onWebSocketMessage (/x/node_modules/@slack/socket-mode/dist/SocketModeClient.js:608:31)`;
  assert.equal(isTransientSocketModeError(err), true);
});

test('finity 措辞 + disconnect 消息也算(即使 stack 缺失)', () => {
  const err = new Error("Unhandled event 'server explicit disconnect' in state 'connected'.");
  err.stack = '';
  assert.equal(isTransientSocketModeError(err), true);
});

test('无关错误不误吞', () => {
  assert.equal(isTransientSocketModeError(new Error('boom')), false);
  assert.equal(isTransientSocketModeError(new Error('TypeError: x is not a function')), false);
  const other = new Error("Unhandled event 'foo' in state 'bar'.");
  other.stack = 'Error\n    at MyApp.doThing (/x/src/app.js:1:1)';
  assert.equal(isTransientSocketModeError(other), false); // 非 socket-mode/finity 且无 disconnect
});

test('容忍非 Error 入参', () => {
  assert.equal(isTransientSocketModeError(null), false);
  assert.equal(isTransientSocketModeError('just a string'), false);
});
