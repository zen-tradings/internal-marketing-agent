export async function uploadCustomerIoAsset({
  baseUrl = 'https://api.customer.io', appApiKey, buffer, filename, name = filename,
  parentFolderId, fetchFn = globalThis.fetch, timeoutMs = 30000,
}) {
  if (!appApiKey) throw assetError('缺少 CUSTOMERIO_APP_API_KEY');
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw assetError('Customer.io asset 为空');
  if (buffer.length > 2 * 1024 * 1024) throw assetError(`Customer.io asset 超过 2MB:${buffer.length}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const form = new FormData();
    form.set('file', new Blob([buffer], { type: 'image/png' }), filename);
    form.set('name', name);
    if (parentFolderId) form.set('parent_folder_id', String(parentFolderId));
    const response = await fetchFn(`${String(baseUrl).replace(/\/+$/, '')}/v1/assets/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${appApiKey}` },
      body: form,
      signal: controller.signal,
    });
    const detail = await safeBody(response);
    if (!response.ok) throw assetError(`Customer.io asset 上传失败:${response.status} ${detail}`.trim());
    const asset = detail?.asset;
    if (!asset?.id || !isPublicHttps(asset.path)) throw assetError('Customer.io asset 返回的公开 HTTPS 地址无效');
    await verifyAssetUrl(asset.path, fetchFn, timeoutMs);
    return asset;
  } finally { clearTimeout(timer); }
}

export function isPublicHttps(value) {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

export async function verifyAssetUrl(url, fetchFn = globalThis.fetch, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, { method: 'GET', signal: controller.signal });
    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    if (!response.ok || !contentType.startsWith('image/')) {
      throw assetError(`Customer.io asset URL 无法读取:${response.status || 'unknown'} ${contentType}`);
    }
    return true;
  } finally { clearTimeout(timer); }
}

async function safeBody(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return text.slice(0, 500); }
}
function assetError(message) { const error = new Error(message); error.stage = 'asset'; return error; }
