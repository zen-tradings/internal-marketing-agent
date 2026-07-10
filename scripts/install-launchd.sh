#!/usr/bin/env bash
# 为 zen-slack-bot (Zen Content Hub) 安装 macOS launchd 开机自启常驻。
#
# 只在本机(有人值守的 Mac)使用。安装后 bot 会作为当前登录用户的 LaunchAgent
# 在开机/登录时自动拉起，进程崩溃时自动重启，正常退出(exit 0)则不重启。
#
# 重要:生成的 plist 里 EnvironmentVariables 只设置 PATH，绝不注入
# HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 等代理变量。src/index.js 的
# assertMainProcessDirect() 会在主进程检测到这些代理变量时主动拒绝启动——
# 这是有意为之的设计(避免微信 API 调用的出口 IP 被代理污染，导致 IP 白名单失效)。
# 如果你的 shell profile 里全局导出了代理变量，不会影响 launchd 启动的进程，
# 因为 launchd 不会继承交互式 shell 的环境变量。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.zentrading.content-hub"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/zen-content-hub"
UID_NUM="$(id -u)"

echo "==> 校验运行前提"

if [ ! -f "$REPO/.env" ]; then
  echo "错误:未找到 $REPO/.env。" >&2
  echo "请先参考 deploy/.env.example 在仓库根目录创建 .env(含 OPENROUTER_API_KEY / SLACK_BOT_TOKEN 等必填项),再重新运行本脚本。" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "错误:未在 PATH 中找到 node。" >&2
  echo "请先安装 Node.js(建议 >=22)并确保当前 shell 的 PATH 能找到它,再重新运行本脚本。" >&2
  exit 1
fi

NODE_BIN="$(command -v node)"
NODE_DIR="$(cd "$(dirname "$NODE_BIN")" && pwd)"

echo "    仓库根目录: $REPO"
echo "    node 路径:   $NODE_BIN"

echo "==> 准备日志目录"
mkdir -p "$LOG_DIR"
mkdir -p "$PLIST_DIR"

echo "==> 生成 plist: $PLIST_PATH"
cat > "$PLIST_PATH" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>src/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${REPO}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>Crashed</key>
        <true/>
    </dict>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/out.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
PLIST_EOF

echo "==> 加载 LaunchAgent(幂等:先尝试卸载已加载的旧实例)"
launchctl bootout "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${UID_NUM}" "$PLIST_PATH"
launchctl kickstart -k "gui/${UID_NUM}/${LABEL}"

echo ""
echo "==> 安装完成"
echo ""
echo "查看运行状态:"
echo "  launchctl print gui/${UID_NUM}/${LABEL} | head"
echo ""
echo "查看日志:"
echo "  tail -f ${LOG_DIR}/out.log"
echo "  tail -f ${LOG_DIR}/err.log"
echo ""
echo "提醒:plist 中记录的是本次安装时解析到的 node 绝对路径(${NODE_BIN})。"
echo "如果之后升级/切换了 node 版本(路径变化,例如 nvm/homebrew 切换版本),需要重新运行本脚本以刷新 plist。"
