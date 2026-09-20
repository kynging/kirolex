#!/usr/bin/env bash
#
# 远程会话的远端预置脚本（docs/DESIGN_remote_sessions.md）。
#
# 幂等，可以反复跑。只做三件事：装 rsync/git、确认 kiro-cli 在、打印一份自检。
#
#   scp scripts/remote-bootstrap.sh <host>:~/ && ssh <host> 'bash ~/remote-bootstrap.sh'
#
# 故意**不**做的事：
#   · 不装 LibreOffice / node_modules / 构建链 —— 远程会话不做构建、测试、预览/PPT
#     （原生依赖跨平台不能用，而文件本来就在本地，那些活留在本地做）
#   · 不写任何凭据、不替你登录 —— 登录要你自己在这台机器上跑 `kiro-cli login`
#   · 不动 KiroLex 的任何配置
set -u

say() { printf '%s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

PKG=""
if have dnf; then PKG="dnf"
elif have yum; then PKG="yum"
elif have apt-get; then PKG="apt-get"
fi

install_pkg() {
  local name="$1"
  have "$name" && return 0
  if [ -z "$PKG" ]; then
    say "✗ 不认识这台机器的包管理器（没有 dnf/yum/apt-get），请手动装 $name"
    return 1
  fi
  say "→ 装 $name（$PKG）"
  case "$PKG" in
    dnf|yum) sudo "$PKG" install -y "$name" >/dev/null 2>&1 ;;
    apt-get) sudo apt-get update -qq >/dev/null 2>&1 && sudo apt-get install -y -qq "$name" >/dev/null 2>&1 ;;
  esac
  have "$name"
}

rc=0
for b in rsync git; do
  install_pkg "$b" || rc=1
done

# kiro-cli 不走包管理器。装法可能随版本变，所以这里只**确认并说清**，不猜一个下载地址 ——
# 猜错会装上一个不能用的东西，比明确报错糟。
if ! have kiro-cli; then
  say "✗ 这台机器上没有 kiro-cli。按你平时的装法装一次（通常在 ~/.local/bin/kiro-cli），再跑一遍这个脚本。"
  rc=1
fi

say ""
say "=== 自检 ==="
say "uname   : $(uname -srm)"
for b in kiro-cli rsync git; do
  if have "$b"; then
    say "$(printf '%-8s' "$b"): $(command -v "$b")  $("$b" --version 2>/dev/null | head -1)"
  else
    say "$(printf '%-8s' "$b"): 缺"
  fi
done

if have kiro-cli; then
  if kiro-cli whoami >/dev/null 2>&1; then
    say "登录    : 已登录  $(kiro-cli whoami 2>/dev/null | head -1)"
  else
    say "登录    : **没登录** —— 在这台机器上跑 \`kiro-cli login\`。"
    say "          （没登录的话执行器起得来、但每一轮都空回，看起来像服务端在返空响应）"
    rc=1
  fi
fi

say ""
if [ "$rc" -eq 0 ]; then
  say "✓ 这台机器可以跑远程会话了。文件仍然存在你本地，KiroLex 会在每一轮前后同步镜像。"
else
  say "✗ 还差上面标 ✗ / 缺 / 没登录 的那几项。"
fi
exit "$rc"
