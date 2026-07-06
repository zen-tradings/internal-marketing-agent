// @slack/socket-mode 1.x 的已知崩溃:其内部 finity 状态机在某个状态下收到未声明的
// 事件时会同步抛出 "Unhandled event '<event>' in state '<state>'"。最典型的是套接字在
// connecting 状态收到 Slack 的 "server explicit disconnect"(连接期被瞬时断开,通常可重连)。
// 这个抛出发生在 WebSocket 消息回调里,冒泡为 uncaughtException,会直接终止进程。
// 我们把这类错误识别出来,容忍它并触发重连,而不是让整个引擎崩溃。
export function isTransientSocketModeError(err) {
  const msg = String((err && err.message) || err || '');
  if (!/Unhandled event .* in state/.test(msg)) return false;
  const stack = String((err && err.stack) || '');
  // 限定来自 socket-mode / finity 状态机,避免误吞其它同措辞的错误
  return /socket-mode|finity|StateMachine|SocketModeClient/i.test(stack) || /disconnect/i.test(msg);
}
