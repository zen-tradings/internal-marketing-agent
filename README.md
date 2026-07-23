# Zen Content Hub

单实例常驻的双渠道内容编排服务：在 Slack 中用自然语言布置任务，自动路由到微信公众号草稿箱或 Customer.io Newsletter 草稿。支持 macOS 本机开发，也支持在 Linux/DigitalOcean 上由 systemd 7×24 小时管理。

## Pipeline

```text
Slack 私聊自然语言 / 频道 @Bot / cron
  → 持久化事件去重、SQLite 入队、限流与限并发处理
  → 直译：直接抓 HTML/PDF、逐页分块翻译与完整性门禁
  → 原创：用户链接 + 官方一手 + 优先信源 + 开放交叉验证
  → 事实审查与引用门禁
  → 中央模板门禁 → 微信固定版式 / Customer.io Newsletter 固定模板
  → 只创建草稿，不发送、不排期
  → Slack best-effort 回报；通知失败不改变草稿结果
```

Node.js 负责流程控制；运行时模型由 `.env` 的 `OPENROUTER_MODEL` 指定。正文默认关闭 reasoning，并由 `OPENROUTER_MAX_TOKENS` 明确控制输出预算，避免推理 token 吃掉文章内容。Exa 只负责检索与正文抓取。

## 目录

```text
src/
├── index.js                 服务入口与依赖装配
├── config/index.js          环境变量配置
├── core/                    队列、SQLite、调研写作、通知
├── triggers/                Slack 与 cron 触发器
├── workflows/               文章类型、提示词、优先信源
├── channels/                微信草稿与 mock 渠道
└── lib/                     门禁、固定图片、封面、渲染输入

scripts/
├── install-launchd.sh       安装本机常驻服务
├── uninstall-launchd.sh     卸载本机常驻服务
├── status.mjs               查看任务状态
├── research-trace.mjs       查看 Exa 查询与命中来源
├── check-openrouter.mjs     检查 OpenRouter 配置
├── check-egress.mjs         只读检查各外部 API 的网络可达性
├── check-translation-text.mjs 生成纯正文文字直译本地验收稿
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

`RUN_RETENTION_DAYS` 控制终态任务记录及其独立运行目录的保留天数，`SLACK_THREAD_RETENTION_DAYS` 控制线程上下文和事件去重记录；清理在启动时执行。调整为更短期限前先备份数据库和 `/var/lib/zen-content-hub`。

查看实时 Exa 调用和最近一次 company 调研轨迹：

```bash
tail -f ~/Library/Logs/zen-content-hub/out.log
npm run trace:research -- company
```

## Slack 自然语言入口

私聊 Bot 时直接像和 AI 对话一样输入任务即可；公共频道必须 `@Bot`，避免误收普通聊天。`NODE_ENV=production` 时必须通过 `SLACK_ALLOWED_USER_IDS` 和 `SLACK_ALLOWED_CHANNEL_IDS` 限定调用者，并用 `SLACK_RATE_LIMIT_PER_MINUTE` 限流。Slack 事件先持久化去重，再入队；重连或重启不会重复接收同一个 event。显式前缀继续保留，但只是兼容快捷方式。链接只表示用户指定的一级优先研究素材，不自动触发直译；只有明确说“直译、完整翻译、全文翻译”等才走完整直译。裸链接和未明确类型的任务默认微信公众号分析，提到 Newsletter、订阅者、邮件或 Customer.io 时路由到 Customer.io。同一 Slack 线程会继承上一任务，可直接说“换标题”“补充这组数据”。

## 工作流

| ID | Slack 前缀 | 用途 |
|---|---|---|
| `wechat` | `wechat:`、`微信：`、无前缀 | 通用公众号文章 |
| `earnings` | `earnings:`、`财报：` | 财报预期与复盘，执行标准四路调研，含官方/一手来源深度发现 |
| `sector` | `sector:`、`行业：` | 行业综述 |
| `morning` | `morning:`、`晨报：` | 24–48 小时晨报 |
| `translate` | `translate:`、`直译：`、`翻译：` | 只提取并忠实翻译第一个用户链接的正文文字 |
| `company` | `company:`、`公司：`、`个股：`、`深度：` | 公司深度分析、历史季度趋势、竞争与产业链，并追加三组专项深搜 |
| `email` | `email:`、`邮件：` | 生成带 Vol. 版号的 newsletter，并在 Customer.io 创建待审核草稿 |

这些内部工作流由规则优先、模型兜底的自然语言路由隐藏。原创研究型任务都会运行开放检索、优先信源检索、限定官方域名检索，以及 `official-discovery` 官方/一手来源深度发现；`company` 另有季度财报、官方披露和产业链三组专项深搜。`morning` 设置 `MORNING_CRON` 后会增加定时触发。`OPENROUTER_ROUTER_MODEL` 和 `OPENROUTER_REVIEW_MODEL` 可分别覆盖路由与事实审查模型。

直译只有一条固定的纯正文文字链路。HTML 先移除图片、图题、表格、表题、代码块、导航、广告、推荐内容和参考文献，再由 Readability 提取正文；必要时用 Chrome 获取动态页面。Notion 配置 `NOTION_API_TOKEN` 后优先读取官方 Markdown，PDF 只通过 Poppler 提取正文文字并过滤图表标题和明显的列式数据。程序按稳定 block ID 翻译标题、段落、小标题和列表，模型漏块、改动数字/URL，或重新生成图片、表格时都会拒绝产稿。用户即使要求保留图表或追加分析，直译路径也只输出第一个链接的正文文字译文。

所有文章、PDF 和重定向都逐跳拒绝内网地址，并受原文大小、PDF 页数和重定向次数限制。首次配置新来源、浏览器或 Notion 时，应先执行 `HUB_DRY_RUN=1` 的真实链接验收；配置示例见 `.env.example`。

也可以绕过 Slack 只生成一篇本地验收稿；该命令会产生 OpenRouter 调用，但不会调用微信接口：

```bash
npm run check:translation-text -- https://example.com/article
```

原创分析默认官方来源优先。用户在 Slack 提供的链接会全文抓取并与官方/一手来源、既定优先信源一起进入第一优先层，但不会被误算为官方来源；关键结论仍需交叉验证。公司/财报任务要求官网、IR、SEC/交易所、证监会或官方业绩材料。法律案件改用案号和案名驱动的独立检索，优先案卷、诉状、裁定、监管材料和精确匹配案件的可靠报道，不再套用公司分析域名清单。公众号正文不放引用脚标或来源链接，文末精选 1–5 个最相关链接；Wenyan 最终只保留一个左对齐的“引用链接”板块。原创公众号工作流每个主要章节都用固定浅蓝底纹样式克制地高亮 1–2 个核心观点或关键词；直译只做正文文字的忠实翻译。

## 发布前处理

### 固定模板契约

所有由 Bot 创建的真实草稿都必须沿用中央登记的固定模板。`src/lib/draft-template.js` 是唯一模板注册表：微信公众号草稿固定为 `zen-wechat/zen-trading@1`，Customer.io Newsletter 草稿固定为 `zen-customerio/zen-research@1`。真实渠道未登记模板、模板 ID 不匹配或未声明锁定时，会在调用发布接口前失败；任务文字、工作流和单次运行都不能指定另一套模板。`mock` 只用于 dry-run，不属于真实草稿渠道。

需要改版时，必须集中修改模板实现、升级注册表中的版本号，并同步渠道测试、渲染 golden 与本文档；不能在单个任务里绕过。标题、正文、链接、期号和受众等内容进入模板预留槽位，不改变模板本身。

`src/channels/wechat-draft.js` 按固定顺序执行：

1. 检查 title、疑似密钥、本地路径和格式警告。
2. 判断表格的移动端可读性：紧凑五列表直接保留；不可读宽表固定首列、每组三个指标自动拆成多个窄表，再执行最终门禁。
3. 在 Markdown 开头注入 `assets/zen-header-banner.gif`。
4. 用 OpenRouter 提取封面字段，再由仓库内置 `tools/cover-generator` 渲染封面；只有替换实现时才需设置 `COVER_GENERATOR_DIR`。浏览器优先读取 `COVER_BROWSER_EXECUTABLE`，否则复用直译浏览器配置并自动发现常见 Chromium/Chrome 路径。
5. 用 `@wenyan-md/core` 和仓库内固定的 `assets/zen-trading.css` 完成正文渲染；不依赖服务器用户目录中预装的 Wenyan 主题。
6. 在最终 HTML 最后追加默认封底底图 `assets/zen-footer-background.png`，并断言其后没有文字或其它节点，再上传微信草稿箱。可通过 `WECHAT_FOOTER_IMAGE` 覆盖为其他封底。

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

Newsletter 会先区分内容类型：市场、行业、公司、财报与数据分析属于研究型，继续执行官方来源、引用和事实审查门禁；首封问候、用户需求收集、Agent/产品介绍、通知公告、邀请与功能更新属于关系/通知型，只依据用户材料写作，不做无意义的市场搜索，也不要求官方引用。若任务同时明确要求官方数据或市场分析，研究型门禁优先。

用 `npm run check:customerio` 只读检查三个阶段的实时人数、当前草稿和缺失配置。

完整的分批试发、审核与扩容步骤见 [`docs/NEWSLETTER_ROLLOUT.md`](docs/NEWSLETTER_ROLLOUT.md)。
