# Zen Content Hub

单实例常驻的双渠道内容编排服务：在 Slack 中用自然语言布置任务，自动路由到微信公众号草稿箱或 Customer.io Newsletter 草稿。支持 macOS 本机开发，也支持在 Linux/DigitalOcean 上由 systemd 7×24 小时管理。

## Pipeline

```text
Slack 私聊自然语言 / 频道 @Bot / PDF/文本附件 / cron
  → 消息/编辑静默防抖、修订去重、SQLite 入队与单实例限并发
  → 直译：范围识别 → 结构化 HTML/PDF → 分块翻译与完整性门禁
  → 微信分析 V2：原始 Prompt → TaskContract → SearchPlan → EvidenceMatrix → 证据后编辑 brief
  → 用户 PDF/Notion/Google Docs/GitHub/链接 + 最新官方一手 + 优先信源 + 开放交叉验证
  → 通用任务用 LatePost 方法；macro 由 Global Macro 主导并组合 LatePost 证据纪律
  → Qwen3.8-Max 写作 → GLM 5.2 逐句事实审计 → 系统确定性引用
  → 中央模板门禁 → 微信固定版式 / Customer.io Newsletter 固定模板
  → 只创建草稿，不发送、不排期
  → Slack best-effort 回报；通知失败不改变草稿结果
```

Node.js 负责流程控制；正文模型由 `.env` 的 `OPENROUTER_MODEL` 指定，生产默认 `qwen/qwen3.8-max`。`OPENROUTER_ROUTER_MODEL`、`OPENROUTER_PLANNER_MODEL` 与 `OPENROUTER_REVIEW_MODEL` 分别控制路由、顶层任务规划/证据编排和逐句事实审计；生产由 `moonshotai/kimi-k3` 负责规划与方向把握，Qwen3.8-Max 负责正文，GLM 5.2 负责路由和审计。未单独设置角色模型时会继承正文模型。`OPENROUTER_REASONING_EFFORT` 与各角色的 `*_REASONING_EFFORT` 独立配置：Kimi 规划和 Qwen 正文使用 `high`，GLM 路由与审计使用 `none`。`OPENROUTER_MAX_TOKENS` 控制每次请求中 reasoning 与最终输出共享的预算。仓库内版本化的写作 skill 在运行时加载并注入提示词，不与特定模型绑定。Exa 只负责检索与正文抓取；`alphaxiv.org` 是内置优先检索域名之一，项目不连接 AlphaXiv MCP。

## 目录

```text
src/
├── index.js                 服务入口与依赖装配
├── config/index.js          环境变量配置
├── core/                    队列、SQLite、调研写作、通知
├── triggers/                Slack 与 cron 触发器
├── workflows/               文章类型、提示词、优先信源
├── channels/                微信、Customer.io 与 mock 草稿渠道
└── lib/                     门禁、固定图片、封面、渲染输入

skills/
├── latepost-ai-writer/      版本化中文 AI 商业科技写作方法、稿型与检查表
└── global-macro-strategy-writer/  全资产宏观方法、三类稿型与 368 篇样本索引

scripts/
├── install-launchd.sh       安装本机常驻服务
├── uninstall-launchd.sh     卸载本机常驻服务
├── status.mjs               查看任务状态
├── research-trace.mjs       查看 Exa 查询与命中来源
├── check-openrouter.mjs     检查 OpenRouter 配置
├── check-egress.mjs         只读检查各外部 API 的网络可达性
├── check-translation.mjs    生成结构化直译本地验收稿
├── requeue-translation.mjs  受限恢复有 checkpoint 的失败直译
├── requeue-analysis-gate.mjs 受限恢复旧版代码门禁误拦截的 V2 分析
├── check-documents.mjs      只读验收私有 Notion / Google Docs
├── google-docs-oauth.mjs    本机生成 Google Docs refresh token
├── preview-newsletter.mjs   生成 Newsletter 本地 HTML 预览
└── update-render-golden.mjs 更新渲染基准

deploy/
├── zen-content-hub.service Linux systemd 服务模板
└── README.md               DigitalOcean 部署、更新与备份手册
```

更详细的代码导航见 [`docs/GUIDE.md`](docs/GUIDE.md)。

## 安装与配置

要求 Node.js 22 或更高版本，并准备 OpenRouter、Slack 和微信公众号凭据。原创分析需要 Exa；直译不依赖 Exa。分析型 PDF 的本地文字提取需要 Poppler 的 `pdfinfo` 与 `pdftotext`，扫描件 OCR 和保留原始结构的 PDF 直译需要 Datalab。Newsletter 还需要 Customer.io App API key。

Slack App 的 Bot Token Scopes 必须包含 `files:read`，否则消息事件虽然会带 PDF 文件名和私有 URL，下载时仍只会返回 Slack 登录页。新增该权限后必须重新安装 App 到工作区，再更新生产 `SLACK_BOT_TOKEN`。程序会在 PDF 进入 Poppler 或 Datalab 前验证真实文件签名，遇到登录页会直接给出权限提示，不再把 HTML 误报成 PDF 损坏。

```bash
npm ci
cp .env.example .env
```

填写 `.env` 后先检查：

```bash
npm run check
npm run check:openrouter
```

服务不检查或限制公网 IP，不维护出口 IP 白名单，也不会因为公网 IP 变化、查询失败或代理环境变量而阻止启动、调研或发布。所有外部请求按主机和 Node.js 运行环境的正常网络配置发出；真正的 DNS、TLS、超时或目标 API 错误仍按普通网络错误处理。`npm run check:egress` 只做各外部 API 的只读可达性检查，不参与服务门禁。

## 运行

直接启动：

```bash
npm start
```

安全演练会执行真实调研和写作，但不会创建微信草稿：

```bash
HUB_DRY_RUN=1 npm start
```

本机常驻运行：

```bash
scripts/install-launchd.sh
launchctl print gui/$(id -u)/com.zentrading.content-hub | head
tail -f ~/Library/Logs/zen-content-hub/out.log
```

代码或 `.env` 更新后重启：

```bash
launchctl kickstart -k gui/$(id -u)/com.zentrading.content-hub
```

不要同时启动 launchd 实例和手动实例，否则会重复消费 Slack 消息。

### Linux / DigitalOcean 常驻

仓库提供了 systemd 服务模板、最小目录布局、健康检查、更新与 SQLite 备份步骤：[`deploy/README.md`](deploy/README.md)。推荐把代码放在 `/opt/zen-content-hub`，运行数据放在 `/var/lib/zen-content-hub`，密钥放在 `/etc/zen-content-hub/zen-content-hub.env`。

健康端点默认关闭；设置 `HEALTH_HOST=127.0.0.1` 和 `HEALTH_PORT=8787` 后启用：

```bash
curl --fail http://127.0.0.1:8787/health
curl --fail http://127.0.0.1:8787/ready
```

代码更新不会自动生效。把通过 CI 的明确提交按 [`deploy/README.md`](deploy/README.md) 打成不可变发布包，在独立 release 目录执行 `npm ci && npm run check`，备份 SQLite 后再切换并重启唯一的 systemd 实例；不要从本地脏工作树直接覆盖生产目录。

`RUN_RETENTION_DAYS` 控制终态任务记录及其独立运行目录的保留天数，`SLACK_THREAD_RETENTION_DAYS` 控制线程上下文和事件去重记录；清理在启动时执行。`cancelled` 和 `needs_input` 与其它终态记录使用同一保留规则。主动停止会删除整个未完成运行目录；等待澄清的任务只保留 `research-trace.json`，其余半成品立即清理。调整为更短期限前先备份数据库和 `/var/lib/zen-content-hub`。

查看实时 Exa 调用和最近一次 company 调研轨迹：

```bash
tail -f ~/Library/Logs/zen-content-hub/out.log
npm run trace:research -- company
```

## Slack 自然语言入口

私聊 Bot 时直接像和 AI 对话一样输入任务即可；公共频道必须 `@Bot`，避免误收普通聊天。`NODE_ENV=production` 时必须通过 `SLACK_ALLOWED_USER_IDS` 和 `SLACK_ALLOWED_CHANNEL_IDS` 限定调用者，并用 `SLACK_RATE_LIMIT_PER_MINUTE` 限流。新消息或最后一次编辑默认静默 5 秒后入队，`SLACK_EDIT_DEBOUNCE_MS` 可调整。任务按 `channel + message_ts + 修订号` 持久化去重；编辑原消息或在线程补充 Prompt 时，尚未发布的旧修订会被取消、清理并替换，入队回执会显示完整要求、精确型号、链接数量和修订号。

中文和英文指令使用同一套路由。Slack 中未经截断的原始 Prompt 是微信分析内容要求的最高权威；主题、比较对象、观点、结构、篇幅和禁止项不能被工作流默认框架覆盖。英文只是指令语言，不改变产物默认语言：公众号与直译结果仍为简体中文，Newsletter 保持自身的语言规则。模型能力比较即使写了 `deep dive` 也走通用 Prompt 驱动分析，不触发公司财务、SEC 或价值链查询。链接只表示用户指定的最高优先研究素材，不自动触发直译；只有明确要求翻译才走完整直译。裸链接和未明确类型的任务默认微信公众号分析。

用户链接和 Slack 附件会先全文读取，再默认用最新官方/一手来源和既定优先来源交叉验证；明确写“仅依据此链接”时不扩展搜索。PDF、Notion、Google Docs 和 GitHub 仓库/文件会直接进入用户一级来源，和普通链接一样不会仅因用户提供就自动被认定为官方事实。Slack 私有文件下载使用 Bot token；分析型 PDF 有 Datalab 时走结构化解析，没有时由 Poppler 提取可搜索文字，扫描件在没有 OCR 服务时明确失败。若用户材料与一手材料各自有明确证据，并且对核心前提形成无法用时间或口径解释的冲突，任务才转为 `needs_input`，Bot 在原线程只问一个明确问题；用户回答后同一冲突不再重复询问。缺资料、型号未验证和事实审计问题不再循环提问；系统按风险、影响、来源和置信度决定局部修复或保留待复核。

在原任务线程或同一频道发送 `@ZenBot 停止当前任务`、`停止进程`、`取消任务`、`stop the current task`、`cancel task` 或 `abort this job`，会停止当前生成任务。排队任务会直接移出队列；运行中任务会中断网络请求、标记为 `cancelled` 并删除自己的 `runs/<run-id>/` 目录，ZenBot 服务本身保持在线。任务一旦进入微信或 Customer.io 草稿创建阶段便不再强杀，避免外部草稿已经创建而本地丢失 `media_id`；Bot 会明确回复该状态。任何路径都只创建草稿，不发送或排期。

## 工作流

| ID | Slack 前缀 | 用途 |
|---|---|---|
| `wechat` | `wechat:`、`微信：`、无前缀 | 通用公众号文章 |
| `macro` | `macro:`、`宏观：`、自然语言 | 全资产宏观快评、机制型深度或周报；只创建微信草稿，无 cron |
| `earnings` | `earnings:`、`财报：` | 财报预期与复盘；固定框架仅在 Prompt 未规定结构时补空白 |
| `sector` | `sector:`、`行业：` | 行业分析；固定框架仅作备用 |
| `morning` | `morning:`、`晨报：` | 24–48 小时晨报 |
| `translate` | `translate:`、`直译：`、`翻译：` | 按用户指定范围忠实翻译第一个链接的结构化内容 |
| `company` | `company:`、`公司：`、`个股：`、`深度：` | 明确要求公司财务、竞争或价值链时使用；不接管模型产品比较 |
| `email` | `email:`、`邮件：` | 生成带 Vol. 版号的 newsletter，并在 Customer.io 创建待审核草稿 |

这些内部工作流由规则优先、模型兜底的自然语言路由隐藏。`macro` 只有同时命中宏观/跨资产主题与分析意图才会自动进入，覆盖政策、经济数据、利率、汇率、流动性、股票、商品、信用、风险偏好、波动率与数字资产；单公司、财报和行业请求仍由更具体的既有流程优先处理，混合请求只选最终问题对应的一个完整流程。微信分析 V2 先把原始 Prompt 固化为 `TaskContract`，抽取中文实体的英文名、法定名称、ticker 或监管别名，再生成最多 `ANALYSIS_SEARCH_MAX_QUERIES` 个定向查询，默认 8 个。每个任务都确定性包含至少一条中文查询和一条英文查询，优先各两条；中文公司任务还会补英文法定名称的官方与行业查询，公司工作流并行补跑季度财务、监管披露和价值链三路深搜。“最新/newly released/current”类动态查询默认使用最近 `ANALYSIS_RECENT_WINDOW_DAYS` 天，默认 60 天，官方产品页和历史材料不受该硬窗口限制。静态官方域名只用于发现候选来源，来源必须同时匹配发布主体、页面类型和目标实体才能进入一手证据；同一证据层级优先英文来源，以及任何语言的独立第三方报道或研究。政府资助、国家所有和公共广播媒体会在检索结果层剔除，但监管机构、交易所和统计部门的原始文件仍可作为一手证据；用户主动贴出的受限媒体链接只保留为上下文，不能充当交叉验证或最终引用。内置名单可用 `EXA_EXCLUDED_MEDIA_DOMAINS` 和 `EXA_INDEPENDENT_MEDIA_DOMAINS` 扩展。Exa 不支持的 `x.com`/`twitter.com` 域名同样会在请求前剔除，避免整路检索因 4xx 失败。搜索结果按用户来源、官方一手、专业优先源、开放来源、语言/独立性和发布日期排序并设分路配额，再按用户要求逐项形成 `EvidenceMatrix`。

`wechat`、`sector`、`company`、`earnings` 在 EvidenceMatrix 完成后继续只使用仓库内版本化的 `latepost-ai-writer`。`macro` 同时加载 `global-macro-strategy-writer` 与 `latepost-ai-writer`：宏观 skill 主导事实/已定价预期/增量信息、跨资产传导、基准与反向情景、观察信号和失效条件，LatePost 只补证据账本、归因、因果推进、事实审计与避免虚构。一个直接一手或原始来源可以支撑核心事实；没有一手依据时必须收窄为已证实事实、待验证点和观察条件。关键观察水平必须可复核；审计会把关键数字、市场定价与市场反应的直接证据优先补入最多五条文末精选来源。高风险推断允许保留，不阻断草稿，但会在原 Slack 线程提醒人工复核。不写买卖、目标价、入场、退出、止损或仓位指令；可靠数据才进入带口径、时点与来源的 Markdown 表格。所有 skill 都不能覆盖 Slack 原始 Prompt、来源门禁、用户指定结构、工作流专属方法或固定输出契约。双 skill 摘要、选定稿型、路由原因、证据边界、最终精选来源和审计结果写入 `research-trace.json`；skill 不用于直译、晨报或 Newsletter，也不得使稿件声称代表参考账号或复刻参考语料。

本机可绕过 Slack 演练完整 macro 调研、写作、审计和渲染前链路；`--dry-run` 强制使用 mock 渠道，不调用微信草稿接口：

```bash
npm run accept:macro -- --dry-run
```

直译使用一条固定的结构化链路。程序先识别“前 11 页”“第 3–8 页”“第 2.1 节”“从 Introduction 到 Conclusion”以及 `first 11 pages`、`pages 3–8`、`translate the Introduction section only` 等中英文范围；没有范围时才翻译全文。英文指令不会改变目标语言，默认仍把英文原文翻译为简体中文。arXiv 优先读取官方 HTML，普通 HTML 保留标题层级、段落、列表、引用、原图与图注、表格、公式、代码和参考文献；正文中带标题的沙箱 `srcdoc` 图表由现有 Chrome 完成懒加载后按原位置截图为 PNG，图题与说明进入翻译单元，外部视频只保留原文链接而不截图。Notion 配置 `NOTION_API_TOKEN` 后优先读取官方 Markdown。PDF 由 Datalab 托管 API 转成结构化 HTML；Datalab 的并列分页容器会按 `data-page-id` 全部原序拼接，不经过只适用于单篇网页的 Readability 选择。完成响应必须具有有效质量分、与请求完全一致的连续页容器，并保证返回图片与 HTML 引用双向匹配；系统再用 Poppler 文本层与 Datalab 原始文本交叉检查结构化正文覆盖率，任何缺页、正文骤减或图表游离都会在翻译和发布前硬失败。Slack 成功通知及 trace 使用实际页级覆盖，不再把没有页级记录的内容显示为“0 页”。

翻译只替换需要翻译的文本节点：标题、正文、列表、图注和表题；原图文件、公式、代码、引文编号、URL 和参考文献结构保持不变。表格不再翻译单元格或重建 Markdown/HTML，而是把原文表格直接栅格化为高清 PNG，按原顺序作为图片进入正文，避免微信公众号重新排版造成字号、换行和列宽失真。标题不追加“（译）”；文首只保留一个包含原文标题、作者、站点和链接的“原文信息”块，不显示日期或翻译范围，论文标题页中重复的作者与机构列表会在摘要前移除。正文高亮按约每 200 个汉字至少 1 处、目标 2–3 处执行，优先选择关键术语、核心机制、中心句或开头关键句，并禁止整段加粗；高亮属于可降级样式，异常 Markdown 会安全清理，不触发重译或阻断。数字校验按数值语义分级：`zero/one`、英文复合数字词、序数、K/M/B/T、千分位、百分比和万/亿等价中文写法允许通过，`百分比`、`百分点` 不会被误扫成数字 `100`；LaTeX 宏、URL、公式/引用占位符、Ticker 和型号统一作为不可变 token。疑似未翻译检测会先遮蔽这些不可变 token；只含公式或引用占位符的块按 token 等价处理，不会把 `ZEN_INLINE` 标记名当成未翻译英文正文。单块最多聚焦修复两轮，仍存在明确数字或不可变 token 差异时选取最佳完整译文，正文保持干净，并把块 ID、差异、原文、候选和最终选择写入 Slack 提醒与 `research-trace.json`。模型漏块、重复/乱序、明显未翻译，或产物丢失图片、原文表格图片、公式、资产损坏时仍会硬失败。每个通过结构硬门禁的文本单元立即写入 checkpoint，同批其它单元失败时不会丢失已完成进度。原图和原文表格中的嵌入文字不会 OCR、翻译或重绘。直译以忠实还原为先，不触发原创写作的中文破折号风格提醒；“美元符号后跟数字”不再触发发布提醒，其它安全、完整性、固定模板和排版门禁继续生效。

HTML 直译不需要 Datalab；原站动态嵌入图表由 DigitalOcean 上的 Chrome 在既有同源网络隔离下截图，不新增第三方解析或外域访问。PDF 直译必须设置 `DATALAB_API_KEY`；Bot、翻译编排、图片持久化、固定模板渲染和草稿创建仍全部运行在 DigitalOcean，外部服务只负责临时解析 PDF。当前 2GB Droplet 不需要安装 Marker/MinerU 模型。原创分析不要求 Datalab：有文字层的 PDF 可由 Poppler 提取；扫描件或需要图表、表格、公式结构时仍应配置 Datalab。

Notion 页面配置 `NOTION_API_TOKEN` 后通过官方 Markdown 接口读取，私有页面还必须在 Notion 页面右上角通过 `Add connections` 共享给该 integration。公开 Google Docs 可直接导出 HTML；私有文档推荐配置 `GOOGLE_DOCS_CLIENT_ID`、`GOOGLE_DOCS_CLIENT_SECRET` 和 `GOOGLE_DOCS_REFRESH_TOKEN`，服务会自动刷新短期 access token，旧的 `GOOGLE_DOCS_ACCESS_TOKEN` 仅作为兼容回退。分析和完整直译共用同一只读认证入口；用户主动提供的 Notion/Google Docs 无法读取时任务会停止，不会忽略原文后继续搜索。GitHub 公共仓库无需 token，私有仓库或较高限额可配置只读 `GITHUB_TOKEN`。详细配置和验收见 [`docs/private-documents.md`](docs/private-documents.md)。

所有文章、PDF、文档 API 和重定向都逐跳拒绝内网地址，并受原文大小、PDF 页数和重定向次数限制。首次配置新来源、浏览器、Notion、Google Docs 或 GitHub 时，应先执行 `HUB_DRY_RUN=1` 的真实链接验收；配置示例见 `.env.example`。

也可以绕过 Slack 只生成一篇本地验收稿；该命令会产生 OpenRouter 调用，但不会调用微信接口：

```bash
npm run check:translation -- "翻译前 11 页 https://example.com/paper.pdf"
```

失败直译可由维护者按 SQLite `runs.id` 中的原 run-id 受限续跑；不要把带哈希的运行目录名当成 run-id：

```bash
npm run requeue:translation -- <run-id>
```

命令只接受失败或中断的 `translate` 任务，要求存在有效 checkpoint，并拒绝已有 `media_id`、其它工作流和不在恢复白名单内的失败类型。重新入队后需按部署环境的正常方式重启单实例服务，由启动恢复逻辑从 checkpoint 继续。

旧版本因“正文包含代码围栏”或“四空格缩进块”而在 `gate` 失败的 V2 分析，可用专用命令恢复：

```bash
npm run requeue:analysis-gate -- <run-id>
```

该命令只接受 `wechat`、`sector`、`company`、`earnings` 的旧代码门禁记录，或历史版本中代码换行节点被最终安全渲染白名单误拦截的精确错误；任务必须没有 `media_id` 并保留有效 Slack 通知信息。其它状态、其它门禁或已发布任务全部拒绝。命令只改为排队状态，不直接执行任务。

原创分析默认官方来源优先，但相关性和实体匹配高于域名。写作模型只接收证据矩阵选出的相关材料，不再接收几十个混杂来源。四个 V2 分析流的事实审计把问题拆成 `impact`（core/supporting/incidental）、`risk`（high/low）、`origin`（用户要求、用户材料、证据、推断或模型新增）和 `confidence`。只有高置信度问题允许自动改文：模型新增的核心或高风险无支持事实有直接证据时局部限定/替换，否则删句；核心删句必须再做一次基于现有证据的局部补写，仍无法成立才停止。低风险非核心问题、中低置信度问题、用户明确前提和已标注推断保留在正文，只写入 Slack 待复核与 trace；用户链接前提按项目 README/文档归因，只有 Prompt 时按工程假设表达，正文不出现 Slack 或“用户说”。第二轮只复核已修改句和剩余高风险事实，不能级联重写全文。法律 V1、晨报和 Newsletter 不使用这套分级审计。公众号正文不放引用脚标或来源链接，系统根据证据矩阵确定性追加唯一、左对齐的“引用链接”板块，精选最多 5 个实际采用的来源。

## 发布前处理

### 固定模板契约

所有由 Bot 创建的真实草稿都必须沿用中央登记的固定模板。`src/lib/draft-template.js` 是唯一模板注册表：微信公众号草稿固定为 `zen-wechat/zen-trading@4`，Customer.io Newsletter 草稿固定为 `zen-customerio/zen-research@1`。真实渠道未登记模板、模板 ID 不匹配或未声明锁定时，会在调用发布接口前失败；任务文字、工作流和单次运行都不能指定另一套模板。`mock` 只用于 dry-run，不属于真实草稿渠道。

需要改版时，必须集中修改模板实现、升级注册表中的版本号，并同步渠道测试、渲染 golden 与本文档；不能在单个任务里绕过。标题、正文、链接、期号和受众等内容进入模板预留槽位，不改变模板本身。

`src/channels/wechat-draft.js` 按固定顺序执行：

1. 检查 title、疑似密钥、本地路径和格式警告。原文自带代码的直译，或原始 Prompt 明确要求代码、代码示例、ASCII 图时，确定性授权代码块；模型不能自行开启。未授权代码降为 Slack 提醒并继续发布。独立四空格缩进代码先规范为 `text` 围栏，已有围栏、HTML `pre` 和嵌套列表不重复转换。
2. 判断原创文章中 Markdown 表格的移动端可读性：紧凑五列表直接保留；不可读宽表固定首列、每组三个指标自动拆成多个窄表，再执行最终门禁。直译表格已经是原文 PNG，不进入这一步的表格重排。
3. 在 Markdown 开头注入 `assets/zen-header-banner.gif`。
4. 写作任务(直译除外)按文章内容生成信息图:先用 OpenRouter 规划最多 `INFOGRAPHIC_MAX_IMAGES` 张配图(模板、数据与插入锚点),再由仓库内置 `tools/infographic-generator` 以 `@antv/infographic` SSR 在本地渲染成 SVG、用 Playwright 截图成 PNG,插入锚点标题或段落之后。图中文字与数字只能来自正文,规划、渲染或锚点定位任一失败都只告警并跳过该图,不阻断发布;重试时先按确定性命名 `infographic-N.png` 剥离旧图再重新生成。可用 `INFOGRAPHIC_ENABLED=false` 整体关闭。
5. 用 OpenRouter 提取封面字段，再由仓库内置 `tools/cover-generator` 把标题与副标题渲染到固定白底 `assets/zen-cover-background.png` 上，输出与底图一致的 900×383 封面；只有替换实现时才需设置 `COVER_GENERATOR_DIR`。浏览器优先读取 `COVER_BROWSER_EXECUTABLE`，否则复用直译浏览器配置并自动发现常见 Chromium/Chrome 路径。
6. 用 `@wenyan-md/core` 和仓库内固定的 `assets/zen-trading.css` 完成正文渲染；代码使用浅色高亮且 `macStyle:false`，不改变模板 ID。最终 HTML 会把引用块和“原文信息”块归一为正文字号，并在上传前拦截非标题大字号、重复“原文信息”、危险嵌入节点，以及空的或含异常子节点的代码结构。代码中的密钥、本地路径和当前进程真实凭据仍在 Markdown 门禁硬拦截。
7. 在最终 HTML 最后依次追加内容调研问卷 `assets/zen-survey-qr.jpg` 与四二维码封底 `assets/zen-footer-qr.png`。系统强制断言调研图是倒数第二个节点、社群封底是最终节点，且两图紧邻、其后没有文字或其它节点，再上传微信草稿箱。可分别通过 `WECHAT_SURVEY_IMAGE`、`WECHAT_FOOTER_IMAGE` 覆盖，但两张尾图必须同时存在。

封面字段提取失败会回退到模板示例数据；封面文件生成失败会阻止发布。

## 测试

```bash
npm run check
```

`npm run check` 会做语法检查、运行全部测试，并对 production 依赖执行 high 级别审计。测试全部使用桩或内存数据，不需要真实网络凭据。渲染输出由 golden 测试锁定；只有确认渲染变化符合预期时才执行：

```bash
npm run test:update-golden
```

## 扩展

- 新文章类型：新增 `src/workflows/<name>.js`，并在 `src/index.js` 注册。
- 新发布渠道：新增实现 `publish()` 的 `src/channels/<name>.js`，在 `src/index.js` 注册，并先在 `src/lib/draft-template.js` 登记固定模板；未登记的真实渠道会 fail closed。
- 新定时任务：在 workflow 的 `triggers` 中声明 `cron:<表达式>`。

保持 `runWriter()` 在每个任务独立目录中生成 `article.md` 的契约，以及发布后立即写入 `media_id` 的幂等行为。通知是附属结果，Slack 回报失败不得覆盖已创建草稿的成功状态。

### Customer.io newsletter

Newsletter 工作流使用 Customer.io App API 和固定模板 `zen-customerio/zen-research@1` 创建名为 `Zen Research from Zen Trading · Vol. N` 的 Newsletter Broadcast 草稿，不设置 `send_now` 或 `scheduled_at`。渲染后的 HTML 必须带有该模板标识，否则不会调用 Customer.io。受众通过 `NEWSLETTER_AUDIENCE_STAGE=internal|pilot|full` 分阶段扩容：内部组是 `Newsletter · Internal Beta`（ID `17`），Pilot 组是 `Newsletter · Pilot`（ID `18`），全量候选组是 `Valid Email Address`（ID `6`）。Bot 会先读取 segment 实时人数并执行阶段人数门禁；`full` 还必须显式设置 `CUSTOMERIO_ALLOW_FULL_AUDIENCE=true`。

所有后续 Customer.io Newsletter 的可见发件人统一为 `Zen Trading <support@zentradings.com>`。渠道和只读检查脚本都会拒绝其他 From 地址，避免配置漂移。

邮件末尾始终提供满意/不满意两个链接。配置 `CUSTOMERIO_NEWSLETTER_FEEDBACK_URL` 时附加 `rating` 和 `edition` 参数；未配置时退化为联系邮箱的预填 `mailto:`。Customer.io MCP 不在核心发布链中，避免给自动任务增加发送权限面。

Newsletter 会先区分内容类型：市场、行业、公司、财报与数据分析属于研究型，继续检索官方来源并执行事实审查，但不设置正文官方链接的最低引用数量；首封问候、用户需求收集、Agent/产品介绍、通知公告、邀请与功能更新属于关系/通知型，只依据用户材料写作，不做无意义的市场搜索，也不要求官方引用。若任务同时明确要求官方数据或市场分析，研究型流程优先。

用 `npm run check:customerio` 只读检查三个阶段的实时人数、当前草稿和缺失配置。

完整的分批试发、审核与扩容步骤见 [`docs/NEWSLETTER_ROLLOUT.md`](docs/NEWSLETTER_ROLLOUT.md)。
