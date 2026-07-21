# Zen Content Hub 导读:一个任务的一生 + 想改什么去哪

> 面向维护者的项目地图。架构与部署看 README.md,本文只回答两个问题:**东西是怎么流动的**、**想改某个行为该动哪个文件**。

## 一、一个任务的一生(主链路)

你在 Slack 里发 `@bot 财报：美光 FY26Q3 https://example.com/xxx`,之后依次发生:

```
① 触发     src/triggers/slack.js
   Socket Mode 收到消息 → parseSlackTask 提取任务文本(清理 Slack 链接格式)
   → resolveWorkflowTask 认出「财报：」前缀 → workflowId = earnings
   → enqueue 落库(SQLite runs 表,状态 queued)

② 排队     src/core/queue.js + src/core/store.js
   限并发出队,状态 queued → running。崩溃重启时 running 会被标 interrupted；管理员显式重新排队后，持久化 queued 任务会在下次启动恢复，避免历史中断任务被自动误发。

③ 调研+写作  src/core/runner.js  (runWriter)
   多路素材,优先级从高到低:
   a. 第一优先层:任务里贴的 URL(最多 5 个,Exa /contents 直抓正文) + 官方/一手来源 + 既定优先信源
   b. 第二优先层:公司财务、竞争格局、上下游等专项深搜与深层子页面
   c. 第三优先层:开放搜索交叉验证
   合并去重后拼进 prompt(workflows/<id>.js 的 promptTemplate + 通用规范),
   调 OpenRouter chat completions(模型 = .env 的 OPENROUTER_MODEL),
   产出 workDir/article.md(必须有 title frontmatter,这是硬契约)。

④ 发布     src/channels/wechat-draft.js  (publish)
   门禁 gate.js(errors 拦截:缺 title/密钥/本地路径;warnings 放行提醒)
   → 注入固定头尾图 assets.js(assets/zen-header-banner.gif + zen-footer-qr.png)
   → 生成封面 cover.js(便宜模型提取封面数据 → ~/zen-push-image 无头 Chrome 渲染,
     失败回退「示例+标题」,不会挂)
   → @wenyan-md/core renderAndPublish 渲染并上传到微信草稿箱(RENDER_OPTS 是
     与 wenyan-mcp 逐字符 parity 的硬约束,永远不要改)→ 拿 media_id 落库(幂等锚点)

⑤ 回报     src/core/notifier.js
   成功/失败/警告都回 Slack 原消息串。这是唯一往 Slack 发消息的地方。
```

## 二、配置的三层

1. **`.env`(运行时开关,改完要重启进程)**:密钥、`OPENROUTER_MODEL`(写作模型,想换更便宜的只改这里)、`WORK_DIR`、`EXA_NUM_RESULTS`/`EXA_PRIORITY_RESULTS`/`EXA_PRIORITY_DOMAINS`(逗号分隔,整体覆盖优先信源)、`HUB_DRY_RUN=1`(干跑,发布改道 mock)、`WECHAT_HEADER_IMAGE`/`WECHAT_FOOTER_IMAGE`(覆盖头尾图)、`MORNING_CRON`(设了晨报就定时自动跑)。
2. **`src/workflows/*.js`(声明式工作流,一等公民)**:每个文件 = 一种文章类型,声明 id、触发器、渠道、promptTemplate、优先信源。公共部分(env getter、信源清单、通用写作规范)在 `workflows/shared.js`；直译 V2 的结构化抓取在 `source-document-v2.js`，分块翻译、校验与断点续跑在 `translate-engine.js`。
3. **`src/config/index.js`(env → config 对象的翻译层)**:新加 env 键时在这里给默认值。

## 三、想改什么,去哪改

| 想改的行为 | 文件 | 备注 |
|---|---|---|
| 写作风格/文章结构 | `src/workflows/<id>.js` 的 promptTemplate | 通用规范在 `workflows/shared.js` |
| 新增一种文章类型 | 新建 `src/workflows/<name>.js` + `src/index.js` WORKFLOWS 注册 | 照抄 earnings.js 的结构 |
| 公司深度分析框架 | `src/workflows/company.js` | 连续季度、竞争、产业链与趋势图 |
| Slack 触发前缀/中文别名 | `src/triggers/slack.js` 的 WORKFLOW_ALIASES | 微信/财报/行业/晨报/直译… |
| 直译 V2 抓取/结构 | `src/workflows/source-document-v2.js` | Readability → Playwright、Notion、PDF 适配，生成稳定 block ID |
| 直译 V2 翻译/完整性/续跑 | `src/workflows/translate-engine.js` | 逐 block 翻译、确定性重组、完整性门禁与 checkpoint |
| 直译 V2 运行时开关 | `.env` 的 `TRANSLATION_*` / `NOTION_API_TOKEN` | 默认关闭；先 dry-run，失败不会回退旧链发布 |
| Slack 自然语言意图/裸链接行为 | `src/triggers/slack.js` 的 NATURAL_RULES | URL 只是研究素材；仅显式翻译才走 translate |
| 优先信源加减域名 | `workflows/shared.js` 的清单,或 .env EXA_PRIORITY_DOMAINS | 写主域即可,子域自动匹配 |
| 门禁规则(拦截/提醒) | `src/lib/gate.js` | 注意:投资建议敏感词已按要求移除,勿加回 |
| 微信宽表可读性与自动拆分 | `src/lib/mobile-tables.js` | 紧凑五列可放行；不可读表先拆分，转换失败才由 gate 拦截 |
| 头尾图换图 | 替换 `assets/` 下文件,或 .env 覆盖路径 | 幂等注入在 `src/lib/assets.js` |
| 封面版式/字段 | `~/zen-push-image/template.html`(另一个仓库) | 数据提取 prompt 在 `src/lib/cover.js` |
| 写作模型/生成参数 | .env `OPENROUTER_MODEL` / `OPENROUTER_TEMPERATURE` / `OPENROUTER_MAX_TOKENS` / `OPENROUTER_REASONING_EFFORT` | 默认 12000 tokens、reasoning=none;改完重启 |
| 微信渲染主题 | 别改。`RENDER_OPTS` 是 parity 硬约束 | 主题本体在 zen-wechat-theme 仓库 |
| Customer.io 邮件草稿 | `src/workflows/email.js` + `src/channels/customerio-draft.js` | 只创建草稿；受众由 `CUSTOMERIO_NEWSLETTER_SEGMENT_ID` 控制 |
| 新发布渠道 | 新建 `src/channels/<name>.js` 实现 publish() + 注册 | 见 README「扩展」一节 |

## 四、日常运维(本机 launchd)

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

改任何 `src/` 代码后的验收三件套:`npm test`(全量,纯桩不联网)→ `npm run check:openrouter`(密钥连通)→ `launchctl kickstart -k …`(重启生效)。

## 五、阅读顺序建议(第一次读代码)

1. `src/index.js`——装配入口,50 行内看懂 makeHandler 把①-⑤串起来的方式。
2. `src/workflows/wechat.js` + `shared.js`——声明式配置长什么样。
3. `src/core/runner.js`——调研+写作,占业务逻辑大头。
4. `src/channels/wechat-draft.js`——发布链路的确定性环节顺序。
5. 其余(store/queue/notifier/triggers)都很薄,遇到再读。

每个模块都是依赖注入风格(makeXxx({ 依赖 })),对应 test/ 下同名测试文件,想确认某行为,先看测试用例往往比看实现快。
