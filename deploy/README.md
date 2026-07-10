# Zen Content Hub 部署指南（海外 VPS 常驻）

本文档只描述部署步骤与文件用途，**不代表本任务已执行实际部署**。部署目标是一台已有的海外 VPS，写作内核走 OpenRouter，调研走 Exa，微信公众号发布走微信 API。

## 0. 硬要求

微信公众号后台的 IP 白名单机制要求：调用 `cgi-bin/token` 等接口的服务器出口 IP，必须提前登记在公众号后台「基本配置 → IP 白名单」里，否则接口会拒绝，常见错误码是 `40164`。

- 使用固定公网 IP 的海外 VPS，不新开云机。
- OpenRouter、Exa、微信 API、Slack 在海外机上应全部直连，不配置代理。
- 必须把 VPS 实际出口 IP 加入公众号 IP 白名单。
- `.env` 只放真实密钥，绝不提交 git。

## 1. VPS 自测

把代码放到 VPS 后，先跑：

```bash
bash deploy/vps-check.sh
```

它会检查 Node 版本、OpenRouter/Exa/微信/Slack 连通性、git、磁盘，并打印本机公网出口 IP。把打印出的 IP 加入公众号后台白名单。

## 2. 安装运行环境

推荐 Ubuntu 22.04/24.04 或同等 Linux 发行版，Node 需要 >=22：

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs git
node -v
npm -v
```

本项目不再需要安装 Claude CLI，也不需要认证 Anthropic。

## 3. 配置微信 IP 白名单

1. 登录 [微信公众平台](https://mp.weixin.qq.com)。
2. 进入「设置与开发」→「基本配置」→「IP 白名单」。
3. 把 `deploy/vps-check.sh` 打印的公网出口 IP 加进去。
4. 保存后等待几分钟生效。

如果发布时报 `40164`，优先在 VPS 上重新执行 `curl https://api.ipify.org` 或 `bash deploy/vps-check.sh`，确认实际出口 IP 与白名单一致。

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
vi /srv/zen/app/.env
```

必须填写：

- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL`
- `EXA_API_KEY`
- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `NOTIFY_CHANNEL_ID`
- `WECHAT_APP_ID`
- `WECHAT_APP_SECRET`

海外 VPS 不需要 `https_proxy`、`http_proxy`、`all_proxy`。`src/index.js` 的 `assertMainProcessDirect()` 会在主进程检测到这些代理变量时拒绝启动，避免微信调用出口 IP 被代理污染。

## 6. 本地/线上演练

先 dry-run，验证 Slack 触发、排队、OpenRouter/Exa 写作、mock 发布、Slack 回报：

```bash
HUB_DRY_RUN=1 node src/index.js
```

确认链路可用后，再去掉 `HUB_DRY_RUN`，任务会发布到微信公众号草稿箱：

```bash
node src/index.js
```

建议先到草稿箱人工核对中文金融写作质量、标题、封面、关注名片与排版，再进行后续正式发布动作。

## 7. 安装为 systemd 服务

```bash
cp deploy/zen-content-hub.service /etc/systemd/system/zen-content-hub.service
# 如果代码目录不是 /srv/zen/app，需要同步修改 unit 里的 WorkingDirectory / EnvironmentFile
systemctl daemon-reload
systemctl enable --now zen-content-hub
systemctl status zen-content-hub
journalctl -u zen-content-hub -f
```

## 8. OpenRouter 探活

`src/lib/health.js` 导出 `checkOpenRouterHealth({ config, fetchFn })`，会请求 OpenRouter `/models`，确认 API key 和网络可用。测试中仍保留 `checkClaudeAuth` 旧导出名作为兼容别名，但它实际指向 OpenRouter 探活。

可在后续接入 node-cron 或 systemd timer，每小时探活一次，失败时复用 `src/core/notifier.js` 发 Slack 告警。

## 9. 故障排查

### 微信接口报 `40164`

- 现象：Slack 失败通知里 `stage` 多为 `publish`，错误信息包含 `40164` 或 IP。
- 排查：确认 VPS 当前公网出口 IP 已加入公众号 IP 白名单；确认主进程没有设置代理变量。

### 微信接口报 `40001`

- 现象：错误信息包含 `40001` 或 `invalid credential`。
- 排查：确认 `WECHAT_APP_SECRET` 与后台一致；确认没有另一套系统使用同一 appid/secret 抢 token。

### 生成阶段失败

- 现象：Slack 失败通知 `stage=generate`。
- 排查：确认 `OPENROUTER_API_KEY`、`OPENROUTER_MODEL`、`EXA_API_KEY`；运行 `bash deploy/vps-check.sh` 检查 OpenRouter/Exa 连通性。

### 发布草稿失败，提示缺少封面

- 现象：`draft/add` 或后续更新接口提示缺少 `thumb_media_id` 或封面图。
- 排查：确认 `src/lib/cover.js` 调用的 `~/zen-push-image` 可用，且生成的封面图片已成功上传素材库并拿到 `media_id`。

### 通用手段

- `journalctl -u zen-content-hub -f`：看主服务实时日志。
- `systemctl status zen-content-hub`：确认服务是否反复重启。
- Slack 通知：失败会带 `stage` 字段，先按 `generate` / `publish` / `cover` / `card` 定位。

## 10. 本机 macOS launchd 常驻（替代方案）

如果不打算用海外 VPS，而是让这台 Mac 长期开机、随开机自动拉起 bot，可以用 macOS 自带的
launchd 代替 systemd。适用场景：电脑本身长期开机（或至少工作时间段开机），希望开机/登录后
`@bot` 就能响应，不用每次手动 `node src/index.js` 或在 VS Code 里手动跑。

### 前提

- 仓库根目录已有 `.env`（参考 `deploy/.env.example` 填好必填项）。
- `node` 在 PATH 中可用。
- **不要**给这台 Mac 上跑的主进程设置 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`：`src/index.js`
  的 `assertMainProcessDirect()` 检测到这些代理变量会直接拒绝启动。这是有意为之的设计，
  避免微信 API 调用的出口 IP 被代理节点污染。安装脚本生成的 plist 里
  `EnvironmentVariables` 只设置了 `PATH`，不会注入任何代理变量；但如果这台 Mac 本身通过
  Clash TUN 之类的系统级代理上网，进程流量依然会被转发（见下方 IP 白名单提醒）。

### 安装

```bash
bash scripts/install-launchd.sh
```

脚本会：
1. 校验 `.env` 与 `node` 是否就绪；
2. 在 `~/Library/LaunchAgents/com.zentrading.content-hub.plist` 生成/覆盖 LaunchAgent 配置
   （`RunAtLoad` 开机自启，`KeepAlive` 仅在崩溃时重启、正常退出不重启）；
3. 若已加载旧实例会先卸载再重新加载，可重复安全执行（幂等）。

### 卸载

```bash
bash scripts/uninstall-launchd.sh
```

### 看日志

```bash
tail -f ~/Library/Logs/zen-content-hub/out.log
tail -f ~/Library/Logs/zen-content-hub/err.log
```

### 查看状态 / 重启

```bash
launchctl print gui/$(id -u)/com.zentrading.content-hub | head
launchctl kickstart -k gui/$(id -u)/com.zentrading.content-hub   # 强制重启
```

### 与 VS Code 手动启动互斥

launchd 常驻和在 VS Code（或终端）里手动 `node src/index.js` **不能同时跑**——两个进程会
用同一个 Slack App Token 建立 Socket Mode 连接，重复消费同一个 Slack 事件，导致同一条消息
被处理/回复两次，甚至微信草稿箱出现重复文章。安装 launchd 常驻前，先确认没有另一个手动
启动的实例在跑（检查 VS Code 终端、`ps aux | grep 'node src/index.js'`）；反过来，如果要临时
手动调试，先执行 `bash scripts/uninstall-launchd.sh` 或至少 `launchctl bootout` 停掉常驻实例，
避免两边同时抢事件。

### 微信 IP 白名单注意事项

微信公众号后台的 IP 白名单只认服务器出口 IP。本机如果通过 Clash TUN 之类的系统级代理上网，
实际出口 IP 是代理节点的 IP，而不是本机公网 IP；切换代理节点后出口 IP 会变，微信接口会报
`40164`。用 launchd 常驻这台 Mac 时，每次更换代理节点都需要重新确认出口 IP（如
`curl https://api.ipify.org`）并同步更新公众号后台的 IP 白名单，否则发布会持续失败。
