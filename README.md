# Zen Content Hub

常驻单进程的内容编排引擎：Slack（或 cron）触发一个写作任务 → 排队 → spawn `claude -p` 调研并写出 `article.md` → 渠道（channel）把文章渲染并发布出去 → 结果回报到 Slack。当前接入的渠道是微信公众号草稿箱；引擎本身与具体渠道/工作流解耦，方便后续接入邮件等其它工作流（见下文「扩展」一节）。

## 架构

```
触发器(triggers)         队列/编排(core)              工作流+渠道
┌────────────┐        ┌──────────────────┐        ┌───────────────────┐
│ slack.js   │──enqueue─▶ queue.js (限并发) │        │ workflows/wechat.js│
│ cron.js    │        │   ↓ handler       │──────▶ │  (prompt/渠道声明) │
└────────────┘        │ store.js (SQLite) │        └─────────┬──────────┘
                       │ runner.js (spawn  │                  │ publish()
                       │   claude 子进程)  │        ┌─────────▼──────────┐
                       │ notifier.js       │        │ channels/          │
                       │  (Slack 回报)     │        │  mock.js (测试/干跑)│
                       └──────────────────┘        │  wechat-draft.js    │
                                                     │  (渲染+发布+名片)  │
                                                     └────────────────────┘
```

- **状态机**：每个任务落库为一行 `runs` 记录，状态在 `queued → running → done|failed`（异常重启后 `running` 会被标为 `interrupted`，见 `store.markInterrupted()`）之间流转，媒体 ID（`media_id`）一旦写入即视为「已发布过」，支撑重试/重启时的幂等（不会重复产生草稿）。
- **进程边界与代理隔离**：微信 API 调用在主进程直连（`assertMainProcessDirect()` 会在检测到主进程带代理变量时直接拒绝启动）；Claude/Exa 调研走代理，代理变量只通过 `CHILD_HTTPS_PROXY`/`CHILD_HTTP_PROXY`/`CHILD_ALL_PROXY` 注入 Claude 子进程 env，两条链路物理隔离，避免代理污染微信调用的出口 IP（详见 `deploy/README.md` 里的 IP 白名单踩坑记录）。

## 目录结构（`src/`）

```
src/
├── config/index.js       读 env + 默认值（代理/超时/并发/路径/密钥）
├── core/
│   ├── store.js           SQLite runs 表 CRUD（better-sqlite3）
│   ├── queue.js            限并发队列
│   ├── runner.js           spawn claude 子进程，注入 prompt/工具/代理 env，超时与产出校验
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
│   └── health.js           Claude 认证保活探测（见 deploy/README.md）
└── index.js                装配入口：makeHandler + start()
```

`src/index.js` 导出了 `makeHandler({ store, runClaude, workflows, channels, config, notifier })`，把「一个任务从取出到落库」的完整处理逻辑封装成可注入依赖的纯函数，方便测试时用桩（stub）替换 `store`/`runClaude`/`channels`/`notifier`，不需要真正连数据库/跑 Claude/发微信。`start()` 用真实依赖组装并启动服务。

## 运行测试

```bash
npm test        # 等价于 node --test，跑 test/ 下全部 node:test 用例
```

测试全部是纯内存/桩依赖，不需要网络、不需要真实 Claude/微信凭据。其中 `test/golden/render-parity.test.js` 会锁定 `@wenyan-md/core` 的渲染输出逐字符比对（parity 验收门），`test/e2e-dryrun.test.js` 是端到端装配测试：走真实 `createQueue` + `makeHandler`，用 `mock` 渠道和 stub `runClaude` 验证一个任务能正确入队、跑通、落 `done`。

## 本地干跑（dry-run）演练

不想真的发布到微信草稿箱，只想验证「触发 → 调研 → 渲染 → 发布 → 回报」全链路能跑通时，设置 `HUB_DRY_RUN`：

```bash
HUB_DRY_RUN=1 node src/index.js
```

设置后，无论 `workflows/*.js` 里 `channel` 字段声明的是什么渠道（例如 `wechat-draft`），实际发布都会被强制改道到 `channels/mock.js`（返回固定的 `mediaId: 'MOCK'`），既不会调用微信 API，也不会产生真实草稿；其它步骤（Slack 触发、排队、spawn `claude -p` 真实调研写作、落库、Slack 回报）都按真实流程走。适合验证 `.env`/Slack 接线/Claude 调用链路是否正常，同时避免误发到公众号。

开关的实现点在 `src/index.js` 的 `makeHandler` 里选渠道那一步：

```js
const channelId = process.env.HUB_DRY_RUN ? 'mock' : wf.channel;
const channel = channels[channelId];
```

## 部署

生产部署（国内 VPS、固定公网 IP、微信 IP 白名单、systemd、Claude 认证保活）见 [`deploy/README.md`](deploy/README.md)。

## 扩展：新增工作流 / 渠道

引擎的核心（`core/`、`index.js`）不需要为新业务改动，只需按接口新增文件并注册：

- **新增工作流**：新建 `workflows/<name>.js`，导出 `{ id, triggers, channel, promptTemplate, retries, ... }`（参考 `workflows/wechat.js`），在 `src/index.js` 的 `WORKFLOWS` 里注册。
- **新增渠道**：新建 `channels/<name>.js`，实现 `async publish({ articlePath, config, workflow, notify, notifier }) → { mediaId, title }` 接口（参考 `channels/mock.js` / `channels/wechat-draft.js`），在 `src/index.js` 的 `CHANNELS` 里注册。
- **新增触发器**：`triggers/cron.js` 已支持在 workflow 的 `triggers` 数组里声明 `cron:<表达式>` 定时入队；`triggers/slack.js` 处理 Slack 消息触发。

以上是为子项目 B（邮件工作流）预留的扩展点：详见 `docs/superpowers/specs/2026-07-04-zen-content-hub-design.md` 第 14 节「扩展点」，B 主要工作是新增 `workflows/email.js` + `channels/email-esp.js` 并按同一接口接入，引擎本身不需要改动。
