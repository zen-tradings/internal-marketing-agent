import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { prepareRenderContext } from '@wenyan-md/core/wrapper';
import { getInputContent } from '../../src/lib/getInputContent.js';
import { RENDER_OPTS } from '../../src/channels/wechat-draft.js';

test('渲染输出与 golden 逐字符一致(锁 core 3.0.11 + RENDER_OPTS)', async () => {
  const ctx = await prepareRenderContext(undefined, { ...RENDER_OPTS, file: 'test/fixtures/sample.md' }, getInputContent);
  // ctx.gzhContent 的字段为 ['content','title','cover'];渲染 HTML 在 .content
  const html = ctx.gzhContent.content;
  const expected = await fs.readFile('test/golden/sample.expected.html', 'utf-8');
  assert.equal(html, expected);
});
