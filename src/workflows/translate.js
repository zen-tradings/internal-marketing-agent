import { sharedResearch, envChannel, envModel, envTimeoutMs, workDirFor, buildPromptTemplate } from './shared.js';

const METHODOLOGY = `【直译任务 — 专属要求,与通用规范冲突时以本节为准】
本工作流只在用户明确要求直译/完整翻译时触发,首要目标是把任务中的第一个来源忠实翻译成简体中文公众号文章。用户同时提出“并分析/并讲讲/翻译后说明”等附加问题时,必须先完成不增不减的全文直译,再另设“原文依据分析”章节回答,不得把分析混入或改写译文:
1. 忠实优先:准确保留原文的结构与小标题层级、论证顺序,数字、单位、公司名、股票代码(Ticker)必须与原文一致,不做换算或改写。
2. 不增不减:不添加原文没有的观点或结论,不删减原文的实质内容(可省略与正文无关的网站导航、广告等噪音)。
3. 术语处理:英文专有名词或术语首次出现时,可在其后用括号保留原文,方便读者对照(此处允许使用括号,不受"括号极度克制"限制)。
4. 来源说明:正文正式内容开始前(即 frontmatter 之后)必须先用一行注明来源,格式类似:
   来源:《原文标题》,发布于 站点/域名,原文链接 URL,发布日期 YYYY-MM-DD(素材缺对应信息则填"未知")。
   以上信息均取自调研素材里该来源的 title/URL/发布日期字段,不得编造。
5. 通用写作规范里的"机构分析师口吻改写"不适用于本工作流:直译以忠实为准,通用规范(不用破折号、金额中文单位等格式类要求)仍需遵守,但如与忠实转述原文冲突(例如原文的括号用法、数字单位),以忠实优先。不要自己加结尾署名板块或落款,文章首尾图由系统自动注入。
6. 兜底:如果任务里没有可读取的来源,或原文抓取为空/无正文可用,不要虚构译文,直接停止发布并报告获取失败。
7. 标题:frontmatter 的 title 用译文标题,可加"(译)"或"译"字样标出这是翻译稿。
8. 高亮:在不改变原文内容和顺序的前提下,每个主要章节用 Markdown 粗体标记 1-2 个核心观点或关键词,只改变视觉强调,不改写原句。
9. 复合任务:附加分析只能依据本次抓取的完整原文,必须区分原文直接使用的术语与概念相近机制；PDF 关键判断标注原文页码。未提出附加问题时不得自行添加分析。
10. PDF 版面:双栏论文必须按正确阅读顺序提取,不得把整页英文 PDF 截图放进正文。能无歧义提取的原图/表格放回对应图题或表题位置；无法可靠提取时,依据原文图题、表题和可见数据在原位置写忠实的中文内容概括,不得保留英文正文页面作为兜底。
其余的用户指定链接(第二条及以后)与开放/优先信源搜索素材仅作术语对照或背景参考,不是翻译对象。`;

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
