#!/usr/bin/env bash
# Zen Content Hub — 海外 VPS 可用性自测
# 用法:在 VPS 上执行  bash deploy/vps-check.sh
# 判断这台 VPS 能否跑本引擎(OpenRouter 写作内核 + 直连微信发布)。
# 只读检查,不改动任何东西。
set -u

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
hr()   { printf '\n== %s ==\n' "$1"; }

hr "1. 运行时"
if command -v node >/dev/null 2>&1; then
  NV=$(node -v); MAJ=${NV#v}; MAJ=${MAJ%%.*}
  if [ "${MAJ:-0}" -ge 22 ]; then pass "Node $NV (>=22)"; else fail "Node $NV 过低,需 >=22"; fi
else fail "未安装 node(需 >=22)"; fi
command -v npm >/dev/null 2>&1 && pass "npm $(npm -v)" || fail "未安装 npm"
command -v git >/dev/null 2>&1 && pass "git $(git --version | awk '{print $3}')" || warn "未安装 git(部署时需要)"

hr "2. 出站连通性(海外机应全部直连)"
chk() { # $1=名称 $2=url  (期望能拿到 HTTP 状态码)
  code=$(curl -s -o /dev/null -m 12 -w '%{http_code}' "$2" 2>/dev/null)
  if [ -n "$code" ] && [ "$code" != "000" ]; then pass "$1 可达 (HTTP $code)"; else fail "$1 不可达(超时/被墙?)"; fi
}
chk "OpenRouter  " "https://openrouter.ai/api/v1/models"
chk "Exa         " "https://api.exa.ai"
chk "微信 API    " "https://api.weixin.qq.com/cgi-bin/token"
chk "Slack       " "https://slack.com/api/api.test"

hr "3. 本机公网 IP(加入公众号 IP 白名单用)"
IP=$(curl -s -m 10 https://api.ipify.org 2>/dev/null || curl -s -m 10 ifconfig.me 2>/dev/null)
if [ -n "$IP" ]; then
  pass "公网出口 IP: $IP"
  echo "     → 到「公众号后台 → 设置与开发 → 基本配置 → IP 白名单」把这个 IP 加进去,否则发布报 40164。"
  echo "     → 确认它是固定 IP(非弹性/漂移)。"
else fail "取不到公网 IP"; fi

hr "4. 资源"
df -h / 2>/dev/null | awk 'NR==2{print "  磁盘 /: 已用 "$5" 可用 "$4}'
if command -v free >/dev/null 2>&1; then free -h | awk 'NR==2{print "  内存: 总 "$2" 可用 "$7}'; fi

hr "结论"
echo "  以上若 Node>=22、OpenRouter/Exa/微信 三项可达、且拿到固定公网 IP,则这台 VPS 可用。"
echo "  下一步:npm ci → 配 .env(见 deploy/.env.example)→ 把上面 IP 加白名单 → HUB_DRY_RUN=1 演练 → 真实冒烟。"
