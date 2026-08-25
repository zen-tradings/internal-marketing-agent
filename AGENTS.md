# Zen Content Hub

单实例运行的 Slack 内容编排服务：常规任务生成微信公众号或 Customer.io Newsletter 草稿；`opening-digest` 是受控例外，会按独立受众发送或排期，并仅在正式 cron 的邮件成功后派生 Discord 投递。开发环境支持 macOS，生产环境支持由 systemd 管理的 Linux 主机。

## 开发与验证

- 需要 Node.js 22+；首次运行 `npm ci`，复制 `.env.example` 为 `.env` 并填写凭据。
- 提交前运行 `npm run check`；它包含语法检查、完整离线测试和高危依赖审计。
- 真实连接检查会访问外部服务，按需运行 `npm run check:openrouter`、`npm run check:egress`、`npm run check:documents` 或 `npm run check:customerio`。`check:documents` 可验收私有 Notion、Google Docs 和 Linear Issue。
- 开发演练使用 `HUB_DRY_RUN=1 npm start`。不要同时运行 launchd、systemd 或手动实例，避免重复消费 Slack 消息。

## 结构与硬约束

- `src/index.js` 装配 Slack、队列、工作流和渠道；`src/core/` 存放队列、SQLite、写作和通知。
- `src/workflows/` 定义任务；常规 `src/channels/` 只创建草稿，`customerio-opening-digest.js` 是受控发送/排期例外；`src/lib/` 放门禁、渲染和网络保护；环境变量由 `src/config/index.js` 统一解析并在启动时校验。
- 每个任务只能写入自己的工作流隔离目录 `WORK_DIR/<workflow>/runs/<readable-run-id>-<hash>/`（`wechat` 直接以 `WORK_DIR` 为工作流基目录），不得复用全局 `article.md` 或 checkpoint；路径必须由 `runWorkDir()` 计算，不能手拼。
- 外部文章、PDF、图片等不可信 URL 必须通过 `safeFetchResource()`：禁止私网地址，逐跳校验重定向，并限制单文件与任务总下载量。认证后的 Notion/Linear 只解析允许名单 URL 再打固定官方 API，不得先抓浏览器页；仅 `uploads.linear.app` 可跳过本机 Fake-IP DNS pinning，跨域重定向仍必须剥掉 Authorization。
- 分析型公开网页/PDF 直读失败时只能依次使用精确缓存、URL 语义检索和已登记的官方镜像恢复；镜像仍必须通过 `safeFetchResource()`，并同时校验发布机构、文号和文件主题。无法证明是同一文件时不得把补充报道冒充用户原文或据此生成原文摘要。用户提供的私有 Notion、Google Docs 或 Linear Issue 读失败必须整单硬失败，禁止 Exa 缓存、语义检索或浏览器回退。
- Slack 私有附件要求 App 的 Bot Token Scopes 包含 `files:read` 并在改 scope 后重新安装；PDF 必须在进入 Poppler 或 Datalab 前验证真实 `%PDF-` 文件签名，Slack 登录 HTML 不得按扩展名误判为 PDF。
- PDF 直译不得把 Datalab 的并列 `.page[data-page-id]` 交给网页 Readability 选择器；请求页数、连续页 ID、有效质量分、Datalab 图片引用和 Poppler 文本覆盖必须在翻译前通过硬门禁，不能依据 Datalab 的 `page_count` 单字段宣称完整。
- 微信分析 V2 的搜索计划必须同时包含中文和英文查询；同一证据层级优先英文来源或任何语言的独立第三方机构。政府资助、国家所有和公共广播媒体不得作为搜索证据或最终引用，但监管机构、交易所和统计部门的原始文件仍可作为一手证据；用户主动提供的受限媒体只作上下文。
- 直译路径只处理第一个链接，并严格遵守用户指定的页码或章节范围；翻译标题、正文、列表、图注和表题，保留原图、公式、代码、引文编号与参考文献结构，原文表格必须栅格化为图片而不是重新排版，不得追加原文没有的分析。
- 直译的明确数字与不可变 token 差异最多局部修复两轮；仍不等价时保留最佳完整译文并在 Slack/trace 标记人工复核。疑似未翻译检测必须先遮蔽不可变 token，纯公式或引用占位符块不能因 marker 名称被当成英文正文。缺块、重复、未翻译、乱序、图表/公式/资产损坏仍必须硬失败。
- 五个 V2 分析流（`wechat`、`sector`、`company`、`earnings`、`macro`）的事实审计只有高置信度问题可自动局部修改；低风险非核心、中低置信度、用户明确前提和已标注推断保留待复核。模型新增的核心/高风险无支持事实才删除或证据化替换，核心删句必须尝试一次局部补写。
- 微信允许原文自带或原始 Prompt 明确要求的代码/ASCII 图；独立四空格代码规范为 `text` 围栏，未授权代码只提醒。密钥、本地路径、危险 HTML 与固定尾图顺序仍是硬门禁。
- 发布成功以渠道返回的 `media_id` 为准；进度和 warning 是 best-effort，终态通知与 QDII 核心回复在 Slack 不可用时必须写入 SQLite outbox 并在连接恢复后按当前任务状态补发；通知失败不得把已创建的草稿改记为失败。
- 所有真实草稿渠道必须在 `src/lib/draft-template.js` 登记固定模板，并暴露完全匹配的 `templateId` 与 `templateLocked: true`；任务输入和工作流不得临时覆盖模板。改版时必须升级模板版本并同步渲染测试与文档。
- 保持微信公众号与常规 Newsletter 的“只创建草稿”边界；`opening-digest` 仅可使用受保护的独立受众并通过现有门禁发送/排期；继续遵守 Slack 允许名单和渲染 golden 测试约束。不得新增公网 IP 白名单、出口 IP 校验或因代理环境变量阻止启动/发布的门禁。
- `opening-digest` 的内容格式/新鲜度、部分行情、OIC、封面、受众人数和预检异常属于可发送降级，只写 `research-trace.json`，不得发 Slack warning。受控例外是邮件成功后的派生渠道：显式启用的微信同步和仅正式 cron 的 Discord 持久 outbox 都复用冻结 payload；人工 TEST 永不进入 Discord。微信草稿创建失败、第三次回读仍不一致或无法回读，以及 Discord 终态投递失败时，邮件任务仍保持 `done`，并发送精确的 best-effort Slack warning；只有明确的硬门禁、严重事实问题修复耗尽或 Customer.io 邮件的客观发送失败才发送 Slack failure。正文退订标签必须本地移除，Customer.io layout 唯一负责法定退订链接，不得恢复 `/contents` 读回门禁。
- 不提交 `.env`、凭据、任务数据库或生成内容。修改环境变量时同步 `.env.example`；改变用户流程、渠道或运维方式时同步 README 或 `docs/`。

## 运维边界

- 生产必须设置 `MAX_QUEUE_SIZE` 并只运行一个进程；当前 1 vCPU/2GB 主机使用 `MAX_CONCURRENCY=2`，且不得超过 2；资源门禁保持浏览器/微信写入/Customer.io 写入各 1、OpenRouter 2、Exa Search 8 QPS，不得通过第二实例扩大并发。
- Slack 生产环境应配置 `SLACK_ALLOWED_USER_IDS` 和 `SLACK_ALLOWED_CHANNEL_IDS`。
- 代码或 `.env` 不会自动热加载；必须先完成检查，再由维护者明确重启对应的 launchd 或 systemd 服务。
- 失败直译只能用 `npm run requeue:translation -- <数据库 run-id>` 受限恢复；不得手改 SQLite 状态。命令必须拒绝无 checkpoint、非直译任务和已有 `media_id` 的任务。旧代码块门禁或代码安全渲染兼容误拦截的 V2 分析只能用 `npm run requeue:analysis-gate -- <数据库 run-id>` 恢复，并拒绝非四类分析、非精确白名单错误、无有效 Slack 通知或已有 `media_id` 的任务。两个命令都只重新入队，再重启唯一实例。
- DigitalOcean 的 `/opt/zen-content-hub` 是带 `.deploy-commit` 的现役不可变发布目录，不保证含 `.git`；先在独立 release 目录安装并验证，再单实例切换，旧目录保留为显式 rollback。
- 生产部署只能通过 `npm run deploy:digitalocean` 执行；目标必须来自 gitignored 的 `deploy/target.env`，并通过 DigitalOcean metadata 确认为 Droplet。禁止根据本机 SSH alias、历史 VPS 名或私网地址猜测生产主机。
- Linux/DigitalOcean 部署、备份与健康检查见 `deploy/README.md`。
