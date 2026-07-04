# Zen Content Hub 部署指南（国内 VPS 常驻）

本文档只描述部署步骤与文件用途，**不代表本任务已执行实际部署**——部署工件（`.env.example` / systemd unit / 本文档）在这里只是写好，供后续人工/脚本在真实 VPS 上执行。

## 0. 为什么这台机器必须是「国内 VPS + 固定公网 IP」

微信公众号后台的 IP 白名单机制要求：调用 `cgi-bin/token` 等接口的服务器出口 IP，必须提前登记在公众号后台「基本配置 → IP 白名单」里，否则接口直接拒绝（错误码 `40164`）。这意味着：

- **不能用海外 VPS**：国内到微信 API 的网络质量、以及很多微信接口对非大陆 IP 有额外风控，稳定性差。
- **不能用会漂移 IP 的机器**（例如某些按需重启就换 IP 的云主机、家庭宽带 PPPoE 拨号）：IP 一变，白名单立刻失效，服务不可用直到重新加白。
- **必须选「固定公网 IP」套餐**：阿里云 / 腾讯云 / 华为云等按量或包年的 ECS/CVM，绑定弹性公网 IP（EIP），全程不释放。

> 项目历史踩坑记录（wenyan-mcp 出口 IP 曾经漂移，撞过两次 40164）：出口 IP 一旦变化 = 服务立即中断，且不会有明显报错日志提示"是 IP 问题"，容易误判为 token 或代码 bug。**这是本项目上线后最容易复发的故障，务必按下面的固定 IP + 白名单流程执行，不要临时用测试机 IP 顶替。**

## 1. VPS 选型与准备

1. 选择大陆节点的云服务器（ECS/CVM/云主机均可），操作系统 Ubuntu 22.04/24.04 或同等 Linux 发行版。
2. 购买/绑定一个**弹性公网 IP（EIP）**并明确该 IP 长期不变（不要用临时公网 IP、不要开启自动续费释放）。
3. 记录这个固定公网 IP，下一步要用。

## 2. 把 VPS 出口 IP 加入公众号 IP 白名单

1. 登录 [微信公众平台](https://mp.weixin.qq.com) → 「设置与开发」→「基本配置」→ 找到「IP 白名单」。
2. 点击「修改」，把第 1 步记录的固定公网 IP 添加进去（多个 IP 用换行分隔）。
3. 保存后**等待几分钟生效**（不是立即生效，首次部署验证时留出等待时间，不要一测失败就怀疑代码）。
4. 建议：VPS 上执行 `curl ifconfig.me`（走直连，不能挂代理）确认实际出口 IP 与白名单里登记的一致——云厂商的 NAT/多网卡场景下，服务器看到的内网 IP 不等于外部实际出口 IP。

## 3. 安装运行环境

```bash
# Node 24
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
node -v   # 确认 >= 24

# Claude CLI
npm install -g @anthropic-ai/claude-code   # 或参照官方安装脚本
```

### 认证 Claude CLI（必须经代理，因为 Anthropic 服务在境外）

大陆 VPS 直连无法访问 Anthropic，认证与后续调用都要走代理。在**认证这一步**临时导出代理变量（注意：只在认证这个 shell 会话里设置，不要写进服务的 `.env` 主进程会用到的变量里）：

```bash
export https_proxy=http://127.0.0.1:7897
export all_proxy=socks5://127.0.0.1:7897
claude   # 走一遍登录/认证流程
unset https_proxy all_proxy
```

认证成功后，`claude` 会把凭证缓存在本地（一般在 `~/.claude` 下），后续子进程调用不需要重新走浏览器登录，只需要在**运行时**通过 `CHILD_HTTPS_PROXY` / `CHILD_ALL_PROXY`（见下文 `.env`）让 Claude 子进程能连上 Anthropic 即可。

> 关键约束（Task 12 已在代码里强制校验）：**主进程（微信 API 调用）严禁设置 `https_proxy`/`http_proxy`/`all_proxy`**，一旦检测到会直接抛错拒绝启动（见 `src/index.js` 的 `assertMainProcessDirect()`）。代理只能通过 `.env` 里的 `CHILD_HTTPS_PROXY` / `CHILD_ALL_PROXY` 注入 Claude 子进程，两条链路必须物理隔离，否则微信调用会被代理节点污染出口 IP，导致白名单失效。

## 4. 部署代码

```bash
mkdir -p /srv/zen/app
# 把仓库代码拉到 /srv/zen/app（git clone 或 rsync）
cd /srv/zen/app
npm ci
```

## 5. 配置 `.env`

```bash
cp deploy/.env.example /srv/zen/app/.env
chmod 600 /srv/zen/app/.env
vi /srv/zen/app/.env   # 填入真实的 SLACK_BOT_TOKEN / SLACK_APP_TOKEN / NOTIFY_CHANNEL_ID / WECHAT_APP_ID / WECHAT_APP_SECRET / 代理地址
```

各字段含义见 `deploy/.env.example` 内注释；再次强调：`CHILD_HTTPS_PROXY`/`CHILD_ALL_PROXY` 只给 Claude 子进程用，`NO_PROXY` 必须包含 `api.weixin.qq.com,mp.weixin.qq.com`，确保即使误配置也不会把微信调用导向代理。

## 6. 安装为 systemd 服务并启动

```bash
cp deploy/zen-content-hub.service /etc/systemd/system/zen-content-hub.service
# 如果代码目录不是 /srv/zen/app，需要同步修改 unit 里的 WorkingDirectory / EnvironmentFile
systemctl daemon-reload
systemctl enable --now zen-content-hub
systemctl status zen-content-hub
journalctl -u zen-content-hub -f   # 查看实时日志
```

## 7. Claude 认证保活

Claude CLI 的登录凭证可能过期（例如长期未用、被服务端吊销）。子进程认证失效不会让 systemd 服务本身崩溃（`runClaude` 只是让单次任务失败），因此需要**主动定时探活**，而不是等用户发文时才发现。

用法：`src/lib/health.js` 导出 `checkClaudeAuth({ execFn })`，注入一个真正执行命令的 `execFn`（例如封装 `node:child_process` 的 `execFile`），跑一次极小的 `claude -p "ping" --output-format json`：

```js
import { checkClaudeAuth } from '../src/lib/health.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const pExecFile = promisify(execFile);

const execFn = (cmd, args) => pExecFile(cmd, args, {
  env: { ...process.env, https_proxy: process.env.CHILD_HTTPS_PROXY, all_proxy: process.env.CHILD_ALL_PROXY },
});

const { ok, detail } = await checkClaudeAuth({ execFn });
if (!ok) {
  // 复用 src/core/notifier.js 的 notifier.warn(...) 把 detail 发到 Slack 告警频道
}
```

建议接入方式二选一：

- **node-cron**（项目已依赖 `node-cron`）：在 `src/index.js` 启动流程里加一条每小时的 cron job，调用上面的探活逻辑，失败时通过既有的 `createNotifier` 往 `NOTIFY_CHANNEL_ID` 发 `⚠️` 告警。
- **系统级 systemd timer**：额外写一个一次性脚本 + `zen-content-hub-healthcheck.timer`，与主服务解耦，即使主服务卡死也能告警。

保活探活本身**不需要真的调用生产 claude 二进制去测试**——这属于运行期集成，本任务只交付 `checkClaudeAuth` 函数与说明，接入 cron 的具体代码留给部署时按需接线。

## 8. 故障排查

### 8.1 微信接口报 `40164`（IP 不在白名单）

- 现象：Slack 收到失败通知，`stage` 多为 `publish`，错误信息里包含 `40164` 或“IP”。
- 排查：
  1. `curl ifconfig.me`（不挂代理）确认服务器当前实际出口 IP。
  2. 对照公众号后台「IP 白名单」列表，看是否一致。云主机换了套餐、重装系统、或运营商 NAT 出口漂移都可能导致这个 IP 变化。
  3. 不一致就把新 IP 加回白名单，等待几分钟生效后重试。
  4. 长期方案：优先选择「弹性公网 IP 单独购买并绑定」的云主机规格，避免和「随实例分配、实例重建就变」的公网 IP 混用。

### 8.2 微信接口报 `40001`（access_token 无效/过期）

- 现象：错误信息包含 `40001` 或 `invalid credential`。
- 常见原因：
  - `WECHAT_APP_SECRET` 填错或改密后未同步 `.env`。
  - 同一个 `appid/secret` 被另一套系统/另一台机器并发调用 `getAccessToken`，各自本地缓存的 token 互相顶掉（微信 access_token 全局唯一，最新一次调用会让旧 token 失效）。
  - 时钟漂移导致以为 token 还没过期。
- 排查：确认 `.env` 里的 `WECHAT_APP_SECRET` 与后台一致；确认没有其他脚本/服务在用同一个 appid 抢 token；必要时重启服务强制重新获取。

### 8.3 发布草稿失败，提示缺少封面（cover）

- 现象：`draft/add` 或后续更新接口报错提示缺少 `thumb_media_id` / 封面图。
- 排查：确认 `src/lib/cover.js`（或工作流里生成封面的步骤）产出的封面图片已成功上传素材库并拿到 `media_id`，再传给草稿接口；检查封面图片尺寸/格式是否符合微信要求（建议使用项目内既有封面生成逻辑，不要跳过这一步直接传空值）。

### 8.4 其他排查通用手段

- `journalctl -u zen-content-hub -f`：看主服务实时日志。
- `systemctl status zen-content-hub`：确认服务是否处于 `Restart=always` 的反复重启循环（如果是，说明启动阶段就在报错，通常是 `.env` 缺关键变量或 `assertMainProcessDirect()` 因主进程误设代理而拒绝启动）。
- Slack 通知：所有任务失败都会带 `stage` 字段（`generate`/`publish`/`card` 等），先看 `stage` 定位是 Claude 生成阶段还是微信发布阶段的问题。
