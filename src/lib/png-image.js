import crypto from 'node:crypto';

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function assertPng(buffer, { width, height, sha256 = '', label = 'PNG' }) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw pngError(`${label}签名无效`);
  }
  const actualWidth = buffer.readUInt32BE(16);
  const actualHeight = buffer.readUInt32BE(20);
  if (actualWidth !== width || actualHeight !== height) {
    throw pngError(`${label}尺寸无效:${actualWidth}×${actualHeight}，期望 ${width}×${height}`);
  }
  if (sha256) {
    const actualSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    if (actualSha256 !== sha256) throw pngError(`${label} SHA-256 不匹配`);
  }
  return buffer;
}

export function pngError(message) {
  return Object.assign(new Error(message), { stage: 'cover', retryable: true });
}
