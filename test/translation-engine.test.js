import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateStrictTranslation } from '../src/workflows/translate-engine.js';

const PUBLIC_DNS = async () => [{ address: '93.184.216.34', family: 4 }];

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zen-translate-text-'));
}

function translator(onPayload) {
  return async ({ prompt }) => {
    const payload = JSON.parse(/输入 JSON:\n([\s\S]+)$/.exec(prompt)[1]);
    onPayload?.(payload, prompt);
    return JSON.stringify({
      translations: payload.units.map((unit) => ({
        id: unit.id,
        text: unit.id === 'meta:title' ? '结构化直译' : `中文译文：${unit.text}`,
      })),
    });
  };
}

test('直译任务没有链接时直接失败', async () => {
  await assert.rejects(() => generateStrictTranslation({
    input: '请直译这篇文章',
    workflow: { workDir: tempDir(), model: 'test-model' },
    writer: { model: 'test-model' },
    completeArticle: translator(),
  }), /缺少可读取的 http\(s\) 原文链接/);
});

test('所有直译请求走结构化文档模式并保留图片、图注和表格', async () => {
  const paragraph = 'This is a full body paragraph with enough source prose for strict text extraction and faithful translation. '.repeat(4);
  const html = `<article>
    <h1>Text-only translation</h1>
    <p>${paragraph}</p>
    <figure><img src="secret.png"><figcaption>SECRET_FIGURE</figcaption></figure>
    <table><tr><td>SECRET_TABLE</td></tr></table>
    <h2>Second section</h2>
    <p>${paragraph}</p>
  </article>`;
  const trace = {};
  const result = await generateStrictTranslation({
    input: '完整直译 https://example.com/article 并保留原图和表格',
    workflow: { workDir: tempDir(), model: 'test-model', timeoutMs: 1000 },
    writer: { model: 'test-model' },
    fetchFn: async (url) => String(url).endsWith('/secret.png')
      ? new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 'base64'), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      : new Response(html, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    fetchWithRetry: async (fetch, url, options) => fetch(url, options),
    completeArticle: translator((payload) => {
      const input = JSON.stringify(payload);
      assert.match(input, /SECRET_FIGURE|SECRET_TABLE/);
    }),
    trace,
    translationConfig: { browserEnabled: false, dnsLookup: PUBLIC_DNS },
  });
  assert.equal(result.manifest.contentMode, 'structured-document');
  assert.equal(result.completeness.contentMode, 'structured-document');
  assert.equal(trace.translationText.contentMode, 'structured-document');
  assert.match(result.article, /!\[/);
  assert.match(result.article, /^\|/m);
  assert.match(result.article, /中文译文：SECRET_FIGURE/);
});

test('模型漏掉结构化文本块时拒绝生成译文', async () => {
  const paragraph = 'This is a complete source paragraph containing enough text for deterministic article extraction. '.repeat(5);
  await assert.rejects(() => generateStrictTranslation({
    input: '直译 https://example.com/article',
    workflow: { workDir: tempDir(), model: 'test-model', timeoutMs: 1000 },
    writer: { model: 'test-model' },
    fetchFn: async () => new Response(`<article><h1>Title</h1><p>${paragraph}</p></article>`, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
    fetchWithRetry: async (fetch, url, options) => fetch(url, options),
    completeArticle: async () => '{"translations":[]}',
    translationConfig: { browserEnabled: false, dnsLookup: PUBLIC_DNS },
  }), /结构化翻译校验失败/);
});

test('断点文件使用结构化版本且可继续翻译', async () => {
  const workDir = tempDir();
  const paragraph = 'This is a complete body paragraph for checkpoint verification and faithful translation. '.repeat(5);
  const args = {
    input: '直译 https://example.com/article',
    workflow: { workDir, model: 'test-model', timeoutMs: 1000 },
    writer: { model: 'test-model' },
    fetchFn: async () => new Response(`<article><h1>Title</h1><p>${paragraph}</p></article>`, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
    fetchWithRetry: async (fetch, url, options) => fetch(url, options),
    completeArticle: translator(),
    translationConfig: { browserEnabled: false, dnsLookup: PUBLIC_DNS },
  };
  await generateStrictTranslation(args);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(workDir, 'translation-checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.version, 5);
  await assert.doesNotReject(() => generateStrictTranslation({ ...args, resumeFromCheckpoint: true }));
});
