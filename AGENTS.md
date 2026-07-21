# Zen Content Hub

本机常驻的 Slack 内容编排服务：生成微信公众号或 Customer.io Newsletter 草稿，绝不由程序直接发送或排期。

## 开发与验证

- 需要 Node.js 22+；首次运行 `npm ci`，复制 `.env.example` 为 `.env` 并填写凭据。
- 全量离线验证：`npm test`。真实连接检查会访问外部服务，按需运行 `npm run check:openrouter`、`npm run check:egress` 或 `npm run check:customerio`。
- 开发演练使用 `HUB_DRY_RUN=1 npm start`；不要与 launchd 实例同时运行。代码或 `.env` 变更须由维护者确认后用 `launchctl kickstart -k gui/$(id -u)/com.zentrading.content-hub` 重启。

## 结构与约定

- `src/index.js` 装配 Slack、队列、工作流和渠道；`src/core/` 存放队列、SQLite、写作和通知。
- `src/workflows/` 定义任务；`src/channels/` 只创建草稿；`src/lib/` 放门禁、渲染和网络保护；环境变量由 `src/config/index.js` 统一解析。
- 不提交 `.env`、凭据、任务数据库或生成的临时内容。修改环境变量时同步 `.env.example`；改变用户流程、渠道或运维方式时同步 README 或 `docs/`。
- 保持微信公众号与 Newsletter 的“只创建草稿”边界、固定出口 fail-closed 保护，以及渲染 golden 测试约束。

## 当前状态

工作树含未提交的直译 V2、固定出口保护、自然语言路由与 Newsletter 改动；先运行 `npm test`，再由维护者审阅并决定提交、重启或发布。运行服务与当前工作树是否一致必须单独核验。
