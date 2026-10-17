import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireSourceDocument, assertUsableArticleResponse } from '../src/lib/translation/acquisition.js';
import { sourceDocumentFromHtml } from '../src/lib/translation/structure.js';
import { officialArticleApi, fetchOfficialArticleHtml, officialArticleImageMirror } from '../src/lib/translation/official-source.js';
import { assertBrowserNavigationResponse } from '../src/lib/translation/browser.js';

const SOURCE = 'https://www.hudsonrivertrading.com/hrtbeat/long-on-research-short-on-bandwidth/';
const API = 'https://www.hudsonrivertrading.com/wp-json/wp/v2/posts?slug=long-on-research-short-on-bandwidth';
const PUBLIC_DNS = async () => [{ address: '93.184.216.34', family: 4 }];
const FORBIDDEN = '<html><head><title>Error 403 Forbidden</title></head><body><h1>403 Forbidden</h1></body></html>';
const BODY = 'A complete synthetic paragraph describing kernel networking and workflow attribution. '.repeat(8);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 'base64');

function post(overrides = {}) {
  return {
    slug: 'long-on-research-short-on-bandwidth', status: 'publish', type: 'post', link: SOURCE,
    title: { rendered: 'Research &amp; bandwidth' },
    date_gmt: '2026-10-12T13:00:57', yoast_head_json: { author: 'Example Author' },
    content: { protected: false, rendered: `<h2>Introduction</h2><p>${BODY}</p>
      <figure><img src="/wp-content/uploads/chart.png"><figcaption>Bandwidth chart</figcaption></figure>
      <pre><code>bytes_received[key] += received;</code></pre>
      <h2>Final section</h2><p>${BODY}End of original article.</p>` },
    ...overrides,
  };
}

test('HRT 真实错误页回归：32 字符来自 403，不能报成正文提取过短', async () => {
  await assert.rejects(sourceDocumentFromHtml({ html: FORBIDDEN, sourceUrl: SOURCE }), /网页正文过短:32 字符/);
  assert.throws(() => assertUsableArticleResponse(FORBIDDEN, SOURCE), /原站返回 HTTP 错误页:Error 403 Forbidden/);
  assert.doesNotThrow(() => assertUsableArticleResponse(`<title>Networking research</title><article><p>${BODY}HTTP 403 Forbidden is a response code.</p></article>`, SOURCE));
});

for (const status of [403, 200]) {
  test(`HRT ${status} 错误页从官方 API 恢复完整原文、末尾、原图和代码，跳过浏览器`, async (t) => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-official-source-'));
    t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
    const calls = [];
    const document = await acquireSourceDocument({
      sourceUrl: SOURCE, workDir, config: { browserEnabled: false }, dnsLookup: PUBLIC_DNS,
      fetchFn: async (url) => {
        calls.push(String(url));
        if (String(url) === SOURCE) return new Response(FORBIDDEN, { status, statusText: status === 403 ? 'Forbidden' : 'OK' });
        if (String(url) === API) return Response.json([post()]);
        if (String(url).endsWith('/chart.png')) return new Response(PNG, { headers: { 'content-type': 'image/png' } });
        throw new Error(`Unexpected URL: ${url}`);
      },
    });
    assert.deepEqual(calls, [SOURCE, API, 'https://www.hudsonrivertrading.com/wp-content/uploads/chart.png']);
    assert.equal(document.sourceUrl, SOURCE);
    assert.equal(document.extractor, 'hrt-wordpress-api');
    assert.equal(document.title, 'Research & bandwidth');
    assert.equal(document.author, '', 'CMS 账号不能当作文章署名');
    assert.equal(document.publishedDate, '2026-10-12T13:00:57Z');
    assert.match(document.blocks.at(-1).text, /End of original article/);
    assert.deepEqual(document.blocks.filter((b) => b.type === 'heading').map((b) => b.text), ['Introduction', 'Final section']);
    assert.equal(document.blocks.find((b) => b.type === 'code').text, 'bytes_received[key] += received;');
    assert.ok(fs.existsSync(document.blocks.find((b) => b.type === 'figure').images[0].localPath));
    assert.deepEqual(document.acquisition.attempts, ['static-http', 'hrt-wordpress-api']);
  });
}

test('官方恢复继续遵守用户章节范围，不下载范围外的图片', async (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-official-scope-'));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const document = await acquireSourceDocument({
    sourceUrl: SOURCE, workDir, config: { browserEnabled: false }, dnsLookup: PUBLIC_DNS,
    scope: { kind: 'sections', start: 'Final section', end: 'Final section' },
    fetchFn: async (url) => String(url) === SOURCE
      ? new Response(FORBIDDEN, { status: 403 }) : Response.json([post()]),
  });
  assert.equal(document.blocks.filter((b) => b.type === 'figure').length, 0);
  assert.match(document.blocks.at(-1).text, /End of original article/);
});

test('HRT 原图 403 后通过固定 WordPress 图片 CDN 恢复，并保留原 URL 与追踪', async (t) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-official-image-'));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const imageUrl = 'https://www.hudsonrivertrading.com/wp-content/uploads/2026/10/chart.png';
  const mirrorUrl = `https://i0.wp.com/www.hudsonrivertrading.com/wp-content/uploads/2026/10/chart.png?ssl=1`;
  const original = post();
  original.content.rendered = original.content.rendered.replace('/wp-content/uploads/chart.png', imageUrl);
  const calls = [];
  const document = await acquireSourceDocument({
    sourceUrl: SOURCE, workDir, config: { browserEnabled: false }, dnsLookup: PUBLIC_DNS,
    fetchFn: async (url, options) => {
      calls.push(String(url));
      if (String(url) === API) return Response.json([original]);
      if (String(url) === mirrorUrl) {
        assert.equal(options.headers.Authorization, undefined);
        return new Response(PNG, { headers: { 'content-type': 'image/png' } });
      }
      return new Response(FORBIDDEN, { status: 403 });
    },
  });
  assert.deepEqual(calls, [SOURCE, API, imageUrl, mirrorUrl]);
  assert.equal(document.blocks.find((b) => b.type === 'figure').images[0].src, imageUrl);
  assert.deepEqual(document.acquisition.assetFallbacks, [{ originalUrl: imageUrl, mirrorUrl }]);
});

test('图片镜像只接受登记文章中的公开 HRT 上传图片，不能代抓其它地址', () => {
  for (const image of [
    'https://evil.example/wp-content/uploads/2026/10/chart.png',
    'http://www.hudsonrivertrading.com/wp-content/uploads/2026/10/chart.png',
    'https://www.hudsonrivertrading.com:8443/wp-content/uploads/2026/10/chart.png',
    'https://www.hudsonrivertrading.com/wp-content/uploads/2026/10/chart.png?token=secret',
    'https://www.hudsonrivertrading.com/wp-content/uploads/2026/10/../../secret.png',
    'https://www.hudsonrivertrading.com/private/report.pdf',
  ]) assert.equal(officialArticleImageMirror(SOURCE, image), undefined);
  assert.equal(officialArticleImageMirror('https://example.com/report', 'https://www.hudsonrivertrading.com/wp-content/uploads/2026/10/chart.png'), undefined);
});

test('正常原文不额外请求 API；未登记网站、路径和协议不猜测接口', async (t) => {
  for (const url of ['https://example.com/hrtbeat/post/', 'https://www.hudsonrivertrading.com.evil.com/hrtbeat/post/', 'https://www.hudsonrivertrading.com/hrtbeat/', 'http://www.hudsonrivertrading.com/hrtbeat/post/']) {
    assert.equal(officialArticleApi(url), undefined);
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-official-static-'));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const calls = [];
  await acquireSourceDocument({
    sourceUrl: SOURCE, workDir, dnsLookup: PUBLIC_DNS, config: { browserEnabled: false },
    fetchFn: async (url) => { calls.push(String(url)); return new Response(`<article><p>${BODY}</p></article>`); },
  });
  assert.deepEqual(calls, [SOURCE]);
});

test('官方 API 拒绝错文、外站、草稿、保护正文、摘要和不唯一结果', async () => {
  const invalid = [
    [], [post(), post()], [post({ slug: 'different-post' })],
    [post({ link: 'https://evil.example/hrtbeat/long-on-research-short-on-bandwidth/' })],
    [post({ link: SOURCE.replace('https:', 'http:') })],
    [post({ link: `${SOURCE}?preview=1` })],
    [post({ status: 'draft' })], [post({ type: 'page' })],
    [post({ content: { protected: true, rendered: BODY } })],
    [post({ content: { rendered: '' }, excerpt: { rendered: BODY } })],
  ];
  for (const payload of invalid) {
    await assert.rejects(fetchOfficialArticleHtml({
      sourceUrl: SOURCE, descriptor: officialArticleApi(SOURCE), dnsLookup: PUBLIC_DNS,
      fetchFn: async () => Response.json(payload),
    }), /官方原文 API/);
  }
});

test('官方 API 仍拦截私网 DNS、跨域重定向和响应超限', async () => {
  await assert.rejects(fetchOfficialArticleHtml({
    sourceUrl: SOURCE, descriptor: officialArticleApi(SOURCE),
    dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
    fetchFn: async () => { throw new Error('must not fetch'); },
  }), /私网或保留地址/);
  await assert.rejects(fetchOfficialArticleHtml({
    sourceUrl: SOURCE, descriptor: officialArticleApi(SOURCE), dnsLookup: PUBLIC_DNS,
    fetchFn: async (url) => String(url) === API
      ? new Response(null, { status: 302, headers: { location: 'https://evil.example/api' } })
      : Response.json([post()]),
  }), /非登记入口/);
  await assert.rejects(fetchOfficialArticleHtml({
    sourceUrl: SOURCE, descriptor: officialArticleApi(SOURCE), dnsLookup: PUBLIC_DNS,
    limits: { maxSourceBytes: 100, maxRedirects: 5, fetchTimeoutMs: 1000 },
    fetchFn: async () => Response.json([post()]),
  }), /超过大小上限/);
});

test('浏览器非成功 HTTP 响应不能进入滚动、截图和正文提取', () => {
  assert.throws(() => assertBrowserNavigationResponse({ ok: () => false, status: () => 403, statusText: () => 'Forbidden' }), /浏览器原文获取失败:403 Forbidden/);
  assert.throws(() => assertBrowserNavigationResponse(null), /未收到原站文档响应/);
  assert.doesNotThrow(() => assertBrowserNavigationResponse({ ok: () => true }));
});
