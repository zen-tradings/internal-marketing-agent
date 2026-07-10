# Zen Content Hub — 开发交接文档(致 Codex）

> 交接日期：2026-07-05 · 交接自：Claude（子项目 A 实现者）· 接手方：Codex
> 分支：`feat/content-hub-engine`（领先 `main` 19 个提交，未合并）
> 一句话：`zen-slack-bot` 已从单文件 Slack→微信 bot 重构为**模块化多工作流内容编排引擎**。子项目 A（引擎 + 微信渠道）已完成；Codex 已完成 T-A：**用 OpenRouter 开源模型 + Exa 替代 Claude Code 作为写作/调研内核**。接下来主要是**部署到一台海外 VPS** 做真实发布冒烟。

---

## 0. 你（Codex）要做的事，按优先级

1. **T-B 部署到海外 VPS + 真实发布冒烟**（原计划 Task 11，§8）。先跑 `deploy/vps-check.sh` 判断 VPS 是否可用。
2. **T-C 清理已知设计债务**（§9，小项，按需）。
4. 未来：子项目 B（邮件）/ C（共享控制台）/ D（官网 panel），见 §10。

**动工前务必读**：本文档 + 设计 spec `docs/superpowers/specs/2026-07-04-zen-content-hub-design.md` + 方向变更 addendum `docs/superpowers/specs/2026-07-05-openrouter-runner-overseas-deployment.md` + 实现计划 `docs/superpowers/plans/2026-07-04-zen-content-hub-engine.md`。逐任务实现记录在 `.superpowers/sdd/progress.md`（gitignored，本地）。

---

## 1. 项目愿景

一个引擎，多个「发布终端」。内容由 AI 生成，经渲染后分发到不同渠道：

| 子项目 | 内容 | 状态 |
|---|---|---|
| **A. 编排引擎 + 微信渠道** | 队列/状态/触发器/渠道适配器骨架，先接微信公众号 | ✅ 已完成（本次交接主体） |
| **B. 邮件工作流** | 群发订阅用户邮箱 | ⬜ 待做（引擎已留 cron 触发器与渠道扩展点） |
| **C. 共享控制台** | 团队可用的 Web UI（提交/观测/审核发布） | ⬜ 待做（SQLite 状态已为其铺路） |
| **D. 官网 panel** | 把内容/控制推到 zentradings.com | ⬜ 待做 |

微信/邮件工作流**各写各的、选题可不同**，不共享内容层；共享的是编排引擎。

---

## 2. 当前状态（子项目 A）

- 分支 `feat/content-hub-engine`，**`npm test` 全绿（57 tests / 0 fail）**。
- 每个任务都过了「实现 → 独立评审 → 修复 → 复评」双关卡，最后有一轮 opus 整体评审（结论与遗留项见 `.superpowers/sdd/progress.md`）。
- 未合并 `main`；建议**真实发布冒烟通过前不并入 main**。

验证方式：`cd ~/zen-slack-bot && npm test`。

---

## 3. 架构总览

Node（ESM）单进程。触发器把任务入队（SQLite 持久化）→ runner 生成 `article.md` → channel 渲染并发布 → notifier 回报。

```
src/
├── config/index.js      loadConfig(env) → {workDir,dbPath,maxConcurrency,defaultTimeoutMs,writer,slack,wechat}
├── core/
│   ├── store.js         openStore(dbPath): runs 表 CRUD（better-sqlite3）
│   ├── queue.js         createQueue({store,maxConcurrency,handler}).enqueue(task)
│   ├── runner.js        runWriter({workflow,input,config}) → {ok,articlePath,stderr}; runClaude 为兼容别名
│   └── notifier.js      createNotifier(postMessage) → {ack,success,failure,warn}
├── triggers/
│   ├── slack.js         parseSlackTask / registerSlack（Socket Mode → enqueue）
│   └── cron.js          parseCronTriggers / registerCron（node-cron → enqueue，为 B 预备）
├── workflows/wechat.js  声明式配置：triggers/model/channel/timeoutMs/retries + promptTemplate（写作规范）
├── channels/
│   ├── mock.js          测试/ dry-run 假渠道
│   └── wechat-draft.js   renderAndPublish（@wenyan-md/core）+ 封面 + 关注名片；导出 RENDER_OPTS
├── lib/
│   ├── getInputContent.js  core 渲染要的读文件函数
│   ├── wechatApi.js        直连微信 token/draft get·update + 名片注入（node:https）
│   ├── cover.js            调 ~/zen-push-image 生成封面 + ensureFrontmatterCover
│   └── health.js           checkOpenRouterHealth（VPS OpenRouter key/网络探活；checkClaudeAuth 为兼容别名）
└── index.js             makeHandler({store,runClaude,workflows,channels,config,notifier}) + start() 装配 + assertMainProcessDirect
```

**核心抽象 = Workflow（声明式配置）**：一个工作流是一份配置（触发器 + 写作规范 prompt + 渠道 + 后处理 + 超时/重试）。加渠道/工作流 = 加配置，不改引擎。

**数据流（一次任务）**：触发 → `enqueue({workflowId,source,input,notify})` → 入队(SQLite queued) → `makeHandler`：running → `runWriter`/兼容名 `runClaude`（Exa 调研 + OpenRouter 生成 article.md）→ 幂等检查(已有 media_id 则跳过) → `channel.publish`（渲染+封面+发布+名片）→ done + notifier.success；任一阶段失败 → failed{stage} + notifier.failure。

---

## 4. 绝对不能破坏的约束（改任何东西前先读）

1. **渲染一致性（parity）**：微信渲染必须与既有公众号排版**逐字节一致**。实现方式：`channels/wechat-draft.js` 用 `@wenyan-md/core/wrapper` 的 `renderAndPublish`，参数 `RENDER_OPTS = {theme:'zen-trading', highlight:'solarized-light', macStyle:true, footnote:true}`，`@wenyan-md/core` 锁 `3.0.10`，`jsdom` 27.4.0。验收门在 `test/golden/render-parity.test.js`（对比 `test/golden/sample.expected.html`）。**动 core 版本或渲染参数会破坏 parity，golden 测试会红。**
2. **`article.md` 契约**：runner 的产出契约是——在 `workflow.workDir` 写一个 `article.md`，frontmatter 至少含 `title`（`cover` 由 channel 补），正文为 Markdown；返回 `{ok:boolean, articlePath, ...}`。**只要守住这个契约，替换 runner（T-A）就不会波及 channel/渲染/发布/parity。这是最重要的解耦接缝。**
3. **ESM only**（`package.json` `"type":"module"`），测试用内置 `node:test`（`node --test`），**测试必须 hermetic**（不打真实网络/DB 文件/外部进程）——用依赖注入（`spawnFn`/`fetchFn`/stub channel）。
4. 微信凭据、API key 走环境变量，绝不进 git（`.env` 已 gitignore）。

---

## 5. 如何运行 / 测试 / 演练

```bash
cd ~/zen-slack-bot
npm ci                        # 用锁定版本，保 parity
npm test                      # node --test，应 54/54 全绿
HUB_DRY_RUN=1 node src/index.js   # 本地演练：所有工作流强制走 mock 渠道，不真发
node src/index.js             # 正式：wechat 工作流默认走 wechat-draft（会真发草稿箱）
```

`HUB_DRY_RUN` 只认 `1|true|yes|on`（严格真值）。

---

## 6. 方向变更（2026-07-05，本次交接确定）

用户调整了两处原设计前提，详见 addendum spec `docs/superpowers/specs/2026-07-05-openrouter-runner-overseas-deployment.md`：

- **部署目标：海外 VPS（复用现有那台，不新开云机）**。影响：OpenRouter/Exa/Anthropic 可直连、无需代理出海；微信 API 海外可达，但**必须把该 VPS 的固定公网 IP 加入公众号后台 IP 白名单**（否则 40164）。原设计的「国内 VPS + CHILD_* 代理出海 + 进程边界隔离」在海外机上基本用不上（全直连），`assertMainProcessDirect` 可保留为无害不变量。
- **写作内核：用 OpenRouter 开源模型完全替代 Claude Code**（用户有 OpenRouter API key）。这是 T-A，见 §7。

---

## 7. T-A：OpenRouter 开源模型 runner（已由 Codex 完成）

**状态**：已实现并通过 `npm test`。`src/core/runner.js` 现在使用 Exa REST `/search` 获取素材，再调用 OpenRouter `/chat/completions` 生成文章；仍保持 §4.2 的 `article.md` 契约不变，因此 channel/渲染/发布/parity 未被触碰。

**难点**：OpenRouter 是 OpenAI 兼容的**纯推理 API**（`POST https://openrouter.ai/api/v1/chat/completions`），没有 Claude Code 的 agent 循环 / MCP / 内置 web 工具。「调研」得自己实现。

**已采用方案（管线式）**：
1. **调研在 Node 侧做**：`searchExa` 调 Exa REST `/search`，请求 top N 来源的 compact text 与 highlights。
2. **组装上下文**：把 `workflow.promptTemplate` 的写作规范 + 调研素材 + 任务拼成 system+user messages。
3. **调 OpenRouter 写作**：`model` 从 `workflow.model || config.writer.model` 取，要求模型输出带 `title` frontmatter 的完整 Markdown。
4. **写 `article.md`，返回 `{ok, articlePath}`**；输出缺 `title` frontmatter 时返回 `ok:false` 并删除半成品。

**备选方案（工具循环式，更灵活更重）**：用 OpenAI 风格 tool-calling，把 Exa search/fetch 作为 tools，让模型自主多轮调研再写。可作为第二阶段迭代。

**实现要点**：
- `src/core/runner.js` 导出 `runWriter`，并保留 `runClaude` 兼容别名，减少 `makeHandler` 与旧测试桩 churn。
- **config**：`loadConfig` 读取 `OPENROUTER_API_KEY`、`OPENROUTER_MODEL`、`OPENROUTER_BASE_URL`、`OPENROUTER_TEMPERATURE`、`EXA_API_KEY`、`EXA_BASE_URL`、`EXA_NUM_RESULTS`。
- **依赖注入**：runner 和 health 都注入 `fetchFn`，测试用 fake OpenRouter/Exa 响应，保持 hermetic。
- **清理**：`spawn claude` 相关的 `--allowedTools`、`--dangerously-skip-permissions`、CHILD_* 代理注入已移除；`config.claudeBin`/`CLAUDE_BIN` 作废；`src/lib/health.js` 已改成 OpenRouter `/models` 探活。
- **质量提示**：开源模型的中文金融写作质量可能弱于 Claude，需要更强的 system prompt 与写作规范约束；建议留一个 `HUB_DRY_RUN=1` 的人工核对环节，并考虑保留「先出草稿箱、人工审核后再群发」的信任模型。

**验收**：新 runner 单测全绿，全量 `npm test` 为 57/57 通过；golden parity 不受影响，因为 channel 未改。下一步仍需在真实 VPS 上跑 `HUB_DRY_RUN=1` 和真实草稿箱冒烟。

---

## 8. T-B：部署海外 VPS + 真实发布冒烟（原 Task 11）

1. 在 VPS 上跑 `bash deploy/vps-check.sh`（本次新增）：检查 Node≥22、能否直连 OpenRouter/Exa/微信、打印公网 IP、git/磁盘等。
2. 把 VPS 公网 IP 加入**公众号后台 → 设置与开发 → 基本配置 → IP 白名单**（不加会报 40164）。
3. `npm ci` → 配 `.env`（用 `deploy/.env.example`：`OPENROUTER_API_KEY`/`EXA_API_KEY`/`WECHAT_*`/`SLACK_*`；海外机通常无需 CHILD_* 代理）→ 用 `deploy/zen-content-hub.service`（systemd）常驻。
4. 先 `HUB_DRY_RUN=1` 跑通链路，再去掉，在 Slack 发 `任务:...`，到公众号草稿箱**肉眼验收**（渲染是否与既有主题一致、封面、关注名片）。
5. 冒烟通过后再考虑合并 `main`。

> 注：`deploy/README.md` 与 `deploy/.env.example` 已按海外 VPS + OpenRouter/Exa 直连订正。

---

## 9. T-C：已知设计债务（小项，按需清理）

来自逐任务评审与整体评审（详见 `.superpowers/sdd/progress.md`）：

- **retry>0 的重跑设计**：现 `runWithRetry` 包住「生成+发布」整体，发布失败会连带重跑生成（换 OpenRouter 后就是重花一次推理）。目前 `wechat.retries=0` 故 dormant。给邮件(B)等设 `retries>0` 前，改为「只重试失败的下游阶段」。
- **golden parity 测试并发偶发**：高并发 `node --test` 下曾两次读到空串（fail-safe，后 0/20）。建议给该测试文件强制串行（`{concurrency:1}`）消除 CI 噪声。
- **notifier 启动竞态**：`deps.notifier` 在 `registerSlack` 之后赋值;已用 `if(deps.notifier)` 守卫（不会崩，最坏丢一条通知）。彻底修需把 notifier 构造提前到装配 enqueue 之前。
- **OpenRouter 超时细分测试**：runner 已有生成成功、缺 frontmatter、Exa HTTP 失败测试；如后续要做更细超时/重试策略，可补 AbortController 超时单测。
- **依赖精确锁**：`jsdom`/`form-data-encoder`/`formdata-node` 已从 caret 改精确（保 parity）;`npm ci` + lockfile 是硬保证。

---

## 10. 未来子项目

- **B 邮件**：另开 spec。核心待解：订阅名单来源、邮件服务商（中国邮箱送达率）、退订合规、HTML 邮件渲染。引擎 cron 触发器已就位；新增 `workflows/email.js` + `channels/email-esp.js` 即可，引擎不改。
- **C 共享控制台**：SQLite 的 `runs` 表已为观测铺路，加只读 API/UI 即可。
- **D 官网 panel**：需先确认 zentradings.com 技术栈。

---

## 11. 仓库地图 / 关键指针

- 设计 spec：`docs/superpowers/specs/2026-07-04-zen-content-hub-design.md`
- 方向变更 addendum：`docs/superpowers/specs/2026-07-05-openrouter-runner-overseas-deployment.md`
- 实现计划（16 任务，TDD）：`docs/superpowers/plans/2026-07-04-zen-content-hub-engine.md`
- 逐任务实现/评审记录：`.superpowers/sdd/progress.md`（gitignored，本地）
- 部署工件：`deploy/`（`.env.example` / `zen-content-hub.service` / `README.md` / `vps-check.sh` / `smoke.md`）
- 渲染 parity 基线：`test/golden/`
- 老单文件（已删）：原 `bot.js` 已删除，逻辑迁移到 `src/`；如需参考旧代理/名片写法见 git 历史 `git show 8f6241f:bot.js`。

有疑问先读 spec/plan/ledger，再动代码；改动务必守住 §4 的四条约束并保持 `npm test` 全绿。
