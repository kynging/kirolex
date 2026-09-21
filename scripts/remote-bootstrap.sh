#!/usr/bin/env bash
#
# 远程会话的远端安装脚本（docs/DESIGN_remote_sessions.md）。
#
# 幂等，可以反复跑。装齐远端跑一条会话需要的东西，然后打印一份自检：
#
#   · 系统包       rsync git unzip tar（rsync 是镜像同步的命脉，没有它这功能整个不成立）
#   · Node（fnm）  claude-code / codex 都是 npm 包，没有 node 就装不上
#   · kiro-cli     从 desktop-release 取对应架构的 zip，跑它自带的 install.sh
#   · claude-code  官方安装脚本 https://claude.ai/install.sh（顺带 @zed-industries/claude-code-acp，
#                  ACP 后端要它；官方脚本装的是原生二进制，不依赖 node）
#   · codex        @openai/codex（官方发布在 npm）
#   · kiro-cli 登录（device flow —— 这台机器没有浏览器，所以打印 URL + code，你在本机浏览器里完成）
#   · uv + mcp-proxy-for-aws + 把 kiro-cli 默认 agent 的 web search MCP 装进 claude code
#     （端点由 KiroLex 从本机实际在跑的那份配置里读出来，用 WEBSEARCH_MCP_URL 传进来 —— 不写死）
#
# KiroLex 的设置界面上有一个按钮直接跑它（「安装依赖」），也可以自己来：
#   scp scripts/remote-bootstrap.sh <host>:~/ && ssh <host> 'bash ~/remote-bootstrap.sh'
#
# 故意**不**做的事：
#   · 不装 LibreOffice / 不装项目依赖（node_modules）/ 不跑构建 —— 远程会话不做构建、测试、预览。
#     那些活在本地做（文件本来就在本地），而 node_modules 里的原生二进制跨平台根本不能用。
#   · 不写任何凭据。登录**不是**代你输密码：走的是 device flow —— 授权动作始终在你自己的浏览器里，
#     脚本只负责把那个 URL 和 code 打出来（没登录这个症状最坑：执行器起得来、但每一轮都空回）。
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
# claude code 用**官方安装脚本**（原生二进制，不依赖 node）；装不上再退回 npm。
# 实测这台机器上 https://claude.ai/install.sh 取到的就是官方 bash 安装器。
if have claude && [ "$FORCE" != "1" ]; then
  say "→ claude 已在 ($(claude --version </dev/null 2>/dev/null | head -1))"
else
  say "→ 官方安装脚本 https://claude.ai/install.sh"
  if curl -fsSL https://claude.ai/install.sh 2>/dev/null | bash >/dev/null 2>&1; then
    export PATH="$HOME/.local/bin:$PATH"
  fi
  have claude || npm_i '@anthropic-ai/claude-code' claude
fi
npm_i '@openai/codex' codex
# ACP 适配层：KiroLex 走 ACP，claude code 要靠它才能当执行器
npm_i '@zed-industries/claude-code-acp' claude-code-acp

# ---------------------------------------------------------------- kiro 登录
#
# 这台机器没有浏览器，所以用 `--use-device-flow`：它打印一个 URL + 一串 code，你在**本机**
# 浏览器里完成授权，这条命令随即返回。参数由 KiroLex 从本机已登录的那份状态里读出来传进来
# （`KIRO_LOGIN_PROVIDER` / `KIRO_LOGIN_REGION`），**不写死在脚本里** —— 那是这个账号自己的地址。
#
# 没登录这个症状最坑：执行器起得来、每一轮都空回，看起来像服务端在返空响应。
step "kiro-cli 登录"
if ! have kiro-cli; then
  say "→ 跳过：这台机器上还没有 kiro-cli"
elif kiro-cli whoami </dev/null >/dev/null 2>&1; then
  say "→ 已登录  $(kiro-cli whoami </dev/null 2>/dev/null | head -1)"
elif [ -n "${KIRO_LOGIN_PROVIDER:-}" ]; then
  say "→ 没登录。用 device flow 登录（授权在**你自己的浏览器**里完成）："
  say "   provider ${KIRO_LOGIN_PROVIDER}${KIRO_LOGIN_REGION:+  region ${KIRO_LOGIN_REGION}}"
  say "   下面会打印一个链接和一串 code —— 打开链接、输入 code，这里就会继续。"
  # shellcheck disable=SC2086
  if kiro-cli login --license pro --use-device-flow \
      --identity-provider "$KIRO_LOGIN_PROVIDER" \
      ${KIRO_LOGIN_REGION:+--region "$KIRO_LOGIN_REGION"} </dev/null 2>&1; then
    say "→ 登录完成  $(kiro-cli whoami </dev/null 2>/dev/null | head -1)"
  else
    note_fail "登录没完成（超时或被取消）。可以再点一次「安装依赖」，或者自己 ssh 上去跑 kiro-cli login"
  fi
else
  note_fail "没登录，而且 KiroLex 没能从本机读出登录参数（provider/region）——"
  say "   请 ssh 到这台机器手动跑一次：kiro-cli login --license pro --use-device-flow"
fi

# ------------------------------------------- web search MCP（给 claude code）
#
# kiro-cli 的内置 agent 挂着一个 `agentcore-websearch`（mcp-proxy-for-aws 代理一个 SigV4 的
# AgentCore 网关）。这一段把**同一套配置**装进这台机器的 claude code 里。
#
# 端点不写死在脚本里：它是这个账号自己的网关地址，写进仓库既是泄漏、换账号之后又会悄悄失效。
# 由 KiroLex 从本机实际在跑的那份配置里读出来，用 WEBSEARCH_MCP_URL 传进来；没传就跳过。
#
# **不抄 `--profile default`**：本机是那么配的，而这台机器走的是实例角色 —— 照抄过去只会让它
# 一启动就找不到 profile。
step "web search MCP（装进 claude code）"
WEBSEARCH_MCP_URL="${WEBSEARCH_MCP_URL:-}"
WEBSEARCH_MCP_SERVICE="${WEBSEARCH_MCP_SERVICE:-bedrock-agentcore}"
WEBSEARCH_MCP_REGION="${WEBSEARCH_MCP_REGION:-us-east-1}"
WEBSEARCH_MCP_NAME="${WEBSEARCH_MCP_NAME:-agentcore-websearch}"

if [ -z "$WEBSEARCH_MCP_URL" ]; then
  say "→ 跳过：没拿到端点（KiroLex 从本机 kiro-cli 的实际调用里读它；本机那条 MCP 没在跑时读不到）"
elif ! have claude; then
  say "→ 跳过：这台机器上没有 claude"
else
  # uv 用**官方安装脚本**；mcp-proxy-for-aws 是个 python 工具，uv tool 装完就在 ~/.local/bin 里
  if ! have uv; then
    say "→ 官方安装脚本 https://astral.sh/uv/install.sh"
    curl -LsSf https://astral.sh/uv/install.sh 2>/dev/null | sh >/dev/null 2>&1
    export PATH="$HOME/.local/bin:$PATH"
  fi
  if have uv && { ! have mcp-proxy-for-aws || [ "$FORCE" = "1" ]; }; then
    say "→ uv tool install mcp-proxy-for-aws"
    uv tool install --force mcp-proxy-for-aws >/dev/null 2>&1 || note_fail "mcp-proxy-for-aws 装不上"
    export PATH="$HOME/.local/bin:$PATH"
  fi
  if have mcp-proxy-for-aws; then
    # 幂等：已经登记过就先删再加（改了端点也能生效）
    if claude mcp list </dev/null 2>/dev/null | grep -q "$WEBSEARCH_MCP_NAME"; then
      claude mcp remove --scope user "$WEBSEARCH_MCP_NAME" </dev/null >/dev/null 2>&1 || true
    fi
    say "→ claude mcp add $WEBSEARCH_MCP_NAME"
    if claude mcp add --scope user "$WEBSEARCH_MCP_NAME" -- \
        mcp-proxy-for-aws "$WEBSEARCH_MCP_URL" \
        --service "$WEBSEARCH_MCP_SERVICE" --region "$WEBSEARCH_MCP_REGION" </dev/null >/dev/null 2>&1; then
      say "  已登记（走这台机器自己的 AWS 凭证签名：实例角色或 ~/.aws）"
    else
      note_fail "claude mcp add 失败"
    fi
  else
    note_fail "没有 mcp-proxy-for-aws，装不了 web search MCP"
  fi
fi

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

if have claude; then
  if claude mcp list </dev/null 2>/dev/null | grep -q "${WEBSEARCH_MCP_NAME:-agentcore-websearch}"; then
    say "web search MCP : 已登记到 claude code"
  else
    say "web search MCP : 没有（端点没传进来，或者 claude 不在）"
  fi
fi

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
