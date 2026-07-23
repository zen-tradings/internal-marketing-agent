import http from 'node:http';

export async function startHealthServer({ host = '127.0.0.1', port = 0, status = () => ({ ok: true }) } = {}) {
  if (!port) return undefined;
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET' || !['/health', '/ready'].includes(request.url)) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    const payload = healthPayload(request.url, status);
    response.writeHead(payload.ok ? 200 : 503, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}

export function healthPayload(url, status = () => ({}), now = () => new Date()) {
  try {
    const current = status() || {};
    const ok = url === '/ready' ? current.ready !== false : current.live !== false;
    const payload = { ...current, ok, at: now().toISOString() };
    delete payload.ready;
    delete payload.live;
    return payload;
  } catch (error) {
    return { ok: false, error: String(error?.message || error), at: now().toISOString() };
  }
}

export async function stopHealthServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
}
