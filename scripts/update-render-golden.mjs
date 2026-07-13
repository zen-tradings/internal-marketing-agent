import fs from 'node:fs/promises';
import { prepareRenderContext } from '@wenyan-md/core/wrapper';
import { getInputContent } from '../src/lib/getInputContent.js';
import { RENDER_OPTS } from '../src/channels/wechat-draft.js';

const ctx = await prepareRenderContext(undefined, { ...RENDER_OPTS, file: 'test/fixtures/sample.md' }, getInputContent);
// 经验确认:Object.keys(ctx.gzhContent) === ['content', 'title', 'cover'];渲染 HTML 承载在 .content(无 .body)
const html = ctx.gzhContent.content;
await fs.writeFile('test/golden/sample.expected.html', html);
console.log('golden 已写入 test/golden/sample.expected.html');
