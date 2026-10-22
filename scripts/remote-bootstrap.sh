#!/usr/bin/env bash
#
# 远程会话的远端安装脚本（docs/DESIGN_remote_sessions.md）。
#
# 幂等，可以反复跑。装齐远端跑一条会话需要的东西，然后打印一份自检：
#
#   · 系统包       git unzip tar（装 kiro-cli 的 zip 要它们）
#   · Node（fnm）  claude-code / codex 都是 npm 包，没有 node 就装不上
#   · kiro-cli     从 desktop-release 取对应架构的 zip，跑它自带的 install.sh
#   · claude-code  官方安装脚本 https://claude.ai/install.sh（顺带 ACP 适配器 @agentclientprotocol/claude-agent-acp，
#                  ACP 后端要它；官方脚本装的是原生二进制，不依赖 node）
#   · codex        @openai/codex（官方发布在 npm）
#   · kiro-cli 登录（device flow —— 这台机器没有浏览器，所以打印 URL + code，你在本机浏览器里完成）
#
# 故意**不**碰 kiro-cli 的配置：不写 agent、不登记 MCP、不动 ~/.kiro。
# 远端那条会话用的 agent 是 KiroLex **每次启动时生成**的一份（只有一条 `kirolex-local` MCP，
# 见 `remoteLocalTools.buildSessionAgent`）—— 脚本再往 ~/.kiro 里写东西，只会变成一份
# 没人读、又会让人以为"配置在那儿"的垃圾。要给远端配和本地不一样的东西时，
# 那也该是显式的一份远端配置，而不是安装脚本顺手塞的。
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
# 只装缺的那一个 ACP 适配器（`claude-agent-acp` / `codex-acp`）：会话里「没连上：没有 … 的 ACP 适配器」那条提示上的
# 「安装」按钮用（src/main/adapterInstall.ts 的 remoteInstallCommand）。只跑 Node（没有才装）、PATH、那一个适配器和它的
# 登录 shell 可见性，其余（系统包 / kiro-cli / claude / codex / 默认模型 / 登录 / sshd）都跳过。不设 = 全装（「安装 AI 工具」）。
ONLY="${ONLY:-}"
# 按「AI 工具配置」装 / 升级到指定版本（src/main/agentProfile.ts 的 remotePinCommand）：`包@版本=命令名`，空格分隔。
# 和 ONLY 一样只跑 Node（没有才装）、PATH、这几个包（适配器再加登录 shell 可见性），其余都跳过。
PINS="${PINS:-}"
[ -n "$PINS" ] && [ -z "$ONLY" ] && ONLY=pins

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s ==\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
full() { [ -z "$ONLY" ]; }
want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

rc=0
note_fail() { say "✗ $*"; rc=1; }

# ---------------------------------------------------------------- 系统包
if full; then
step "系统包（git / unzip / tar）"
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

for b in git unzip tar; do install_pkg "$b"; done
fi

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

# **最新的 LTS** ——「把脚本改成运行最新的 LTS 版本 node」。不写死大版本：问 fnm 现在的 LTS 是哪一个，
# 不是它就装上并设成默认（已经有一个老的 node 也一样升 —— 系统自带的、或者以前装的 22）。
# 拿不到远端版本列表（离线 / 被墙）时退回 `--lts`，再不行就沿用现有的 node，不因为这一步把整个安装弄挂。
# 只装一个适配器时（ONLY）已经有 node 就不动它：升级 node 会换掉全局 node_modules 所在的版本目录，已经装好的另一家适配器会跟着"消失"。
if [ -n "$ONLY" ] && have node; then
  say "→ 已有 node $(node -v)（$(command -v node)），只装 $ONLY，不升级 node"
else
if ! have fnm && [ ! -x "$HOME/.local/share/fnm/fnm" ]; then
  say "→ 装 fnm"
  curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell --install-dir "$HOME/.local/share/fnm" >/dev/null 2>&1
fi
load_fnm
FNM="$HOME/.local/share/fnm/fnm"; [ -x "$FNM" ] || FNM="$(command -v fnm 2>/dev/null || true)"
if [ -n "$FNM" ]; then
  LTS="$("$FNM" ls-remote --lts 2>/dev/null | tail -1 | awk '{print $1}')"
  CUR="$(node -v 2>/dev/null || true)"
  if [ -n "$LTS" ] && [ "$CUR" = "$LTS" ]; then
    say "→ node 已是最新 LTS（$CUR）"
  elif [ -n "$LTS" ]; then
    say "→ 装 node $LTS（最新 LTS）${CUR:+，原来是 $CUR}"
    "$FNM" install "$LTS" >/dev/null 2>&1 && "$FNM" default "$LTS" >/dev/null 2>&1 || note_fail "node $LTS 没装上"
  else
    say "→ 问不到 LTS 列表，按 --lts 装"
    "$FNM" install --lts >/dev/null 2>&1 && "$FNM" default lts-latest >/dev/null 2>&1 || true
  fi
  load_fnm
fi
fi
if have node; then say "→ 现在用的 node：$(node -v)（$(command -v node)）"; else note_fail "node 没装上 —— claude-code / codex 都要它"; fi

# ------------------------------------------- 以后的登录 shell 也要找得到 node / npm 全局命令
# KiroLex 起远程会话用的是 `ssh … bash -lc '<命令>'`：一个**非交互的登录 shell**。fnm 是用 --skip-shell
# 装的（不改 shell 配置），所以不补这一步的话，那个登录 shell 里既没有 node，也没有 npm -g 装出来的
# claude-agent-acp / codex-acp —— 适配器装上了，KiroLex 却报"那台机器上没有适配器"（它们的 shebang 还要 node）。
# 写一份 ~/.kirolex-env.sh，从登录 shell 读的那个文件里 source 它：`bash -l` 只读 ~/.bash_profile、
# ~/.bash_login、~/.profile 里**第一个存在的**；~/.bashrc 在 Ubuntu 上对非交互 shell 会提前 return，靠不住。
step "PATH（给以后的登录 shell）"
ENVF="$HOME/.kirolex-env.sh"
cat > "$ENVF" <<'ENVEOF'
# KiroLex：让 `bash -lc` 里起的远程会话找得到 node 和 npm 全局命令（remote-bootstrap.sh 写的，可以重跑）
export PATH="$HOME/.local/bin:$PATH"
if [ -x "$HOME/.local/share/fnm/fnm" ]; then eval "$("$HOME/.local/share/fnm/fnm" env --shell bash)" 2>/dev/null; fi
ENVEOF
PF=""
for f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
  if [ -f "$f" ]; then PF="$f"; break; fi
done
[ -n "$PF" ] || PF="$HOME/.profile"
if grep -qs 'kirolex-env.sh' "$PF"; then
  say "→ 已在 $PF"
else
  printf '\n# KiroLex（remote-bootstrap.sh）\n[ -f "$HOME/.kirolex-env.sh" ] && . "$HOME/.kirolex-env.sh"\n' >> "$PF"
  say "→ 写进 $PF"
fi

# ---------------------------------------------------------------- kiro-cli
# 装法是从这台机器上实测出来的（bash 历史里就是这一条 URL），不是猜的：
#   curl … desktop-release.q.us-east-1.amazonaws.com/latest/kirocli-x86_64-linux.zip
# 解出来是 kirocli/{install.sh,bin/}，install.sh 把三个二进制放进 ~/.local/bin 再跑
# `kiro-cli setup`（参数透传，所以给 --no-confirm）。
if full; then
step "kiro-cli"
if have kiro-cli && [ "$FORCE" != "1" ]; then
  say "→ kiro-cli 已在 $(kiro-cli --version 2>/dev/null | head -1)"
else
  arch="$(uname -m)"
  #
  # **glibc 版本也要看，不只是架构** —— 在 AL2023 arm64 上踩过。
  #
  # `kirocli-aarch64-linux.zip` 是给 glibc >= 2.39 的系统编的，而 AL2023 是 2.34：
  # install.sh 会打印
  #   `This release built for a GNU system with glibc 2.39 or newer, try installing the musl version`
  # 然后 **exit 0** —— 所以"装没装上"只能靠后面 `have kiro-cli` 发现，
  # 原来的脚本就是这样静默失败的（日志里只有一句"kiro-cli 没装上"，看不出是 libc 的事）。
  #
  # musl 版是静态链接的，哪个 glibc 都能跑。所以判据是：**glibc 不够新就用 musl**。
  # x86_64 留着 glibc 版（那台老机器一直在用，别无谓换）。
  libc_ok=1
  libc_ver="$(ldd --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+' | head -1)"
  if [ -n "$libc_ver" ]; then
    # 2.39 起才够；`sort -V` 比手写数字比较稳（2.9 vs 2.39 那种坑）
    [ "$(printf '%s\n' "$libc_ver" 2.39 | sort -V | head -1)" = "2.39" ] || libc_ok=0
  fi
  case "$arch" in
    x86_64|amd64) zip_name="kirocli-x86_64-linux.zip" ;;
    aarch64|arm64)
      if [ "$libc_ok" = "1" ]; then zip_name="kirocli-aarch64-linux.zip"
      else zip_name="kirocli-aarch64-linux-musl.zip"; say "→ glibc $libc_ver < 2.39，用 musl 版"; fi ;;
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
        # 不要把 install.sh 的输出丢掉：它**成功和失败都 exit 0**，
        # 唯一的线索就在 stdout 里（上面那条 glibc 提示就是这么被吞掉的）。
        inst="$(sh "$tmp/kirocli/install.sh" --no-confirm 2>&1)" || true
        printf '%s\n' "$inst" | grep -iE 'error|glibc|musl' | head -3 | while IFS= read -r l; do say "   $l"; done
      fi
    else
      note_fail "下载失败（这台机器连不上 $KIRO_RELEASE_BASE？）"
    fi
    rm -rf "$tmp"
    have kiro-cli || note_fail "kiro-cli 没装上"
  fi
fi
fi

# ------------------------------------------------- claude code / codex
if full; then
step "claude code / codex（npm 全局）"
elif [ -n "$PINS" ]; then
step "按 AI 工具配置装 / 升级（npm 全局）"
else
step "ACP 适配器 $ONLY（npm 全局）"
fi
npm_i() {
  local pkg="$1" bin="$2"
  # `</dev/null`：有些工具（claude-code-acp 是 stdio 上的 ACP 服务）会读 stdin，
  # 而脚本若是从 stdin 喂进来的，它就会把剩下的脚本吃掉 —— 实测过，自检整段没跑而退出码还是 0。
  if have "$bin" && [ "$FORCE" != "1" ]; then say "→ $bin 已在 ($("$bin" --version </dev/null 2>/dev/null | head -1))"; return 0; fi
  if ! have npm; then note_fail "没有 npm，装不了 $pkg"; return 1; fi
  # 系统自带的 node：全局目录要 root，`npm -g` 会 EACCES。改装到 ~/.local（bin 落在 ~/.local/bin，
  # 上面那份 ~/.kirolex-env.sh 已经把它放进以后登录 shell 的 PATH）。
  if [ ! -w "$(npm root -g 2>/dev/null)" ]; then
    npm config set prefix "$HOME/.local" >/dev/null 2>&1
    export PATH="$HOME/.local/bin:$PATH"
    say "→ npm 全局目录不可写，改装到 ~/.local"
  fi
  say "→ npm i -g $pkg"
  # 输出先留在临时文件里：成功时不刷屏，失败时把最后几行（网络 / 权限 / 下载的具体原因）带出来，
  # 加 `  npm: ` 前缀 —— KiroLex 从这几行取失败原因写进会话和日志（adapterInstall.ts 的 remoteInstallReason）。
  local npm_log; npm_log="$(mktemp 2>/dev/null || echo "/tmp/kirolex-npm-$$.log")"
  if npm install -g "$pkg" >"$npm_log" 2>&1 </dev/null; then
    rm -f "$npm_log"
  else
    tail -n 12 "$npm_log" | tr -d '\r' | grep -v '^[[:space:]]*$' | sed 's/^/  npm: /'
    rm -f "$npm_log"
    note_fail "$pkg 装不上"; return 1
  fi
}
# claude code 用**官方安装脚本**（原生二进制，不依赖 node）；装不上再退回 npm。
# 实测这台机器上 https://claude.ai/install.sh 取到的就是官方 bash 安装器。
if full; then
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
fi
# ACP 适配层：KiroLex 走 ACP，Claude Code / Codex 要靠它们才能当执行器（engines.ts 的 REMOTE_ADAPTER_BIN）。
# 原来装的是 @zed-industries/claude-code-acp —— 那个包已经改名停更，KiroLex 起的是下面这两个命令。
want claude-agent-acp && npm_i '@agentclientprotocol/claude-agent-acp' claude-agent-acp
want codex-acp && npm_i '@agentclientprotocol/codex-acp' codex-acp

# 装到 fnm / nvm 管的 node 下时，`npm -g` 的 bin 落在那个版本自己的目录里 —— 只有交互 shell 看得到。
# KiroLex 起适配器用的是 `bash -lc`，所以那里**连同 node** 都要找得到；找不到就在 ~/.local/bin
# （~/.kirolex-env.sh 已经把它放进登录 shell 的 PATH）放一个用 node 绝对路径的包装脚本。
# 已经装好的（跳过了 npm_i 的）也要过这一步：graviton 上就是"早就装了、只是登录 shell 看不到"。
login_visible() {
  local bin="$1" pkg="$2" entry nodebin w
  if bash -lc "command -v $bin && command -v node" </dev/null >/dev/null 2>&1; then
    say "→ $bin：登录 shell 里找得到（连同 node）"; return 0
  fi
  have node || { note_fail "$bin：这里也没有 node，放不了包装脚本"; return 1; }
  entry="$(npm root -g 2>/dev/null)/$pkg/dist/index.js"
  [ -f "$entry" ] || { note_fail "$bin：找不到它的入口 $entry"; return 1; }
  # fnm 的 `command -v node` 是一个每个 shell 临时建的 multishell 链接 —— 要解到真正的安装目录
  nodebin="$(command -v node)"; nodebin="$(readlink -f "$nodebin" 2>/dev/null || printf '%s' "$nodebin")"
  mkdir -p "$HOME/.local/bin"
  w="$HOME/.local/bin/$bin"
  # 先删：npm prefix 是 ~/.local 时这里是 npm 的 symlink，直接写会顺着它改掉适配器自己的入口
  rm -f "$w"
  cat > "$w" <<WEOF
#!/bin/sh
# KiroLex（remote-bootstrap.sh）：登录 shell 看不到这台机器的 node（fnm / nvm 只在交互 shell 里加 PATH），用绝对路径起 $pkg
[ -x '$nodebin' ] || { echo "$bin: $nodebin 不在了（node 换过版本？）—— 在 KiroLex 里重跑「安装 AI 工具」" >&2; exit 127; }
export PATH='$(dirname "$nodebin")':"\$PATH"
exec '$nodebin' '$entry' "\$@"
WEOF
  chmod +x "$w"
  if bash -lc "command -v $bin" </dev/null >/dev/null 2>&1; then
    say "→ $bin：登录 shell 看不到 node，放了包装脚本 $w（node：$nodebin）"
  else
    note_fail "$bin：放了包装脚本 $w，但 ~/.local/bin 不在登录 shell 的 PATH 里"
  fi
}
want claude-agent-acp && login_visible claude-agent-acp '@agentclientprotocol/claude-agent-acp'
want codex-acp && login_visible codex-acp '@agentclientprotocol/codex-acp'

# 按配置钉版本（PINS）：已经是那个版本的不动；claude 是官方安装脚本装的原生版时用它自己的 `claude install <版本>`
# （npm 装的会被 ~/.local/bin 里那份挡住）。装完再问一次版本，对不上算失败（带上 PATH 上是哪一份）。
pin_cur() {
  local pkg="$1" bin="$2" r
  case "$bin" in
    claude|codex) "$bin" --version </dev/null 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?' | head -1 ;;
    *) r="$(npm root -g 2>/dev/null)"
       [ -n "$r" ] && [ -f "$r/$pkg/package.json" ] && node -p 'require(process.argv[1]).version' "$r/$pkg/package.json" 2>/dev/null ;;
  esac
}
npm_pin() {
  local spec="$1" bin="$2" pkg ver cur real FORCE=1
  pkg="${spec%@*}"; ver="${spec##*@}"
  cur="$(pin_cur "$pkg" "$bin")"
  if [ "$cur" = "$ver" ]; then say "→ $bin 已是 $ver"; return 0; fi
  say "→ $bin ${cur:-没装} → $ver"
  real="$(readlink -f "$(command -v "$bin" 2>/dev/null)" 2>/dev/null)"
  case "$bin:$real" in
    "claude:$HOME/.local/share/claude/"*)
      local ilog; ilog="$(mktemp 2>/dev/null || echo "/tmp/kirolex-claude-$$.log")"
      say "→ claude install $ver（原生版）"
      if ! claude install "$ver" >"$ilog" 2>&1 </dev/null; then
        tail -n 12 "$ilog" | tr -d '\r' | grep -v '^[[:space:]]*$' | sed 's/^/  npm: /'
        rm -f "$ilog"; note_fail "claude $ver 装不上"; return 1
      fi
      rm -f "$ilog" ;;
    *) npm_i "$pkg@$ver" "$bin" || return 1 ;;
  esac
  hash -r 2>/dev/null
  cur="$(pin_cur "$pkg" "$bin")"
  if [ "$cur" != "$ver" ]; then note_fail "$bin 装完是 ${cur:-?}，不是 $ver（PATH 上的是 $(command -v "$bin" 2>/dev/null)）"; return 1; fi
  say "✓ $bin $ver"
}
if [ -n "$PINS" ]; then
  for kx_spec in $PINS; do
    case "$kx_spec" in *@*=*) ;; *) note_fail "看不懂的 PINS 项：$kx_spec"; continue ;; esac
    npm_pin "${kx_spec%%=*}" "${kx_spec##*=}"
  done
  for kx_spec in $PINS; do
    case "${kx_spec##*=}" in
      claude-agent-acp) login_visible claude-agent-acp '@agentclientprotocol/claude-agent-acp' ;;
      codex-acp) login_visible codex-acp '@agentclientprotocol/codex-acp' ;;
    esac
  done
  step "自检（按配置的版本）"
  for kx_spec in $PINS; do
    kx_b="${kx_spec##*=}"; kx_p="${kx_spec%%=*}"
    say "$(printf '%-16s' "$kx_b"): $(pin_cur "${kx_p%@*}" "$kx_b")（要 ${kx_p##*@}）"
  done
  if [ "$rc" -eq 0 ]; then say "✓ 都是配置里的版本了。"; else say "✗ 还差上面标 ✗ 的那几项。"; fi
  exit "$rc"
fi

# 只装一个适配器（ONLY）到这里就完了：KiroLex 装完会再按会话的起法（bash -lc）真起一次验证（index.ts verifyRemoteAdapter）。
if [ -n "$ONLY" ]; then
  step "自检（$ONLY）"
  if bash -lc "command -v $ONLY" </dev/null >/dev/null 2>&1; then
    say "$ONLY : 登录 shell 里找得到"
  else
    say "$ONLY : **登录 shell 里找不到**"
    rc=1
  fi
  if [ "$rc" -eq 0 ]; then say "✓ $ONLY 装好了。"; else say "✗ $ONLY 没装好，见上面标 ✗ 的那几行。"; fi
  exit "$rc"
fi

# ---------------------------------------------------------------- 默认走 Amazon Bedrock
#
# 「脚本应该默认将模型设置为 bedrock 的 global endpoint。保留让客户自己配置域名和 key 或者用官方订阅登录的选项」。
# 只给**还没配过**的工具写默认值：已经配了网关 / Bedrock、或者官方账号登录过的，一律不碰（KiroLex 的「🔑 登录」页
# 随时可以改成 Bedrock / 手动填写 / 官方登录）。不写任何密钥 —— 用这台机器的 AWS 凭证链（EC2 实例角色、~/.aws、SSO）。
# 模型 ID 和 aiLogin.ts 的 BEDROCK_DEFAULTS 一致：
#   · Claude Code：global 推理配置文件，region 用这台机器自己的；
#   · Codex：Bedrock 的 Responses 端点上 OpenAI 模型目前只在美东，所以固定 us-east-1（它也不认 global 前缀）。
step "默认模型：Amazon Bedrock"
IMDS_T=$(curl -s -m 3 -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null)
AWS_R=$(curl -s -m 3 -H "X-aws-ec2-metadata-token: $IMDS_T" http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null)
[ -z "$AWS_R" ] && AWS_R=$(aws configure get region 2>/dev/null)
[ -z "$AWS_R" ] && AWS_R=us-east-1

if have claude; then
  if [ -f "$HOME/.claude/.credentials.json" ] || grep -qE '"(ANTHROPIC_BASE_URL|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_USE_BEDROCK)"' "$HOME/.claude/settings.json" 2>/dev/null; then
    say "→ Claude Code 已经配过（网关 / Bedrock / 官方登录），不动"
  else
    mkdir -p "$HOME/.claude"
    KX_R="$AWS_R" node -e '
      const fs = require("fs"), f = process.env.HOME + "/.claude/settings.json";
      let j = {}; try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
      j.env = Object.assign({}, j.env, {
        CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: process.env.KX_R, ANTHROPIC_BEDROCK_REGION_PREFIX: "global",
        ANTHROPIC_MODEL: "global.anthropic.claude-opus-5-5",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "global.anthropic.claude-opus-5-5",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "global.anthropic.claude-sonnet-5-5",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "global.anthropic.claude-haiku-4-5-20251001-v1:0" });
      fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 });' \
      && say "→ Claude Code 默认走 Amazon Bedrock（global 推理配置文件，region=$AWS_R）"
  fi
fi

if have codex; then
  if [ -f "$HOME/.codex/auth.json" ] || grep -qE '^\s*model_provider\s*=' "$HOME/.codex/config.toml" 2>/dev/null; then
    say "→ Codex 已经配过（provider / 官方登录），不动"
  else
    mkdir -p "$HOME/.codex"
    { [ -f "$HOME/.codex/config.toml" ] && cat "$HOME/.codex/config.toml"; } > "$HOME/.codex/config.toml.kx-rest" 2>/dev/null || true
    { printf 'model = "openai.gpt-6.1-sol"\nmodel_provider = "amazon-bedrock"\n'
      cat "$HOME/.codex/config.toml.kx-rest"
      printf '\n[model_providers.amazon-bedrock.aws]\nregion = "us-east-1"\n'; } > "$HOME/.codex/config.toml"
    rm -f "$HOME/.codex/config.toml.kx-rest"
    chmod 600 "$HOME/.codex/config.toml"
    say "→ Codex 默认走 Amazon Bedrock（openai.gpt-6.1-sol @ us-east-1）"
  fi
  # Codex 的沙箱要 bubblewrap；没有的话它用自带的那份并每次警告一句。能免密 sudo 就顺手装上
  if ! have bwrap && sudo -n true 2>/dev/null; then
    { sudo -n dnf install -y bubblewrap || sudo -n yum install -y bubblewrap || sudo -n apt-get install -y bubblewrap; } >/dev/null 2>&1 \
      && say "→ bubblewrap 装上了（Codex 沙箱）"
  fi
fi

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
  #
  # **`--identity-provider` / `--region` 这两个参数不生效** —— 在 kiro-cli 2.25.0 上实测。
  # 不管有没有传，它照样交互式追问 Start URL 和 Region。而且：
  #
  #   · 没有 TTY 时，那两个追问拿到**空串**（它自己会 warn `called input while stdout is
  #     not a terminal`），于是 region="" → `region must be a valid host label`。
  #     这就是原来这条命令 100% 失败的原因，而报错完全看不出是"追问没人答"。
  #   · 所以必须给它一个真 pty（`script -qc`），再把答案从 stdin 喂进去。
  #   · pty 上 stdin/stdout 是同一个终端，程序会读到自己的回显 → 值被拼两遍
  #     （`us-east-1us-east-1`）。所以先 `stty -echo`。
  #
  # Region 是 **Identity Center 实例所在的区**，不是 profile ARN 里那个区
  # （那份 ARN 写着 us-east-1，而 IdC 在 ap-northeast-1 —— 用 us-east-1 会
  # `InvalidRequestException`）。所以 KiroLex 传进来的 `KIRO_LOGIN_REGION` 要是 IdC 的区。
  #
  # **region 只能试** —— 它是 Identity Center 实例所在的区，而本机没有任何可靠来源：
  # `kiro-cli whoami` 只给 profile ARN 的区（`arn:aws:codewhisperer:us-east-1`），
  # 那是 CodeWhisperer profile 的区，**不是** IdC 的区。拿它去登录会
  # `InvalidRequestException`（实测：IdC 在 ap-northeast-1，ARN 写着 us-east-1）。
  #
  # 所以按候选逐个试：区不对时 `StartDeviceAuthorization` 会**秒失败**，
  # 对的那个才会打印 URL + code 然后阻塞等你授权。KiroLex 传进来的那个排第一
  # （它至少是个线索），后面跟上常见的几个。
  login_in="$(mktemp)"
  logged_in=0
  for reg in ${KIRO_LOGIN_REGION:-} ap-northeast-1 us-east-1 us-west-2 eu-west-1; do
    kiro-cli whoami </dev/null >/dev/null 2>&1 && { logged_in=1; break; }
    printf '%s\n%s\n' "$KIRO_LOGIN_PROVIDER" "$reg" > "$login_in"
    #
    # 必须给真 pty，而且要先关回显：
    #   · 没 TTY 时那两个追问拿到空串（它自己 warn `called input while stdout is not
    #     a terminal`）→ region="" → `must be a valid host label`。原来 100% 失败就是这个。
    #   · pty 上 stdin/stdout 是同一个终端，程序会读到自己的回显 → 值被拼两遍
    #     （`us-east-1us-east-1`）。所以 `stty -echo`。
    # `--identity-provider` / `--region` 这两个参数在 2.25.0 上**不生效**，照样会追问。
    script -qc "stty -echo; kiro-cli login --license pro --use-device-flow" /dev/null < "$login_in" 2>&1 \
      | tr -d '\r' | sed 's/\x1b\[[0-9;]*[A-Za-z]//g;s/[▰▱]//g;s/Logging in\.\.\.//g' \
      | grep -vE '^[[:space:]]*$' || true
    kiro-cli whoami </dev/null >/dev/null 2>&1 && { logged_in=1; break; }
    say "   region $reg 不对，换一个再试"
  done
  rm -f "$login_in"
  if [ "$logged_in" = "1" ]; then
    say "→ 登录完成  $(kiro-cli whoami </dev/null 2>/dev/null | head -1)"
  else
    note_fail "登录没完成（超时或被取消）。可以再点一次「安装依赖」，或者自己 ssh 上去跑 kiro-cli login"
  fi
else
  note_fail "没登录，而且 KiroLex 没能从本机读出登录参数（provider/region）——"
  say "   请 ssh 到这台机器手动跑一次：kiro-cli login --license pro --use-device-flow"
fi

# ---------------------------------------------------------------- 自检
# ---------------------------------------------------- sshd 回收死连接
#
# 默认 `ClientAliveInterval 0` = sshd **从不**探测客户端还在不在。客户端那头断了
# （笔记本 VPN 掉线、合盖睡眠）而 TCP 没收到 FIN 时，sshd-session 和它下面所有的
# kiro-cli 会一直挂着 —— 实测一次挂了 7.5 小时、14 个进程（7 条会话 × 2），
# 而 KiroLex 自己的远端清理只扫 PPID==1 的孤儿，这种父进程还活着的扫不到。
# 老那台 EC2 被拖到 CPU 100%、sshd 握手超时，就是这类垃圾越积越多。
#
# 30 秒探一次、连续 4 次没回就断 = 2 分钟内回收，子进程随之收到 SIGHUP。
#
# 顺带把 `MaxSessions` 调到 64：KiroLex 一台机器共用一条复用连接（sshMux.ts），每个执行器
# （kiro-cli acp / claude-agent-acp / codex-acp）占它上面一个 session，而 sshd 默认只给 10 个。
# 2026-10-22 实测：正好 10 个执行器时再起一个就报 `Session open refused by peer`。
# 两项**分别**判断：已经有 ClientAlive、但没有 MaxSessions 的老机器也要补上。
#
# 先 `sshd -t` 再 reload：配置写坏了就还原，reload 不断现有连接（MaxSessions 对新连接才生效）。
step "sshd 回收死连接"
F=/etc/ssh/sshd_config.d/60-kirolex.conf
if sudo -n true 2>/dev/null; then
  NEED_ALIVE=0; NEED_SESS=0
  sudo grep -qs '^ClientAliveInterval' "$F" || NEED_ALIVE=1
  sudo grep -qs '^MaxSessions' "$F" || NEED_SESS=1
  if [ "$NEED_ALIVE" = 0 ] && [ "$NEED_SESS" = 0 ]; then
    say "→ 已配置（$F）"
  else
    sudo cp -a "$F" /tmp/60-kirolex.conf.bak 2>/dev/null || sudo rm -f /tmp/60-kirolex.conf.bak
    if [ "$NEED_ALIVE" = 1 ]; then
      printf '%s\n' '# KiroLex：让 sshd 自己发现已经死掉的客户端（见 remote-bootstrap.sh）' \
        'ClientAliveInterval 30' 'ClientAliveCountMax 4' | sudo tee -a "$F" >/dev/null
    fi
    if [ "$NEED_SESS" = 1 ]; then
      printf '%s\n' '# KiroLex：一条复用连接上最多 64 个会话（默认 10，执行器一多就被拒）' \
        'MaxSessions 64' | sudo tee -a "$F" >/dev/null
    fi
    if ! sudo sshd -t 2>/dev/null; then
      if [ -f /tmp/60-kirolex.conf.bak ]; then sudo cp -a /tmp/60-kirolex.conf.bak "$F"; else sudo rm -f "$F"; fi
      note_fail "sshd 配置校验没过，已还原 —— 死连接不会被自动回收、会话数上限还是默认的 10"
    elif sudo systemctl reload sshd 2>/dev/null || sudo systemctl reload ssh 2>/dev/null; then
      if [ "$NEED_ALIVE" = 1 ]; then say "→ 已开：30 秒探一次，2 分钟内回收死连接"; fi
      if [ "$NEED_SESS" = 1 ]; then say "→ 已开：一条连接最多 64 个会话（新连接生效）"; fi
    else
      # reload 没成功 = 正在跑的 sshd 还是旧配置；文件也还原，别留一份「看着改了、其实没生效」的配置
      if [ -f /tmp/60-kirolex.conf.bak ]; then sudo cp -a /tmp/60-kirolex.conf.bak "$F"; else sudo rm -f "$F"; fi
      note_fail "sshd 重新加载失败（systemctl reload sshd / ssh 都没成功），已还原 —— 死连接不会被自动回收、会话数上限还是默认的 10"
    fi
  fi
else
  say "→ 跳过：没有免密 sudo。建议手动加 ClientAliveInterval 30 / ClientAliveCountMax 4 / MaxSessions 64"
fi

step "自检"
say "uname   : $(uname -srm)"
for b in kiro-cli git unzip node npm claude codex claude-agent-acp codex-acp; do
  if have "$b"; then
    say "$(printf '%-16s' "$b"): $(command -v "$b")  $("$b" --version </dev/null 2>/dev/null | head -1)"
  else
    say "$(printf '%-16s' "$b"): 缺"
    case "$b" in
      kiro-cli) rc=1 ;;   # 只有它是硬依赖：远程会话就是在远端跑一个 kiro-cli
    esac
  fi
done

# KiroLex 是用一个**新的登录 shell** 起适配器的（`bash -lc`）—— 在这里找得到不算数，要在那种 shell 里找得到
for b in claude-agent-acp codex-acp; do
  if bash -lc "command -v $b" </dev/null >/dev/null 2>&1; then
    say "$(printf '%-16s' "$b") : 登录 shell 里找得到（Claude Code / Codex 远程会话能起）"
  else
    say "$(printf '%-16s' "$b") : **登录 shell 里找不到** —— 这台机器跑不了对应引擎的远程会话"
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
  say "✓ 这台机器可以跑远程会话了。文件仍然在你本地 —— 远端通过隧道读写你这台机器上的文件（不复制）。"
  say "  Claude Code / Codex 默认走 Amazon Bedrock（用这台机器的 AWS 凭证，需要 Bedrock 调用权限）；"
  say "  想用自己的域名 + key 或官方账号登录，在 KiroLex 那条会话左下角「🔑 登录」里改。"
else
  say "✗ 还差上面标 ✗ / 缺 / 没登录 的那几项。"
fi
exit "$rc"
