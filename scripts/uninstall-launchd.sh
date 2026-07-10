#!/usr/bin/env bash
# 卸载 zen-slack-bot (Zen Content Hub) 的 macOS launchd 常驻。
# 对应 scripts/install-launchd.sh。容忍"当前未加载"的情况,可重复执行。
set -euo pipefail

LABEL="com.zentrading.content-hub"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

echo "==> 卸载 LaunchAgent: ${LABEL}"
launchctl bootout "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1 || echo "    (未加载,跳过)"

if [ -f "$PLIST_PATH" ]; then
  rm -f "$PLIST_PATH"
  echo "    已删除 $PLIST_PATH"
else
  echo "    plist 不存在,跳过删除:$PLIST_PATH"
fi

echo "==> 卸载完成"
