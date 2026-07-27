import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  attachmentsFromSlackMessages,
  isDirectUserUrl,
  loadDirectUserSources,
  normalizeSlackAttachments,
  sourceRequestHeadersForAttachment,
  translationAttachment,
} from '../src/core/user-sources.js';

function response(body, contentType = 'text/html; charset=utf-8') {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        if (key === 'content-type') return contentType;
        if (key === 'content-length') return String(buffer.length);
        return null;
      },
    },
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
  };
}

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

test('Slack file_share 保留 PDF 元数据并用 Bot token 读取私有下载地址', () => {
  const files = [{
    id: 'F1',
    name: 'report.pdf',
    mimetype: 'application/pdf',
    filetype: 'pdf',
    size: 1234,
    url_private_download: 'https://files.slack.com/files-pri/T1-F1/download/report.pdf',
  }];
  const normalized = normalizeSlackAttachments(files);
  assert.equal(normalized.length, 1);
  assert.equal(translationAttachment(normalized).name, 'report.pdf');
  assert.deepEqual(
    sourceRequestHeadersForAttachment(normalized[0], 'xoxb-secret'),
    { Authorization: 'Bearer xoxb-secret' },
  );
  assert.equal(
    attachmentsFromSlackMessages([{ text: '翻译附件', attachments: files }, { text: '补充', attachments: files }]).length,
    1,
  );
});

test('Google Docs 链接通过 Drive export 读取并保留原始链接为一级用户来源', async () => {
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return response(`<!doctype html><html><head><title>Research Note</title></head><body><article>
      <h1>Research Note</h1>
      <p>${'This document contains primary user-provided analysis. '.repeat(20)}</p>
    </article></body></html>`);
  };
  const originalUrl = 'https://docs.google.com/document/d/doc-123/edit';
  const result = await loadDirectUserSources({
    userUrls: [originalUrl],
    workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'google-doc-source-')),
    config: {
      translation: { browserEnabled: false, dnsLookup: publicDns },
      documents: { googleDocsAccessToken: 'google-token' },
    },
    fetchFn,
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].url, originalUrl);
  assert.equal(result.sources[0].userSpecified, true);
  assert.match(result.sources[0].text, /primary user-provided analysis/);
  assert.match(calls[0].url, /googleapis\.com\/drive\/v3\/files\/doc-123\/export/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer google-token');
  assert.equal(isDirectUserUrl(originalUrl), true);
});

test('GitHub 仓库先读 tree，再并行读取高价值代码文件', async () => {
  let activeFiles = 0;
  let maxActiveFiles = 0;
  const fetchFn = async (url) => {
    const target = String(url);
    if (/\/repos\/acme\/demo$/.test(target)) {
      return response(JSON.stringify({
        full_name: 'acme/demo',
        description: 'Demo agent',
        default_branch: 'main',
        language: 'JavaScript',
        pushed_at: '2026-07-26T00:00:00Z',
      }), 'application/json');
    }
    if (/\/git\/trees\/main/.test(target)) {
      return response(JSON.stringify({
        tree: [
          { type: 'blob', path: 'README.md', size: 100 },
          { type: 'blob', path: 'package.json', size: 100 },
          { type: 'blob', path: 'src/index.js', size: 100 },
        ],
      }), 'application/json');
    }
    if (/\/contents\//.test(target)) {
      activeFiles += 1;
      maxActiveFiles = Math.max(maxActiveFiles, activeFiles);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeFiles -= 1;
      const file = decodeURIComponent(target.match(/\/contents\/([^?]+)/)?.[1] || '');
      return response(`content for ${file}`, 'text/plain');
    }
    throw new Error(`unexpected URL ${target}`);
  };
  const result = await loadDirectUserSources({
    userUrls: ['https://github.com/acme/demo'],
    workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'github-source-')),
    config: {
      translation: { dnsLookup: publicDns },
      documents: { githubToken: 'github-token' },
    },
    fetchFn,
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.sources[0].extractor, 'github-rest-parallel');
  assert.equal(result.sources[0].official, undefined);
  assert.match(result.sources[0].text, /FILE: README\.md/);
  assert.match(result.sources[0].text, /FILE: src\/index\.js/);
  assert.ok(maxActiveFiles >= 2);
});
