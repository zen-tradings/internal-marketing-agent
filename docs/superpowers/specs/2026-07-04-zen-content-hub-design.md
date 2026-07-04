# Zen Content Hub 设计文档(子项目 A:编排引擎 + 微信渠道)

- 日期:2026-07-04
- 范围:**子项目 A** —— 把现有 `zen-slack-bot` 重构为可托管多工作流的内容编排引擎,先只接入微信渠道,顺手修复现有 bug。
- 后续:子项目 B(邮件工作流)、C(共享控制台)、D(网站 panel)另开 spec;本文档在「扩展点」一节标好接口,B 主要是填空。
- 现目录:`~/zen-slack-bot/`,重构后建议更名为 `zen-content-hub`(实现阶段再定,不影响本设计)。

## 1. 目标与非目标

### 目标
1. 把 `bot.js`(378 行单文件)重构成分层、模块化、可测试的编排引擎(选定方案 2:模块化 + SQLite 持久化状态)。
2. 修复现有微信 pipeline 的确定性 bug:stdout 正则解析脆弱、代理污染导致微信白名单失败、无队列/并发控制、无状态持久化、配置硬编码。
3. 引入 **Workflow 抽象**:每个工作流是一份声明式配置(触发器 + prompt + 工具 + 渠道 + 后处理),新增渠道 = 加配置,不改引擎。
4. 发布归属改为 **(b) Node 负责发布**:Claude 只调研+写作产出 markdown,Node 侧用 `@wenyan-md/core` 渲染并调微信草稿 API,`media_id` 来自 API 返回值而非解析 stdout。
5. 引擎常驻国内 VPS,支持 Slack 临时触发与 cron 定时触发。

### 非目标(本子项目不做)
- 邮件工作流(子项目 B)。
- 共享控制台 Web UI(子项目 C)——但状态持久化为其预留只读数据。
- 控制 zentradings.com panel(子项目 D)。
- 前后端分离/BullMQ/Postgres 等重基础设施(方案 3,推迟到控制台真正立项)。

## 2. 背景:现状与痛点

现有 `~/zen-slack-bot/bot.js`:Slack Socket Mode 监听 → `spawn claude -p <prompt>` 子进程(带 Exa + wenyan-mcp 工具白名单)→ 正则抠 stdout 的 `MEDIA_ID:`/`TITLE:` → 直连微信 API 注入关注名片 → 回 Slack 通知。

已确认的具体缺陷:
- **P1 发布判定脆弱**(`bot.js:228`):依赖 Claude 精确输出 `MEDIA_ID:`,措辞变化即静默判「未发布」。
- **P1 微信白名单失败(40164)根因**:Claude 子进程注入了 `https_proxy=127.0.0.1:7897`(`bot.js:167`),`wenyan-mcp` 继承该环境变量,其微信上传走了 clash 轮换出口 IP,掉出白名单;而 bot 自身的 `injectFollowCard` 走 `no_proxy` 直连,两条微信调用出口不一致。
- **P2 无队列/并发控制**(`bot.js:92,144`):每条消息立即 spawn 一个 claude 进程。
- **P2 无状态持久化**:任务仅有按时间戳命名的日志文件,无法观测、重启即丢。
- **P2 配置硬编码**:代理地址、超时(10min)、工作目录、工具白名单散落在代码里。
- **P3 名片注入**:失败仅 `console.error`,不回报 Slack;token 每次现拉(core 已内置缓存可替代)。
- **安全**:微信 `APP_SECRET` 明文存于 `~/.claude.json` 与 `.env`。

## 3. 架构总览

常驻国内 VPS 的 **Node 单进程**服务,内部分层:

```
zen-content-hub/
├── core/
│   ├── queue.js       任务队列(限并发,状态持久化到 SQLite)
│   ├── runner.js      spawn claude -p,注入 workflow 的 prompt/工具,超时,重试
│   ├── store.js       SQLite 访问层:runs 表读写
│   └── notifier.js    统一回报(Slack thread)
├── triggers/
│   ├── slack.js       Socket Mode:@bot / "任务:" → enqueue
│   └── cron.js        node-cron:定时 → enqueue
├── workflows/
│   ├── wechat.js      微信工作流配置
│   └── email.js       (子项目 B)
├── channels/
│   ├── wechat-draft.js   微信草稿适配器(渲染 + 发布 + 名片注入)
│   └── email-esp.js      (子项目 B)
├── net/
│   └── http.js        出站分流:构造微信直连 / Anthropic·Exa 走代理的 HttpAdapter
├── config/
│   ├── index.js       读环境变量 + 默认值(代理/超时/并发)
│   └── workflows.js    工作流注册表:trigger → workflow 映射
├── test/              fixtures + 单测 + dry-run
└── index.js           启动:装载 config → store → queue → triggers(slack + cron)
```

### 核心抽象:Workflow

一等公民,声明式:

```js
// workflows/wechat.js
export default {
  id: 'wechat',
  triggers: ['slack'],                 // 邮件将是 ['cron:0 8 * * 1', 'slack']
  workDir: '/srv/zen/wechat',          // Claude 子进程 cwd,产出 article.md
  allowedTools: [                      // 注意:不再含 wenyan-mcp 的 publish
    'mcp__exa__web_search_exa',
    'mcp__exa__web_fetch_exa',
  ],
  promptTemplate: (task) => `...`,     // 由现 buildPrompt 迁移改造:要求写到 article.md
  output: { kind: 'file', path: 'article.md' },  // Claude 产出约定
  channel: 'wechat-draft',             // 用哪个渠道适配器发布
  postProcess: ['inject-follow-card'],
  timeoutMs: 10 * 60 * 1000,
  retries: 0,                          // cron 工作流可设 >0
};
```

新增渠道/工作流不触碰 `core/`。

## 4. 组件详述

- **core/queue.js**:FIFO,默认并发 1(可配 `MAX_CONCURRENCY`)。入队即写 SQLite(status=`queued`);取出置 `running`;结束置 `done`/`failed`。进程启动时把残留 `running` 标为 `interrupted` 并可选重投。
- **core/runner.js**:按 workflow 配置 `spawn(CLAUDE_BIN, ['-p', prompt, '--dangerously-skip-permissions', '--allowedTools', ...], {cwd, env})`。env 由 `net/http.js` 的分流策略产生(见 §9)。超时用 workflow.timeoutMs。子进程结束后**不解析 stdout 找 media_id**——只判断退出码与 `article.md` 是否生成;发布交给 channel。
- **core/store.js**:封装 `better-sqlite3`(同步 API,单进程够用)。见 §7 schema。
- **core/notifier.js**:统一 Slack 回报(收到/成功/失败/警告),带 run id 与阶段信息;是唯一出 Slack 消息的地方。
- **triggers/slack.js**:迁移现有 `app.message` + `app_mention` + 去重(processedTs)+ `cleanSlackText`;解析出 task 后构造 `Task` 入队,不再直接 spawn。
- **triggers/cron.js**:读各 workflow 的 `cron:` 触发器,注册 `node-cron`;到点构造 `Task{source:'cron'}` 入队。本子项目微信无 cron,但引擎先具备该能力(供 B 用)。
- **channels/wechat-draft.js**:见 §6。
- **net/http.js**:见 §9。
- **config/**:所有可变项集中,环境变量优先。

## 5. 数据流与状态机

一次任务:

1. **触发**:Slack/cron → `Task{id, workflowId, input, source, notify:{channel,ts}}` → `queue.enqueue` → SQLite `queued`。
2. **执行**:queue 取出 → `running` → runner spawn claude(注入 prompt + 工具 + 分流 env)→ Claude 调研+写作 → 写 `article.md`(frontmatter: title、cover)。
3. **校验**:runner 检查退出码 == 0 且 `article.md` 存在且含必需 frontmatter;否则 `failed{stage:'generate'}`。
4. **发布**:channel 读 md → 渲染 → 注入名片 → 上传封面 → `publishToDraft` → `{media_id}`。任一步失败 `failed{stage:'render'|'publish'}`。
5. **回报**:notifier 回 Slack(✅ 标题+media_id / ❌ 阶段+错误摘要 / ⚠️ 名片注入失败但已出草稿);SQLite `done`/`failed`。

状态:`queued → running → (generate → render → publish) → done | failed | interrupted`。

## 6. 微信渠道详细设计(基于 @wenyan-md/core)

已验证依赖:全局装有 `@wenyan-md/mcp@2.0.3`,其内含 `@wenyan-md/core@3.0.10`,提供独立可调用的渲染与发布库。项目改为**直接依赖 `@wenyan-md/core`**,wenyan-mcp 退出微信链路。

**渲染**(`@wenyan-md/core`):
```js
import { createWenyanCore } from '@wenyan-md/core';
const core = await createWenyanCore({ isWechat: true });
const fm = await core.handleFrontMatter(markdown);       // 取 title/cover
const html = await core.renderMarkdown(fm.body ?? markdown);
const styled = await core.applyStylesWithTheme(el, { themeId: 'zen-trading' });
```
- `zen-trading` 主题 CSS 在 `~/zen-wechat-theme/zen-trading.css`,需在渲染前注册进 core 的 theme registry(core 导出了 themeRegistry 相关 API)。实现阶段确认注册方式(CSS 字符串 vs themeId)。

**名片注入**(postProcess `inject-follow-card`):在 styled HTML 上做,而非现在的「发布后 draft/get + draft/update」两次往返。定位现有蓝色结尾板块 marker(`background:#0E2138;border-radius:.6em;padding:1.4em`)前插入 `mp-common-profile` section。账号基本信息(head_img/nickname/alias/signature)仍走 `getaccountbasicinfo`。

**发布**(`@wenyan-md/core/publish`):
```js
import { WechatPublisher } from '@wenyan-md/core/publish';
const pub = new WechatPublisher(httpAdapter /* 直连微信 */);
const token = await pub.getAccessTokenWithCache(APP_ID, APP_SECRET);   // 内置缓存
const cover = await pub.uploadImage(coverBlob, 'cover.jpg', token, APP_ID);
const { media_id } = await pub.publishToDraft(token, {
  title, author, content: styledHtmlWithCard, thumb_media_id: cover.media_id,
});
```
- `media_id` 来自返回值 → 彻底消灭 stdout 解析。
- token 缓存与 upload-cache 由 core 内置(可注入自定义 storage adapter 指向 `~/.config/wenyan-md/` 或项目内路径)。
- **封面来源**:frontmatter 指定本地图片路径或复用已有素材;若缺失,回报 ⚠️ 并要求补图(微信草稿必须有封面)。

## 7. 数据模型(SQLite)

```sql
CREATE TABLE runs (
  id            TEXT PRIMARY KEY,      -- uuid/时间戳
  workflow_id   TEXT NOT NULL,
  source        TEXT NOT NULL,          -- 'slack' | 'cron'
  input         TEXT NOT NULL,          -- 任务原文
  status        TEXT NOT NULL,          -- queued|running|done|failed|interrupted
  stage         TEXT,                   -- generate|render|publish
  title         TEXT,
  media_id      TEXT,
  error         TEXT,
  notify_json   TEXT,                   -- {channel, ts}
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER
);
CREATE INDEX idx_runs_status ON runs(status);
CREATE INDEX idx_runs_created ON runs(created_at);
```
控制台(C)以后只读此表即可观测,无需改引擎。

## 8. 错误处理与重试

- 每阶段独立 try/catch,失败写 `{status:failed, stage, error(截断)}`,Slack 回报**具体阶段**。
- 幂等:core 的 upload-cache 防封面重复上传;同一 run 重试不产生重复草稿(发布前查是否已有 media_id)。
- 超时:`workflow.timeoutMs`,到点 SIGKILL,回报超时。
- 重试:`workflow.retries`(cron 工作流建议 >0;Slack 临时任务默认 0,失败让人看)。
- 名片注入失败:默认**告警但不阻断**(仍出草稿),Slack ⚠️。
- 启动自愈:残留 `running` → `interrupted`。

## 9. 出站网络分流(关键)

VPS 在国内,因此:
- **微信 API(`api.weixin.qq.com` 等)**:强制**直连**,不经任何代理 → VPS 固定公网 IP → 加入公众号后台 IP 白名单 → 根治 40164。由 `net/http.js` 提供一个「不读 proxy 环境变量」的 HttpAdapter 注入给 `WechatPublisher`。
- **Anthropic API、Exa**:Claude 子进程与 MCP 需要出海,走代理(VPS 上部署的出海线路)。仅对这些流量设 `https_proxy`,并把微信域名放进 `no_proxy`。
- 关键:**微信调用不再依赖 Claude 子进程的 env**(发布已移到 Node 侧),因此代理污染 bug 从架构上消失。

> 风险:国内 VPS 访问 Anthropic/Exa 需稳定出海线路,合规与稳定性需自行保障(见 §13)。

## 10. 部署

- 国内 VPS(阿里/腾讯云),固定公网 IP,加入公众号 IP 白名单。
- 进程常驻:pm2 或 systemd(自启、崩溃重启、日志切割)。
- **Claude Code 在 VPS 上运行**:需安装 CLI 并完成认证(经代理访问 Anthropic);headless 用 `-p --dangerously-skip-permissions`。认证保活是运维重点(见开放问题)。
- Node 版本对齐(现用 v24.17.0)。

## 11. 密钥管理

- 微信 `APP_ID/APP_SECRET`、Slack tokens、代理凭据统一走**环境变量或 VPS 上的独立 secret 文件**(权限 600),不进 git。
- `.gitignore` 排除 `.env`、日志、`node_modules/`。
- 迁移后建议轮换一次已明文暴露过的微信 secret。

## 12. 测试策略

- **渲染层**:markdown fixtures → 断言输出 HTML 含 zen-trading 主题类名、名片 section、结尾三行板块(纯函数,易测)。
- **渠道层**:mock `HttpAdapter`,断言 `publishToDraft` 入参(title/content/thumb_media_id)正确,不打真实微信。
- **队列/状态**:入队→执行→落库的状态流转单测(内存 SQLite)。
- **端到端 `--dry-run`**:跑完整链路,发布替换为 mock adapter,人工核对渲染产物文件。
- **真实冒烟**:手动脚本,真发一篇到草稿箱,肉眼验收(白名单/封面/名片)。

## 13. 风险与开放问题

1. **国内 VPS 出海稳定性/合规**:Claude 与 Exa 需经代理访问境外 API;线路选择与合规需确认。若不可行,回退到「香港/新加坡 VPS」需重议 §9(微信改为海外 IP 白名单)。
2. **Claude Code 在 VPS 上的认证保活**:长期无人值守下 token/登录如何续期,需在实现计划中定方案(如定期检查 + 失败告警到 Slack)。
3. **zen-trading 主题注册方式**:确认 `@wenyan-md/core` 注册自定义主题的确切 API(themeId vs 直接传 CSS),渲染结果需与现有草稿视觉一致。
4. **封面图来源**:临时任务如何提供封面(frontmatter 指定/素材库复用/AI 生成),缺图流程需定义。
5. **微信 IP 白名单可加数量**:确认后台可加的 IP 数与 VPS IP 是否长期固定(非弹性公网 IP 漂移)。

## 14. 扩展点(为子项目 B 邮件预留)

- **触发器**:`cron.js` 已具备定时能力,B 的 newsletter 直接用。
- **工作流**:新增 `workflows/email.js`(独立选题、独立 prompt),引擎不改。
- **渠道**:新增 `channels/email-esp.js` 实现同一 `publish(content, meta) → result` 接口。
- **B 的待解问题(不在本 spec)**:订阅名单来源、邮件服务商(中国邮箱送达率)、退订合规、HTML 邮件渲染。

## 15. 里程碑

1. **M1 引擎骨架**:config + store(SQLite)+ queue + runner + notifier + slack trigger,跑通「入队→spawn claude→落库→回报」(发布先 mock)。
2. **M2 微信渠道 (b)**:`channels/wechat-draft.js`(core 渲染 + 名片注入 + WechatPublisher 发布),`--dry-run` + 真实冒烟通过。
3. **M3 分流与部署**:`net/http.js` 分流、VPS 部署、白名单、pm2/systemd、Claude 认证保活;线上真发验收。
4. **M4 硬化**:cron 触发器、重试/幂等、启动自愈、测试补全。
