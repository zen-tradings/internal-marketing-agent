import { sharedResearch, envChannel, envModel, envTimeoutMs, workDirFor, buildPromptTemplate } from './shared.js';

const METHODOLOGY = `【直译任务 — 专属要求,与通用规范冲突时以本节为准】
本工作流的目标是把用户指定素材中的第一篇(调研素材里标为【用户指定素材】的第一条)忠实翻译成简体中文公众号文章,而不是重新分析或改写:
1. 忠实优先:准确保留原文的结构与小标题层级、论证顺序,数字、单位、公司名、股票代码(Ticker)必须与原文一致,不做换算或改写。
2. 不增不减:不添加原文没有的观点或结论,不删减原文的实质内容(可省略与正文无关的网站导航、广告等噪音)。
3. 术语处理:英文专有名词或术语首次出现时,可在其后用括号保留原文,方便读者对照(此处允许使用括号,不受"括号极度克制"限制)。
4. 来源说明:正文正式内容开始前(即 frontmatter 之后)必须先用一行注明来源,格式类似:
   来源:《原文标题》,发布于 站点/域名,原文链接 URL,发布日期 YYYY-MM-DD(素材缺对应信息则填"未知")。
   以上信息均取自调研素材里该来源的 title/URL/发布日期字段,不得编造。
5. 通用写作规范里的"机构分析师口吻改写"不适用于本工作流:直译以忠实为准,通用规范(不用破折号、金额中文单位、结尾三行板块等格式类要求)仍需遵守,但如与忠实转述原文冲突(例如原文的括号用法、数字单位),以忠实优先。
6. 兜底:如果调研素材里没有任何【用户指定素材】,或该素材抓取为空/无正文可用,不要虚构译文,直接在文章里如实说明"未能获取到原文内容,无法生成翻译",并按格式要求写出 frontmatter 和固定结尾三行板块。
7. 标题:frontmatter 的 title 用译文标题,可加"(译)"或"译"字样标出这是翻译稿。
其余的用户指定链接(第二条及以后)与开放/优先信源搜索素材仅作术语对照或背景参考,不是翻译对象。`;

export default {
  id: 'translate',
  triggers: ['slack'],
  get workDir() { return workDirFor('translate'); },
  get model() { return envModel(); },
  get channel() { return envChannel(); },
  get timeoutMs() { return envTimeoutMs(); },
  get research() { return sharedResearch(); },
  retries: 0,
  promptTemplate: (task) => buildPromptTemplate({
    persona: 'Zen Trading 公众号译者',
    task,
    methodologyBlock: METHODOLOGY,
  }),
};
