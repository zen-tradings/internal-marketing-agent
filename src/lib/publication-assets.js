import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { JSDOM } from 'jsdom';
import { withTaskCancellation } from './task-cancellation.js';
import { safeFetchResource } from './safe-fetch.js';

export function imageFormat(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') throw new Error('微信不支持的 WebP');
  if (/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(bytes.toString('utf8').trimStart())) throw new Error('微信不支持的 SVG');
  throw new Error('文件没有允许的 PNG/JPEG/GIF 图片签名');
}

function within(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function validateLocalImage(src, { absoluteDirPath, trustedAssetPaths = [] } = {}) {
  const decoded = decodeURIComponent(String(src));
  if (/^[a-z][a-z0-9+.-]*:/i.test(decoded) || decoded.startsWith('//') || decoded.includes('\0')) {
    throw new Error('图片地址必须是已登记的本地资产');
  }
  if (!path.isAbsolute(decoded) && !absoluteDirPath) throw new Error('图片缺少任务目录');
  const filename = path.resolve(absoluteDirPath || '.', decoded);
  let real;
  try { real = fs.realpathSync(filename); } catch { throw new Error(`本地图片不存在:${src}`); }
  const trusted = trustedAssetPaths.filter(Boolean).some((allowed) => {
    try { return path.resolve(allowed) === filename && fs.realpathSync(allowed) === real; } catch { return false; }
  });
  if (!trusted && (!absoluteDirPath || !within(path.resolve(absoluteDirPath), filename)
    || !within(fs.realpathSync(absoluteDirPath), real))) throw new Error(`图片越出任务资产目录:${src}`);
  const stat = fs.statSync(real);
  if (!stat.isFile() || !stat.size || stat.size > 10 * 1024 * 1024) throw new Error('图片必须是 10MB 内的非空普通文件');
  const descriptor = fs.openSync(real, 'r');
  try {
    const head = Buffer.alloc(512);
    const length = fs.readSync(descriptor, head, 0, head.length, 0);
    imageFormat(head.subarray(0, length));
  } finally { fs.closeSync(descriptor); }
  return real;
}

// Materialize the only historically accepted remote images before the publisher,
// whose built-in downloader does not enforce the application's network policy.
export async function registerPublicationAssets(content, cover, options = {}) {
  const document = new JSDOM(`<body>${content}</body>`).window.document;
  const manifest = [];
  let downloadedBytes = 0;
  const register = async (src) => {
    if (/^https:\/\/mmbiz\.qpic\.cn(?:\/|$)/i.test(src)) {
      if (!options.absoluteDirPath) throw new Error('远程图片缺少任务目录');
      const result = await safeFetchResource({ url: src, fetchFn: withTaskCancellation(options.fetchFn || globalThis.fetch, options.signal), maxBytes: 10 * 1024 * 1024 });
      downloadedBytes += result.buffer.length;
      if (downloadedBytes > 40 * 1024 * 1024) throw new Error('发布图片下载超过任务 40MB 上限');
      const extension = imageFormat(result.buffer);
      const digest = crypto.createHash('sha256').update(result.buffer).digest('hex');
      src = path.join(options.absoluteDirPath, `publication-${digest}.${extension}`);
      await fs.promises.writeFile(src, result.buffer, { mode: 0o600 });
    }
    const filename = validateLocalImage(src, options);
    manifest.push({ path: filename, sha256: crypto.createHash('sha256').update(await fs.promises.readFile(filename)).digest('hex') });
    return filename;
  };
  for (const image of document.querySelectorAll('img')) {
    image.setAttribute('src', await register(image.getAttribute('src') || image.getAttribute('data-src') || ''));
    image.removeAttribute('data-src');
  }
  const registeredCover = cover ? await register(cover) : cover;
  await fs.promises.writeFile(path.join(options.absoluteDirPath, 'publication-assets.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { content: document.body.innerHTML, cover: registeredCover };
}
