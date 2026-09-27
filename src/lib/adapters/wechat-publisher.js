export { wechatPublisher } from '@wenyan-md/core/wrapper';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createWechatClient } from '@wenyan-md/core/wechat';
import { defaultHttpAdapter } from '@wenyan-md/core/http';
import { wechatPublisher } from '@wenyan-md/core/wrapper';
import { fetchWithTimeout } from '../http-timeout.js';
import { performRemoteOperation } from '../remote-operation.js';

export const wechatRequestContext = new AsyncLocalStorage();
const boundedWechatClient = createWechatClient({
  ...defaultHttpAdapter,
  fetch(resource, options) {
    const context = wechatRequestContext.getStore() || {};
    return fetchWithTimeout(context.fetchFn || globalThis.fetch, resource, options, {
      timeoutMs: context.timeoutMs || 30000,
      signal: context.signal,
      label: '微信 API',
    });
  },
});

// Wenyan's publisher keeps token and asset caches, while its default transport has no timeout. Replace only its
// network method at module initialization so caching and rendering stay unchanged; AsyncLocalStorage isolates request options.
wechatPublisher.fetchAccessToken = boundedWechatClient.fetchAccessToken;
wechatPublisher.uploadMaterial = boundedWechatClient.uploadMaterial;
wechatPublisher.publishArticle = async (token, payload) => {
  const context = wechatRequestContext.getStore() || {};
  const list = async () => {
    const data = await boundedWechatClient.listDrafts(token, 0, 20, 0);
    return data?.item || [];
  };
  const mediaId = await performRemoteOperation({
    operations: context.remoteOperations, runId: context.runId,
    operation: 'create-wechat-draft', payload,
    snapshot: async () => (await list()).map(item => String(item.media_id)),
    create: async () => (await boundedWechatClient.publishArticle(token, payload)).media_id,
    recover: async (record) => {
      const before = new Set(JSON.parse(record.before_ids_json || '[]'));
      const matches = (await list()).filter(item => {
        const article = item?.content?.news_item?.[0];
        return !before.has(String(item.media_id)) && article?.title === payload.title && article?.content === payload.content;
      });
      return matches.length === 1 ? matches[0].media_id : undefined;
    },
  });
  return { media_id: mediaId };
};
wechatPublisher._listDraftsFn = boundedWechatClient.listDrafts;
wechatPublisher._getDraftFn = boundedWechatClient.getDraft;
wechatPublisher._updateDraftFn = boundedWechatClient.updateDraft;

// Formula-heavy articles produce many small equation images. wenyan's uploadImages
// fires every upload concurrently and repeats identical files; gate uploads through
// a small concurrency window and reuse an in-process content-hash cache so repeated
// files (deduped formulas, covers on retries) upload once.
const UPLOAD_CONCURRENCY = 4;
const UPLOAD_RETRY_DELAY_MS = 1000;
const uploadCache = new Map();
let uploadInFlight = 0;
const uploadWaiters = [];

function uploadQueueSlot(task) {
  return new Promise((resolve) => {
    const resume = () => {
      uploadInFlight += 1;
      resolve();
    };
    if (uploadInFlight < UPLOAD_CONCURRENCY) {
      uploadInFlight += 1;
      resolve();
    } else {
      uploadWaiters.push(resume);
    }
  }).then(async () => {
    try {
      return await task();
    } finally {
      uploadInFlight -= 1;
      const next = uploadWaiters.shift();
      if (next) next();
    }
  });
}

const WECHAT_SYSTEM_ERROR_RE = /errcode["':=\s]*-1|system error hint/i;
// WeChat material/add_material 拒绝超过 10MB 的单张图片；这是微信的硬限制，
// 超限时不会返回 errcode -1，因此不能依赖现有的 -1 降帧重试路径。
export const WECHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const GIF_REENCODE_MAX_FRAMES = 60;
const GIF_REENCODE_SCRIPT = `
import sys
from PIL import Image, ImageSequence

src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src)
frames = []
durations = []
for frame in ImageSequence.Iterator(im):
    frames.append(frame.copy())
    durations.append(frame.info.get("duration") or im.info.get("duration") or 100)
total = len(frames)
step = max(1, (total + ${GIF_REENCODE_MAX_FRAMES} - 1) // ${GIF_REENCODE_MAX_FRAMES})
if step == 1:
    im.save(dst, save_all=True)
else:
    sub = frames[::step]
    per_frame = round(sum(durations) / len(sub))
    sub[0].save(dst, save_all=True, append_images=sub[1:], duration=per_frame, loop=im.info.get("loop", 0))
`;

export async function isAnimatedGif(file) {
  try {
    if (!file || typeof file.arrayBuffer !== 'function') return false;
    const head = Buffer.from(await file.slice(0, 6).arrayBuffer());
    return head.subarray(0, 3).toString('ascii') === 'GIF';
  } catch { return false; }
}

// 上传前把超大图片收敛到微信 10MB 硬限制内：动画 GIF 用降帧重编码（≤60 帧，动画保留），
// 重编码后仍超限或非 GIF 超限时抛出清晰硬错误，而不是把必败请求发给微信拿回含混的 API 错误。
export async function prepareWechatImage(file, filename) {
  if (!file || typeof file.arrayBuffer !== 'function') return file;
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length <= WECHAT_IMAGE_MAX_BYTES) return file;
  const name = filename || 'image';
  if (buffer.subarray(0, 3).toString('ascii') !== 'GIF') {
    throw new Error(`原文图片超过微信 10MB 上限:${name} ${buffer.length}/${WECHAT_IMAGE_MAX_BYTES}`);
  }
  const reencoded = await reencodeAnimatedGif(file, filename);
  const reencodedBuffer = Buffer.from(await reencoded.arrayBuffer());
  if (reencodedBuffer.length > WECHAT_IMAGE_MAX_BYTES) {
    throw new Error(`GIF 降帧后仍超过微信 10MB 上限:${name} ${reencodedBuffer.length}/${WECHAT_IMAGE_MAX_BYTES}`);
  }
  console.error(`超大 GIF 已降帧以符合微信 10MB 上限:${name} ${buffer.length} -> ${reencodedBuffer.length}`);
  return reencoded;
}

// Re-encode an animated GIF to at most GIF_REENCODE_MAX_FRAMES frames using the pinned Pillow runtime
// (QDII venv, requirements-qdii.lock). Throws when the runtime is unavailable; callers keep the original file.
export async function reencodeAnimatedGif(file, filename) {
  const pythonPath = wechatRequestContext.getStore()?.gifReencodePythonPath
    || process.env.QDII_PYTHON_PATH
    || 'python3';
  const buffer = Buffer.from(await file.arrayBuffer());
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 24);
  const inputPath = path.join(os.tmpdir(), `zen-gif-${hash}.gif`);
  const outputPath = path.join(os.tmpdir(), `zen-gif-${hash}.reencoded.gif`);
  await fs.promises.writeFile(inputPath, buffer);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(pythonPath, ['-c', GIF_REENCODE_SCRIPT, inputPath, outputPath], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr = String(stderr + chunk).slice(0, 400); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`GIF 重编码进程退出码 ${code}${stderr ? `:${stderr}` : ''}`));
      });
    });
    const data = await fs.promises.readFile(outputPath);
    if (!data.length) throw new Error('GIF 降帧输出为空');
    return new File([data], filename || 'image.gif', { type: 'image/gif' });
  } finally {
    await fs.promises.rm(inputPath, { force: true }).catch(() => {});
    await fs.promises.rm(outputPath, { force: true }).catch(() => {});
  }
}

function installUploadGate() {
  if (wechatPublisher.__zenUploadGate) return;
  wechatPublisher.__zenUploadGate = true;
  const previous = wechatPublisher.uploadImage.bind(wechatPublisher);
  wechatPublisher.uploadImage = async function zenUploadImage(file, filename, accessToken, appId) {
    let cacheKey;
    try {
      if (file && typeof file.arrayBuffer === 'function') {
        const buffer = Buffer.from(await file.arrayBuffer());
        cacheKey = `${appId || ''}:${createHash('sha256').update(buffer).digest('hex')}`;
        const cached = uploadCache.get(cacheKey);
        if (cached) return cached;
      }
    } catch (error) {
      cacheKey = undefined;
      console.error('图片上传去重缓存失败,回退直传:', error?.message || error);
    }
    if (cacheKey) {
      let result;
      // 超过微信 10MB 硬限制的图片在这里先收敛（动画 GIF 降帧）；否则 add_material
      // 会直接拒绝且不会走下方 errcode -1 的降帧重试路径。
      let uploadFile = await prepareWechatImage(file, filename);
      for (let attempt = 1; ; attempt += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop
          result = await uploadQueueSlot(() => previous(uploadFile, filename, accessToken, appId));
          break;
        } catch (error) {
          console.error('图片上传失败,重试一次:', error?.message || error);
          if (attempt >= 2) throw error;
          // WeChat add_material rejects high-frame animated GIFs with errcode -1 (system error)
          // before any quota or size limit applies. Re-encode to at most 60 frames with the pinned
          // Pillow runtime and retry once; animation is preserved, only frame rate is sampled.
          if (WECHAT_SYSTEM_ERROR_RE.test(String(error?.message || error)) && await isAnimatedGif(uploadFile)) {
            try {
              // eslint-disable-next-line no-await-in-loop
              uploadFile = await reencodeAnimatedGif(uploadFile, filename);
              console.error('GIF 疑似超帧数被微信拒绝,已降帧重传:', filename);
            } catch (reencodeError) {
              console.error('GIF 降帧重编码失败,保持原图重试:', reencodeError?.message || reencodeError);
            }
          }
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, UPLOAD_RETRY_DELAY_MS));
        }
      }
      if (result?.media_id && result?.url) uploadCache.set(cacheKey, result);
      return result;
    }
    return previous(file, filename, accessToken, appId);
  };
}
installUploadGate();

