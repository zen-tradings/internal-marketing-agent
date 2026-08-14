import { sharedResearch, officialFirstPolicy, envChannel, envModel, envTimeoutMs, workDirFor, buildPromptTemplate } from './shared.js';
import { runtimeConfig } from '../config/runtime.js';

const METHODOLOGY = `【晨报体例 — 专属要求】
撰写晨会纪要体例的简报,风格紧凑、观点鲜明,总篇幅控制在一页以内:
1. 隔夜关键事件:挑选三到六条最重要的隔夜或盘前事件(财报、指引变化、并购、监管、宏观数据等),每条用两到三句话说明发生了什么、以及为什么重要(对相关公司或板块的影响)。
2. 当日关注催化剂:列出今日值得关注的事件(财报电话会、经济数据公布、行业会议等)及预计影响方向。
3. 一句话观点:结尾给出鲜明、可执行的一句话判断,不要只罗列新闻而不表态。
素材必须以最近二十四到四十八小时内的信息为主;若素材明显早于这个窗口,须在文中如实注明信息时间,不得把旧闻包装成最新动态。若某条事件性质存疑或缺乏事实支撑,应明确说明信息不足,而非编造细节。`;

export default {
  id: 'morning',
  mode: 'analysis',
  sourcePolicy: officialFirstPolicy(),
  factReview: true,
  // 支持可选 cron 定时触发:设置 MORNING_CRON 后自动追加 cron 触发器,未设置则仅 slack。
  get triggers() {
    const cronExpr = runtimeConfig()?.workflowEnvironment?.morningCron || process.env.MORNING_CRON;
    return cronExpr ? ['slack', `cron:${cronExpr}`] : ['slack'];
  },
  get workDir() { return workDirFor('morning'); },
  get model() { return envModel(); },
  get channel() { return envChannel(); },
  get timeoutMs() { return envTimeoutMs(); },
  get research() { return sharedResearch(); },
  retries: 0,
  promptTemplate: (task) => buildPromptTemplate({
    persona: 'Zen Trading 公众号晨报编辑',
    task,
    methodologyBlock: METHODOLOGY,
  }),
};
