# 设计变更 Addendum:OpenRouter runner + 海外 VPS 部署

- 日期:2026-07-05
- 关系:本文修订 `2026-07-04-zen-content-hub-design.md`(下称"原 spec")的 §9(出站网络)、§10(部署)与 §6/§4(写作内核)。原 spec 其余部分仍有效。
- 触发:用户两处决策变更 —— ①部署改到**海外 VPS**(复用现有,不新开云机);②写作内核用 **OpenRouter 开源模型完全替代 Claude Code**。
- 实施方:后续由 Codex 开发,见 `docs/HANDOFF.md` §7/§8。

## 1. 写作内核:OpenRouter 替代 Claude Code

### 背景与原设计
原 spec 的 runner 为「`spawn claude -p` 让 Claude Code 以 agent 方式调研(Exa MCP)+ 写作,产出 `article.md`」。现改为用 OpenRouter 的开源模型完成同一职责。

### 不变的接缝(必须守住)
runner 的输入/输出契约不变:
- 输入:`runWriter({ workflow, input, config })`(原名 `runClaude`)
- 输出:在 `workflow.workDir` 写 `article.md`(frontmatter 含 `title`,正文 Markdown),返回 `{ ok, articlePath, ... }`
- 下游 `channels/wechat-draft.js` 的渲染(`renderAndPublish` + `RENDER_OPTS`)、封面、名片、发布、parity 全部**不变**。

### 关键差异
OpenRouter 是 OpenAI 兼容纯推理 API,无 agent 循环 / 工具 / MCP。"调研"须自建。

### 方案 A(推荐,管线式)
1. Node 侧调研:Exa REST API / `exa-js`(需 `EXA_API_KEY`)search + fetch top N 来源。
2. 组装 system(zen-trading 写作规范,迁移自 `workflows/wechat.js` 的 promptTemplate)+ user(任务 + 调研素材)。
3. 调 OpenRouter `POST /v1/chat/completions`(model 从 config/workflow 取),要求输出带 `title` frontmatter 的完整 Markdown。
4. 写 `article.md`,返回 `{ok, articlePath}`。

### 方案 B(备选,工具循环式)
OpenAI 风格 tool-calling,Exa search/fetch 作为 tools,模型自主多轮调研再写。更灵活更重,可作二期。

### 配置新增
`OPENROUTER_API_KEY`、`OPENROUTER_MODEL`、`OPENROUTER_BASE_URL`(默认 `https://openrouter.ai/api/v1`)、`EXA_API_KEY`;`loadConfig` 读取;workflow 可带 `model` 覆盖。

### 连带清理
- 移除 `spawn claude` 的 `--allowedTools`/`--dangerously-skip-permissions`/CHILD_* 代理注入。
- `lib/health.js` 的 `checkClaudeAuth` → OpenRouter 探活(`GET /models` 或最小 completion)。
- `config.claudeBin`/`CLAUDE_BIN` 作废。

### 测试
注入 fake `fetch`(OpenRouter + Exa 固定响应),断言写出的 `article.md` 含 `title` frontmatter 且返回 `ok:true`,保持 hermetic;沿用现有 `test/runner.test.js` 注入风格。golden parity 不受影响(未动 channel)。

### 质量与信任
开源模型中文金融写作质量可能弱于 Claude,需更强 system prompt;建议保留「先出草稿箱、人工审核、再(邮件)群发」的信任模型,`HUB_DRY_RUN=1` 做人工核对。

## 2. 部署:海外 VPS

### 修订原 spec §9(出站网络)
海外 VPS 上 OpenRouter / Exa / Anthropic 均可**直连**,无需代理出海。原「国内 VPS + CHILD_* 代理 + 进程边界隔离」不再需要:
- 全部出站直连,不设任何 `*_proxy`。
- `assertMainProcessDirect` 保留为无害不变量(海外机上天然满足)。
- 微信 API(`api.weixin.qq.com`)海外可达。

### 修订原 spec §10(部署)
- 目标:一台**海外 VPS**(用户现有),固定公网 IP。
- **必须**把该 VPS 公网 IP 加入公众号后台 IP 白名单(否则 40164)。这是海外机唯一的微信侧硬要求。
- 常驻:systemd(`deploy/zen-content-hub.service`)。
- 上线前先 `deploy/vps-check.sh` 判定可用性(Node≥22 / 直连 OpenRouter·Exa·微信 / 公网 IP / git·磁盘)。
- `.env`:`OPENROUTER_API_KEY`/`EXA_API_KEY`/`WECHAT_*`/`SLACK_*`;海外机通常无需 CHILD_* 代理。

### 风险/权衡
- 海外 IP 调微信延迟略高、偶有风控;若不稳,退路是香港/新加坡机(距内地近、通常仍可直连 OpenRouter)。
- 微信白名单可加 IP 数量有限,确认 VPS 用固定公网 IP(非弹性漂移)。

## 3. 对原 spec 其它部分的影响
- 引擎骨架(queue/store/notifier/triggers/channels/workflow 抽象)、微信渲染 parity、SQLite 状态、cron 触发器扩展点:**均不变**,继续有效。
- 原 spec §13 的「Claude 在 VPS 上认证保活」开放问题:随 Claude 被替换而作废,改为 OpenRouter key 有效性监控。
