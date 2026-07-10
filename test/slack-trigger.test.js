import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSlackTask, resolveWorkflowTask } from '../src/triggers/slack.js';

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

test('多工作流路由:无前缀走 defaultWorkflowId', () => {
  assert.deepEqual(
    resolveWorkflowTask('写英伟达', ['wechat', 'email'], 'wechat'),
    { workflowId: 'wechat', task: '写英伟达' }
  );
});

test('多工作流路由:英文前缀 "wechat:" 命中并剥离前缀', () => {
  assert.deepEqual(
    resolveWorkflowTask('wechat: 写英伟达', ['wechat', 'email'], 'wechat'),
    { workflowId: 'wechat', task: '写英伟达' }
  );
});

test('多工作流路由:中文别名 "微信：" 命中并剥离前缀', () => {
  assert.deepEqual(
    resolveWorkflowTask('微信：写英伟达', ['wechat', 'email'], 'wechat'),
    { workflowId: 'wechat', task: '写英伟达' }
  );
});

test('多工作流路由:id 大小写不敏感', () => {
  assert.deepEqual(
    resolveWorkflowTask('WeChat: 写英伟达', ['wechat', 'email'], 'wechat'),
    { workflowId: 'wechat', task: '写英伟达' }
  );
});

test('多工作流路由:"email:" 未注册时整段走默认工作流', () => {
  assert.deepEqual(
    resolveWorkflowTask('email: 发周报', ['wechat'], 'wechat'),
    { workflowId: 'wechat', task: 'email: 发周报' }
  );
});

test('多工作流路由:"email:" 已注册时路由到 email', () => {
  assert.deepEqual(
    resolveWorkflowTask('email: 发周报', ['wechat', 'email'], 'wechat'),
    { workflowId: 'email', task: '发周报' }
  );
});

test('多工作流路由:未知前缀整段走默认工作流', () => {
  assert.deepEqual(
    resolveWorkflowTask('foo: 发周报', ['wechat', 'email'], 'wechat'),
    { workflowId: 'wechat', task: 'foo: 发周报' }
  );
});

test('多工作流路由:配合「任务：」触发格式,前缀解析同样生效', () => {
  const task = parseSlackTask('任务：wechat: 写英伟达', 'B1');
  assert.equal(task, 'wechat: 写英伟达');
  assert.deepEqual(
    resolveWorkflowTask(task, ['wechat', 'email'], 'wechat'),
    { workflowId: 'wechat', task: '写英伟达' }
  );
});

test('多工作流路由:配合 @mention 触发格式,前缀解析同样生效', () => {
  const task = parseSlackTask('<@B1> 微信：写英伟达', 'B1');
  assert.equal(task, '微信：写英伟达');
  assert.deepEqual(
    resolveWorkflowTask(task, ['wechat', 'email'], 'wechat'),
    { workflowId: 'wechat', task: '写英伟达' }
  );
});

const NEW_WORKFLOW_IDS = ['wechat', 'earnings', 'sector', 'morning', 'translate'];

test('多工作流路由:英文前缀 "earnings:" 命中并剥离前缀', () => {
  assert.deepEqual(
    resolveWorkflowTask('earnings: 写英伟达财报', NEW_WORKFLOW_IDS, 'wechat'),
    { workflowId: 'earnings', task: '写英伟达财报' }
  );
});

test('多工作流路由:中文别名 "财报：" 命中并路由到 earnings', () => {
  assert.deepEqual(
    resolveWorkflowTask('财报：写英伟达财报', NEW_WORKFLOW_IDS, 'wechat'),
    { workflowId: 'earnings', task: '写英伟达财报' }
  );
});

test('多工作流路由:中文别名 "行业：" 命中并路由到 sector', () => {
  assert.deepEqual(
    resolveWorkflowTask('行业：写半导体行业综述', NEW_WORKFLOW_IDS, 'wechat'),
    { workflowId: 'sector', task: '写半导体行业综述' }
  );
});

test('多工作流路由:中文别名 "晨报：" 命中并路由到 morning', () => {
  assert.deepEqual(
    resolveWorkflowTask('晨报：写今天的晨报', NEW_WORKFLOW_IDS, 'wechat'),
    { workflowId: 'morning', task: '写今天的晨报' }
  );
});

test('多工作流路由:英文前缀 "translate:" 命中并路由到 translate', () => {
  assert.deepEqual(
    resolveWorkflowTask('translate: https://example.com/article', NEW_WORKFLOW_IDS, 'wechat'),
    { workflowId: 'translate', task: 'https://example.com/article' }
  );
});

test('多工作流路由:中文别名 "直译：" 命中并路由到 translate', () => {
  assert.deepEqual(
    resolveWorkflowTask('直译：https://example.com/article', NEW_WORKFLOW_IDS, 'wechat'),
    { workflowId: 'translate', task: 'https://example.com/article' }
  );
});

test('多工作流路由:中文别名 "翻译：" 命中并路由到 translate', () => {
  assert.deepEqual(
    resolveWorkflowTask('翻译：https://example.com/article', NEW_WORKFLOW_IDS, 'wechat'),
    { workflowId: 'translate', task: 'https://example.com/article' }
  );
});
