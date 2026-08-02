import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSlackIntentClassifier,
  buildSlackThreadInput,
  isSlackStopCommand,
  mergeSlackThreadMessages,
  parseSlackTask,
  resolveNaturalWorkflowTask,
  resolveWorkflowTask,
  slackStopResponse,
  slackMessageEventKey,
  slackPromptMetadata,
} from '../src/triggers/slack.js';

test('识别 "任务:" 前缀', () => {
  assert.equal(parseSlackTask('任务:写英伟达', 'B1'), '写英伟达');
  assert.equal(parseSlackTask('任务：写英伟达', 'B1'), '写英伟达');
  assert.equal(parseSlackTask('Task: analyze Nvidia', 'B1'), 'analyze Nvidia');
});
test('识别 @bot 提及并清理链接', () => {
  assert.equal(parseSlackTask('<@B1> 分析 <https://x.com|X>', 'B1'), '分析 https://x.com');
});
test('非任务返回 null', () => {
  assert.equal(parseSlackTask('随便聊聊', 'B1'), null);
});

test('Slack 私聊接受普通自然语言,公共频道仍必须 @Bot 或任务前缀', () => {
  assert.equal(parseSlackTask('帮我写一篇英伟达分析', 'B1', { channelType: 'im', channel: 'D1' }), '帮我写一篇英伟达分析');
  assert.equal(parseSlackTask('帮我写一篇英伟达分析', 'B1', { channelType: 'channel', channel: 'C1' }), null);
});

test('同一条 @Bot 消息的 message 与 app_mention 使用同一个持久化去重键', () => {
  const message = slackMessageEventKey({ channel: 'C1', ts: '1784898806.000100', eventId: 'EvMessage' });
  const mention = slackMessageEventKey({ channel: 'C1', ts: '1784898806.000100', eventId: 'EvMention' });
  assert.equal(message, 'message:C1:1784898806.000100');
  assert.equal(mention, message);
  assert.equal(
    slackMessageEventKey({ channel: 'C1', ts: '1784898806.000100', revision: '1784898810.000200' }),
    'message:C1:1784898806.000100:rev:1784898810.000200',
  );
  assert.equal(slackMessageEventKey({ eventId: 'EvFallback' }), 'event:EvFallback');
});

test('Slack 编辑替换同一消息而不是追加，线程确认合并为完整 Prompt', () => {
  const initial = mergeSlackThreadMessages([], {
    ts: '1.0',
    text: '比较 Opus 5 和 Kimi K3',
    attachments: [{ name: 'source.pdf', url: 'https://files.slack.com/source.pdf' }],
  });
  const edited = mergeSlackThreadMessages(initial, { ts: '1.0', text: '比较 Opus 5 和 Kimi K2', edited: true });
  const replied = mergeSlackThreadMessages(edited, { ts: '2.0', text: '确认使用 Kimi K2' });
  assert.equal(edited.length, 1);
  assert.equal(edited[0].attachments[0].name, 'source.pdf');
  assert.equal(edited[0].text, '比较 Opus 5 和 Kimi K2');
  const input = buildSlackThreadInput(replied, { clarification: { question: '请确认 Kimi 版本' } });
  assert.match(input, /^比较 Opus 5 和 Kimi K2/);
  assert.match(input, /系统曾询问的核心确认/);
  assert.match(input, /确认使用 Kimi K2/);
  assert.doesNotMatch(input, /Kimi K3/);
  assert.deepEqual(slackPromptMetadata(input, 2), {
    promptRevision: 2,
    promptEntities: ['Opus 5', 'Kimi K2'],
    userUrlCount: 0,
    userFileCount: 0,
    freshnessRequirement: '按任务需要核对当前信息',
  });
});

test('中英文停止表达只匹配独立控制指令', () => {
  for (const command of [
    '停止', '停止当前任务', '停止进程', '取消任务', '终止当前作业', '别做了', '不要继续了',
    'stop', 'please stop the current task', 'cancel task', 'abort this job', 'terminate process', 'kill the running task',
  ]) {
    assert.equal(isSlackStopCommand(command), true, command);
  }
  assert.equal(isSlackStopCommand('停止使用中文破折号'), false);
  assert.equal(isSlackStopCommand('analyze process technology'), false);
  assert.match(slackStopResponse({ kind: 'active', run: { id: 'r1' } }), /正在中断任务 r1/);
  assert.match(slackStopResponse({ kind: 'too-late' }), /草稿创建阶段/);
});

test('自然语言路由:裸链接是研究素材并默认公众号分析,只有显式翻译才走直译', async () => {
  const ids = ['wechat', 'email', 'translate', 'company', 'earnings', 'sector', 'morning'];
  assert.equal((await resolveNaturalWorkflowTask('https://papers.ssrn.com/abstract=1', { workflowIds: ids })).workflowId, 'wechat');
  assert.equal((await resolveNaturalWorkflowTask('请完整翻译这篇文章 https://example.com/a', { workflowIds: ids })).workflowId, 'translate');
  const middleKeyword = await resolveNaturalWorkflowTask('帮忙把 https://example.com/a 这篇内容翻译一下', { workflowIds: ids });
  assert.equal(middleKeyword.workflowId, 'translate');
  assert.equal(middleKeyword.reason, 'translation-keyword-with-url');
  assert.equal((await resolveNaturalWorkflowTask('给订阅者写一期 newsletter', { workflowIds: ids })).workflowId, 'email');
});

test('自然语言路由:用户链接加财务、竞品和上下游要求进入公司深度分析', async () => {
  const ids = ['wechat', 'email', 'translate', 'company', 'earnings', 'sector', 'morning'];
  const task = '分析长鑫存储 https://www.stcn.com/article/detail/4010092.html，根据这个链接和官方信息源写专业深度分析，包括财务分析、竞争对手和上下游';
  const route = await resolveNaturalWorkflowTask(task, { workflowIds: ids });
  assert.equal(route.workflowId, 'company');
  assert.equal(route.reason, 'natural-rule');
});

test('模型能力比较即使写 deep dive 也走 prompt 驱动 wechat，不误入公司财务链路', async () => {
  const ids = ['wechat', 'email', 'translate', 'company', 'earnings', 'sector', 'morning'];
  const route = await resolveNaturalWorkflowTask(
    'please write a deep dive analysis report comparing newly released Opus 5 and Kimi K2',
    { workflowIds: ids },
  );
  assert.equal(route.workflowId, 'wechat');
  assert.equal(route.reason, 'model-comparison');
});

test('英文自然语言与中文使用同一套工作流路由', async () => {
  const ids = ['wechat', 'email', 'translate', 'company', 'earnings', 'sector', 'morning', 'macro'];
  const cases = [
    ['Please translate the first 11 pages of https://example.com/paper.pdf', 'translate'],
    ['Translate https://example.com/article into Simplified Chinese', 'translate'],
    ['Draft a subscriber newsletter about our product update', 'email'],
    ['Write an earnings review comparing actuals vs consensus and guidance', 'earnings'],
    ['Prepare a semiconductor industry analysis and market landscape', 'sector'],
    ['Create a pre-market morning brief covering overnight markets', 'morning'],
    ['Do an in-depth analysis of Nvidia, including competitors and the supply chain', 'company'],
    ['Write a WeChat article about AI infrastructure', 'wechat'],
  ];
  for (const [task, expected] of cases) {
    assert.equal((await resolveNaturalWorkflowTask(task, { workflowIds: ids })).workflowId, expected, task);
  }
  const machineTranslation = await resolveNaturalWorkflowTask(
    'Write an industry analysis of the machine translation market using https://example.com/report',
    { workflowIds: ids },
  );
  assert.equal(machineTranslation.workflowId, 'sector');
});

test('宏观自然路由要求“跨资产宏观主题 + 分析意图”，覆盖快评、深度、周报与数字资产', async () => {
  const ids = ['wechat', 'email', 'translate', 'company', 'earnings', 'sector', 'morning', 'macro'];
  const cases = [
    ['CPI 公布后，写一篇利率、美元和黄金的市场快评', 'macro'],
    ['解释美元流动性如何传导到美债、股票和人民币，写机制型深度', 'macro'],
    ['复盘本周利率、汇率、商品和风险偏好并展望下周', 'macro'],
    ['Write a crypto liquidity outlook covering Bitcoin, real yields and the dollar', 'macro'],
    ['Write a cross-asset deep dive on Fed policy transmission through rates, FX and equities', 'macro'],
  ];
  for (const [task, expected] of cases) {
    const route = await resolveNaturalWorkflowTask(task, { workflowIds: ids });
    assert.equal(route.workflowId, expected, task);
    assert.equal(route.reason, 'macro-theme+analysis-intent');
  }
  assert.equal(
    (await resolveNaturalWorkflowTask('今天美元是多少', { workflowIds: ids })).workflowId,
    'wechat',
    '只有宏观主题、没有分析意图时不能进入 macro',
  );
});

test('混合请求按更具体的最终问题只选一个流程，公司、财报和行业不误入 macro', async () => {
  const ids = ['wechat', 'email', 'translate', 'company', 'earnings', 'sector', 'morning', 'macro'];
  const cases = [
    ['分析英伟达最近五个季度财务、竞争格局和供应链，并讨论利率影响', 'company'],
    ['写一篇英伟达本季财报点评，比较实际与预期，并分析美元影响', 'earnings'],
    ['研究半导体行业供需和市场格局，并讨论利率周期', 'sector'],
  ];
  for (const [task, expected] of cases) {
    assert.equal((await resolveNaturalWorkflowTask(task, { workflowIds: ids })).workflowId, expected, task);
  }
});

test('macro 显式中英文前缀和中文别名均为可选覆盖', async () => {
  const ids = ['wechat', 'macro'];
  assert.deepEqual(
    resolveWorkflowTask('宏观：分析美元流动性', ids, 'wechat'),
    { workflowId: 'macro', task: '分析美元流动性' },
  );
  const route = await resolveNaturalWorkflowTask('macro: analyze dollar liquidity', { workflowIds: ids });
  assert.equal(route.workflowId, 'macro');
  assert.equal(route.reason, 'explicit-prefix');
});

test('自然语言路由:同线程短补充继承上个工作流,模糊长任务默认微信', async () => {
  const ids = ['wechat', 'email', 'translate'];
  const followup = await resolveNaturalWorkflowTask('换一个更直接的标题', { workflowIds: ids, previousWorkflowId: 'translate' });
  assert.equal(followup.workflowId, 'translate');
  assert.equal(followup.reason, 'thread-context');
  const fallback = await resolveNaturalWorkflowTask('写一篇对这个主题的深入看法，供下周讨论使用。'.repeat(10), { workflowIds: ids, defaultWorkflowId: 'wechat' });
  assert.equal(fallback.workflowId, 'wechat');
});

test('模型路由给短 JSON 预留足够输出预算并关闭 reasoning', async () => {
  let body;
  const fetchFn = async (_url, options) => {
    body = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"workflowId":"email"}' } }],
      }),
    };
  };
  const classify = createSlackIntentClassifier({
    writer: {
      openrouterApiKey: 'or-key',
      model: 'z-ai/glm-5.2',
      baseUrl: 'https://openrouter.ai/api/v1',
    },
  }, fetchFn);

  assert.equal(await classify('写一封 newsletter', ['wechat', 'email']), 'email');
  assert.equal(body.max_tokens, 256);
  assert.deepEqual(body.reasoning, { effort: 'none', exclude: true });
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

const NEW_WORKFLOW_IDS = ['wechat', 'earnings', 'sector', 'morning', 'translate', 'company', 'macro'];

test('公司深度任务:财务 + 竞争对手 + 上下游自动路由到 company', () => {
  const task = '写一篇关于amat的分析发到草稿箱，财务分析 + 竞争对手 + 上下游';
  assert.deepEqual(resolveWorkflowTask(task, NEW_WORKFLOW_IDS, 'wechat'), { workflowId: 'company', task });
});

test('公司深度任务:显式“公司：”前缀路由到 company', () => {
  assert.deepEqual(
    resolveWorkflowTask('公司：分析 AMAT 最近五个季度', NEW_WORKFLOW_IDS, 'wechat'),
    { workflowId: 'company', task: '分析 AMAT 最近五个季度' }
  );
});

test('普通公司写作任务不误判,仍走默认 wechat', () => {
  const task = '写一篇关于 AMAT 的公司介绍';
  assert.deepEqual(resolveWorkflowTask(task, NEW_WORKFLOW_IDS, 'wechat'), { workflowId: 'wechat', task });
});

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

test('多工作流路由:中文别名 "直译" 后紧跟内容(无任何分隔符)也路由到 translate', () => {
  assert.deepEqual(
    resolveWorkflowTask('直译https://example.com/article', NEW_WORKFLOW_IDS, 'wechat'),
    { workflowId: 'translate', task: 'https://example.com/article' }
  );
});

test('多工作流路由:中文别名 "直译" 后接空格也路由到 translate', () => {
  assert.deepEqual(
    resolveWorkflowTask('直译 https://example.com/article', NEW_WORKFLOW_IDS, 'wechat'),
    { workflowId: 'translate', task: 'https://example.com/article' }
  );
});

test('多工作流路由:中文别名 "直译" 后接全角冒号(无空格)也路由到 translate', () => {
  assert.deepEqual(
    resolveWorkflowTask('直译：x', NEW_WORKFLOW_IDS, 'wechat'),
    { workflowId: 'translate', task: 'x' }
  );
});

test('多工作流路由:只发别名本身(无任何内容)仍路由到 translate,任务文本为空串', () => {
  assert.deepEqual(
    resolveWorkflowTask('直译', NEW_WORKFLOW_IDS, 'wechat'),
    { workflowId: 'translate', task: '' }
  );
});

test('多工作流路由:英文工作流 id 仍要求冒号,"translate:" 有效', () => {
  assert.deepEqual(
    resolveWorkflowTask('translate: https://example.com/article', NEW_WORKFLOW_IDS, 'wechat'),
    { workflowId: 'translate', task: 'https://example.com/article' }
  );
});

test('多工作流路由:正文以英文工作流 id 开头但无冒号("wechatXXX ...")不误判为 wechat,整段走默认(用非 wechat 的默认工作流验证未被误路由)', () => {
  assert.deepEqual(
    resolveWorkflowTask('wechatXXX 写点东西', NEW_WORKFLOW_IDS, 'sector'),
    { workflowId: 'sector', task: 'wechatXXX 写点东西' }
  );
});
