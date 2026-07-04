import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFollowCard, locateInsertIndex } from '../src/lib/wechatApi.js';

test('buildFollowCard 含 mp-common-profile 与 appId', () => {
  const html = buildFollowCard({ appId: 'wxABC', head_img: 'h', nickname: 'Zen', user_name: 'zen_alias', signature: '专业' });
  assert.match(html, /mp-common-profile/);
  assert.match(html, /wxABC/);
  assert.match(html, /Zen/);
});

test('locateInsertIndex 定位结尾蓝色板块前', () => {
  const content = '正文<section style="background:#0E2138;border-radius:.6em;padding:1.4em">结尾</section>';
  const idx = locateInsertIndex(content);
  assert.ok(idx > 0 && idx < content.indexOf('background:#0E2138'));
});
