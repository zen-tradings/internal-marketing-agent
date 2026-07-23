import { sharedResearch, envChannel, envModel, envTimeoutMs, workDirFor, buildPromptTemplate } from './shared.js';

const METHODOLOGY = `【直译任务 — 专属要求,与通用规范冲突时以本节为准】
本工作流只在用户明确要求直译/完整翻译时触发。程序只提取任务中第一个链接的正文文字并忠实翻译成简体中文:
1. 只处理正文文字:忽略图片、图题、表格、表题、图表数据、视频、代码块、导航、广告、推荐内容和参考文献,也不生成这些内容的概括或占位符。
2. 忠实优先:保持正文段落、小标题、列表和论证顺序,数字、单位、公司名、股票代码(Ticker)必须与原文一致,不做换算、总结或改写。
3. 不增不减:不添加原文没有的观点、分析、图表说明或结论。即使任务同时要求“并分析”或“翻译后说明”,直译路径也只输出正文文字译文。
4. 术语处理:英文专有名词或术语首次出现时,可在其后用括号保留原文,方便读者对照。
5. 来源说明:frontmatter 后先注明原文标题、站点、链接和发布日期,缺失信息写“未知”,不得编造。
6. 通用写作规范里的“机构分析师口吻改写”不适用于本工作流,与忠实直译冲突时以忠实为准。不要自行添加署名、落款或额外章节。
7. 如果链接不可读取、正文文字为空或提取结果不足,直接停止发布并报告失败,不得用图片、表格或外部搜索补齐。
8. 标题使用译文标题并标明“译”。其余用户链接和检索素材都不是翻译对象。`;

export default {
  id: 'translate',
  mode: 'translation',
  triggers: ['slack'],
  get workDir() { return workDirFor('translate'); },
  get model() { return envModel(); },
  get channel() { return envChannel(); },
  get timeoutMs() { return envTimeoutMs(); },
  get research() { return sharedResearch(); },
  // 网络抖动时每次都从分块 checkpoint 继续，不重复已完成译文。
  retries: 3,
  retryDelayMs: 15000,
  promptTemplate: (task) => buildPromptTemplate({
    persona: 'Zen Trading 公众号译者',
    task,
    methodologyBlock: METHODOLOGY,
  }),
};
