// Known @slack/socket-mode 1.x crash: its finity state machine synchronously throws
// "Unhandled event '<event>' in state '<state>'" for an undeclared event. A common case is
// a Slack "server explicit disconnect" while connecting. The WebSocket callback escapes as an
// uncaughtException and terminates the process, so recognize it, tolerate it, and reconnect.
export function isTransientSocketModeError(err) {
  const msg = String((err && err.message) || err || '');
  if (!/Unhandled event .* in state/.test(msg)) return false;
  const stack = String((err && err.stack) || '');
  // Require the socket-mode/finity origin to avoid swallowing unrelated errors with similar wording.
  return /socket-mode|finity|StateMachine|SocketModeClient/i.test(stack) || /disconnect/i.test(msg);
}

export function isSlackAppConnected(app) {
  try {
    return app?.receiver?.client?.isActive?.() === true;
  } catch {
    return false;
  }
}
