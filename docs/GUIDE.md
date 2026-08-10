# Zen Content Hub 导读：一个任务的一生 + 想改什么去哪

> 面向维护者的项目地图。架构与部署看 README.md，本文只回答两个问题：**东西是怎么流动的**、**想改某个行为该动哪个文件**。

## 一、一个任务的一生(主链路)

你在 Slack 里发 `@bot 财报：美光 FY26Q3 https://example.com/xxx`,之后依次发生:

```
① 触发     src/triggers/slack.js
   Socket Mode 收到消息 → parseSlackTask 提取任务文本(清理 Slack 链接格式)
   → resolveWorkflowTask 认出「财报：」前缀 → workflowId = earnings
   → 用户/频道允许名单与每分钟限流 → 新消息/编辑防抖
   → channel + message_ts + 修订号持久化去重
   → enqueue 落库(SQLite runs 表,状态 queued)

② 排队     src/core/queue.js + src/core/store.js
   有界队列限流、限并发出队，状态 queued → running。每个活动任务拥有独立 AbortController
   和 generate/publish 阶段标记；Slack 中英文停止指令可在 generate 阶段取消任务并清理
   run 目录，进入外部 publish 阶段后拒绝强杀。崩溃重启时 running 会被标 interrupted；
   管理员显式重新排队后，持久化 queued 任务会在下次启动恢复，避免历史中断任务被自动误发。

③ 调研+写作  src/core/analysis-v2.js + src/core/runner.js
   微信原创/行业/公司/财报/macro 先把未经截断的 Slack 原始 Prompt 固化为 TaskContract，
   抽取英文/法定别名后再生成最多 8 个 SearchPlan 定向查询。Slack PDF/文本附件、
   PDF/Notion/Google Docs/GitHub URL 与 Exa 搜索并行读取，并作为一级用户来源。直读失败时
   依次尝试精确缓存和 URL 语义恢复；FCC PDF 只有在机构、`DA` 文号和文件主题全部匹配时，
   才使用 `docs.fcc.gov` 的官方 TXT 附件恢复为同一用户文档；
   每个任务至少包含一条中文查询和一条英文查询，默认继续以最新官方/一手、
   既定优先源和开放来源交叉验证。同层级优先英文或任何语言的独立第三方机构，
   搜索结果确定性排除政府资助、国家所有和公共广播媒体；监管、交易所、统计部门
   的原始文件仍可作一手证据，用户主动提供的受限媒体只作上下文、不作佐证或引用。
   公司任务同时补跑
   季度财务、监管披露和价值链三路深搜。检索结果按用户每项要求形成
   EvidenceMatrix；静态域名只用于发现，必须匹配发布主体、页面类型和目标实体才能
   判为一手来源。证据矩阵完成后，通用任务由 latepost-ai-writer 选择受控稿型、证据可支持的
   角度、核心矛盾和结尾约束；Slack Prompt、来源安全、用户指定结构和工作流方法始终
   优先。正文模型只接收相关证据写作，生产由 Qwen3.8-Max 承担；GLM 5.2 的事实审计按影响、风险、来源和置信度返回精确原句与
   局部动作，低风险/中低置信度/用户前提保留待复核，只有高置信度问题可自动修改，
   不能重写全文。缺资料和无支持句不再提问；只有用户材料与一手来源对核心前提
   形成双边、不可调和冲突时转 needs_input，同一线程回答后不重复询问。
   引用链接由系统从证据矩阵精选并确定性追加，不再由模型维护。macro 会优先保留
   与概率、价格、收益率和市场反应等关键要求直接对应的证据；审计再返回最多四组
   关键主张与证据 ID，与至少一个核心一手来源合并成最多五条最终精选来源。macro 同时加载
   global-macro-strategy-writer，由它主导已定价预期、增量信息、跨资产传导、双向情景、
   观察信号和失效条件；LatePost 方法只补证据、归因、因果推进和避免虚构。其 trace
   额外记录双 skill、选定稿型、Slack 路由原因、证据边界、最终精选来源与宏观审计结果。
   中低置信度的高风险推断允许保留并创建草稿，但必须在原 Slack 线程提醒人工复核。
   生产默认运行 V2；V1 路径只通过 ANALYSIS_PIPELINE_VERSION 保留为单实例紧急回退，
   并使用确定性稿型回退，不作为日常运行模式。写作 skill 仅作用于微信原创、行业、
   公司、财报和 macro；翻译、晨报和 Newsletter 不加载它。macro 只有 Slack 触发器，
   没有 cron，且渠道固定沿用微信草稿，绝不自动发布。
   调 OpenRouter chat completions(正文模型 = .env 的 OPENROUTER_MODEL),
   每个任务使用 `runWorkDir()` 计算的独立
   `workDir/runs/<readable-run-id>-<hash>/`，产出其中的 article.md
   (必须有 title frontmatter，这是硬契约，checkpoint 和生成素材也不得跨任务复用)。

④ 发布     src/index.js → src/channels/wechat-draft.js  (publish)
   draft-template.js 先核对真实渠道已登记并锁定固定模板，未登记或不匹配时拒绝调用发布接口
   → 四空格代码规范为 text 围栏；gate.js(errors 拦截:缺 title/密钥/本地路径，未授权代码仅 warning)
   → Markdown 阶段由 assets.js 注入固定头图 assets/zen-header-banner.gif
   → 生成封面 cover.js(便宜模型提取封面数据 → 仓库内置 cover-generator 用无头 Chromium 渲染；
     字段提取失败回退安全默认值，生成器失败或超时则阻止发布)
   → @wenyan-md/core 渲染，wechat-render.js 在最终 HTML 末尾依次追加
     assets/zen-survey-qr.jpg、assets/zen-footer-qr.png，再上传微信草稿箱(RENDER_OPTS 是与 wenyan-mcp
     逐字符 parity 的硬约束,永远不要改)→ 拿 media_id 落库(幂等锚点)

⑤ 回报     src/core/notifier.js
   入队回执显示完整 Prompt、精确型号、链接数量和修订号。成功/失败/警告/澄清都
   best-effort 回 Slack 原消息串。通知失败只记录日志，不能把已创建草稿改记为失败。
```

## 二、配置的三层

1. **`.env`（运行时开关，改完要重启进程）**：密钥、模型、任务目录、队列上限、抓取/外部 API 超时、Slack 允许名单、数据保留期、`HUB_DRY_RUN=1`、固定头图、两张固定尾图和定时表达式。完整列表和默认值以 `.env.example` 为准。服务不配置或校验公网出口 IP。
2. **`src/workflows/*.js`(声明式工作流)**:每个文件声明 id、触发器、渠道、优先信源和备用方法论。V2 中 Slack Prompt 决定内容，行业/公司/财报方法论只补充用户未规定的结构。公共信源在 `workflows/shared.js`；结构化直译继续使用自己的固定链路。
3. **`src/config/index.js`(env → config 对象的翻译层)**:新加 env 键时在这里给默认值。

## 三、想改什么,去哪改

| 想改的行为 | 文件 | 备注 |
|---|---|---|
| 分析 Prompt 合同、证据矩阵、局部审计 | `src/core/analysis-v2.js` | 原始 Prompt 最高优先；纯函数便于回归 |
| 微信分析编排与外部调用 | `src/core/runner.js` 的 Analysis V2 分支 | 规划、Exa、写作、审计、确定性引用 |
| 中文原创写作方法、稿型与质量检查 | `skills/latepost-ai-writer/` + `src/lib/editorial-skill.js` | EvidenceMatrix 后路由；trace 记录摘要、稿型与角度；不得覆盖用户结构 |
| 全资产宏观方法、三类稿型与样本索引 | `skills/global-macro-strategy-writer/` + `src/workflows/macro.js` | 宏观主导、LatePost 约束证据；只创建微信草稿，无 cron |
| 用户附件与直接文档 | `src/core/user-sources.js` | Slack 私有文件、PDF、Notion、Google Docs、GitHub；并行读取并保留一级来源身份；受阻文档的官方镜像必须验证机构、文号和主题 |
| QDII 股票持仓数据 | `src/core/qdii.js` + `python/qdii_worker.py` | AKShare 合格即用；过期/空数据依次回退证监会、交易所和可验证基金公司，PDF 下载仍走安全网络门禁 |
| 备用文章结构 | `src/workflows/<id>.js` 的 `defaultMethodology` | 只在用户未规定结构时补空白 |
| 新增一种文章类型 | 新建 `src/workflows/<name>.js` + `src/index.js` WORKFLOWS 注册 | 照抄 earnings.js 的结构 |
| 公司深度备用框架 | `src/workflows/company.js` | 只有 Prompt 确实要求公司财务/竞争/价值链时使用 |
| Slack 中英文触发、编辑、补充、停止与路由 | `src/triggers/slack.js` | macro 要求宏观主题 + 分析意图；公司/财报/行业优先，混合请求只选一个流程 |
| 直译范围识别 | `src/workflows/translation-scope.js` | 页码和章节范围；用户页码为 1-based，Datalab 请求转换为 0-based |
| 直译内容提取/结构 | `src/workflows/translation-source-text.js` | arXiv HTML 优先、普通 HTML/Notion；保留标题、段落、图表、公式、代码和引用 |
| PDF 结构化解析 | `src/workflows/datalab-parser.js` | 直译/扫描件走托管 Datalab；完成态需稳定返回有效质量分、完整连续分页及双向匹配的图片引用；有文字层的分析型 PDF 可在 `user-sources.js` 用 Poppler 降级读取 |
| 直译翻译/完整性/checkpoint | `src/workflows/translation-source-text.js` | Datalab 多页根容器原序解析，Poppler/Datalab/结构化正文三方覆盖校验；逐文本节点翻译，不可变 token 在未翻译检测前遮蔽，纯公式/引用占位符块只做 token 等价校验；最多两轮定向修复、宽松复核例外、逐单元 checkpoint 及结构/资产硬门禁 |
| 直译执行与研究轨迹 | `src/workflows/translate-engine.js` | 把 manifest、严格等价状态、待复核块、全部候选与最终选择写入 trace |
| 失败直译受限续跑 | `scripts/requeue-translation.mjs` + `src/core/store.js` | 只接受数据库 run-id；要求 checkpoint，拒绝其它工作流、已有 `media_id` 和非白名单失败 |
| 旧代码输出分析受限重排 | `scripts/requeue-analysis-gate.mjs` + `src/core/store.js` | 仅四个 V2 分析流的旧代码 gate/安全渲染兼容错误，拒绝已发布、无 Slack 通知和其它错误 |
| 文档抓取配置 | `.env` 的 `TRANSLATION_*` / `NOTION_API_TOKEN` / `GOOGLE_DOCS_CLIENT_ID` / `GOOGLE_DOCS_CLIENT_SECRET` / `GOOGLE_DOCS_REFRESH_TOKEN` / `GITHUB_TOKEN` / `DATALAB_*` | 控制来源、私有文档、PDF 页数、浏览器、解析质量、超时和重定向；access token 仅为兼容回退 |
| 单任务取消、发布阶段保护与垃圾目录清理 | `src/core/queue.js`、`src/index.js`、`src/lib/task-cancellation.js` | generate 可取消；publish 后拒绝强杀；取消后状态为 cancelled |
| 优先信源加减域名 | `workflows/shared.js` 的清单,或 .env EXA_PRIORITY_DOMAINS | 写主域即可,子域自动匹配 |
| 门禁规则(拦截/提醒) | `src/lib/gate.js` + `src/lib/code-blocks.js` | 未授权代码只提醒；密钥/本地路径仍硬拦截；投资建议敏感词已移除，勿加回 |
| 微信宽表可读性与自动拆分 | `src/lib/mobile-tables.js` | 紧凑五列可放行；不可读表先拆分，转换失败才由 gate 拦截 |
| 固定头图/尾图换图 | 替换 `assets/` 下文件，或用 `WECHAT_HEADER_IMAGE` / `WECHAT_SURVEY_IMAGE` / `WECHAT_FOOTER_IMAGE` 覆盖 | Markdown 只注入头图；最终 HTML 强制按“调研图、社群封底”顺序保留最后两张 |
| 封面版式/字段 | `tools/cover-generator/template.html` | 自定义生成器时覆盖 `COVER_GENERATOR_DIR`；数据提取 prompt 在 `src/lib/cover.js` |
| 分析模型与预算 | `.env` 的 `OPENROUTER_MODEL` / `OPENROUTER_ROUTER_MODEL` / `OPENROUTER_PLANNER_MODEL` / `OPENROUTER_REVIEW_MODEL` / `ANALYSIS_*` | 正文、路由、规划、审计分离；生产默认 V2 |
| 草稿固定模板总门禁 | `src/lib/draft-template.js` | 所有真实渠道必须登记模板 ID 并锁定；任务不得覆盖，改版必须升版本和更新测试 |
| 微信渲染主题 | `zen-wechat/zen-trading@4`、`assets/zen-trading.css` 与 `RENDER_OPTS` | 主题文件随仓库部署；引用块归一为正文字号，最终 HTML 在发布前执行字体、重复来源与固定尾图顺序检查 |
| Customer.io 邮件草稿 | `src/workflows/email.js` + `src/channels/customerio-draft.js` | 固定 `zen-customerio/zen-research@3`，页脚地址固定为 `700 Leahy St, Redwood City, CA 94061`，只创建草稿；受众由 internal/pilot/full 三阶段配置控制 |
| Opening Digest 开市日报 | `src/workflows/opening-digest.js` + `src/channels/customerio-opening-digest.js` | 美东 10:15 生成、目标 10:30；开盘窗口、标准区块、3-5 条 catalyst 与来源规则均为软审计，只有带具体证据的高置信度核心事实错误在两轮局部修复后仍失败才停发；九格行情固定归一化，OIC 或封面失败可省略。受众预检失败或人数为零只写 trace，明确读到非 `test2` 才停发；正文退订标签本地移除，不再读回 `/contents`，所有可继续的降级均不发 Slack warning |
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

目录布局、首次安装、不可变发布包、数据库备份、安全更新和健康检查见 [`../deploy/README.md`](../deploy/README.md)。QDII 开发环境先运行 `npm run setup:qdii` 建立 Python 3.11+ 虚拟环境。更新时在独立 release 目录安装 Node/Python 锁定依赖并执行检查，再切换并重启唯一的 systemd 实例；现役目录用 `.deploy-commit` 标记，不依赖在线 `git pull`。

改任何 `src/` 代码后的验收顺序：`npm run check`（测试不使用真实业务凭据；依赖审计会访问 npm registry）→ 按需执行真实连接检查 → 备份 SQLite → 明确重启对应服务。不要从 Git 拉取后未经检查直接重启。

结构化校验失败的直译不要手工改数据库。确认目标版本已部署后，按 [`../deploy/README.md`](../deploy/README.md) 的受限续跑步骤使用数据库 run-id 恢复；命令验证 checkpoint 和 `media_id` 后，重启唯一实例让持久化队列接管。旧版代码围栏/四空格门禁误拦截的四类 V2 分析，只能用 `npm run requeue:analysis-gate -- <run-id>` 恢复；该命令同样只入队、不直接运行。

## 五、阅读顺序建议(第一次读代码)

1. `src/index.js`——装配入口；从 `makeHandler` 和 `main` 看①-⑤、连接恢复、健康检查与优雅退出如何串起来。
2. `src/workflows/wechat.js` + `shared.js`——声明式配置长什么样。
3. `src/core/runner.js`——调研+写作,占业务逻辑大头。
4. `src/channels/wechat-draft.js`——发布链路的确定性环节顺序。
5. 其余(store/queue/notifier/triggers)都很薄,遇到再读。

每个模块都是依赖注入风格(makeXxx({ 依赖 })),对应 test/ 下同名测试文件,想确认某行为,先看测试用例往往比看实现快。
