# Zen Content Hub 导读：一个任务的一生 + 想改什么去哪

> 面向维护者的项目地图。架构与部署看 README.md，本文只回答两个问题：**东西是怎么流动的**、**想改某个行为该动哪个文件**。

## 一、一个任务的一生(主链路)

你在 Slack 里发 `@bot 财报：美光 FY26Q3 https://example.com/xxx`,之后依次发生:

```
① 触发     src/triggers/slack.js
   Socket Mode 收到消息 → parseSlackTask 提取任务文本(清理 Slack 链接格式)
   → resolveWorkflowTask 认出「财报：」前缀 → workflowId = earnings
   → 用户/频道允许名单与每分钟限流 → slack_events 持久化去重
   → enqueue 落库(SQLite runs 表,状态 queued)

② 排队     src/core/queue.js + src/core/store.js
   有界队列限流、限并发出队，状态 queued → running。崩溃重启时 running 会被标 interrupted；管理员显式重新排队后，持久化 queued 任务会在下次启动恢复，避免历史中断任务被自动误发。

③ 调研+写作  src/core/runner.js  (runWriter)
   标准研究型任务并行运行四路：open-search、priority-search、official-search，
   以及 official-discovery（Exa type=deep，只接受官方/一手来源）。任务里贴的 URL
   (最多 5 个,Exa /contents 直抓正文)、官方/一手来源和既定优先信源属于第一优先层；
   开放搜索用于交叉验证。只有 company 工作流额外运行季度财报、官方披露和产业链三组
   type=deep 专项搜索；不要把“specialist=0”误读成未运行官方深度发现。
   合并去重后拼进 prompt(workflows/<id>.js 的 promptTemplate + 通用规范),
   调 OpenRouter chat completions(模型 = .env 的 OPENROUTER_MODEL),
   每个任务使用独立的 workDir/runs/<run-id>/，产出其中的 article.md
   (必须有 title frontmatter，这是硬契约，checkpoint 和生成素材也不得跨任务复用)。

④ 发布     src/index.js → src/channels/wechat-draft.js  (publish)
   draft-template.js 先核对真实渠道已登记并锁定固定模板，未登记或不匹配时拒绝调用发布接口
   → 门禁 gate.js(errors 拦截:缺 title/密钥/本地路径;warnings 放行提醒)
   → 注入固定头尾图 assets.js(assets/zen-header-banner.gif + zen-footer-background.png)
   → 生成封面 cover.js(便宜模型提取封面数据 → 仓库内置 cover-generator 用无头 Chromium 渲染；
     字段提取失败回退安全默认值，生成器失败或超时则阻止发布)
   → @wenyan-md/core renderAndPublish 渲染并上传到微信草稿箱(RENDER_OPTS 是
     与 wenyan-mcp 逐字符 parity 的硬约束,永远不要改)→ 拿 media_id 落库(幂等锚点)

⑤ 回报     src/core/notifier.js
   成功/失败/警告都 best-effort 回 Slack 原消息串。通知失败只记录日志，不能把已创建草稿改记为失败。
```

## 二、配置的三层

1. **`.env`（运行时开关，改完要重启进程）**：密钥、模型、任务目录、队列上限、抓取/外部 API 超时、Slack 允许名单、数据保留期、`HUB_DRY_RUN=1`、头尾图和定时表达式。完整列表和默认值以 `.env.example` 为准。服务不配置或校验公网出口 IP。
2. **`src/workflows/*.js`(声明式工作流,一等公民)**:每个文件 = 一种文章类型,声明 id、触发器、渠道、promptTemplate、优先信源。公共部分(env getter、信源清单、通用写作规范)在 `workflows/shared.js`；纯文字直译的正文提取在 `translation-source-text.js`，入口、追踪和断点续跑在 `translate-engine.js`。
3. **`src/config/index.js`(env → config 对象的翻译层)**:新加 env 键时在这里给默认值。

## 三、想改什么,去哪改

| 想改的行为 | 文件 | 备注 |
|---|---|---|
| 写作风格/文章结构 | `src/workflows/<id>.js` 的 promptTemplate | 通用规范在 `workflows/shared.js` |
| 新增一种文章类型 | 新建 `src/workflows/<name>.js` + `src/index.js` WORKFLOWS 注册 | 照抄 earnings.js 的结构 |
| 公司深度分析框架 / 专项深搜 | `src/workflows/company.js` | 连续季度、竞争、产业链与趋势图；额外三组 type=deep 查询 |
| 标准官方深度发现 | `src/core/runner.js` 的 `official-discovery` | 所有研究型任务均运行；只保留官方/一手结果 |
| Slack 触发前缀/中文别名 | `src/triggers/slack.js` 的 WORKFLOW_ALIASES | 微信/财报/行业/晨报/直译… |
| 直译正文提取/结构 | `src/workflows/translation-source-text.js` | Readability → Playwright、Notion、PDF 纯文字适配；图片、图题、表格、表题和代码块在模型调用前删除 |
| 直译翻译/完整性/续跑 | `src/workflows/translate-engine.js` | 固定纯文字模式，逐 block 翻译、确定性重组、完整性门禁与 checkpoint |
| 直译抓取配置 | `.env` 的 `TRANSLATION_*` / `NOTION_API_TOKEN` | 只控制正文来源大小、PDF 页数、浏览器、超时和重定向；没有图片/表格处理或旧链开关 |
| Slack 自然语言意图/裸链接行为 | `src/triggers/slack.js` 的 NATURAL_RULES | URL 只是研究素材；仅显式翻译才走 translate |
| 优先信源加减域名 | `workflows/shared.js` 的清单,或 .env EXA_PRIORITY_DOMAINS | 写主域即可,子域自动匹配 |
| 门禁规则(拦截/提醒) | `src/lib/gate.js` | 注意:投资建议敏感词已按要求移除,勿加回 |
| 微信宽表可读性与自动拆分 | `src/lib/mobile-tables.js` | 紧凑五列可放行；不可读表先拆分，转换失败才由 gate 拦截 |
| 头尾图换图 | 替换 `assets/` 下文件,或 .env 覆盖路径 | 幂等注入在 `src/lib/assets.js` |
| 封面版式/字段 | `tools/cover-generator/template.html` | 自定义生成器时覆盖 `COVER_GENERATOR_DIR`；数据提取 prompt 在 `src/lib/cover.js` |
| 写作模型/生成参数 | .env `OPENROUTER_MODEL` / `OPENROUTER_TEMPERATURE` / `OPENROUTER_MAX_TOKENS` / `OPENROUTER_REASONING_EFFORT` | 默认 12000 tokens、reasoning=none;改完重启 |
| 草稿固定模板总门禁 | `src/lib/draft-template.js` | 所有真实渠道必须登记模板 ID 并锁定；任务不得覆盖，改版必须升版本和更新测试 |
| 微信渲染主题 | 别改。`zen-wechat/zen-trading@1` 与 `RENDER_OPTS` 是 parity 硬约束 | 主题本体在 zen-wechat-theme 仓库 |
| Customer.io 邮件草稿 | `src/workflows/email.js` + `src/channels/customerio-draft.js` | 固定 `zen-customerio/zen-research@1`，只创建草稿；受众由 internal/pilot/full 三阶段配置控制 |
| 新发布渠道 | 新建 `src/channels/<name>.js` 实现 publish() + 注册模板和渠道 | 见 README「扩展」一节；未登记模板时 fail closed |

## 四、日常运维

### macOS 本机 launchd

```bash
# 看状态 / 日志
launchctl print gui/$(id -u)/com.zentrading.content-hub | head
tail -f ~/Library/Logs/zen-content-hub/out.log

# 改完代码让它生效(launchd 不会自动 reload)
launchctl kickstart -k gui/$(id -u)/com.zentrading.content-hub

# 开发调试:先停常驻再手动跑,避免双实例重复消费 Slack 消息
scripts/uninstall-launchd.sh && HUB_DRY_RUN=1 node src/index.js
# 调完装回去
scripts/install-launchd.sh
```

### Linux / DigitalOcean systemd

目录布局、首次安装、数据库备份、安全更新和健康检查见 [`../deploy/README.md`](../deploy/README.md)。更新代码后先 `npm ci && npm run check`，再执行 `sudo systemctl restart zen-content-hub`。生产只运行一个实例。

改任何 `src/` 代码后的验收顺序：`npm run check`（测试不使用真实业务凭据；依赖审计会访问 npm registry）→ 按需执行真实连接检查 → 备份 SQLite → 明确重启对应服务。不要从 Git 拉取后未经检查直接重启。

## 五、阅读顺序建议(第一次读代码)

1. `src/index.js`——装配入口；从 `makeHandler` 和 `main` 看①-⑤、连接恢复、健康检查与优雅退出如何串起来。
2. `src/workflows/wechat.js` + `shared.js`——声明式配置长什么样。
3. `src/core/runner.js`——调研+写作,占业务逻辑大头。
4. `src/channels/wechat-draft.js`——发布链路的确定性环节顺序。
5. 其余(store/queue/notifier/triggers)都很薄,遇到再读。

每个模块都是依赖注入风格(makeXxx({ 依赖 })),对应 test/ 下同名测试文件,想确认某行为,先看测试用例往往比看实现快。
