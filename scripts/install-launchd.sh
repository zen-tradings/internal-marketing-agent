#!/usr/bin/env bash
# Install the zen-slack-bot (Zen Content Hub) macOS launchd persistent service.
#
# Use only on a locally attended Mac. The bot runs as the current user's LaunchAgent at boot/login, restarts on
# crashes, and does not restart after a normal exit (exit 0).
#
# The generated plist explicitly sets only the PATH required by the service. The project neither checks public egress
# IP nor blocks startup/publishing for proxy variables; macOS and Node.js determine routing. launchd does not inherit
# interactive shell-profile variables, so configure any service-specific network environment explicitly in service config.
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
  echo "请先复制 .env.example 为 .env 并填写必填项,再重新运行本脚本。" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "错误:未在 PATH 中找到 node。" >&2
  echo "请先安装 Node.js(建议 >=22)并确保当前 shell 的 PATH 能找到它,再重新运行本脚本。" >&2
  exit 1
fi

NODE_BIN="$(command -v node)"
NODE_DIR="$(cd "$(dirname "$NODE_BIN")" && pwd)"

# launchd does not read interactive shell profiles. Besides Node's directory, add common Apple Silicon and Intel
# Homebrew bin paths and prefer the current brew prefix so Poppler and other runtime tools remain available after login.
PATH_PARTS=("$NODE_DIR")
append_path_part() {
  local candidate="$1"
  [ -n "$candidate" ] || return 0
  [ -d "$candidate" ] || return 0
  local existing
  for existing in "${PATH_PARTS[@]}"; do
    [ "$existing" = "$candidate" ] && return 0
  done
  PATH_PARTS+=("$candidate")
}

BREW_PREFIX=""
if command -v brew >/dev/null 2>&1; then
  BREW_PREFIX="$(brew --prefix 2>/dev/null || true)"
fi
append_path_part "${BREW_PREFIX:+${BREW_PREFIX}/bin}"
append_path_part "/opt/homebrew/bin"
append_path_part "/usr/local/bin"
append_path_part "/usr/bin"
append_path_part "/bin"
append_path_part "/usr/sbin"
append_path_part "/sbin"
SERVICE_PATH="$(IFS=:; echo "${PATH_PARTS[*]}")"

POPLER_COMMANDS=(pdftotext pdfinfo)
for command_name in "${POPLER_COMMANDS[@]}"; do
  if ! env PATH="$SERVICE_PATH" "$command_name" -v >/dev/null 2>&1; then
    if [ -n "$BREW_PREFIX" ] && brew list --versions poppler >/dev/null 2>&1; then
      echo "错误:Poppler 已安装,但服务环境找不到 ${command_name}。" >&2
      echo "请检查 Homebrew 安装状态,然后重新运行本脚本。" >&2
    else
      echo "错误:未安装 PDF 直译所需的 Poppler 命令 ${command_name}。" >&2
      echo "请先运行 brew install poppler,再重新运行本脚本。" >&2
    fi
    exit 1
  fi
done

echo "    仓库根目录: $REPO"
echo "    node 路径:   $NODE_BIN"
echo "    服务 PATH:   $SERVICE_PATH"
echo "    Poppler:      已验证 pdftotext / pdfinfo"

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
        <string>${SERVICE_PATH}</string>
    </dict>
</dict>
</plist>
PLIST_EOF

echo "==> 加载 LaunchAgent(幂等:先尝试卸载已加载的旧实例)"
launchctl bootout "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1 \
  || launchctl bootout "gui/${UID_NUM}" "$PLIST_PATH" >/dev/null 2>&1 \
  || true

# bootout can return before the old process exits. Wait for the service to leave the launchd domain to avoid a
# transient Input/output error during the following bootstrap.
for _ in {1..20}; do
  if ! launchctl print "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

BOOTSTRAPPED=false
for _ in {1..3}; do
  if launchctl bootstrap "gui/${UID_NUM}" "$PLIST_PATH"; then
    BOOTSTRAPPED=true
    break
  fi
  sleep 1
done
if [ "$BOOTSTRAPPED" != true ]; then
  echo "错误:LaunchAgent 重新加载失败,请检查 launchctl 与日志输出。" >&2
  exit 1
fi
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
