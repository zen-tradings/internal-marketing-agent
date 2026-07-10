# Zen Content Hub

常驻单进程的内容编排引擎：Slack（或 cron）触发一个写作任务 → 排队 → Exa 调研 + OpenRouter 开源模型写出 `article.md` → 渠道（channel）把文章渲染并发布出去 → 结果回报到 Slack。当前接入的渠道是微信公众号草稿箱；引擎本身与具体渠道/工作流解耦，方便后续接入邮件等其它工作流（见下文「扩展」一节）。

## 架构

```
触发器(triggers)         队列/编排(core)              工作流+渠道
┌────────────┐        ┌──────────────────┐        ┌───────────────────┐
│ slack.js   │──enqueue─▶ queue.js (限并发) │        │ workflows/wechat.js│
│ cron.js    │        │   ↓ handler       │──────▶ │  (prompt/渠道声明) │
└────────────┘        │ store.js (SQLite) │        └─────────┬──────────┘
                       │ runner.js         │                  │ publish()
                       │ (Exa+OpenRouter)  │        ┌─────────▼──────────┐
                       │ notifier.js       │        │ channels/          │
                       │  (Slack 回报)     │        │  mock.js (测试/干跑)│
                       └──────────────────┘        │  wechat-draft.js    │
                                                     │  (渲染+发布+名片)  │
                                                     └────────────────────┘
```

- **状态机**：每个任务落库为一行 `runs` 记录，状态在 `queued → running → done|failed`（异常重启后 `running` 会被标为 `interrupted`，见 `store.markInterrupted()`）之间流转，媒体 ID（`media_id`）一旦写入即视为「已发布过」，支撑重试/重启时的幂等（不会重复产生草稿）。
- **海外 VPS 直连**：部署目标是固定公网 IP 的海外 VPS，OpenRouter、Exa、微信 API、Slack 都走直连。`assertMainProcessDirect()` 会在检测到主进程带代理变量时拒绝启动，避免代理污染微信调用的出口 IP。
- **Exa 调研链路**：`runner.js` 并行跑两路 `/search`（优先信源路带 `includeDomains`，开放路不带），结果按 URL 去重合并，任一路失败会自动降级为只用另一路，两路都失败才报错；工作流（如 `workflows/wechat.js` 的 `research.prioritySources`）声明式配置优先信源域名，可用 `EXA_PRIORITY_DOMAINS`（逗号分隔）整体覆盖，`EXA_PRIORITY_RESULTS` 控制优先路返回条数（默认 4）。任务文本里贴的 http(s) URL（最多 5 个）会被直接摘出并调 Exa `/contents` 抓正文，作为最高优先级素材参与写作，抓取失败同样只降级不报错。

## 目录结构（`src/`）

```
src/
├── config/index.js       读 env + 默认值（OpenRouter/Exa/超时/并发/路径/密钥）
├── core/
│   ├── store.js           SQLite runs 表 CRUD（better-sqlite3）
│   ├── queue.js            限并发队列
│   ├── runner.js           Exa REST 调研 + OpenRouter chat completions 写作，校验 article.md 契约
│   └── notifier.js         Slack 回报（唯一往 Slack 发消息的地方）
├── triggers/
│   ├── slack.js            Socket Mode → enqueue
│   └── cron.js             node-cron → enqueue（定时任务，供子项目 B 复用）
├── workflows/
│   └── wechat.js           微信工作流声明式配置 + promptTemplate
├── channels/
│   ├── mock.js             假渠道，测试/dry-run 用
│   └── wechat-draft.js     renderAndPublish 渲染 + 封面 + 名片注入 + 发布草稿
├── lib/
│   ├── getInputContent.js  runner 要求的读文件函数
│   ├── wechatApi.js        直连微信 token / 素材 / 草稿箱接口
│   ├── cover.js            调 zen-push-image 生成封面
│   └── health.js           OpenRouter /models 探活（见 deploy/README.md）
└── index.js                装配入口：makeHandler + start()
```

`src/index.js` 导出了 `makeHandler({ store, runClaude, workflows, channels, config, notifier })`，把「一个任务从取出到落库」的完整处理逻辑封装成可注入依赖的纯函数。`runClaude` 是兼容旧测试和装配的依赖名，当前实际指向 OpenRouter runner；测试时可用桩（stub）替换 `store`/`runClaude`/`channels`/`notifier`，不需要真正连数据库/网络/微信。`start()` 用真实依赖组装并启动服务。

## 运行测试

```bash
npm test        # 等价于 node --test，跑 test/ 下全部 node:test 用例
```

测试全部是纯内存/桩依赖，不需要网络、不需要真实 OpenRouter/Exa/微信凭据。其中 `test/golden/render-parity.test.js` 会锁定 `@wenyan-md/core` 的渲染输出逐字符比对（parity 验收门），`test/e2e-dryrun.test.js` 是端到端装配测试：走真实 `createQueue` + `makeHandler`，用 `mock` 渠道和 stub `runClaude` 验证一个任务能正确入队、跑通、落 `done`。

## 本地干跑（dry-run）演练

不想真的发布到微信草稿箱，只想验证「触发 → 调研 → 渲染 → 发布 → 回报」全链路能跑通时，设置 `HUB_DRY_RUN`：

```bash
HUB_DRY_RUN=1 node src/index.js
```

设置后，无论 `workflows/*.js` 里 `channel` 字段声明的是什么渠道（例如 `wechat-draft`），实际发布都会被强制改道到 `channels/mock.js`（返回固定的 `mediaId: 'MOCK'`），既不会调用微信 API，也不会产生真实草稿；其它步骤（Slack 触发、排队、OpenRouter/Exa 真实调研写作、落库、Slack 回报）都按真实流程走。适合验证 `.env`/Slack 接线/写作链路是否正常，同时避免误发到公众号。

开关的实现点在 `src/index.js` 的 `makeHandler` 里选渠道那一步：

```js
const channelId = /^(1|true|yes|on)$/i.test(process.env.HUB_DRY_RUN || '') ? 'mock' : wf.channel;
const channel = channels[channelId];
```

## VS Code + Cline 本地真实链路运行

本仓库已包含 VS Code 工作区配置：

- `Run and Debug` 里选择 `Zen Content Hub: real pipeline`，会启动 `node src/index.js`。
- `Terminal > Run Task...` 里选择 `Zen: run real pipeline`，会先执行 `npm run check:openrouter`，通过后再执行 `npm start`。
- `Terminal > Run Task...` 里选择 `Zen: check OpenRouter auth`，会用项目 `.env` 探测 OpenRouter `/models` 和最小 completion。
- `Terminal > Run Task...` 里选择 `Zen: test`，会执行 `npm test`。
- `.vscode/extensions.json` 会推荐安装 Cline；Cline 已可用 OpenRouter 作为 provider，适合在 VS Code 里继续改代码、跑命令和检查这个 bot。

真实链路启动配置不会设置 `HUB_DRY_RUN`，因此 Slack 触发后会走 Exa 调研、OpenRouter 写作、微信公众号草稿箱发布和 Slack 回报。启动配置会显式清空 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` 等代理变量，以满足 `src/index.js` 的直连保护。

运行前确认项目根目录 `.env` 已填写这些变量：

```bash
OPENROUTER_API_KEY=
EXA_API_KEY=
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
WECHAT_APP_ID=
WECHAT_APP_SECRET=
```

Cline 自己的 OpenRouter key 在 VS Code 扩展设置里配置，不要写入仓库文件。打开 Cline 后选择 OpenRouter provider，填入 API key，再选择你想用于写代码的模型；这只影响 Cline，不影响本 bot 的运行时模型。本 bot 的运行时模型仍由 `.env` 里的 `OPENROUTER_MODEL` 控制。

如果 Slack 回报 `OpenRouter completion failed: 401 Unauthorized {"error":{"message":"User not found."...}}`，先在项目根目录运行：

```bash
npm run check:openrouter
```

若检查通过但 Slack 仍报 401，通常是旧的 bot 进程还在用旧环境变量。停止当前 VS Code task/debug 进程后重新启动真实链路。

这个项目还包含 `.clinerules/zen-content-hub.md`，Cline 会把它作为工作区规则读取。以后你在 Cline 里让它优化 pipeline 时，可以直接让它按这些规则先检查 `git status`、保护 `.env`、跑 `npm run check:openrouter` 和 `npm test`。

## 发布链路的确定性环节（2026-07-10 起）

`channels/wechat-draft.js` 的 `publish()` 在渲染发布前依次执行三个 Node 侧确定性步骤（与写作模型无关，GLM 等模型无需具备图片能力）：

1. **门禁**（`src/lib/gate.js`）：对模型产出的原文做规则检查。errors（缺 title、疑似密钥、本地路径泄漏）会拦截发布并 Slack 告警；warnings（破折号、美元符号、缺固定结尾板块）放行但提醒。
2. **固定头尾图注入**（`src/lib/assets.js`）：自动在正文开头插入 `assets/zen-header-banner.gif`、结尾插入 `assets/zen-footer-qr.png`（可用 `WECHAT_HEADER_IMAGE`/`WECHAT_FOOTER_IMAGE` 覆盖），幂等、缺文件降级为告警。
3. **内容驱动封面**（`src/lib/cover.js`）：先用 `.env` 的 `OPENROUTER_MODEL` 从文章提取封面数据（tag/标题/核心结论/链路/要点），再套 `~/zen-push-image` 模板由无头 Chrome 渲染；提取失败自动回退到「示例数据+标题」，封面不会因此挂掉。

Slack 触发支持工作流前缀路由：`@bot wechat: 写一篇……` 或 `@bot 微信：……`；无前缀默认走 wechat。未注册的前缀按普通任务文本处理（为子项目 B 的 `email:` 预留）。

## 部署

**本机 macOS 常驻（当前方案）**：`scripts/install-launchd.sh` 注册 launchd LaunchAgent，登录自启、崩溃自动拉起，日志在 `~/Library/Logs/zen-content-hub/`。卸载用 `scripts/uninstall-launchd.sh`。注意不要同时在 VS Code 里再启动一个实例（会重复消费 Slack 消息）；node 升级后需重跑安装脚本。

生产部署（海外 VPS、固定公网 IP、微信 IP 白名单、systemd、OpenRouter 探活）见 [`deploy/README.md`](deploy/README.md)。

## 扩展：新增工作流 / 渠道

引擎的核心（`core/`、`index.js`）不需要为新业务改动，只需按接口新增文件并注册：

- **新增工作流**：新建 `workflows/<name>.js`，导出 `{ id, triggers, channel, promptTemplate, retries, ... }`（参考 `workflows/wechat.js`），在 `src/index.js` 的 `WORKFLOWS` 里注册。
- **新增渠道**：新建 `channels/<name>.js`，实现 `async publish({ articlePath, config, workflow, notify, notifier }) → { mediaId, title }` 接口（参考 `channels/mock.js` / `channels/wechat-draft.js`），在 `src/index.js` 的 `CHANNELS` 里注册。
- **新增触发器**：`triggers/cron.js` 已支持在 workflow 的 `triggers` 数组里声明 `cron:<表达式>` 定时入队；`triggers/slack.js` 处理 Slack 消息触发。

以上是为子项目 B（邮件工作流）预留的扩展点：详见 `docs/superpowers/specs/2026-07-04-zen-content-hub-design.md` 第 14 节「扩展点」，B 主要工作是新增 `workflows/email.js` + `channels/email-esp.js` 并按同一接口接入，引擎本身不需要改动。

### 公众号写作工作流一览

除 `wechat`（通用写作任务）外，还内置若干把已安装的 Claude 金融 skill 方法论「编译」成 `promptTemplate` 的公众号写作工作流（以及一个忠实直译工作流），共同的 env getter 语义、Exa 优先信源清单、通用写作规范/产出格式都抽在 `workflows/shared.js` 里复用：

| 工作流 id | 文件 | Slack 触发前缀 | 用途 |
|---|---|---|---|
| `wechat` | `workflows/wechat.js` | `wechat:` / `微信：` / 无前缀（默认） | 通用公众号写作任务 |
| `earnings` | `workflows/earnings.js` | `earnings:` / `财报：` | 财报更新点评：实际 vs 预期、分部指标、指引变化、预期修正、投资论点复核、风险与催化剂 |
| `sector` | `workflows/sector.js` | `sector:` / `行业：` | 行业综述：市场规模与驱动、产业链与竞争格局、关键趋势、供需与价格信号、值得跟踪的公司与指标、情景与风险 |
| `morning` | `workflows/morning.js` | `morning:` / `晨报：` | 晨报：紧凑体例，隔夜关键事件 3-6 条 + 当日催化剂 + 一句话观点，要求以近 24-48 小时素材为主 |
| `translate` | `workflows/translate.js` | `translate:` / `直译：` / `翻译：` | 把任务里第一个用户指定链接的原文忠实直译成简体中文公众号文章（保留结构与数字，不做分析改写），文首注明来源标题/站点/链接/发布日期 |

`earnings`/`sector`/`morning` 的 `workDir` 是 `<WORK_DIR 基准目录>/<工作流 id>` 子目录（`wechat` 保持不带子目录的现状），避免并发任务的 `article.md` 互相覆盖。`morning` 额外支持可选的 `MORNING_CRON` 环境变量：设置后 `triggers` 会追加 `cron:<MORNING_CRON>` 定时入队，未设置则仅 Slack 触发。
