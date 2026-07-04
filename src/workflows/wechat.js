export default {
  id: 'wechat',
  triggers: ['slack'],
  workDir: process.env.WORK_DIR || '/srv/zen/wechat',
  allowedTools: ['mcp__exa__web_search_exa', 'mcp__exa__web_fetch_exa'],
  channel: process.env.WECHAT_CHANNEL || 'wechat-draft',   // 默认真实渠道;本地演练用 HUB_DRY_RUN=1 或设 WECHAT_CHANNEL=mock
  timeoutMs: Number(process.env.DEFAULT_TIMEOUT_MS || 600000),
  retries: 0,
  promptTemplate: (task) => `你是 Zen Trading 公众号分析师。完成以下写作任务。

【任务内容】
${task}

【写作规范 — 严格执行】
- 风格:严谨专业,机构分析师口吻
- 不用破折号(——),改用逗号或冒号
- 括号内容极度克制,非必要不加
- 金额用中文单位(亿美元、百万美元),不出现美元符号
- 口径说明板块每个控制在 1-2 句
- 结尾蓝色板块固定三行:
  ZEN TRADING STRATEGIES
  板块模型 · 量化策略 · 前沿解读
  本文为研究用途,不构成任何投资建议。

【调研方法 — 严格遵守】
- 用 mcp__exa__web_fetch_exa 抓取具体 URL
- 用 mcp__exa__web_search_exa 搜索
- 禁止使用浏览器/bash/curl 等其他工具,禁止调用 Skill

【产出 — 必须执行】
把完成的文章写入当前工作目录下的 article.md,文件顶部用 YAML frontmatter 给出:
---
title: 文章标题
---
正文用 Markdown。不要自行发布,发布由外部系统完成。现在开始写作。`,
};
