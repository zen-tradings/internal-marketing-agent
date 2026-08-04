import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectCodeBlocks,
  normalizeIndentedCodeBlocks,
} from '../src/lib/code-blocks.js';

test('四空格代码规范为 text 围栏并保留内部缩进', () => {
  const input = [
    '---', 'title: T', '---', '',
    '示例：', '',
    '    def run():',
    '        return 1',
    '',
    '结尾。',
  ].join('\n');
  const result = normalizeIndentedCodeBlocks(input, { allowCodeBlocks: true });
  assert.equal(result.transformedBlocks, 1);
  assert.match(result.markdown, /```text\ndef run\(\):\n    return 1\n```/);
  assert.match(result.markdown, /结尾。$/);
});

test('已有围栏、HTML pre 和嵌套列表不重复转换', () => {
  const input = [
    '---', 'title: T', '---', '',
    '```python', '    x = 1', '```', '',
    '<pre><code>    y = 2</code></pre>', '',
    '- 项目',
    '    - 子项目',
  ].join('\n');
  const result = normalizeIndentedCodeBlocks(input, { allowCodeBlocks: true });
  assert.equal(result.changed, false);
  assert.equal((result.markdown.match(/```/g) || []).length, 2);
});

test('未授权代码也规范化并由策略层识别后提醒', () => {
  const input = '---\ntitle: T\n---\n\n    print("x")';
  const result = normalizeIndentedCodeBlocks(input);
  assert.equal(result.changed, true);
  assert.match(result.markdown, /```text\nprint\("x"\)\n```/);
  assert.equal(inspectCodeBlocks(input).indented, true);
  assert.equal(inspectCodeBlocks(result.markdown).fenced, true);
});
