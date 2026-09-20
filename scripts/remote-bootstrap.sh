#!/usr/bin/env bash
#
# 远程会话的远端安装脚本（docs/DESIGN_remote_sessions.md）。
#
# 幂等，可以反复跑。装齐远端跑一条会话需要的东西，然后打印一份自检：
#
#   · 系统包       rsync git unzip tar（rsync 是镜像同步的命脉，没有它这功能整个不成立）
#   · Node（fnm）  claude-code / codex 都是 npm 包，没有 node 就装不上
#   · kiro-cli     从 desktop-release 取对应架构的 zip，跑它自带的 install.sh
#   · claude-code  @anthropic-ai/claude-code（顺带 @zed-industries/claude-code-acp，ACP 后端要它）
#   · codex        @openai/codex
#
# KiroLex 的设置界面上有一个按钮直接跑它（「安装依赖」），也可以自己来：
#   scp scripts/remote-bootstrap.sh <host>:~/ && ssh <host> 'bash ~/remote-bootstrap.sh'
#
# 故意**不**做的事：
#   · 不装 LibreOffice / 不装项目依赖（node_modules）/ 不跑构建 —— 远程会话不做构建、测试、预览。
#     那些活在本地做（文件本来就在本地），而 node_modules 里的原生二进制跨平台根本不能用。
#   · 不写任何凭据、不替你登录 —— 登录要你自己在这台机器上跑 `kiro-cli login`。
#     脚本只负责**告诉你**没登录（这个症状最坑：执行器起得来、但每一轮都空回）。
#   · 已经装好的东西默认跳过。想强制重装：`FORCE=1 bash remote-bootstrap.sh`
set -u

FORCE="${FORCE:-0}"
KIRO_RELEASE_BASE="${KIRO_RELEASE_BASE:-https://desktop-release.q.us-east-1.amazonaws.com/latest}"

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s ==\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

rc=0
note_fail() { say "✗ $*"; rc=1; }

# ---------------------------------------------------------------- 系统包
step "系统包（rsync / git / unzip / tar）"
PKG=""
if have dnf; then PKG="dnf"
elif have yum; then PKG="yum"
elif have apt-get; then PKG="apt-get"
fi

install_pkg() {
  local name="$1"
  if have "$name" && [ "$FORCE" != "1" ]; then say "→ $name 已在 ($(command -v "$name"))"; return 0; fi
  if [ -z "$PKG" ]; then
    note_fail "不认识这台机器的包管理器（没有 dnf/yum/apt-get），请手动装 $name"
    return 1
  fi
  say "→ 装 $name（$PKG）"
  case "$PKG" in
    dnf|yum) sudo "$PKG" install -y "$name" >/dev/null 2>&1 ;;
    apt-get) sudo apt-get update -qq >/dev/null 2>&1 && sudo apt-get install -y -qq "$name" >/dev/null 2>&1 ;;
  esac
  have "$name" || { note_fail "$name 装不上（权限？源？）"; return 1; }
}

for b in rsync git unzip tar; do install_pkg "$b"; done

# ---------------------------------------------------------------- Node
# claude-code 和 codex 都是 npm 包。用 fnm 而不是系统 nodejs：发行版自带的往往太老，
# 而这两个包对 node 版本有要求；fnm 装在用户目录下，不需要 sudo，也不会动系统的 node。
step "Node（给 claude-code / codex 用）"
export PATH="$HOME/.local/bin:$HOME/.local/share/fnm:$PATH"
load_fnm() {
  if [ -x "$HOME/.local/share/fnm/fnm" ]; then
    eval "$("$HOME/.local/share/fnm/fnm" env --shell bash)" 2>/dev/null || true
  fi
}
load_fnm

if have node; then
  say "→ node 已在 $(node -v)"
else
  if ! have fnm && [ ! -x "$HOME/.local/share/fnm/fnm" ]; then
    say "→ 装 fnm"
    curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell --install-dir "$HOME/.local/share/fnm" >/dev/null 2>&1
  fi
  load_fnm
  if have fnm || [ -x "$HOME/.local/share/fnm/fnm" ]; then
    say "→ 装 node 22（LTS）"
    "${HOME}/.local/share/fnm/fnm" install 22 >/dev/null 2>&1 || fnm install 22 >/dev/null 2>&1
    "${HOME}/.local/share/fnm/fnm" default 22 >/dev/null 2>&1 || fnm default 22 >/dev/null 2>&1
    load_fnm
  fi
  have node || note_fail "node 没装上 —— claude-code / codex 都要它"
fi

# ---------------------------------------------------------------- kiro-cli
# 装法是从这台机器上实测出来的（bash 历史里就是这一条 URL），不是猜的：
#   curl … desktop-release.q.us-east-1.amazonaws.com/latest/kirocli-x86_64-linux.zip
# 解出来是 kirocli/{install.sh,bin/}，install.sh 把三个二进制放进 ~/.local/bin 再跑
# `kiro-cli setup`（参数透传，所以给 --no-confirm）。
step "kiro-cli"
if have kiro-cli && [ "$FORCE" != "1" ]; then
  say "→ kiro-cli 已在 $(kiro-cli --version 2>/dev/null | head -1)"
else
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) zip_name="kirocli-x86_64-linux.zip" ;;
    aarch64|arm64) zip_name="kirocli-aarch64-linux.zip" ;;
    *) zip_name="" ;;
  esac
  if [ -z "$zip_name" ]; then
    note_fail "不认识的架构 $arch —— 手动装 kiro-cli 再跑一遍"
  else
    tmp="$(mktemp -d)"
    say "→ 下载 $zip_name"
    if curl --proto '=https' --tlsv1.2 -sSf "$KIRO_RELEASE_BASE/$zip_name" -o "$tmp/kirocli.zip"; then
      say "→ 解包并安装（install.sh → ~/.local/bin）"
      if unzip -q -o "$tmp/kirocli.zip" -d "$tmp"; then
        sh "$tmp/kirocli/install.sh" --no-confirm >/dev/null 2>&1 || true
      fi
    else
      note_fail "下载失败（这台机器连不上 $KIRO_RELEASE_BASE？）"
    fi
    rm -rf "$tmp"
    have kiro-cli || note_fail "kiro-cli 没装上"
  fi
fi

# ------------------------------------------------- claude code / codex
step "claude code / codex（npm 全局）"
npm_i() {
  local pkg="$1" bin="$2"
  # `</dev/null`：有些工具（claude-code-acp 是 stdio 上的 ACP 服务）会读 stdin，
  # 而脚本若是从 stdin 喂进来的，它就会把剩下的脚本吃掉 —— 实测过，自检整段没跑而退出码还是 0。
  if have "$bin" && [ "$FORCE" != "1" ]; then say "→ $bin 已在 ($("$bin" --version </dev/null 2>/dev/null | head -1))"; return 0; fi
  if ! have npm; then note_fail "没有 npm，装不了 $pkg"; return 1; fi
  say "→ npm i -g $pkg"
  npm install -g "$pkg" >/dev/null 2>&1 || { note_fail "$pkg 装不上"; return 1; }
}
npm_i '@anthropic-ai/claude-code' claude
npm_i '@openai/codex' codex
# ACP 适配层：KiroLex 走 ACP，claude code 要靠它才能当执行器
npm_i '@zed-industries/claude-code-acp' claude-code-acp

# ---------------------------------------------------------------- 自检
step "自检"
say "uname   : $(uname -srm)"
for b in kiro-cli rsync git unzip node npm claude codex claude-code-acp; do
  if have "$b"; then
    say "$(printf '%-16s' "$b"): $(command -v "$b")  $("$b" --version </dev/null 2>/dev/null | head -1)"
  else
    say "$(printf '%-16s' "$b"): 缺"
    case "$b" in
      kiro-cli|rsync|git) rc=1 ;;   # 这三个缺了远程会话根本跑不起来
    esac
  fi
done

if have kiro-cli; then
  if kiro-cli whoami </dev/null >/dev/null 2>&1; then
    say "登录            : 已登录  $(kiro-cli whoami </dev/null 2>/dev/null | head -1)"
  else
    say "登录            : **没登录** —— 在这台机器上跑 \`kiro-cli login\`。"
    say "                  （没登录的话执行器起得来、但每一轮都空回，看起来像服务端在返空响应）"
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
