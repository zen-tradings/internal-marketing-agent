import fs from 'node:fs/promises';
import { prepareRenderContext } from '@wenyan-md/core/wrapper';
import { getInputContent } from '../src/lib/getInputContent.js';
import { RENDER_OPTS } from '../src/channels/wechat-draft.js';

const ctx = await prepareRenderContext(undefined, { ...RENDER_OPTS, file: 'test/fixtures/sample.md' }, getInputContent);
// Verified contract: Object.keys(ctx.gzhContent) is content/title/cover and rendered HTML is in .content, not .body.
const html = ctx.gzhContent.content;
await fs.writeFile('test/golden/sample.expected.html', html);
console.log('golden 已写入 test/golden/sample.expected.html');
