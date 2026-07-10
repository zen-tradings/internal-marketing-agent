export async function checkOpenRouterHealth({ config, fetchFn = globalThis.fetch }) {
  try {
    const writer = config.writer || {};
    const baseUrl = String(writer.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    const res = await fetchFn(`${baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${writer.openrouterApiKey}` },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} ${await safeText(res)}`.trim());
    const data = await res.json();
    const count = Array.isArray(data.data) ? data.data.length : 0;
    return { ok: true, detail: `models:${count}` };
  } catch (e) {
    return { ok: false, detail: String(e.message || e).slice(0, 120) };
  }
}

export const checkClaudeAuth = checkOpenRouterHealth;

async function safeText(res) {
  try { return (await res.text()).slice(0, 120); } catch { return ''; }
}
