import { sharedResearch, envChannel, envModel, envTimeoutMs, workDirFor, buildPromptTemplate } from './shared.js';

const METHODOLOGY = `【直译任务 — 专属要求,与通用规范冲突时以本节为准】
本工作流只在用户明确要求直译/完整翻译时触发。程序读取任务中第一个链接,按用户指定范围忠实翻译为简体中文:
1. 范围优先:识别“前 N 页”“第 N-M 页”、指定章节及章节区间;用户未指定范围时才翻译全文。不得擅自扩大到范围之外。
2. 结构完整:保持标题层级、正文段落、列表、图片顺序、图号与图注、表格顺序、公式、代码和引用关系。原图不重绘,只翻译图注;表格按原文内容直接转成高清图片,不翻译单元格、不重建 Markdown/HTML 表格;公式、代码、作者名、DOI、URL 和引用编号保持不变。
3. 忠实优先:数字、单位、公司名、股票代码(Ticker)必须与原文一致,不做换算、总结或改写。
4. 不增不减:不添加原文没有的观点、分析、图表说明或结论。即使任务同时要求“并分析”或“翻译后说明”,直译路径也只输出指定范围的译文。
5. 术语处理:英文专有名词或术语首次出现时,可在其后用括号保留原文,方便读者对照。
6. 来源说明:frontmatter 后只保留一个固定“原文信息”块,注明原文标题、作者、站点和原文链接。不要显示发布日期或翻译范围,正文不得再次重复标题、作者和机构列表。
7. 通用写作规范里的“机构分析师口吻改写”不适用于本工作流,与忠实直译冲突时以忠实为准。不要自行添加署名、落款或额外分析章节。
8. 如果链接不可读取、指定范围不存在、结构化解析失败或内容不完整,直接停止发布并报告失败,不得用外部搜索补齐。
9. 标题只使用译文标题,不要添加“译”“译文”“（译）”或其它翻译标记。其余用户链接和检索素材都不是翻译对象。
10. 提高关键词和核心观点的高亮密度:正文每约 200 个汉字至少一处,最多每 65 个汉字一处,不足 40 字的短句可以不加高亮。优先高亮关键术语、核心机制、中心句或开头关键句;每处可覆盖 2–64 个字符的关键短语或短句,加粗总字数不超过该段可见字数的 45%,不能把整段全部加粗。小标题继续使用既定标题层级突出显示。`;

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
