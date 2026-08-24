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
  recoverOfficialDocumentMirrors,
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

test('FCC PDF 被 CDN 拒绝时从检索材料识别文号并读取匹配的官方 TXT 附件', async () => {
  const calls = [];
  const result = await recoverOfficialDocumentMirrors({
    userUrls: ['https://www.fcc.gov/sites/default/files/robots-nsd.pdf'],
    discoverySources: [{
      title: 'FCC robot covered-list analysis',
      text: 'The router order was DA 26-278. The advanced robotic-device public notice was DA 26-786 and includes the national security determination.',
    }],
    config: { translation: { dnsLookup: publicDns } },
    fetchFn: async (url) => {
      calls.push(String(url));
      const robotDocument = String(url).includes('DA-26-786');
      const topic = robotDocument
        ? 'Advanced Robotic Devices robot security determination. '
        : 'Consumer routers and network equipment determination. ';
      return response(
        `Federal Communications Commission ${robotDocument ? 'DA 26-786' : 'DA 26-278'}\n${topic.repeat(20)}`,
        'text/plain; charset=UTF-8',
      );
    },
  });

  assert.deepEqual(calls, [
    'https://docs.fcc.gov/public/attachments/DA-26-278A1.txt',
    'https://docs.fcc.gov/public/attachments/DA-26-786A1.txt',
  ]);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].url, 'https://docs.fcc.gov/public/attachments/DA-26-786A1.txt');
  assert.equal(result.sources[0].userSpecified, true);
  assert.equal(result.sources[0].official, true);
  assert.equal(result.sources[0].recoveredForUserUrl, 'https://www.fcc.gov/sites/default/files/robots-nsd.pdf');
  assert.deepEqual(result.attempts.map((attempt) => attempt.status), ['rejected-mismatch', 'ok']);
});

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
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].url, originalUrl);
  assert.equal(result.sources[0].userSpecified, true);
  assert.match(result.sources[0].text, /primary user-provided analysis/);
  assert.match(calls[0].url, /googleapis\.com\/drive\/v3\/files\/doc-123\/export/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer google-token');
  assert.equal(isDirectUserUrl(originalUrl), true);
});

test('Google Docs refresh token 自动换取 access token，分析文档与直译共用认证', async () => {
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    const target = String(url);
    calls.push({ url: target, options });
    if (target === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({
        access_token: 'refreshed-access-token',
        expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return response(`<!doctype html><html><head><title>Private Note</title></head><body><article>
      <h1>Private Note</h1>
      <p>${'Private Google Docs content supplied by the user. '.repeat(20)}</p>
    </article></body></html>`);
  };
  const originalUrl = 'https://docs.google.com/document/u/0/d/private-doc-456/edit';
  const result = await loadDirectUserSources({
    userUrls: [originalUrl],
    workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'google-doc-refresh-source-')),
    config: {
      translation: { browserEnabled: false, dnsLookup: publicDns },
      documents: {
        googleDocsClientId: 'client-id-refresh-test',
        googleDocsClientSecret: 'client-secret',
        googleDocsRefreshToken: 'refresh-token',
      },
    },
    fetchFn,
  });
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  assert.equal(result.sources.length, 1);
  assert.match(result.sources[0].text, /Private Google Docs content/);
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.match(String(calls[0].options.body), /grant_type=refresh_token/);
  assert.match(String(calls[0].options.body), /refresh_token=refresh-token/);
  assert.match(calls[1].url, /googleapis\.com\/drive\/v3\/files\/private-doc-456\/export/);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer refreshed-access-token');
  assert.equal(isDirectUserUrl(originalUrl), true);
});

test('Google Docs OAuth 配置不完整时返回可操作错误', async () => {
  const result = await loadDirectUserSources({
    userUrls: ['https://docs.google.com/document/d/private-doc/edit'],
    workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'google-doc-incomplete-oauth-')),
    config: {
      translation: { browserEnabled: false, dnsLookup: publicDns },
      documents: { googleDocsClientId: 'client-id-only' },
    },
    fetchFn: async () => {
      throw new Error('不应发起网络请求');
    },
  });
  assert.equal(result.sources.length, 0);
  assert.equal(result.errors[0].kind, 'google-doc');
  assert.match(result.errors[0].error, /OAuth 配置不完整/);
  assert.match(result.errors[0].error, /GOOGLE_DOCS_CLIENT_SECRET/);
});

test('Notion 新版 app.notion.com/p 链接作为一级用户来源读取', async () => {
  const originalUrl = 'https://app.notion.com/p/baseten-blog-22580-From-GPT2-to-Kimi3-Explained-0123456789abcdef0123456789abcdef?source=copy_link';
  const result = await loadDirectUserSources({
    userUrls: [originalUrl],
    workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'notion-app-source-')),
    config: {
      translation: {
        browserEnabled: false,
        dnsLookup: publicDns,
        notionApiToken: 'notion-token',
      },
      documents: {},
    },
    fetchFn: async (url, options = {}) => {
      assert.match(String(url), /api\.notion\.com\/v1\/pages\/01234567-89ab-cdef-0123-456789abcdef\/markdown/);
      assert.equal(options.headers.Authorization, 'Bearer notion-token');
      return new Response(JSON.stringify({
        markdown: `# Private report\n\n${'Private user-provided Notion research. '.repeat(20)}`,
        truncated: false,
        unknown_block_ids: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].url, originalUrl);
  assert.match(result.sources[0].text, /Private user-provided Notion research/);
  assert.equal(isDirectUserUrl(originalUrl), true);
});

test('Linear Issue 作为一级用户来源读取，不请求浏览器页面', async () => {
  const originalUrl = 'https://linear.app/zen-trading/issue/ZEN-33/semianalysis-are-open-models-catching-up';
  const calls = [];
  const result = await loadDirectUserSources({
    userUrls: [originalUrl],
    workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'linear-issue-source-')),
    config: {
      translation: {
        browserEnabled: false,
        dnsLookup: publicDns,
        linearApiKey: 'lin_api_user',
      },
      documents: {},
    },
    fetchFn: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      assert.equal(String(url), 'https://api.linear.app/graphql');
      assert.equal(options.headers.Authorization, 'lin_api_user');
      return new Response(JSON.stringify({
        data: {
          issue: {
            identifier: 'ZEN-33',
            title: 'Are open models catching up',
            description: `# Private Linear report\n\n${'Private user-provided Linear research. '.repeat(20)}`,
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].url, originalUrl);
  assert.equal(result.sources[0].sourceType, 'linear');
  assert.equal(result.sources[0].extractor, 'linear-graphql-api');
  assert.match(result.sources[0].text, /Private user-provided Linear research/);
  assert.equal(isDirectUserUrl(originalUrl), true);
  assert.equal(isDirectUserUrl('https://linear.app/zen-trading/document/notes-abc'), false);
  assert.equal(calls.length, 1);
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
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  assert.equal(result.sources[0].extractor, 'github-rest-parallel');
  assert.equal(result.sources[0].official, undefined);
  assert.match(result.sources[0].text, /FILE: README\.md/);
  assert.match(result.sources[0].text, /FILE: src\/index\.js/);
  assert.ok(maxActiveFiles >= 2);
});
