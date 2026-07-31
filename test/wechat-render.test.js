import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  alignTerminalReferences,
  appendFinalFooter,
  appendFinalTailImages,
  normalizeBodyTypography,
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

test('微信最终 HTML:调研图与社群封底固定为最后两张且顺序不可交换', () => {
  const survey = 'asset:zen-survey-qr.jpg';
  const footer = 'asset:zen-footer-qr.png';
  const html = `<section><p><img src="${footer}"></p><p>正文</p><p><img src="${survey}"></p><section class="footnotes">脚注</section></section>`;
  const output = appendFinalTailImages(html, { surveyPath: survey, footerPath: footer });
  const document = new JSDOM(`<body>${output}</body>`).window.document;
  const root = document.body.firstElementChild;
  const tail = [...root.children].slice(-2);

  assert.equal(document.querySelectorAll('[data-zen-final-survey="true"]').length, 1);
  assert.equal(document.querySelectorAll('[data-zen-final-footer="true"]').length, 1);
  assert.equal(tail[0].getAttribute('data-zen-final-tail-wrapper'), 'survey');
  assert.equal(tail[1].getAttribute('data-zen-final-tail-wrapper'), 'footer');
  assert.equal(tail[1], root.lastChild);
  assert.doesNotThrow(() => validatePreparedWechatHtml(output, {
    finalSurveyPath: survey,
    finalFooterPath: footer,
  }));

  root.insertBefore(tail[1], tail[0]);
  assert.throws(() => validatePreparedWechatHtml(document.body.innerHTML, {
    finalSurveyPath: survey,
    finalFooterPath: footer,
  }), /固定社群封底不是最终节点|固定调研图必须紧邻社群封底并位于其前/);
});

test('微信最终 HTML:固定尾图必须成对配置', () => {
  assert.throws(
    () => appendFinalTailImages('<p>正文</p>', { surveyPath: '/survey.jpg' }),
    /必须同时配置/,
  );
  assert.throws(
    () => validatePreparedWechatHtml('<p>正文</p>', { finalFooterPath: '/footer.png' }),
    /必须同时配置/,
  );
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

test('微信最终 HTML:引用和原文信息字号归一为正文字号', () => {
  const output = normalizeBodyTypography(
    '<section><blockquote style="font-size:1.5em"><p style="font-size:1.2em">原文信息</p></blockquote></section>',
  );
  const document = new JSDOM(`<body>${output}</body>`).window.document;
  assert.equal(document.querySelector('blockquote').style.fontSize, '0.88em');
  assert.equal(document.querySelector('blockquote p').style.fontSize, '1em');
  assert.doesNotThrow(() => validatePreparedWechatHtml(output));
  assert.throws(
    () => validatePreparedWechatHtml('<blockquote style="font-size:1.05em">过大文字</blockquote>'),
    /大于正文字号/,
  );
});

test('微信最终 HTML:重复原文信息板块在发布前被拦截', () => {
  const html = '<blockquote><strong>原文信息</strong></blockquote><blockquote><strong>原文信息</strong></blockquote>';
  assert.throws(() => validatePreparedWechatHtml(html), /2 个“原文信息”板块/);
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

test('微信最终 HTML:在调用微信 API 前拦截本地 WebP 和 SVG', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-wechat-image-format-'));
  fs.writeFileSync(
    path.join(dir, 'disguised.png'),
    Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]),
  );
  fs.writeFileSync(path.join(dir, 'vector.dat'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'));

  assert.throws(
    () => validatePreparedWechatHtml(
      '<img src="disguised.png"><img src="vector.dat">',
      { absoluteDirPath: dir },
    ),
    /微信不支持的 WebP.*微信不支持的 SVG/,
  );
});
