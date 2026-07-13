# Zen Content Hub

本机常驻的内容编排服务：Slack 或 cron 触发任务，Exa 调研，OpenRouter 写作，生成 `article.md`，渲染到微信公众号草稿箱，并把结果回报到 Slack。

## Pipeline

```text
Slack / cron
  → SQLite 入队与限并发处理
  → Exa 抓取用户链接 + 优先信源搜索 + 开放搜索
  → OpenRouter 生成 Markdown
  → 内容门禁 + 固定头尾图 + 封面
  → 微信草稿箱
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
└── update-render-golden.mjs 更新渲染基准
```

更详细的代码导航见 [`docs/GUIDE.md`](docs/GUIDE.md)。

## 安装与配置

要求 Node.js 22 或更高版本，并准备 OpenRouter、Exa、Slack 和微信公众号凭据。

```bash
npm ci
cp .env.example .env
```

填写 `.env` 后先检查：

```bash
npm test
npm run check:openrouter
```

主进程必须直连 OpenRouter、Exa 和微信 API。检测到 `HTTP_PROXY`、`HTTPS_PROXY` 或 `ALL_PROXY` 时，服务会拒绝启动，避免微信出口 IP 被代理污染。

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

## 工作流

| ID | Slack 前缀 | 用途 |
|---|---|---|
| `wechat` | `wechat:`、`微信：`、无前缀 | 通用公众号文章 |
| `earnings` | `earnings:`、`财报：` | 财报分析 |
| `sector` | `sector:`、`行业：` | 行业综述 |
| `morning` | `morning:`、`晨报：` | 24–48 小时晨报 |
| `translate` | `translate:`、`直译：`、`翻译：` | 忠实翻译第一个用户链接 |
| `company` | `company:`、`公司：`、`个股：`、`深度：` | 公司深度分析、历史季度趋势、竞争与产业链 |
| `email` | `email:`、`邮件：` | 生成带 Vol. 版号的 newsletter，并在 Customer.io 创建待审核草稿 |

同时包含财务、竞争对手和上下游要求的任务会自动路由到 `company`。`morning` 设置 `MORNING_CRON` 后会增加定时触发。各工作流目前共用 `OPENROUTER_MODEL`，但可在 workflow 的 `model` 属性覆盖。

## 发布前处理

`src/channels/wechat-draft.js` 按固定顺序执行：

1. 检查 title、疑似密钥、本地路径和格式警告。
2. 注入 `assets/zen-header-banner.gif` 与 `assets/zen-footer-qr.png`。
3. 用 OpenRouter 提取封面字段，再由 `~/zen-push-image` 渲染封面。
4. 用 `@wenyan-md/core` 渲染并上传微信草稿箱。

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

`email:` 工作流默认只调用 Customer.io App API 创建 newsletter 草稿，不设置 `send_now` 或 `scheduled_at`。受众通过 `NEWSLETTER_AUDIENCE_STAGE=internal|pilot|full` 分阶段扩容：内部组是 `Newsletter · Internal Beta`（ID `17`），Pilot 组是 `Newsletter · Pilot`（ID `18`），全量候选组是 `Valid Email Address`（ID `6`）。Bot 会先读取 segment 实时人数并执行阶段人数门禁；`full` 还必须显式设置 `CUSTOMERIO_ALLOW_FULL_AUDIENCE=true`。全量发送前仍需在 Customer.io 复核订阅偏好与预计人数。

用 `npm run check:customerio` 只读检查三个阶段的实时人数、当前草稿和缺失配置。

完整的分批试发、审核与扩容步骤见 [`docs/NEWSLETTER_ROLLOUT.md`](docs/NEWSLETTER_ROLLOUT.md)。
