# Zen 微信草稿箱 Pipeline 迁移清单

这份文档用于把当前 `zen-slack-bot` / Zen Content Hub 迁移给另一个 agent 或另一台机器。不要把真实 `.env`、微信密钥、Slack token、OpenRouter key、Exa key 提交到 git 或贴到公开上下文。

## 1. 当前 pipeline 做什么

两种使用方式：

1. **Slack 触发自动写作发布**：Slack mention / cron → OpenRouter 写作 → Exa 调研 → 生成 `article.md` → 生成封面 → Wenyan 渲染 → 微信草稿箱。
2. **手动写稿发布**：直接写 `/Users/clarachen/zen-wechat-theme/article.md` → 调用 `wechat-draft` channel → 生成封面 → Wenyan 渲染 → 微信草稿箱。

当前多篇文章实际使用的是第二种手动发布方式，但代码也保留完整 Slack pipeline。

## 2. 仓库和本地资产

主仓库：

```bash
/Users/clarachen/zen-slack-bot
```

微信公众号主题/文章工作目录：

```bash
/Users/clarachen/zen-wechat-theme
```

当前发布文件：

```bash
/Users/clarachen/zen-wechat-theme/article.md
```

封面生成器：

```bash
/Users/clarachen/zen-push-image
```

固定正文头图和尾图：

```bash
/Users/clarachen/Downloads/ZenTrading_banner_wechat.gif
/Users/clarachen/Downloads/Weixin Image_20260706194505_80_126.png
```

注意：Markdown 图片路径中，尾图文件名要保留空格，不要写成 `%20`。

## 3. Node 依赖

项目使用 ESM。Node 建议 22+，当前本机是 Node 24。

安装：

```bash
cd /Users/clarachen/zen-slack-bot
npm ci
```

关键依赖：

- `@wenyan-md/core@3.0.10`：Markdown 渲染并发布到微信公众号草稿箱。
- `dotenv`：读取 `.env`。
- `@slack/bolt`：Slack Socket Mode。
- `better-sqlite3`：任务队列状态。
- `node-cron`：定时任务。

## 4. 环境变量

复制样例：

```bash
cp deploy/.env.example .env
chmod 600 .env
```

必须填写：

```bash
OPENROUTER_API_KEY=
OPENROUTER_MODEL=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_TEMPERATURE=0.4
OPENROUTER_HTTP_REFERER=https://zentradings.com
OPENROUTER_APP_TITLE=Zen Content Hub

EXA_API_KEY=
EXA_BASE_URL=https://api.exa.ai
EXA_NUM_RESULTS=5

SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
NOTIFY_CHANNEL_ID=

WECHAT_APP_ID=
WECHAT_APP_SECRET=

WECHAT_CHANNEL=wechat-draft
```

常用运行路径：

```bash
WORK_DIR=/srv/zen/wechat
DB_PATH=/srv/zen/runs.db
MAX_CONCURRENCY=1
DEFAULT_TIMEOUT_MS=600000
```

本机手动发布时，`WORK_DIR` 不重要，因为脚本显式传入 `/Users/clarachen/zen-wechat-theme/article.md`。

不要设置这些代理变量：

```bash
https_proxy
http_proxy
all_proxy
HTTPS_PROXY
HTTP_PROXY
ALL_PROXY
```

`src/index.js` 会拒绝带代理变量启动，避免微信出口 IP 被污染。若在本机而非 VPS 发布，需要通过 Clash 规则保证微信 API 走白名单出口。

## 5. 微信 IP 白名单

微信调用 `cgi-bin/token` 的出口 IP 必须在公众号后台白名单，否则会报：

```text
40164 invalid ip ... not in whitelist
```

生产建议：用固定公网 IP 的海外 VPS，直连 OpenRouter / Exa / 微信 / Slack，并把 VPS 公网 IP 加入公众号后台白名单。

本机当前修过的 Clash 规则：

```yaml
rules:
- DOMAIN-SUFFIX,weixin.qq.com,加强年付-US73
```

源头 merge 配置也有：

```yaml
prepend-rules:
  - DOMAIN-SUFFIX,weixin.qq.com,加强年付-US73
```

但注意：`prepend-rules` 有时不会展开到运行态最终 `rules`，必须检查运行态第一条规则是否真的存在。

验证 Clash 运行态：

```bash
curl -sS --max-time 5 \
  --unix-socket /tmp/verge/verge-mihomo.sock \
  -H 'Authorization: Bearer set-your-secret' \
  http://unix/rules
```

验证微信 token：

```bash
set -a
. ./.env
set +a
curl -sS "https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=$WECHAT_APP_ID&secret=$WECHAT_APP_SECRET"
```

成功时返回 `access_token`。失败时如果是 `40164`，先修 IP / 代理 / Clash 规则，不要继续发。

## 6. 当前发布行为的重要修改

已经改过两点：

1. 默认不自动插入账号名片，避免插入错误名片。
2. 每次发布前都会根据当前文章标题重新生成并覆盖 `cover`，避免沿用旧封面。

代码位置：

```bash
src/channels/wechat-draft.js
src/lib/cover.js
```

如果未来确认名片数据正确，需要显式开启：

```bash
WECHAT_INJECT_FOLLOW_CARD=1
```

默认不要开。

相关测试：

```bash
node --test test/cover.test.js test/wechat-draft.test.js
```

## 7. 手动写稿发布到草稿箱

文章格式必须有 frontmatter：

```markdown
---
title: 文章标题
---

![Zen Trading](/Users/clarachen/Downloads/ZenTrading_banner_wechat.gif)

正文...

![Zen Trading 社群](/Users/clarachen/Downloads/Weixin Image_20260706194505_80_126.png)
```

发布命令：

```bash
cd /Users/clarachen/zen-slack-bot
rm -f /Users/clarachen/.config/wenyan-md/token.json /Users/clarachen/.config/wenyan-md/upload-cache.json

node --input-type=module <<'NODE'
import 'dotenv/config';
import { loadConfig } from './src/config/index.js';
import wechatDraft from './src/channels/wechat-draft.js';

const config = loadConfig();
const articlePath = '/Users/clarachen/zen-wechat-theme/article.md';
const result = await wechatDraft.publish({ articlePath, config, notify: null, notifier: null });
console.log(JSON.stringify(result, null, 2));
NODE
```

返回示例：

```json
{
  "mediaId": "...",
  "title": "..."
}
```

## 8. 发布后回读校验

拿到 `mediaId` 后必须回读草稿，确认标题、正文图片、链接、是否误插名片。

```bash
cd /Users/clarachen/zen-slack-bot

node --input-type=module <<'NODE'
import 'dotenv/config';
import { loadConfig } from './src/config/index.js';
import { getToken, getDraft } from './src/lib/wechatApi.js';

const mediaId = '替换为刚返回的 mediaId';
const config = loadConfig();
const token = await getToken(config.wechat.appId, config.wechat.appSecret);
const draft = await getDraft(token, mediaId);

if (draft.errcode) {
  console.log(JSON.stringify({ ok: false, errcode: draft.errcode, errmsg: draft.errmsg }, null, 2));
  process.exit(1);
}

const item = draft.news_item?.[0] || {};
const content = item.content || '';
console.log(JSON.stringify({
  ok: true,
  title: item.title,
  contentLength: content.length,
  imgTags: (content.match(/<img\b/g) || []).length,
  hasProfileCard: content.includes('mp-common-profile'),
  mediaId,
}, null, 2));
NODE
```

期望：

```json
{
  "ok": true,
  "imgTags": 2,
  "hasProfileCard": false
}
```

## 9. Slack 自动 pipeline

启动：

```bash
cd /Users/clarachen/zen-slack-bot
node src/index.js
```

Dry-run：

```bash
HUB_DRY_RUN=1 node src/index.js
```

核心链路：

```text
Slack trigger
→ src/triggers/slack.js
→ queue / SQLite store
→ src/core/runner.js
→ Exa search
→ OpenRouter chat completion
→ WORK_DIR/article.md
→ src/channels/wechat-draft.js
→ cover generation
→ @wenyan-md/core renderAndPublish
→ 微信草稿箱
→ Slack success / failure
```

写作模型不是 Claude Code，而是 OpenRouter 模型。旧函数名 `runClaude` 只是兼容别名，实际指向 OpenRouter runner。

## 10. VPS 部署

迁移到 VPS 推荐路径：

```bash
mkdir -p /srv/zen/app
cd /srv/zen/app
git clone <repo> .
npm ci
cp deploy/.env.example .env
chmod 600 .env
vi .env
bash deploy/vps-check.sh
```

把 `vps-check.sh` 打印出的公网 IP 加到公众号后台 IP 白名单。

systemd：

```bash
cp deploy/zen-content-hub.service /etc/systemd/system/zen-content-hub.service
systemctl daemon-reload
systemctl enable --now zen-content-hub
journalctl -u zen-content-hub -f
```

如果 VPS 上也要手动发布固定头尾图，需要同步：

```bash
/Users/clarachen/zen-wechat-theme
/Users/clarachen/zen-push-image
/Users/clarachen/Downloads/ZenTrading_banner_wechat.gif
/Users/clarachen/Downloads/Weixin Image_20260706194505_80_126.png
```

在 Linux VPS 上路径应改成对应路径，并同步修改文章 Markdown 图片路径。

## 11. 常见故障

### 40164 invalid ip

微信看到的出口 IP 不在白名单。修 IP 白名单或代理规则。

### 40001 invalid credential

微信 app secret 错，或者另一套系统抢 token / 使用了旧 secret。

### 封面生成失败

确认 `/Users/clarachen/zen-push-image/render.mjs` 存在且能运行。生产机上要迁移这个封面生成器，或改 `src/lib/cover.js` 的 `DEFAULT_GENERATOR_DIR`。

### 尾图找不到

Markdown 里路径必须是：

```markdown
![Zen Trading 社群](/Users/clarachen/Downloads/Weixin Image_20260706194505_80_126.png)
```

不要把空格编码成 `%20`。

### 发布成功但草稿重复

手动脚本没有幂等保护，每跑一次会新增一篇草稿。Slack queue 里有 media_id 幂等，但手动发布没有。

## 12. 交接给另一个 agent 的最短提示词

```text
你在 /Users/clarachen/zen-slack-bot 里操作。先读 docs/PIPELINE_MIGRATION.md。
目标是把 /Users/clarachen/zen-wechat-theme/article.md 发布到微信公众号草稿箱。
不要自动插入账号名片。发布前生成新封面并覆盖 cover。
发布前先确认微信 token 能取到，若 40164 先修出口 IP/Clash/VPS 白名单。
发布后必须用 getDraft 回读校验：title、imgTags、hasProfileCard=false。
不要打印或泄露 .env 里的真实密钥。
```
