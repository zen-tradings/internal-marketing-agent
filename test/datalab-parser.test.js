import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertPdfWithDatalab } from '../src/workflows/datalab-parser.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z2S0AAAAASUVORK5CYII=';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zen-datalab-'));
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('Datalab 按指定页码解析 PDF，低质量时自动升级 accurate 并落地图片', async () => {
  const submissions = [];
  const fetchFn = async (url, options = {}) => {
    if (String(url).endsWith('/convert')) {
      const mode = options.body.get('mode');
      submissions.push({
        mode,
        pageRange: options.body.get('page_range'),
        outputFormat: options.body.get('output_format'),
      });
      return jsonResponse({
        success: true,
        request_id: `req-${mode}`,
        request_check_url: `https://www.datalab.to/api/v1/convert/req-${mode}`,
      });
    }
    const accurate = String(url).endsWith('req-accurate');
    return jsonResponse({
      status: 'complete',
      success: true,
      html: '<article><h1>Paper</h1><p>Body</p><figure><img src="image.png"></figure></article>',
      images: { 'image.png': PNG },
      parse_quality_score: accurate ? 4.6 : 2.4,
      page_count: 11,
      metadata: { title: 'Paper' },
    });
  };
  const result = await convertPdfWithDatalab({
    pdfBuffer: Buffer.from('%PDF fixture'),
    pageRange: '0-10',
    workDir: tempDir(),
    config: { datalabApiKey: 'secret', datalabMode: 'balanced' },
    fetchFn,
    sleepFn: async () => {},
  });

  assert.deepEqual(submissions, [
    { mode: 'balanced', pageRange: '0-10', outputFormat: 'html' },
    { mode: 'accurate', pageRange: '0-10', outputFormat: 'html' },
  ]);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.parseQualityScore, 4.6);
  assert.ok(fs.existsSync(result.images['image.png']));
  assert.match(result.html, /<figure>/);
});

test('Datalab 未配置密钥时明确失败', async () => {
  await assert.rejects(() => convertPdfWithDatalab({
    pdfBuffer: Buffer.from('%PDF fixture'),
    workDir: tempDir(),
    config: {},
  }), /DATALAB_API_KEY/);
});

test('Datalab 拒绝非信任结果查询主机', async () => {
  await assert.rejects(() => convertPdfWithDatalab({
    pdfBuffer: Buffer.from('%PDF fixture'),
    workDir: tempDir(),
    config: { datalabApiKey: 'secret' },
    fetchFn: async () => jsonResponse({
      success: true,
      request_id: 'req-1',
      request_check_url: 'https://attacker.example/api/v1/convert/req-1',
    }),
    sleepFn: async () => {},
  }), /非信任主机/);
});

test('Datalab API 基地址不能把密钥发送到非信任主机', async () => {
  await assert.rejects(() => convertPdfWithDatalab({
    pdfBuffer: Buffer.from('%PDF fixture'),
    workDir: tempDir(),
    config: {
      datalabApiKey: 'secret',
      datalabBaseUrl: 'https://attacker.example/api/v1',
    },
  }), /受信任的 HTTPS 主机/);
});
