#!/usr/bin/env bash
# Uninstall the zen-slack-bot (Zen Content Hub) macOS launchd service.
# Counterpart to scripts/install-launchd.sh. Tolerates an unloaded service and is safe to run repeatedly.
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
