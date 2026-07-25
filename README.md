# Zen Content Hub

单实例常驻的双渠道内容编排服务：在 Slack 中用自然语言布置任务，自动路由到微信公众号草稿箱或 Customer.io Newsletter 草稿。支持 macOS 本机开发，也支持在 Linux/DigitalOcean 上由 systemd 7×24 小时管理。

## Pipeline

```text
Slack 私聊自然语言 / 频道 @Bot / cron
  → 消息/编辑静默防抖、修订去重、SQLite 入队与单实例限并发
  → 直译：范围识别 → 结构化 HTML/PDF → 分块翻译与完整性门禁
  → 微信分析 V2：原始 Prompt → TaskContract → SearchPlan → EvidenceMatrix
  → 用户链接 + 最新官方一手 + 优先信源 + 开放交叉验证
  → GLM 5.2 写作 → 逐句事实审计 → 系统确定性引用
  → 中央模板门禁 → 微信固定版式 / Customer.io Newsletter 固定模板
  → 只创建草稿，不发送、不排期
  → Slack best-effort 回报；通知失败不改变草稿结果
```

Node.js 负责流程控制；正文模型由 `.env` 的 `OPENROUTER_MODEL` 指定，生产默认 `z-ai/glm-5.2`。`OPENROUTER_PLANNER_MODEL` 与 `OPENROUTER_REVIEW_MODEL` 可独立覆盖任务规划和逐句事实审计，未设置时继承正文模型。正文默认关闭 reasoning，并由 `OPENROUTER_MAX_TOKENS` 明确控制输出预算。Exa 只负责检索与正文抓取。

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

scripts/
├── install-launchd.sh       安装本机常驻服务
├── uninstall-launchd.sh     卸载本机常驻服务
├── status.mjs               查看任务状态
├── research-trace.mjs       查看 Exa 查询与命中来源
├── check-openrouter.mjs     检查 OpenRouter 配置
├── check-egress.mjs         只读检查各外部 API 的网络可达性
├── check-translation.mjs    生成结构化直译本地验收稿
├── preview-newsletter.mjs   生成 Newsletter 本地 HTML 预览
└── update-render-golden.mjs 更新渲染基准

deploy/
├── zen-content-hub.service Linux systemd 服务模板
└── README.md               DigitalOcean 部署、更新与备份手册
```

更详细的代码导航见 [`docs/GUIDE.md`](docs/GUIDE.md)。

## 安装与配置

要求 Node.js 22 或更高版本，并准备 OpenRouter、Slack 和微信公众号凭据。原创分析需要 Exa；直译不依赖 Exa。Newsletter 还需要 Customer.io App API key。

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

代码更新不会自动生效。先拉取代码、执行 `npm ci && npm run check`，再重启 systemd；数据库应在停服或使用 SQLite 在线备份机制时备份。生产环境只运行一个实例。

`RUN_RETENTION_DAYS` 控制终态任务记录及其独立运行目录的保留天数，`SLACK_THREAD_RETENTION_DAYS` 控制线程上下文和事件去重记录；清理在启动时执行。`cancelled` 和 `needs_input` 与其它终态记录使用同一保留规则。主动停止会删除整个未完成运行目录；等待澄清的任务只保留 `research-trace.json`，其余半成品立即清理。调整为更短期限前先备份数据库和 `/var/lib/zen-content-hub`。

查看实时 Exa 调用和最近一次 company 调研轨迹：

```bash
tail -f ~/Library/Logs/zen-content-hub/out.log
npm run trace:research -- company
```

## Slack 自然语言入口

私聊 Bot 时直接像和 AI 对话一样输入任务即可；公共频道必须 `@Bot`，避免误收普通聊天。`NODE_ENV=production` 时必须通过 `SLACK_ALLOWED_USER_IDS` 和 `SLACK_ALLOWED_CHANNEL_IDS` 限定调用者，并用 `SLACK_RATE_LIMIT_PER_MINUTE` 限流。新消息或最后一次编辑默认静默 5 秒后入队，`SLACK_EDIT_DEBOUNCE_MS` 可调整。任务按 `channel + message_ts + 修订号` 持久化去重；编辑原消息或在线程补充 Prompt 时，尚未发布的旧修订会被取消、清理并替换，入队回执会显示完整要求、精确型号、链接数量和修订号。

中文和英文指令使用同一套路由。Slack 中未经截断的原始 Prompt 是微信分析内容要求的最高权威；主题、比较对象、观点、结构、篇幅和禁止项不能被工作流默认框架覆盖。英文只是指令语言，不改变产物默认语言：公众号与直译结果仍为简体中文，Newsletter 保持自身的语言规则。模型能力比较即使写了 `deep dive` 也走通用 Prompt 驱动分析，不触发公司财务、SEC 或价值链查询。链接只表示用户指定的最高优先研究素材，不自动触发直译；只有明确要求翻译才走完整直译。裸链接和未明确类型的任务默认微信公众号分析。

用户链接会先全文读取，再默认用最新官方/一手来源和既定优先来源交叉验证；明确写“仅依据此链接”时不扩展搜索。用户链接不会自动被认定为官方事实，最终引用也由系统按实际支持力精选。若用户链接与一手材料对核心实体、型号或主要前提发生实质冲突，任务转为 `needs_input`，Bot 在原线程只问一个明确问题；授权用户回复后，原 Prompt、最新编辑、补充链接和确认答案会组成新修订重新入队。次要口径差异不打断任务。

在原任务线程或同一频道发送 `@ZenBot 停止当前任务`、`停止进程`、`取消任务`、`stop the current task`、`cancel task` 或 `abort this job`，会停止当前生成任务。排队任务会直接移出队列；运行中任务会中断网络请求、标记为 `cancelled` 并删除自己的 `runs/<run-id>/` 目录，ZenBot 服务本身保持在线。任务一旦进入微信或 Customer.io 草稿创建阶段便不再强杀，避免外部草稿已经创建而本地丢失 `media_id`；Bot 会明确回复该状态。任何路径都只创建草稿，不发送或排期。

## 工作流

| ID | Slack 前缀 | 用途 |
|---|---|---|
| `wechat` | `wechat:`、`微信：`、无前缀 | 通用公众号文章 |
| `earnings` | `earnings:`、`财报：` | 财报预期与复盘；固定框架仅在 Prompt 未规定结构时补空白 |
| `sector` | `sector:`、`行业：` | 行业分析；固定框架仅作备用 |
| `morning` | `morning:`、`晨报：` | 24–48 小时晨报 |
| `translate` | `translate:`、`直译：`、`翻译：` | 按用户指定范围忠实翻译第一个链接的结构化内容 |
| `company` | `company:`、`公司：`、`个股：`、`深度：` | 明确要求公司财务、竞争或价值链时使用；不接管模型产品比较 |
| `email` | `email:`、`邮件：` | 生成带 Vol. 版号的 newsletter，并在 Customer.io 创建待审核草稿 |

这些内部工作流由规则优先、模型兜底的自然语言路由隐藏。微信分析 V2 先把原始 Prompt 固化为 `TaskContract`，再生成最多 `ANALYSIS_SEARCH_MAX_QUERIES` 个定向查询；“最新/newly released/current”类动态查询默认使用最近 `ANALYSIS_RECENT_WINDOW_DAYS` 天，官方产品页不受该硬窗口限制。静态官方域名只用于发现候选来源，来源必须同时匹配发布主体、页面类型和目标实体才能进入一手证据。搜索结果按用户要求逐项形成 `EvidenceMatrix`，不再以“至少两个官方来源”这种全局数量门禁决定成败。

直译使用一条固定的结构化链路。程序先识别“前 11 页”“第 3–8 页”“第 2.1 节”“从 Introduction 到 Conclusion”以及 `first 11 pages`、`pages 3–8`、`translate the Introduction section only` 等中英文范围；没有范围时才翻译全文。英文指令不会改变目标语言，默认仍把英文原文翻译为简体中文。arXiv 优先读取官方 HTML，普通 HTML 保留标题层级、段落、列表、引用、原图与图注、表格、公式、代码和参考文献；Notion 配置 `NOTION_API_TOKEN` 后优先读取官方 Markdown。PDF 由 Datalab 托管 API 转成结构化 HTML，Poppler 只用于本地页数和元数据校验。

翻译只替换需要翻译的文本节点：标题、正文、列表、图注和表题；原图文件、公式、代码、引文编号、URL 和参考文献结构保持不变。表格不再翻译单元格或重建 Markdown/HTML，而是把原文表格直接栅格化为高清 PNG，按原顺序作为图片进入正文，避免微信公众号重新排版造成字号、换行和列宽失真。标题不追加“（译）”；文首只保留一个包含原文标题、作者、站点和链接的“原文信息”块，不显示日期或翻译范围，论文标题页中重复的作者与机构列表会在摘要前移除。正文高亮按约每 200 个汉字至少 1 处、目标 2–3 处执行，优先选择关键术语、核心机制、中心句或开头关键句，并禁止整段加粗。模型漏块、改动数字/URL，或产物丢失图片、原文表格图片、公式时都会拒绝产稿。原图和原文表格中的嵌入文字不会 OCR、翻译或重绘。直译以忠实还原为先，不触发原创写作的中文破折号风格提醒；“美元符号后跟数字”不再触发发布提醒，其它安全、完整性、固定模板和排版门禁继续生效。

HTML 直译不需要 Datalab。PDF 直译必须设置 `DATALAB_API_KEY`；Bot、翻译编排、图片持久化、固定模板渲染和草稿创建仍全部运行在 DigitalOcean，外部服务只负责临时解析 PDF。当前 2GB Droplet 不需要安装 Marker/MinerU 模型。

所有文章、PDF 和重定向都逐跳拒绝内网地址，并受原文大小、PDF 页数和重定向次数限制。首次配置新来源、浏览器或 Notion 时，应先执行 `HUB_DRY_RUN=1` 的真实链接验收；配置示例见 `.env.example`。

也可以绕过 Slack 只生成一篇本地验收稿；该命令会产生 OpenRouter 调用，但不会调用微信接口：

```bash
npm run check:translation -- "翻译前 11 页 https://example.com/paper.pdf"
```

原创分析默认官方来源优先，但相关性和实体匹配高于域名。写作模型只接收证据矩阵选出的相关材料，不再接收几十个混杂来源。事实审计器只返回文章中的精确原句、严重程度、证据编号和删除/限定/替换/澄清动作，不能重写全文或把自己的建议称为“原问题”。非核心无支持表述会确定性删除并在 Slack 提醒，草稿继续创建；核心型号、主要前提或来源冲突才暂停询问。公众号正文不放引用脚标或来源链接，系统根据证据矩阵确定性追加唯一、左对齐的“引用链接”板块，精选最多 5 个实际采用的来源。

## 发布前处理

### 固定模板契约

所有由 Bot 创建的真实草稿都必须沿用中央登记的固定模板。`src/lib/draft-template.js` 是唯一模板注册表：微信公众号草稿固定为 `zen-wechat/zen-trading@3`，Customer.io Newsletter 草稿固定为 `zen-customerio/zen-research@1`。真实渠道未登记模板、模板 ID 不匹配或未声明锁定时，会在调用发布接口前失败；任务文字、工作流和单次运行都不能指定另一套模板。`mock` 只用于 dry-run，不属于真实草稿渠道。

需要改版时，必须集中修改模板实现、升级注册表中的版本号，并同步渠道测试、渲染 golden 与本文档；不能在单个任务里绕过。标题、正文、链接、期号和受众等内容进入模板预留槽位，不改变模板本身。

`src/channels/wechat-draft.js` 按固定顺序执行：

1. 检查 title、疑似密钥、本地路径和格式警告。
2. 判断原创文章中 Markdown 表格的移动端可读性：紧凑五列表直接保留；不可读宽表固定首列、每组三个指标自动拆成多个窄表，再执行最终门禁。直译表格已经是原文 PNG，不进入这一步的表格重排。
3. 在 Markdown 开头注入 `assets/zen-header-banner.gif`。
4. 用 OpenRouter 提取封面字段，再由仓库内置 `tools/cover-generator` 把标题与副标题渲染到固定白底 `assets/zen-cover-background.png` 上，输出与底图一致的 900×383 封面；只有替换实现时才需设置 `COVER_GENERATOR_DIR`。浏览器优先读取 `COVER_BROWSER_EXECUTABLE`，否则复用直译浏览器配置并自动发现常见 Chromium/Chrome 路径。
5. 用 `@wenyan-md/core` 和仓库内固定的 `assets/zen-trading.css` 完成正文渲染；不依赖服务器用户目录中预装的 Wenyan 主题。最终 HTML 会把引用块和“原文信息”块归一为正文字号，并在上传前拦截非标题大字号及重复“原文信息”板块。
6. 在最终 HTML 最后追加带四个二维码的固定封底 `assets/zen-footer-qr.png`，并断言其后没有文字或其它节点，再上传微信草稿箱。可通过 `WECHAT_FOOTER_IMAGE` 覆盖为其他封底。

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
