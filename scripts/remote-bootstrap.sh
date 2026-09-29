#!/usr/bin/env bash
#
# 远程会话的远端安装脚本（docs/DESIGN_remote_sessions.md）。
#
# 幂等，可以反复跑。装齐远端跑一条会话需要的东西，然后打印一份自检：
#
#   · 系统包       git unzip tar（装 kiro-cli 的 zip 要它们）
#   · Node（fnm）  claude-code / codex 都是 npm 包，没有 node 就装不上
#   · kiro-cli     从 desktop-release 取对应架构的 zip，跑它自带的 install.sh
#   · claude-code  官方安装脚本 https://claude.ai/install.sh（顺带 @zed-industries/claude-code-acp，
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

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s ==\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

rc=0
note_fail() { say "✗ $*"; rc=1; }

# ---------------------------------------------------------------- 系统包
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
step "自检"
say "uname   : $(uname -srm)"
for b in kiro-cli git unzip node npm claude codex claude-code-acp; do
  if have "$b"; then
    say "$(printf '%-16s' "$b"): $(command -v "$b")  $("$b" --version </dev/null 2>/dev/null | head -1)"
  else
    say "$(printf '%-16s' "$b"): 缺"
    case "$b" in
      kiro-cli) rc=1 ;;   # 只有它是硬依赖：远程会话就是在远端跑一个 kiro-cli
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
