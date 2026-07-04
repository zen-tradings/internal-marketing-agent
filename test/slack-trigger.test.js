import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSlackTask } from '../src/triggers/slack.js';

test('识别 "任务:" 前缀', () => {
  assert.equal(parseSlackTask('任务:写英伟达', 'B1'), '写英伟达');
  assert.equal(parseSlackTask('任务：写英伟达', 'B1'), '写英伟达');
});
test('识别 @bot 提及并清理链接', () => {
  assert.equal(parseSlackTask('<@B1> 分析 <https://x.com|X>', 'B1'), '分析 https://x.com');
});
test('非任务返回 null', () => {
  assert.equal(parseSlackTask('随便聊聊', 'B1'), null);
});
