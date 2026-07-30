import { test } from 'node:test';
import assert from 'node:assert/strict';

test('workflow env 属性延迟读取:import 后修改 env 仍生效(getter 语义)', async () => {
  // 模拟 dotenv.config() 在 import 之后才注入 env 的真实启动时序
  const origWorkDir = process.env.WORK_DIR;
  const origModel = process.env.OPENROUTER_MODEL;
  const origChannel = process.env.WECHAT_CHANNEL;
  delete process.env.WORK_DIR;
  delete process.env.OPENROUTER_MODEL;
  delete process.env.WECHAT_CHANNEL;

  try {
    const mod = await import('../src/workflows/wechat.js');
    const wf = mod.default;
    assert.equal(wf.editorialSkill, 'latepost-ai-writer');
    // 加载后 env 仍为空 → 回退默认值
    assert.equal(wf.workDir, '/srv/zen/wechat');
    assert.equal(wf.model, undefined);
    assert.equal(wf.channel, 'wechat-draft');

    // 模拟 dotenv.config() 注入 env
    process.env.WORK_DIR = '/tmp/test-zen';
    process.env.OPENROUTER_MODEL = 'test/model';
    process.env.WECHAT_CHANNEL = 'mock';

    // getter 延迟读取 → 拿到新值
    assert.equal(wf.workDir, '/tmp/test-zen');
    assert.equal(wf.model, 'test/model');
    assert.equal(wf.channel, 'mock');
  } finally {
    if (origWorkDir) process.env.WORK_DIR = origWorkDir; else delete process.env.WORK_DIR;
    if (origModel) process.env.OPENROUTER_MODEL = origModel; else delete process.env.OPENROUTER_MODEL;
    if (origChannel) process.env.WECHAT_CHANNEL = origChannel; else delete process.env.WECHAT_CHANNEL;
  }
});

test('workflow.research:行业优先源排除 Exa 不支持域名,官方源与两类 env 均可整体覆盖', async () => {
  const orig = process.env.EXA_PRIORITY_DOMAINS;
  const origOfficial = process.env.EXA_OFFICIAL_DOMAINS;
  const origExcluded = process.env.EXA_EXCLUDED_MEDIA_DOMAINS;
  const origIndependent = process.env.EXA_INDEPENDENT_MEDIA_DOMAINS;
  delete process.env.EXA_PRIORITY_DOMAINS;
  delete process.env.EXA_OFFICIAL_DOMAINS;
  delete process.env.EXA_EXCLUDED_MEDIA_DOMAINS;
  delete process.env.EXA_INDEPENDENT_MEDIA_DOMAINS;

  try {
    const mod = await import('../src/workflows/wechat.js');
    const wf = mod.default;

    // 未设置 env → 内置默认信源列表,包含代表性域名
    const defaults = wf.research.prioritySources;
    assert.ok(Array.isArray(defaults) && defaults.length > 0);
    assert.ok(defaults.includes('trendforce.com'));
    assert.ok(defaults.includes('semianalysis.com'));
    assert.ok(!defaults.includes('x.com'));
    assert.ok(!defaults.includes('twitter.com'));

    // “官方/一手信源”任务走独立域名清单,不把行业分析站误算作官方来源
    assert.ok(wf.research.officialSources.includes('sec.gov'));
    assert.ok(wf.research.officialSources.includes('nasdaq.com'));
    assert.ok(wf.research.officialSources.includes('skhynix.com'));
    assert.ok(wf.research.officialSources.includes('sse.com.cn'));
    assert.ok(wf.research.officialSources.includes('cninfo.com.cn'));
    assert.ok(wf.research.officialSources.includes('cxmt.com'));
    assert.ok(wf.research.excludedMediaSources.includes('bbc.com'));
    assert.ok(wf.research.excludedMediaSources.includes('xinhuanet.com'));
    assert.ok(wf.research.independentReportingSources.includes('reuters.com'));
    assert.ok(wf.research.independentReportingSources.includes('caixin.com'));

    // 设置 env → 整体覆盖,逗号分隔并去除空白
    process.env.EXA_PRIORITY_DOMAINS = 'foo.com, bar.com ,baz.com';
    assert.deepEqual(wf.research.prioritySources, ['foo.com', 'bar.com', 'baz.com']);
    process.env.EXA_OFFICIAL_DOMAINS = 'sec.test, exchange.test';
    assert.deepEqual(wf.research.officialSources, ['sec.test', 'exchange.test']);
    process.env.EXA_EXCLUDED_MEDIA_DOMAINS = 'public.test, STATE.test';
    assert.ok(wf.research.excludedMediaSources.includes('public.test'));
    assert.ok(wf.research.excludedMediaSources.includes('state.test'));
    process.env.EXA_INDEPENDENT_MEDIA_DOMAINS = 'independent.test';
    assert.ok(wf.research.independentReportingSources.includes('independent.test'));
  } finally {
    if (orig) process.env.EXA_PRIORITY_DOMAINS = orig; else delete process.env.EXA_PRIORITY_DOMAINS;
    if (origOfficial) process.env.EXA_OFFICIAL_DOMAINS = origOfficial; else delete process.env.EXA_OFFICIAL_DOMAINS;
    if (origExcluded) process.env.EXA_EXCLUDED_MEDIA_DOMAINS = origExcluded; else delete process.env.EXA_EXCLUDED_MEDIA_DOMAINS;
    if (origIndependent) process.env.EXA_INDEPENDENT_MEDIA_DOMAINS = origIndependent; else delete process.env.EXA_INDEPENDENT_MEDIA_DOMAINS;
  }
});

test('新工作流(earnings/sector/morning):id、channel、workDir 子目录、research 与 wechat 语义一致', async () => {
  const origWorkDir = process.env.WORK_DIR;
  const origChannel = process.env.WECHAT_CHANNEL;
  const origExa = process.env.EXA_PRIORITY_DOMAINS;
  delete process.env.WORK_DIR;
  delete process.env.WECHAT_CHANNEL;
  delete process.env.EXA_PRIORITY_DOMAINS;

  try {
    const [{ default: earnings }, { default: sector }, { default: morning }] = await Promise.all([
      import('../src/workflows/earnings.js'),
      import('../src/workflows/sector.js'),
      import('../src/workflows/morning.js'),
    ]);

    assert.equal(earnings.id, 'earnings');
    assert.equal(sector.id, 'sector');
    assert.equal(morning.id, 'morning');
    assert.equal(earnings.editorialSkill, 'latepost-ai-writer');
    assert.equal(sector.editorialSkill, 'latepost-ai-writer');
    assert.equal(morning.editorialSkill, undefined);
    assert.doesNotMatch(morning.promptTemplate('今日晨报'), /LatePost AI Writer/);

    // 默认基准目录下按工作流 id 建子目录,避免并发任务 article.md 互相覆盖
    assert.equal(earnings.workDir, '/srv/zen/wechat/earnings');
    assert.equal(sector.workDir, '/srv/zen/wechat/sector');
    assert.equal(morning.workDir, '/srv/zen/wechat/morning');

    // channel getter 语义与 wechat 相同,同样受 WECHAT_CHANNEL 控制
    assert.equal(earnings.channel, 'wechat-draft');
    process.env.WECHAT_CHANNEL = 'mock';
    assert.equal(earnings.channel, 'mock');
    assert.equal(sector.channel, 'mock');
    assert.equal(morning.channel, 'mock');
    delete process.env.WECHAT_CHANNEL;

    // WORK_DIR 变化后子目录也跟着变(getter 语义,不是 import 时求值一次)
    process.env.WORK_DIR = '/tmp/test-zen';
    assert.equal(earnings.workDir, '/tmp/test-zen/earnings');

    // research.prioritySources 与 wechat 完全同一份清单
    assert.ok(earnings.research.prioritySources.includes('trendforce.com'));
    assert.deepEqual(sector.research.prioritySources, morning.research.prioritySources);
  } finally {
    if (origWorkDir) process.env.WORK_DIR = origWorkDir; else delete process.env.WORK_DIR;
    if (origChannel) process.env.WECHAT_CHANNEL = origChannel; else delete process.env.WECHAT_CHANNEL;
    if (origExa) process.env.EXA_PRIORITY_DOMAINS = origExa; else delete process.env.EXA_PRIORITY_DOMAINS;
  }
});

test('translate 工作流:id、workDir 子目录、channel/research 与其它工作流语义一致', async () => {
  const origWorkDir = process.env.WORK_DIR;
  const origChannel = process.env.WECHAT_CHANNEL;
  delete process.env.WORK_DIR;
  delete process.env.WECHAT_CHANNEL;

  try {
    const { default: translate } = await import('../src/workflows/translate.js');

    assert.equal(translate.id, 'translate');
    assert.deepEqual(translate.triggers, ['slack']);
    assert.equal(translate.workDir, '/srv/zen/wechat/translate');
    assert.equal(translate.retries, 3);
    assert.equal(translate.retryDelayMs, 15000);
    assert.equal(translate.shouldRetry(new Error('fetch failed: ECONNRESET')), true);
    assert.equal(translate.shouldRetry(new Error('Slack PDF 下载返回登录页')), false);

    process.env.WECHAT_CHANNEL = 'mock';
    assert.equal(translate.channel, 'mock');
    delete process.env.WECHAT_CHANNEL;

    process.env.WORK_DIR = '/tmp/test-zen';
    assert.equal(translate.workDir, '/tmp/test-zen/translate');

    assert.ok(translate.research.prioritySources.includes('trendforce.com'));

    const prompt = translate.promptTemplate('https://example.com/article');
    assert.match(prompt, /Zen Trading 公众号译者/);
    assert.match(prompt, /翻译为简体中文/);
    assert.match(prompt, /忠实优先/);
    assert.match(prompt, /【写作规范/); // 仍拼装通用约束块
    assert.doesNotMatch(prompt, /LatePost AI Writer/);
  } finally {
    if (origWorkDir) process.env.WORK_DIR = origWorkDir; else delete process.env.WORK_DIR;
    if (origChannel) process.env.WECHAT_CHANNEL = origChannel; else delete process.env.WECHAT_CHANNEL;
  }
});

test('company 工作流:专业分析提示词、独立目录与专项检索', async () => {
  const origWorkDir = process.env.WORK_DIR;
  delete process.env.WORK_DIR;
  try {
    const { default: company } = await import('../src/workflows/company.js');
    assert.equal(company.id, 'company');
    assert.equal(company.editorialSkill, 'latepost-ai-writer');
    assert.equal(company.workDir, '/srv/zen/wechat/company');
    assert.equal(typeof company.research.extraQueries, 'function');
    const extraQueries = company.research.extraQueries('AMAT');
    assert.equal(extraQueries.length, 3);
    assert.equal(extraQueries[0].type, 'deep');
    assert.equal(extraQueries[0].category, 'financial report');
    const prompt = company.promptTemplate('分析 AMAT');
    assert.match(prompt, /最近四到六个季度做同口径比较/);
    assert.match(prompt, /quarterly-chart/);
    assert.match(prompt, /不要按用户关键词机械分栏/);
    assert.match(prompt, /真正可比对手/);
    assert.match(prompt, /未上市、拟上市或季度披露不足/);
  } finally {
    if (origWorkDir) process.env.WORK_DIR = origWorkDir; else delete process.env.WORK_DIR;
  }
});

test('morning 工作流:MORNING_CRON 未设置时仅 slack 触发,设置后追加 cron 触发器(getter 语义)', async () => {
  const orig = process.env.MORNING_CRON;
  delete process.env.MORNING_CRON;

  try {
    const { default: morning } = await import('../src/workflows/morning.js');
    assert.deepEqual(morning.triggers, ['slack']);

    process.env.MORNING_CRON = '0 7 * * *';
    assert.deepEqual(morning.triggers, ['slack', 'cron:0 7 * * *']);
  } finally {
    if (orig) process.env.MORNING_CRON = orig; else delete process.env.MORNING_CRON;
  }
});

test('email 工作流:Customer.io 草稿渠道、独立目录与 Vol. 版号', async () => {
  const origWorkDir = process.env.WORK_DIR;
  const origEdition = process.env.NEWSLETTER_EDITION;
  delete process.env.WORK_DIR;
  delete process.env.NEWSLETTER_EDITION;
  try {
    const { default: email } = await import('../src/workflows/email.js');
    assert.equal(email.id, 'email');
    assert.equal(email.channel, 'customerio-draft');
    assert.equal(email.workDir, '/srv/zen/wechat/email');
    assert.equal(email.editorialSkill, undefined);
    assert.match(email.systemPrompt, /research newsletter/);
    assert.doesNotMatch(email.promptTemplate('AI market update'), /LatePost AI Writer/);
    assert.match(email.outputInstruction, /Customer\.io/);
    assert.match(email.promptTemplate('HBM update'), /Vol\. 1/);
    assert.match(email.promptTemplate('HBM update'), /preheader:/);

    process.env.NEWSLETTER_EDITION = 'vol.2';
    assert.match(email.promptTemplate('HBM update'), /Vol\. 2/);
  } finally {
    if (origWorkDir) process.env.WORK_DIR = origWorkDir; else delete process.env.WORK_DIR;
    if (origEdition) process.env.NEWSLETTER_EDITION = origEdition; else delete process.env.NEWSLETTER_EDITION;
  }
});
