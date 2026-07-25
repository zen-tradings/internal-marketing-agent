import { sharedResearch, officialFirstPolicy, envChannel, envModel, envTimeoutMs, workDirFor, buildPromptTemplate } from './shared.js';

const METHODOLOGY = `【公司深度分析框架】
这不是资料汇编。先形成一个可证伪的核心判断，再用财务趋势、竞争位置和产业链证据推进论证。文章应像专业分析师写给投资委员会的研究更新，有取舍、有因果、有段落过渡，不要按用户关键词机械分栏。

必须完成:
1. 开篇用两到三段回答三个问题:最近发生了什么变化、变化为何重要、市场最容易忽略什么。不要先介绍公司历史。
2. 对已上市且连续披露季度数据的公司,用最近四到六个季度做同口径比较,至少覆盖营收、同比或环比、毛利率、营业利润率、EPS;素材允许时加入自由现金流和关键分部。对未上市、拟上市或季度披露不足的公司,改用招股书、交易所受理文件或审计报告中的最近可比年度/报告期数据,明确披露边界,绝不为了凑季度而推算。先给表格,再解释拐点及驱动,不要逐行复述数字。
3. 在季度表格后输出一个且仅一个 quarterly-chart 数据块，格式严格如下，数组必须等长且只填数字:
\`\`\`quarterly-chart
{"title":"近五季度营收与毛利率","periods":["FY25Q2","FY25Q3"],"revenue":[71.9,73.0],"grossMargin":[48.7,48.9],"revenueUnit":"亿美元","source":"公司季度财报"}
\`\`\`
系统会把它渲染为微信内联趋势图。数据不足四个可比季度时不要猜测,保留已披露期间表格并省略该数据块。
4. 竞争分析必须比较公司与两到四个真正可比对手在产品环节、客户结构、周期暴露、技术壁垒和份额变化上的差异，说明谁在什么情景下更占优。不要只列公司名单。
5. 上下游分析要画清价值传导:关键零部件或技术平台 → 公司产品 → 直接客户 → 终端需求，并指出订单、收入和利润率之间的时间差及主要瓶颈。
6. 结尾回到核心判断，给出未来两个到四个季度最值得验证的三项指标。除非素材提供可靠现价和一致预期，否则不要硬写目标价、DCF或买卖评级。

写作要求:
- 标题和小标题要表达判断，不使用“财务分析”“竞争对手分析”“上下游分析”这类任务清单式标题。
- 少用“从……看”“需要注意的是”“综合来看”等模板连接词;通过因果关系自然过渡。
- 全文只保留一个简短的数据口径与来源说明，不要每节重复“口径说明”。
- 区分事实、管理层观点和作者判断;所有数字都必须来自系统素材。`;

function extraQueries(task) {
  return [
    {
      query: `${task}，查找最近五个已披露季度的官方 earnings releases，覆盖 revenue、gross margin、operating margin、EPS 和 cash flow`,
      type: 'deep',
      category: 'financial report',
      numResults: 8,
      kind: 'quarterly-financials',
      systemPrompt: '优先公司投资者关系网站和 SEC 官方文件。返回五个不同季度的官方 earnings releases 或 10-Q，不要用新闻摘要替代。',
      additionalQueries: [
        `${task} official investor relations quarterly earnings releases`,
        `${task} SEC 10-Q recent quarters`,
      ],
    },
    {
      query: `${task}，查找公司官网、招股书、交易所受理文件、监管披露和审计财务数据`,
      type: 'deep',
      category: 'financial report',
      numResults: 8,
      kind: 'company-official-disclosures',
      systemPrompt: '优先公司官网、证监会、证券交易所、巨潮资讯以及原始招股书或审计报告。若公司未上市，不得用媒体估算冒充官方财务披露。',
      additionalQueries: [
        `${task} 官网 官方 产品 新闻`,
        `${task} 招股书 交易所 受理 财务报告`,
      ],
    },
    {
      query: `${task} competitors customers suppliers semiconductor value chain official filings market share`,
      type: 'deep',
      numResults: 8,
      kind: 'company-value-chain',
      systemPrompt: '用可比公司官网、财报、监管文件和产业数据原始发布方验证竞争格局、客户、供应商与上下游关系；媒体报道仅作线索。',
      additionalQueries: [
        `${task} 竞争对手 官方财报 市场份额`,
        `${task} 上游 供应商 下游 客户 官方披露`,
      ],
    },
  ];
}

export default {
  id: 'company',
  mode: 'analysis',
  sourcePolicy: officialFirstPolicy(),
  factReview: true,
  triggers: ['slack'],
  get workDir() { return workDirFor('company'); },
  get model() { return envModel(); },
  get channel() { return envChannel(); },
  get timeoutMs() { return envTimeoutMs(); },
  get research() { return { ...sharedResearch(), extraQueries }; },
  defaultMethodology: METHODOLOGY,
  retries: 0,
  promptTemplate: (task) => buildPromptTemplate({
    persona: 'Zen Trading 资深股票研究分析师',
    task,
    methodologyBlock: METHODOLOGY,
  }),
};
