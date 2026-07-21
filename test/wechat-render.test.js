import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  alignTerminalReferences,
  appendFinalFooter,
  removeDuplicateReferenceSections,
  styleKeyHighlights,
  validatePreparedWechatHtml,
} from '../src/lib/wechat-render.js';

test('微信最终 HTML:尾图移动到脚注和来源之后且只出现一次', () => {
  const footer = '/assets/zen-footer-qr.png';
  const html = `<section><p><img src="${footer}"></p><p>正文</p><section class="footnotes">脚注</section><p>来源文字</p></section>`;
  const output = appendFinalFooter(html, footer);
  const document = new JSDOM(`<body>${output}</body>`).window.document;
  const root = document.body.firstElementChild;
  const footers = document.querySelectorAll('[data-zen-final-footer="true"]');
  assert.equal(footers.length, 1);
  assert.equal(root.lastElementChild.getAttribute('data-zen-final-footer-wrapper'), 'true');
  assert.equal(root.lastElementChild.nextSibling, null);
  assert.equal(root.lastElementChild.textContent, '');
});

test('微信最终 HTML:文末引用链接及列表强制左对齐', () => {
  const html = '<section><h2 style="text-align:center">引用链接</h2><ol style="text-align:center"><li><a href="https://example.com">来源 A</a></li></ol></section>';
  const output = alignTerminalReferences(html);
  const document = new JSDOM(`<body>${output}</body>`).window.document;
  for (const selector of ['h2', 'ol', 'li', 'a']) {
    assert.equal(document.querySelector(selector).style.textAlign, 'left');
  }
});

test('微信最终 HTML:Markdown 粗体渲染为克制的关键词高亮', () => {
  const output = styleKeyHighlights('<section><p>这是<strong>核心观点</strong>。</p></section>');
  const strong = new JSDOM(`<body>${output}</body>`).window.document.querySelector('strong');
  assert.equal(strong.getAttribute('data-zen-key-highlight'), 'true');
  assert.match(strong.getAttribute('style'), /linear-gradient/);
  assert.equal(strong.style.color, 'rgb(41, 74, 99)');
});

test('微信最终 HTML:Wenyan 自动脚注与手工引用重复时只保留最后一个引用链接板块', () => {
  const html = '<section><p>正文</p><h2>引用链接</h2><ol id="manual"><li><a href="https://a.example">A</a></li></ol><h3>引用链接</h3><section id="footnotes"><p>A: https://a.example</p></section></section>';
  const output = removeDuplicateReferenceSections(html);
  const document = new JSDOM(`<body>${output}</body>`).window.document;
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter((node) => node.textContent.trim() === '引用链接');
  assert.equal(headings.length, 1);
  assert.equal(headings[0].tagName, 'H3');
  assert.equal(document.querySelector('#manual'), null);
  assert.ok(document.querySelector('#footnotes'));
});

test('微信最终 HTML:校验乱码、空表格、坏图和本地图片存在性', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-wechat-html-'));
  fs.writeFileSync(path.join(dir, 'ok.png'), Buffer.from([1, 2, 3]));
  assert.deepEqual(
    validatePreparedWechatHtml('<p><img src="ok.png"></p><table><tr><td>A</td></tr></table>', { absoluteDirPath: dir }),
    { images: 1, tables: 1 },
  );
  assert.throws(
    () => validatePreparedWechatHtml('<p>坏字�</p><img src="missing.png"><table></table>', { absoluteDirPath: dir }),
    /疑似乱码.*本地图片不存在.*表格结构为空或损坏/,
  );
});
