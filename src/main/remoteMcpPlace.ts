/**
 * **「从本机转发」的 stdio MCP 这台电脑上没有时，在哪跑** ——「别逼用户在本机再装一份」。
 *
 * 实测（2026-10-25）：MCP 配置「通用（带本机工具）」里 builder-mcp、agentcore-websearch 标了 forwardFromLocal，
 * 命令是 Mac 上的路径（`/Users/keyinan/.local/bin/mcp-proxy-for-aws`…），配置经 S3 同步到了 Windows，
 * Windows 上没装 → 每条远程会话都报「起不来」。而远端 aws-tokyo 上本来就有 `~/.local/bin/mcp-proxy-for-aws`，
 * 直接在那儿跑是通的。所以远程会话准备时，对这类 MCP 按顺序决定（`placeForwardStdio`）：
 *   a. 本机找得到命令 → 照旧本机起、转发；
 *   b. 本机没有、远端找得到同名命令（按命令的 basename，在远端 PATH、~/.local/bin、~/bin 里找，`remoteWhichScript`）
 *      → 直接在远端起：交给远端适配器的是一条普通 stdio MCP，参数原样（路径型参数不改写），不走转发；
 *   c. 两边都没有 → 不起、不重试，只进「⚠ N 个 MCP 不可用」徽标（不在会话正文里说）。
 * 可以按电脑手动指定（`perMachine["<主机名>"].runOn`：`remote` = 总是在远端运行，`local` = 总是本机转发；
 * 不写 = 自动），手动的优先于自动。这套回退不改 mcp-combos.json。
 *
 * 只管组合里标了 forwardFromLocal（或命令是本机路径）的 stdio 项。明确标了 forwardFromLocal 的一律按上面三步走
 * （名字是 playwright / drawio / pencil 也一样）；只因为名字在 `FORWARD_BY_NAME` 里才转发、没标的，自动模式下不挪到远端
 * —— 只有手动选了「总是在远端运行」才挪。HTTP 型的转发方式不变。
 * 远端只查、不装任何东西。远端起的那条交出去之前在远端试一次握手（`remoteMcpProbeScript`，只用 bash），就绪了才交。
 * 纯逻辑（脚本文本 + 解析），ssh 调用在 index.ts。
 */
import { FORWARD_BY_NAME, isLocalPathCommand, type McpEntry } from './forwardMcp.ts';
import type { McpComboServer } from './mcpCombos.ts';
import { tr } from './uiText.ts';

export type McpRunOn = 'auto' | 'remote' | 'local';

/** perMachine 里能写的那两个（`auto` = 不写）。 */
export const MCP_RUN_ON_VALUES = ['remote', 'local'] as const;

export function normalizeRunOn(v: unknown): McpRunOn {
  return v === 'remote' || v === 'local' ? v : 'auto';
}

/**
 * 命令的 basename（远端按它找）：去引号、取最后一段（`/` 和 `\` 都算分隔符），Windows 的 .exe / .cmd / .bat / .com 去掉。
 * 只认得 `[\w.+-]` 的名字（要放进远端脚本）；别的 → ''（当远端找不到）。
 */
export function commandBasename(command: string): string {
  let c = String(command ?? '').trim();
  if (c.length >= 2 && c.startsWith('"') && c.endsWith('"')) c = c.slice(1, -1).trim();
  const base = c.split(/[\\/]/).pop() || '';
  const name = base.replace(/\.(exe|cmd|bat|com)$/i, '');
  return /^[\w.+-]{1,100}$/.test(name) && name !== '.' && name !== '..' ? name : '';
}

/** 这一条是不是「从本机转发」、该走这套回退的（组合里那份定义，已按这台电脑套过 perMachine）。 */
export function placeEligible(name: string, s: McpComboServer | undefined): boolean {
  if (!s || s.disabled || s.url !== undefined || typeof s.command !== 'string' || !s.command.trim()) return false;
  const runOn = normalizeRunOn(s.runOn);
  if (runOn === 'remote' || s.forwardFromLocal) return true;
  /* 只因为名字（playwright 这类）才转发、自己没标的：它的意义就是操作这台电脑，自动模式下不挪 */
  if (FORWARD_BY_NAME.includes(name)) return false;
  return isLocalPathCommand(s.command);
}

export interface PlacedRemote { entry: McpEntry; remoteCommand: string }
export interface PlacedMissing { entry: McpEntry; reason: string }

/**
 * 每条转发的 stdio 项放哪（规则见文件头）。`eligible` 之外的照旧本机（`local`）。
 * `remoteFound` = 远端按 basename 找到的完整路径（还没去远端查 = undefined：需要查的那些放进 `needRemote`，查完再调一次）。
 */
export function placeForwardStdio(input: {
  entries: McpEntry[];
  eligible: (name: string) => boolean;
  runOn: (name: string) => McpRunOn;
  localHas: (e: McpEntry) => boolean;
  remoteFound?: Map<string, string>;
  remoteHost: string;
}): { local: McpEntry[]; remote: PlacedRemote[]; missing: PlacedMissing[]; needRemote: string[] } {
  const local: McpEntry[] = [];
  const remote: PlacedRemote[] = [];
  const missing: PlacedMissing[] = [];
  const needRemote: string[] = [];
  for (const e of input.entries) {
    if (!input.eligible(e.name)) { local.push(e); continue; }
    const mode = input.runOn(e.name);
    /* 总是本机转发：本机没有就按「这台电脑上找不到」（localMcp 起之前查，`missing`） */
    if (mode === 'local') { local.push(e); continue; }
    const localOk = mode === 'auto' && input.localHas(e);
    if (localOk) { local.push(e); continue; }
    const base = commandBasename(e.command);
    if (!input.remoteFound) { if (base && !needRemote.includes(base)) needRemote.push(base); continue; }
    const found = base ? input.remoteFound.get(base) : undefined;
    if (found) { remote.push({ entry: e, remoteCommand: found }); continue; }
    missing.push({
      entry: e,
      reason: mode === 'remote'
        ? tr('{host} has no {cmd} (set to always run on the remote machine)', { host: input.remoteHost, cmd: base || e.command })
        : tr('Neither this computer nor {host} has {cmd}', { host: input.remoteHost, cmd: base || e.command }),
    });
  }
  return { local, remote, missing, needRemote };
}

/**
 * 远端按 basename 找命令：`command -v`（登录 shell 的 PATH），再 ~/.local/bin、~/bin 下可执行的同名文件。
 * 每找到一个打一行 `KXWHICH <名字>\t<完整路径>`。名字已过 `commandBasename`（只有安全字符）。
 */
export function remoteWhichScript(names: string[]): string {
  const safe = names.filter((n) => /^[\w.+-]{1,100}$/.test(n));
  return `for n in ${safe.map((n) => `'${n}'`).join(' ')}; do
  p=$(command -v -- "$n" 2>/dev/null)
  case "$p" in /*) ;; *) p="";; esac
  if [ -z "$p" ]; then
    for d in "$HOME/.local/bin" "$HOME/bin"; do
      if [ -f "$d/$n" ] && [ -x "$d/$n" ]; then p="$d/$n"; break; fi
    done
  fi
  [ -n "$p" ] && printf 'KXWHICH %s\\t%s\\n' "$n" "$p"
done
true`;
}

export function parseRemoteWhich(out: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of String(out || '').split('\n')) {
    const r = /^KXWHICH ([^\t]+)\t(\/.+?)\s*$/.exec(line);
    if (r && !m.has(r[1])) m.set(r[1], r[2]);
  }
  return m;
}

/** 交给远端适配器的那条（ACP 的 stdio MCP 形状）：命令换成远端找到的路径，参数、env 原样。 */
export function remoteStdioServer(p: PlacedRemote): { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> } {
  return {
    name: p.entry.name,
    command: p.remoteCommand,
    args: [...(p.entry.args || [])],
    env: Object.entries(p.entry.env || {}).map(([name, value]) => ({ name, value: String(value) })),
  };
}

/** 远端起的 MCP 握手超时（秒）：mcp-proxy-for-aws 这类第一次起要几秒。 */
export const REMOTE_PROBE_TIMEOUT_SEC = 20;

/** 单引号包起来给 bash（里面的 `'` 换成 `'\\''`）。 */
function sq(v: string): string {
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

/**
 * **就绪检查**（同本机转发那条，61004ec5）：在远端起一次那条命令，`initialize` → `tools/list`，拿到回复才算就绪，然后关掉。
 * 只用 bash（3.2 也行）+ mkfifo，不依赖远端有 python / node —— 检查不了就不算就绪（不交、后台接着试）。
 * 输出一行：`KXPROBE ok <工具数>` / `KXPROBE fail <原因>`。命令、参数、env 各自单引号转义，参数原样。
 */
export function remoteMcpProbeScript(p: PlacedRemote, timeoutSec = REMOTE_PROBE_TIMEOUT_SEC): string {
  const envArgs = Object.entries(p.entry.env || {}).map(([k, v]) => sq(`${k}=${v}`)).join(' ');
  const argv = [p.remoteCommand, ...(p.entry.args || [])].map(sq).join(' ');
  const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'kirolex-probe', version: '1' } } });
  const inited = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  return `trap '' PIPE
kxd=$(mktemp -d 2>/dev/null || echo "/tmp/kxprobe.$$")
mkdir -p "$kxd" && mkfifo "$kxd/in" "$kxd/out" || { echo 'KXPROBE fail cannot create a pipe on the remote machine'; exit 0; }
kxpre=; command -v setsid >/dev/null 2>&1 && kxpre=setsid
$kxpre env ${envArgs} ${argv} <"$kxd/in" >"$kxd/out" 2>"$kxd/err" &
kxpid=$!
disown "$kxpid" 2>/dev/null
exec 3>"$kxd/in" 4<"$kxd/out"
kxend=$((SECONDS + ${Math.max(1, Math.floor(timeoutSec))}))
kxstop() {
  kill -9 -- "-$kxpid" 2>/dev/null || kill -9 "$kxpid" 2>/dev/null
  exec 3>&- 4<&-
  kxerr=$(tail -c 300 "$kxd/err" 2>/dev/null | tr '\\n' ' ')
  rm -rf "$kxd"
}
kxwait() {
  kxre='"id"[[:space:]]*:[[:space:]]*'"$1"'([^0-9]|$)'
  while :; do
    kxleft=$((kxend - SECONDS))
    [ "$kxleft" -gt 0 ] || return 1
    IFS= read -r -t "$kxleft" kxline <&4 || return 1
    if [[ $kxline =~ $kxre ]]; then return 0; fi
  done
}
kxfail() { kxstop; echo "KXPROBE fail $1${'$'}{kxerr:+: $kxerr}"; exit 0; }
printf '%s\\n' ${sq(init)} >&3 2>/dev/null || kxfail 'it exited right away'
kxwait 1 || kxfail 'no reply to initialize'
case "$kxline" in *'"result"'*) ;; *) kxfail "initialize failed: ${'$'}{kxline:0:200}";; esac
printf '%s\\n%s\\n' ${sq(inited)} ${sq(list)} >&3 2>/dev/null || kxfail 'it exited after initialize'
kxwait 2 || kxfail 'no reply to tools/list'
case "$kxline" in *'"result"'*) ;; *) kxfail "tools/list failed: ${'$'}{kxline:0:200}";; esac
kxn=0; kxrest=$kxline
while [[ $kxrest == *'"inputSchema"'* ]]; do kxrest=${'$'}{kxrest#*'"inputSchema"'}; kxn=$((kxn + 1)); done
kxstop
echo "KXPROBE ok $kxn"`;
}

export type RemoteProbeResult = { ok: boolean; toolCount: number; error?: string };

/** `KXPROBE …` 那一行 → 结果。没有这一行（ssh 断了…）= 没就绪。 */
export function parseRemoteProbe(out: string): RemoteProbeResult {
  const line = String(out || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('KXPROBE ')).pop();
  if (!line) return { ok: false, toolCount: 0, error: tr('No result from the readiness check on the remote machine') };
  const ok = /^KXPROBE ok (\d+)$/.exec(line);
  if (ok) return { ok: true, toolCount: Number(ok[1]) };
  const fail = /^KXPROBE fail (.*)$/.exec(line);
  let why = fail ? fail[1] : line;
  try { const j = JSON.parse(why); if (typeof j === 'string') why = j; } catch { /* 原样 */ }
  return { ok: false, toolCount: 0, error: why || tr('Unknown error') };
}

/**
 * **远端直连的 http MCP 在远端机器上敲一次 `initialize`**（组合里没标 forwardFromLocal 的那种，见 `comboHttpDirect`）：
 * 2xx 算通，别的状态码 / curl 报错算连不上（`KXPROBE fail <原因>`，同 `parseRemoteProbe`）。
 * 远端没有 curl 就当通（查不了不报警 —— 交给适配器的那份照样交，它自己连）。头里没有 `${env:…}`，原样带上。
 */
export function remoteHttpProbeScript(d: { url: string; headers: Record<string, string> }, timeoutSec = REMOTE_PROBE_TIMEOUT_SEC): string {
  const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'kirolex-probe', version: '1' } } });
  const headers = Object.entries(d.headers || {}).map(([k, v]) => `-H ${sq(`${k}: ${v}`)}`).join(' ');
  return `command -v curl >/dev/null 2>&1 || { echo 'KXPROBE ok 0'; exit 0; }
kxerr=$(mktemp 2>/dev/null || echo "/tmp/kxhttp.$$")
kxcode=$(curl -sS -o /dev/null -w '%{http_code}' --max-time ${Math.max(1, Math.floor(timeoutSec))} -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' ${headers} --data ${sq(init)} ${sq(d.url)} 2>"$kxerr")
kxmsg=$(tail -c 300 "$kxerr" 2>/dev/null | tr '\n' ' '); rm -f "$kxerr"
case "$kxcode" in 2??) echo 'KXPROBE ok 0';; 000|'') echo "KXPROBE fail ${'$'}{kxmsg:-no response}";; *) echo "KXPROBE fail HTTP $kxcode";; esac`;
}
