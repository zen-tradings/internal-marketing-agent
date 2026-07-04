// Claude 认证自检：跑一次极小探活命令，用来确认子进程仍能通过代理认证到 Anthropic。
// execFn 由调用方注入（生产环境用真正 spawn/exec claude 的实现；测试用 fake，避免真调用 claude 二进制)。
export async function checkClaudeAuth({ execFn }) {
  try {
    const { stdout } = await execFn('claude', ['-p', 'ping', '--output-format', 'json']);
    return { ok: true, detail: String(stdout).slice(0, 120) };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}
