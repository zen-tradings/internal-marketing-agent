# Zen Content Hub

单实例运行的 Slack 内容编排服务：生成微信公众号或 Customer.io Newsletter 草稿，程序绝不直接发送或排期。开发环境支持 macOS，生产环境支持由 systemd 管理的 Linux 主机。

## 开发与验证

- 需要 Node.js 22+；首次运行 `npm ci`，复制 `.env.example` 为 `.env` 并填写凭据。
- 提交前运行 `npm run check`；它包含语法检查、完整离线测试和高危依赖审计。
- 真实连接检查会访问外部服务，按需运行 `npm run check:openrouter`、`npm run check:egress`、`npm run check:documents` 或 `npm run check:customerio`。
- 开发演练使用 `HUB_DRY_RUN=1 npm start`。不要同时运行 launchd、systemd 或手动实例，避免重复消费 Slack 消息。

## 结构与硬约束

- `src/index.js` 装配 Slack、队列、工作流和渠道；`src/core/` 存放队列、SQLite、写作和通知。
- `src/workflows/` 定义任务；`src/channels/` 只创建草稿；`src/lib/` 放门禁、渲染和网络保护；环境变量由 `src/config/index.js` 统一解析并在启动时校验。
- 每个任务只能写入自己的工作流隔离目录 `WORK_DIR/<workflow>/runs/<readable-run-id>-<hash>/`（`wechat` 直接以 `WORK_DIR` 为工作流基目录），不得复用全局 `article.md` 或 checkpoint；路径必须由 `runWorkDir()` 计算，不能手拼。
- 外部文章、PDF、图片等不可信 URL 必须通过 `safeFetchResource()`：禁止私网地址，逐跳校验重定向，并限制单文件与任务总下载量。
- Slack 私有附件要求 App 的 Bot Token Scopes 包含 `files:read` 并在改 scope 后重新安装；PDF 必须在进入 Poppler 或 Datalab 前验证真实 `%PDF-` 文件签名，Slack 登录 HTML 不得按扩展名误判为 PDF。
- 微信分析 V2 的搜索计划必须同时包含中文和英文查询；同一证据层级优先英文来源或任何语言的独立第三方机构。政府资助、国家所有和公共广播媒体不得作为搜索证据或最终引用，但监管机构、交易所和统计部门的原始文件仍可作为一手证据；用户主动提供的受限媒体只作上下文。
- 直译路径只处理第一个链接，并严格遵守用户指定的页码或章节范围；翻译标题、正文、列表、图注和表题，保留原图、公式、代码、引文编号与参考文献结构，原文表格必须栅格化为图片而不是重新排版，不得追加原文没有的分析。
- 直译的明确数字与不可变 token 差异最多局部修复两轮；仍不等价时保留最佳完整译文并在 Slack/trace 标记人工复核。缺块、重复、未翻译、乱序、图表/公式/资产损坏仍必须硬失败。
- 四个 V2 分析流的事实审计只有高置信度问题可自动局部修改；低风险非核心、中低置信度、用户明确前提和已标注推断保留待复核。模型新增的核心/高风险无支持事实才删除或证据化替换，核心删句必须尝试一次局部补写。
- 微信允许原文自带或原始 Prompt 明确要求的代码/ASCII 图；独立四空格代码规范为 `text` 围栏，未授权代码只提醒。密钥、本地路径、危险 HTML 与固定尾图顺序仍是硬门禁。
- 发布成功以渠道返回的 `media_id` 为准；Slack 通知是 best-effort，通知失败不得把已创建的草稿改记为失败。
- 所有真实草稿渠道必须在 `src/lib/draft-template.js` 登记固定模板，并暴露完全匹配的 `templateId` 与 `templateLocked: true`；任务输入和工作流不得临时覆盖模板。改版时必须升级模板版本并同步渲染测试与文档。
- 保持微信公众号与 Newsletter 的“只创建草稿”边界、Slack 允许名单和渲染 golden 测试约束。不得新增公网 IP 白名单、出口 IP 校验或因代理环境变量阻止启动/发布的门禁。
- 不提交 `.env`、凭据、任务数据库或生成内容。修改环境变量时同步 `.env.example`；改变用户流程、渠道或运维方式时同步 README 或 `docs/`。

## 运维边界

- 生产建议 `MAX_CONCURRENCY=1`、设置 `MAX_QUEUE_SIZE`，并只运行一个进程。
- Slack 生产环境应配置 `SLACK_ALLOWED_USER_IDS` 和 `SLACK_ALLOWED_CHANNEL_IDS`。
- 代码或 `.env` 不会自动热加载；必须先完成检查，再由维护者明确重启对应的 launchd 或 systemd 服务。
- 失败直译只能用 `npm run requeue:translation -- <数据库 run-id>` 受限恢复；不得手改 SQLite 状态。命令必须拒绝无 checkpoint、非直译任务和已有 `media_id` 的任务。旧代码块门禁误拦截的 V2 分析只能用 `npm run requeue:analysis-gate -- <数据库 run-id>` 恢复，并拒绝非四类分析、非旧 `failed/gate`、无有效 Slack 通知或已有 `media_id` 的任务。两个命令都只重新入队，再重启唯一实例。
- DigitalOcean 的 `/opt/zen-content-hub` 是带 `.deploy-commit` 的现役不可变发布目录，不保证含 `.git`；先在独立 release 目录安装并验证，再单实例切换，旧目录保留为显式 rollback。
- Linux/DigitalOcean 部署、备份与健康检查见 `deploy/README.md`。
