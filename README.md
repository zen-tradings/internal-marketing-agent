# Zen Content Hub

本机常驻的双渠道内容编排服务：在 Slack 中用自然语言布置任务，自动路由到微信公众号草稿箱或 Customer.io Newsletter 草稿。

## Pipeline

```text
Slack 私聊自然语言 / 频道 @Bot / cron
  → SQLite 入队与限并发处理
  → 直译：直接抓 HTML/PDF、逐页分块翻译与完整性门禁
  → 原创：用户链接 + 官方一手 + 优先信源 + 开放交叉验证
  → 事实审查与引用门禁
  → 微信固定版式 / Customer.io Newsletter 模板
  → 只创建草稿，不发送、不排期
  → Slack 回报
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
├── check-egress.mjs         检查固定出口与各发布 API 的可达性
├── check-translation-v2.mjs 生成直译 V2 本地验收稿
├── preview-newsletter.mjs   生成 Newsletter 本地 HTML 预览
└── update-render-golden.mjs 更新渲染基准
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
npm test
npm run check:openrouter
```

主进程不使用 `HTTP_PROXY`、`HTTPS_PROXY` 或 `ALL_PROXY` 等应用层代理变量；本机需要由 Clash TUN 在网络层统一接管。设置 `EGRESS_GUARD_ENABLED=true` 和 `EXPECTED_EGRESS_IP=<静态出口 IP>` 后，服务会在启动、每个任务及微信发布前核对公网出口。需要允许多个出口时，在 `EXPECTED_EGRESS_IPS` 中用英文逗号分隔追加，原有 `EXPECTED_EGRESS_IP` 会一并保留在白名单中。出口不匹配时停止联网。运行期间还会定时复检；连续失败达到 `EGRESS_MONITOR_FAILURE_THRESHOLD` 后进程退出，由 launchd 重启并等待允许的出口恢复。

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

查看实时 Exa 调用和最近一次 company 调研轨迹：

```bash
tail -f ~/Library/Logs/zen-content-hub/out.log
npm run trace:research -- company
```

## Slack 自然语言入口

私聊 Bot 时直接像和 AI 对话一样输入任务即可；公共频道必须 `@Bot`，避免误收普通聊天。显式前缀继续保留，但只是兼容快捷方式。链接只表示用户指定的一级优先研究素材，不自动触发直译；只有明确说“直译、完整翻译、全文翻译”等才走完整直译。裸链接和未明确类型的任务默认微信公众号分析，提到 Newsletter、订阅者、邮件或 Customer.io 时路由到 Customer.io。同一 Slack 线程会继承上一任务，可直接说“换标题”“补充这组数据”。

## 工作流

| ID | Slack 前缀 | 用途 |
|---|---|---|
| `wechat` | `wechat:`、`微信：`、无前缀 | 通用公众号文章 |
| `earnings` | `earnings:`、`财报：` | 财报分析 |
| `sector` | `sector:`、`行业：` | 行业综述 |
| `morning` | `morning:`、`晨报：` | 24–48 小时晨报 |
| `translate` | `translate:`、`直译：`、`翻译：` | 忠实翻译第一个用户链接；可在译文后追加原文依据分析 |
| `company` | `company:`、`公司：`、`个股：`、`深度：` | 公司深度分析、历史季度趋势、竞争与产业链 |
| `email` | `email:`、`邮件：` | 生成带 Vol. 版号的 newsletter，并在 Customer.io 创建待审核草稿 |

这些内部工作流由规则优先、模型兜底的自然语言路由隐藏。`morning` 设置 `MORNING_CRON` 后会增加定时触发。`OPENROUTER_ROUTER_MODEL` 和 `OPENROUTER_REVIEW_MODEL` 可分别覆盖路由与事实审查模型。

直译 V2 用 `TRANSLATION_V2_ENABLED=true` 渐进启用。它先把网页转换成带稳定 block ID 的 `SourceDocument`，再只让模型翻译标题、段落、列表、图题和表格单元格，最终由程序按原 ID 顺序重组 Markdown。静态网页先用 Readability 识别正文；正文过短、含懒加载或 Canvas/SVG 时回退本机 Chrome；Notion 页面配置 `NOTION_API_TOKEN` 后优先读取官方整页 Markdown；复杂 PDF 可配置 `TRANSLATION_DOCLING_PATH`，否则继续使用 Poppler 严格路径。图片下载失败、表格尺寸变化、block 缺失、数字/URL 改变、最终 HTML 乱码或本地图片损坏时拒绝创建草稿，不回退旧链发布不完整内容。

V2 默认关闭，先执行 `HUB_DRY_RUN=1` 的真实链接验收。配置示例和抓取大小、超时、浏览器路径、Notion、Docling 开关见 `.env.example`。复合任务中的“翻译后分析”和“纯文字直译”暂时继续走原有专用路径，保持已有行为与断点兼容。

也可以绕过 Slack 只生成一篇本地验收稿；该命令会产生 OpenRouter 调用，但不会调用微信接口：

```bash
npm run check:translation-v2 -- https://example.com/article
```

原创分析默认官方来源优先。用户在 Slack 提供的链接会全文抓取并与官方/一手来源、既定优先信源一起进入第一优先层，但不会被误算为官方来源；关键结论仍需交叉验证。公司/财报任务要求官网、IR、SEC/交易所、证监会或官方业绩材料。法律案件改用案号和案名驱动的独立检索，优先案卷、诉状、裁定、监管材料和精确匹配案件的可靠报道，不再套用公司分析域名清单。公众号正文不放引用脚标或来源链接，文末精选 1–5 个最相关链接；Wenyan 最终只保留一个左对齐的“引用链接”板块。所有公众号工作流每个主要章节都用固定浅蓝底纹样式克制地高亮 1–2 个核心观点或关键词，直译不改变原文措辞与顺序。

## 发布前处理

`src/channels/wechat-draft.js` 按固定顺序执行：

1. 检查 title、疑似密钥、本地路径和格式警告。
2. 判断表格的移动端可读性：紧凑五列表直接保留；不可读宽表固定首列、每组三个指标自动拆成多个窄表，再执行最终门禁。
3. 在 Markdown 开头注入 `assets/zen-header-banner.gif`。
4. 用 OpenRouter 提取封面字段，再由 `~/zen-push-image` 渲染封面。
5. 用 `@wenyan-md/core` 的 `zen-trading` 主题完成正文和脚注渲染。
6. 在最终 HTML 最后追加四二维码 `assets/zen-footer-qr.png`，并断言其后没有文字或其它节点，再上传微信草稿箱。

封面字段提取失败会回退到模板示例数据；封面文件生成失败会阻止发布。

## 测试

```bash
npm test
```

测试全部使用桩或内存数据，不需要真实网络凭据。渲染输出由 golden 测试锁定；只有确认渲染变化符合预期时才执行：

```bash
npm run test:update-golden
```

## 扩展

- 新文章类型：新增 `src/workflows/<name>.js`，并在 `src/index.js` 注册。
- 新发布渠道：新增实现 `publish()` 的 `src/channels/<name>.js`，并在 `src/index.js` 注册。
- 新定时任务：在 workflow 的 `triggers` 中声明 `cron:<表达式>`。

保持 `runWriter()` 的 `article.md` 契约和发布后立即写入 `media_id` 的幂等行为。

### Customer.io newsletter

Newsletter 工作流使用 Customer.io App API 创建名为 `Zen Research from Zen Trading · Vol. N` 的 Newsletter Broadcast 草稿，不设置 `send_now` 或 `scheduled_at`。受众通过 `NEWSLETTER_AUDIENCE_STAGE=internal|pilot|full` 分阶段扩容：内部组是 `Newsletter · Internal Beta`（ID `17`），Pilot 组是 `Newsletter · Pilot`（ID `18`），全量候选组是 `Valid Email Address`（ID `6`）。Bot 会先读取 segment 实时人数并执行阶段人数门禁；`full` 还必须显式设置 `CUSTOMERIO_ALLOW_FULL_AUDIENCE=true`。

所有后续 Customer.io Newsletter 的可见发件人统一为 `Zen Trading <support@zentradings.com>`。渠道和只读检查脚本都会拒绝其他 From 地址，避免配置漂移。

邮件末尾始终提供满意/不满意两个链接。配置 `CUSTOMERIO_NEWSLETTER_FEEDBACK_URL` 时附加 `rating` 和 `edition` 参数；未配置时退化为联系邮箱的预填 `mailto:`。Customer.io MCP 不在核心发布链中，避免给自动任务增加发送权限面。

Newsletter 会先区分内容类型：市场、行业、公司、财报与数据分析属于研究型，继续执行官方来源、引用和事实审查门禁；首封问候、用户需求收集、Agent/产品介绍、通知公告、邀请与功能更新属于关系/通知型，只依据用户材料写作，不做无意义的市场搜索，也不要求官方引用。若任务同时明确要求官方数据或市场分析，研究型门禁优先。

用 `npm run check:customerio` 只读检查三个阶段的实时人数、当前草稿和缺失配置。

完整的分批试发、审核与扩容步骤见 [`docs/NEWSLETTER_ROLLOUT.md`](docs/NEWSLETTER_ROLLOUT.md)。
