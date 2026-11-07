/**
 * **跳板机（ProxyJump）** —— 目标机器在私有子网里、只能借另一台进去时用。
 *
 * ## 为什么需要这个字段，而不是让人自己写 `~/.ssh/config`
 *
 * 写 `~/.ssh/config` 当然也能跳，但那是**用户全局**的文件：换一台笔记本、或者重装，
 * KiroLex 里配好的那台机器就悄悄连不上了 —— 而报出来的错是"连接超时"，
 * 看不出问题在一个不在这个仓库里的文件上。跳板是**这台目标机器的属性**，
 * 就该跟 `identityFile` / `sshPort` 存在一起。
 *
 * ## 为什么是 ProxyCommand 而不是 `-o ProxyJump=`
 *
 * `-o ProxyJump=host` 会让 ssh 另起一个 ssh 去连跳板，而那个新进程**不继承** `-i`
 * ——它只会去翻默认密钥和 `~/.ssh/config`。于是"目标机器的密钥填对了、还是连不上"，
 * 原因是跳板那一跳没密钥。所以这里自己拼 `ProxyCommand`，把**同一把钥匙**显式传给跳板那跳。
 *
 * 跳板可以带端口：`ec2-user@1.2.3.4:2222`。
 */

import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { RemoteTarget } from './config';
import { tr, trConcat } from './uiText.ts';

/**
 * 包一层单引号给 `/bin/sh` —— `ProxyCommand` 的值是交给 shell 跑的，
 * 路径里有空格（macOS 上 `~/Library/Application Support/...` 就有）不包会被切断。
 */
function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** 从 `user@host:port` 里把端口摘出来。没写端口就返回 `undefined`。 */
export function splitJump(jump: string): { dest: string; port?: number } {
  const t = String(jump || '').trim();
  /*
    只认**最后一个**冒号后面是纯数字的情况。IPv6 字面量（`[::1]:22` / `::1`）里
    冒号一堆，按"最后一个冒号"切会把地址切坏 —— 所以带方括号的按方括号认，
    裸 IPv6 干脆不切（那种写法必须用 `[...]:port`）。
  */
  const br = /^(\[[^\]]+\])(?::(\d{1,5}))?$/.exec(t);
  if (br) return { dest: br[1], port: br[2] ? Number(br[2]) : undefined };
  if ((t.match(/:/g) || []).length > 1) return { dest: t };   // 裸 IPv6，不动
  const m = /^(.*):(\d{1,5})$/.exec(t);
  if (m) return { dest: m[1], port: Number(m[2]) };
  return { dest: t };
}

/**
 * 跳板对应的 ssh 参数。没配跳板返回空数组（所以调用点可以无条件展开）。
 *
 * `identityFile` 是**目标机器**的密钥，这里也给跳板用 —— 绝大多数情况两跳同一把钥匙
 * （同一个 keypair 启的机器）。不是的话再加字段，不要现在猜。
 */
/**
 * 一个跳板地址**长得**对不对：`user@host`、`host:port`、`[v6]:port`。
 *
 * 这是白名单而不是黑名单：拼进 `ProxyCommand` 的东西最终由 shell 解释，
 * 而"列出所有危险字符"这件事历史上没人做对过。主机名/用户名本来也只需要这几类字符。
 */
export function validJump(jump: string): boolean {
  /* 开头不许是 `-`：`-W` 后面那个参数会被跳板那条 ssh 当成选项 */
  return /^[A-Za-z0-9._@:[\]][A-Za-z0-9._@:[\]-]*$/.test(String(jump || ''));
}

/**
 * **sshHost 不许以 `-` 开头** —— 它是 ssh 的一个位置参数，`-oProxyCommand=calc.exe`
 * 这种值没有空格、能过 `validateTarget` 原来的检查，然后被 ssh 当成**选项**解析，
 * 也就是在这台机器上执行任意命令。配置会走 S3 备份/恢复回来（见上面 proxyArgs 的说明），
 * 会话记录里也存着一份 remote 快照，所以拼参数的地方再拦一次，不只靠保存时的校验。
 */
export function unsafeSshHost(host: string | undefined): boolean {
  return /^\s*-/.test(String(host || ''));
}
export function assertSafeSshHost(host: string | undefined): void {
  if (unsafeSshHost(host)) throw new Error(tr('The SSH address cannot start with `-` ({host}). Refusing to put it into an ssh command.', { host: String(host).slice(0, 40) }));
}

export function proxyArgs(remote: Pick<RemoteTarget, 'proxyJump' | 'identityFile'>): string[] {
  const jump = String(remote.proxyJump || '').trim();
  if (!jump) return [];
  /*
    **形状不对就当没配跳板**（而不是抛）：这条路上抛异常等于让一条会话起不来，
    而界面在保存时就已经拦过一次（`validateTarget`）—— 这里是第二道，
    针对的是"配置从别处回来"的情况。
  */
  if (!validJump(jump)) return [];
  const { dest, port } = splitJump(jump);
  if (!dest) return [];
  const parts = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
  if (remote.identityFile) parts.push('-i', shq(remote.identityFile));
  if (port && port !== 22) parts.push('-p', String(port));
  /*
    **`dest` 也要包引号** —— 这整个字符串是交给 `/bin/sh -c` 跑的，所以它里面的
    任何东西都是 shell 代码。`validateTarget` 只拦了空格，`;` / `$(…)` / 反引号 / `|`
    都能过 —— 一个 `h;curl …` 就是在这台笔记本上执行命令。

    配置不是"纯本地可信输入"：`config.json` 会走 S3 备份/恢复（`s3Sync.ts`），
    也就是说它可以从别处回来。所以这里按不可信处理。
    （`%h:%p` 是 ssh 自己的占位符，必须留在引号外面，否则它不会被替换。）
  */
  parts.push('-W', '%h:%p', shq(dest));
  return ['-o', `ProxyCommand=${parts.join(' ')}`];
}

/* ------------------------------------------------------------------ AWS SSM */

/**
 * **通过 AWS SSM 连（SSH over SSM）** —— 机器不开 22 端口、没有公网 IP，按 instance-id 连。
 *
 * 只换**传输层**：`ProxyCommand = aws ssm start-session … AWS-StartSSHSession`，ssh 自己照旧跑在上面。
 * 所以 ControlMaster 复用、`-R` 反向隧道（本机 MCP 全靠它）、stdio 上的 ACP、保活全都不变。
 *
 * 为什么不用纯 SSM（start-session 直接 exec 引擎）：SSM 端口转发只有本机→远端方向，没有反向隧道，
 * 本机工具全挂；start-session 默认还带 pty，stdio 不是二进制干净的，ACP 跑不了。
 *
 * 下面三个值都会拼进交给 shell 跑的 `ProxyCommand`，所以是**白名单**（和 `validJump` 同一个理由）。
 */
export const SSM_INSTANCE_RE = /^(i|mi)-[0-9a-f]{8,17}$/;
export const SSM_REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;
export const SSM_PROFILE_RE = /^[A-Za-z0-9_.+-]{1,64}$/;

/** start-session 握手比直连慢（要先过 SSM 的 websocket），直连那个 10 秒不够。 */
export const SSM_CONNECT_TIMEOUT_S = 30;

type SsmFields = Pick<RemoteTarget, 'connectVia' | 'ssmInstanceId' | 'ssmRegion' | 'ssmProfile' | 'sshPort'>;

export function isSsm(remote: Pick<RemoteTarget, 'connectVia'> | undefined): boolean {
  return remote?.connectVia === 'ssm';
}

/** SSM 的三个字段对不对。返回一句给人看的错误，或者 `null`。 */
export function ssmFieldError(remote: SsmFields): string | null {
  if (!SSM_INSTANCE_RE.test(String(remote.ssmInstanceId || ''))) return tr('The instance ID must look like i-0123456789abcdef0 (i- or mi- followed by 8-17 hex digits).');
  if (!SSM_REGION_RE.test(String(remote.ssmRegion || ''))) return tr('The region must look like us-east-1 or ap-northeast-1.');
  if (remote.ssmProfile && !SSM_PROFILE_RE.test(String(remote.ssmProfile))) return tr('The AWS profile may only contain letters, digits and `_ . + -` (at most 64).');
  return null;
}

/**
 * 在本机找 `aws` / `session-manager-plugin` 的**绝对路径**。
 *
 * 先 PATH，再试 `/usr/local/bin`、`/opt/homebrew/bin` —— 从 Finder / Dock 启动的 app 拿到的 PATH
 * 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，而官方安装包恰好装在 `/usr/local/bin`。找不到返回 `undefined`。
 */
export function findLocalTool(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = defaultExists,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const win = platform === 'win32';
  const sep = win ? ';' : ':';
  const dirs = String(env.PATH || env.Path || '').split(sep).filter(Boolean);
  const extra = win
    ? [`${env.ProgramFiles || 'C:\\Program Files'}\\Amazon\\AWSCLIV2`, `${env.ProgramFiles || 'C:\\Program Files'}\\Amazon\\SessionManagerPlugin\\bin`]
    : ['/usr/local/bin', '/opt/homebrew/bin'];
  /* `.cmd`：pip / 某些包管理器装的 aws 是 `aws.cmd`；Win32 分支经 cmd.exe 跑，它照样能起（见 `winProxyCommand`） */
  const names = win ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const d of [...dirs, ...extra]) {
    for (const n of names) {
      const p = win ? `${d.replace(/[\\/]+$/, '')}\\${n}` : `${d.replace(/\/+$/, '')}/${n}`;
      if (exists(p)) return p;
    }
  }
  return undefined;
}

function defaultExists(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** 目录名（两种分隔符都认）。 */
function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : p;
}

/* --------------------------------------------- 谁来跑 ProxyCommand：sh 还是 CreateProcessW */

/**
 * **ProxyCommand 的语法跟着实际选中的 ssh 走**，不是只看 `process.platform`：
 *
 *   · `posix`：OpenSSH / MSYS（Git 自带的 `usr\bin\ssh.exe`）/ Cygwin —— 经 `$SHELL -c "exec <ProxyCommand>"` 跑，
 *     单引号、`&&`、`exec`、`>/dev/null` 都认。
 *   · `win32`：Windows 自带的 Win32-OpenSSH（`C:\Windows\System32\OpenSSH\ssh.exe`）—— **不经 shell**，
 *     直接 `CreateProcessW` 执行 ProxyCommand 那一整行。POSIX 写法的第一个 token（`9>/dev/null;`）找不到，
 *     报 `CreateProcessW failed error:2`（KYN-DESKTOP 实测）。所以这里要套一层 `cmd.exe /d /s /c "…"`。
 *
 * 判法：照 libuv `spawn('ssh')` 的找法，按 PATH 顺序找第一个 `ssh.exe`；同目录有 `sh.exe` / `bash.exe`
 * 的是 MSYS / Cygwin（它们的 ssh 用 sh 跑 ProxyCommand）→ `posix`，否则（包括一个都没找到）→ `win32`。
 */
export type ProxyFlavor = 'posix' | 'win32';

let flavorOverride: ProxyFlavor | undefined;
/** 测试用：固定成某一种（不传 = 恢复按 PATH 判断）。 */
export function setProxyFlavorOverride(f?: ProxyFlavor): void {
  flavorOverride = f;
}

export function sshFlavor(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = defaultExists,
  platform: NodeJS.Platform = process.platform,
): ProxyFlavor {
  if (flavorOverride) return flavorOverride;
  if (platform !== 'win32') return 'posix';
  const dirs = String(env.PATH || env.Path || '').split(';').filter(Boolean);
  for (const d of dirs) {
    const dir = d.replace(/[\\/]+$/, '');
    if (!exists(`${dir}\\ssh.exe`)) continue;
    return exists(`${dir}\\sh.exe`) || exists(`${dir}\\bash.exe`) ? 'posix' : 'win32';
  }
  return 'win32';
}

/** `%SystemRoot%\System32\cmd.exe` 的绝对路径（ProxyCommand 不经 shell，`cmd` 这个名字未必找得到）。 */
export function winCmdPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = String(env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows').replace(/[\\/]+$/, '');
  return `${root}\\System32\\cmd.exe`;
}

/** cmd 里的一个参数：有空格 / 特殊字符就包双引号（Windows 路径里不会有 `"`）。 */
function winq(s: string): string {
  return /^[A-Za-z0-9_.:\\/+=@-]+$/.test(s) ? s : `"${s}"`;
}

/**
 * cmd 里起一个程序：路径一律双引号。`.cmd` / `.bat` 前面加 `call` —— 不加的话批处理 `exit /b 1`
 * 的退出码 `&&` 看不见（本机实测：推送失败了照样往下 start-session）。
 */
function winRun(exe: string): string {
  return /\.(cmd|bat)$/i.test(exe) ? `call "${exe}"` : `"${exe}"`;
}

/**
 * **本机直接跑一个工具（aws 预检）时怎么起它**。`findLocalTool` 在 Windows 上可能给出 `aws.cmd`，
 * 而 Node 的 `execFile` 不能直接起 `.cmd` / `.bat`（报 EINVAL）—— 于是「测试连接」的预检还没走到 ssh 就失败了。
 * 这种时候改成 `cmd.exe /d /s /c "call "<aws.cmd>" <参数>"`，`windowsVerbatimArguments` 让 Node 原样交出这一行：
 *   · `call`：不加的话批处理的 `exit /b N` 退出码丢掉（见 `winRun`），cmd 的退出码就是 call 回来的 errorlevel；
 *   · 参数里只要有字母数字和 `_ . : \ / + @ -` 以外的字符（空格、`=`、`,` 在 cmd 里都是分隔符）就包双引号；
 *     `"` 和 `%` 在 cmd 命令行里没有可靠的转义，带这两种字符的参数直接拒绝（我们拼的参数都过了白名单，不会有）。
 * `.exe` 和非 Windows 照旧直接起，一个字节不变。
 */
export function localToolSpawn(
  file: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[]; windowsVerbatimArguments?: true } {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return { file, args };
  const q = (a: string): string => {
    if (/["%]/.test(a)) throw new Error(tr('Cannot pass {arg} to {file} through cmd.exe (it contains " or %).', { arg: a.slice(0, 60), file }));
    return /^[A-Za-z0-9_.:\\/+@-]+$/.test(a) ? a : `"${a}"`;
  };
  if (/["%]/.test(file)) throw new Error(tr('Cannot pass {arg} to {file} through cmd.exe (it contains " or %).', { arg: file, file }));
  return {
    file: winCmdPath(env),
    args: ['/d', '/s', '/c', `"call "${file}" ${args.map(q).join(' ')}"`],
    windowsVerbatimArguments: true,
  };
}

/** 跑一条本机命令（aws 预检用，`ssmPreflight` 的 `run`）：失败也 resolve，把退出码和输出交回去。 */
export function runLocalTool(file: string, args: string[], timeoutMs = 20_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let spec: ReturnType<typeof localToolSpawn>;
    try { spec = localToolSpawn(file, args); } catch (err: any) {
      resolve({ code: 1, stdout: '', stderr: String(err?.message || err) });
      return;
    }
    execFile(spec.file, spec.args, { timeout: timeoutMs, encoding: 'utf8', windowsVerbatimArguments: spec.windowsVerbatimArguments }, (err: any, stdout, stderr) => resolve({
      code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
      stdout: String(stdout || ''),
      stderr: String(stderr || (err && typeof err.code !== 'number' ? err.message : '') || ''),
    }));
  });
}

/**
 * 把几段 cmd 命令（`&&` 串起来）包成 Win32-OpenSSH 能直接 `CreateProcessW` 的 ProxyCommand：
 * `C:\Windows\System32\cmd.exe /d /s /c "<seg1> && <seg2>"`。
 *
 *   · `/s`：cmd 只去掉**最外层**那对引号、里面原样执行 —— 不用 `/s` 时 cmd 会按"恰好两个引号、没有特殊字符…"
 *     那套启发式决定剥不剥，里面带 `"<aws.exe>"` 时结果难猜。`/d`：不跑 AutoRun（注册表里用户的 cmd 初始化脚本）。
 *   · `pluginDir`：session-manager-plugin 不在 PATH 上时前面加 `set "PATH=<dir>;%PATH%"`（这是 cmd 的写法，不是 `env`）。
 *   · **`%` 全部写成 `%%`**：Win32-OpenSSH 和别的 OpenSSH 一样会展开 ProxyCommand 里的 `%h` / `%p` / `%%`，
 *     路径里的 `%`（以及 `%PATH%`）不转义会被当成占位符。转义后 ssh 交给 cmd 的是单个 `%`，
 *     `%PATH%` 再由 cmd 展开；路径里字面的 `%name%` 恰好是个已定义变量时 cmd 也会展开它 —— cmd 命令行里没有转义 `%` 的办法，这种路径不支持。
 */
export function winProxyCommand(segments: string[], opts: { pluginDir?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const segs = opts.pluginDir ? [`set "PATH=${opts.pluginDir};%PATH%"`, ...segments] : segments;
  const line = `${winq(winCmdPath(opts.env))} /d /s /c "${segs.join(' && ')}"`;
  return line.replace(/%/g, '%%');
}

/**
 * `ProxyCommand` 的值：`aws ssm start-session --target <id> --document-name AWS-StartSSHSession
 * --parameters portNumber=<port> --region <r> [--profile <p>]`。
 *
 * `aws` 用绝对路径并包单引号（路径里可能有空格）。三个 SSM 值过了白名单才拼 —— 不对就抛，
 * 不要退回直连：退回去的那条 ssh 会去连一个叫 `i-…` 的主机名，报出来的是看不懂的 DNS 错。
 *
 * `pluginDir`：session-manager-plugin 所在目录**不在** PATH 上时传进来（aws 是按 PATH 找它的），
 * 这时前面套一层 `env PATH=…`。ssh 是 `exec <ProxyCommand>` 跑的，所以必须用 `env` 而不是 `PATH=… aws`。
 */
export function ssmProxyCommand(
  remote: SsmFields,
  opts: { aws?: string; pluginDir?: string; flavor?: ProxyFlavor; env?: NodeJS.ProcessEnv } = {},
): string {
  const aws = opts.aws || findLocalTool('aws') || 'aws';
  const args = startSessionArgs(remote);
  /* Win32-OpenSSH：不经 shell，套 cmd.exe（见 `winProxyCommand`）；aws 路径一律双引号 */
  if (opts.flavor === 'win32') return winProxyCommand([`${winRun(aws)} ${args.join(' ')}`], { pluginDir: opts.pluginDir, env: opts.env });
  const cmd = [shq(aws), ...args].join(' ');
  return opts.pluginDir ? `env PATH=${shq(opts.pluginDir)}:"$PATH" ${cmd}` : cmd;
}

/** `ssm start-session …` 的参数（不含 `aws`）。三个 SSM 值过了白名单才拼，不对就抛。 */
function startSessionArgs(remote: SsmFields): string[] {
  const why = ssmFieldError(remote);
  if (why) throw new Error(why);
  const port = remote.sshPort && remote.sshPort > 0 ? remote.sshPort : 22;
  const parts = [
    'ssm', 'start-session',
    '--target', String(remote.ssmInstanceId),
    '--document-name', 'AWS-StartSSHSession',
    '--parameters', `portNumber=${port}`,
    '--region', String(remote.ssmRegion),
  ];
  if (remote.ssmProfile) parts.push('--profile', String(remote.ssmProfile));
  return parts;
}

/**
 * 本机 session-manager-plugin 的目录 —— 只在它不在当前 PATH 上时返回（见 `ssmProxyCommand`）。
 * `win32`（Win32-OpenSSH）按 `;` 分、不分大小写比；Windows 上的 MSYS ssh 照旧不补（它的 PATH 是另一套写法）。
 */
export function pluginDirIfOffPath(env: NodeJS.ProcessEnv = process.env, flavor: ProxyFlavor = sshFlavor(env)): string | undefined {
  if (process.platform === 'win32' && flavor !== 'win32') return undefined;
  const win = flavor === 'win32';
  const plugin = findLocalTool('session-manager-plugin', env, defaultExists, win ? 'win32' : process.platform);
  if (!plugin) return undefined;
  const dir = dirOf(plugin);
  const norm = (d: string): string => (win ? d.replace(/[\\/]+$/, '').toLowerCase() : d.replace(/\/+$/, ''));
  const onPath = String(env.PATH || env.Path || '').split(win ? ';' : ':').some((d) => norm(d) === norm(dir));
  return onPath ? undefined : dir;
}

/* ------------------------------------------------- EC2 Instance Connect 临时公钥 */

/**
 * **SSM 机器默认不要私钥文件** ——「SSM 模式根本不该让人填登录用户和私钥」。
 *
 * 做法（在用户 Mac 上实测过）：本机生成一把临时 ed25519 密钥，连接前用
 * `aws ec2-instance-connect send-ssh-public-key` 把公钥推给那台实例（只管 60 秒），
 * ssh 再带 `-i <临时私钥> -o IdentitiesOnly=yes`。sshMux 的主连接只在建立时认证一次，
 * 之后的通道复用这条连接，所以 60 秒够用。
 *
 * 推送放在 **ProxyCommand 里、start-session 之前**（见 `transportArgs`）：ProxyCommand 恰好在
 * ssh 每次**真正新建连接**时跑一次 —— 主连接、备用主连接、没有复用时的每条一次性 ssh 都是；
 * 走已有连接的通道不跑它，也就不多推。这样不用在十几处调用点各自先 await 一次。
 *
 * `ssmUseOwnKey` = 「改用自己的私钥（不推临时公钥）」：走老路径（`-i identityFile`，不推送）。
 * `mi-` 托管实例不是 EC2，Instance Connect 推不了：没勾「改用自己的私钥」就**不连**、说清楚
 * （`assertSsmKeyUsable`），不静默拿配置里的旧私钥 —— 只有用户勾了才用它。
 */
type KeyFields = Pick<RemoteTarget, 'connectVia' | 'ssmInstanceId' | 'ssmUseOwnKey'> & { id?: string };

export function usesSsmTempKey(remote: KeyFields): boolean {
  return isSsm(remote) && !remote.ssmUseOwnKey && /^i-/.test(String(remote.ssmInstanceId || ''));
}

/** 没勾「改用自己的私钥」、又推不了临时公钥（`mi-` 托管实例）时给人看的话；能连返回 `null`。 */
export function ssmKeyUnusable(remote: KeyFields): string | null {
  if (!isSsm(remote) || remote.ssmUseOwnKey || usesSsmTempKey(remote)) return null;
  return tr('{id} is a managed instance (mi-…), so EC2 Instance Connect cannot push a temporary SSH key to it. Under Advanced, choose "Use my own private key (no temporary key)" and pick the key for that machine.', { id: String(remote.ssmInstanceId || '') });
}
export function assertSsmKeyUsable(remote: KeyFields): void {
  const why = ssmKeyUnusable(remote);
  if (why) throw new Error(why);
}

/** 临时密钥按机器复用多久；过期换一把（每次新建连接照样重推，推送只管 60 秒）。 */
export const SSM_KEY_TTL_MS = 12 * 60 * 60_000;

let ssmKeyRoot = path.join(os.homedir(), '.kirolex', 'ssm-keys');
/** 测试用：换掉 `~/.kirolex/ssm-keys`。 */
export function setSsmKeyRoot(dir: string): void {
  ssmKeyRoot = dir;
  keyCache.clear();
}

/** `~/.kirolex/ssm-keys/<remoteId>/`。会话里存的老快照可能没有 id，就按实例 ID 分目录。 */
export function ssmKeyDir(remote: KeyFields): string {
  const name = String(remote.id || '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '')
    || String(remote.ssmInstanceId || 'remote').replace(/[^A-Za-z0-9-]/g, '_');
  return path.join(ssmKeyRoot, name);
}

export interface SsmKey { privateKey: string; publicKey: string; createdAt: number }
const keyCache = new Map<string, SsmKey>();

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}
function sshString(b: Buffer | string): Buffer {
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return Buffer.concat([u32(buf.length), buf]);
}

/**
 * 生成一把 ed25519，返回 OpenSSH 格式的私钥（`openssh-key-v1`，不加密）和 `authorized_keys` 那一行公钥。
 * 用 Node 自己的 crypto 而不是起 `ssh-keygen`：`buildSshArgs` 是同步的，而且少一个本机依赖。
 */
export function generateEd25519(comment = 'kirolex-ssm'): { pem: string; pub: string } {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string };
  const seed = Buffer.from(jwk.d, 'base64url');
  const pub = Buffer.from(jwk.x, 'base64url');
  const type = 'ssh-ed25519';
  const pubBlob = Buffer.concat([sshString(type), sshString(pub)]);
  const check = crypto.randomBytes(4);
  let priv = Buffer.concat([check, check, sshString(type), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(comment)]);
  /* 不加密时按 8 字节补齐，补的是 1, 2, 3… */
  const pad: number[] = [];
  for (let i = 1; (priv.length + pad.length) % 8 !== 0; i++) pad.push(i);
  priv = Buffer.concat([priv, Buffer.from(pad)]);
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'), sshString('none'), sshString('none'), sshString(Buffer.alloc(0)),
    u32(1), sshString(pubBlob), sshString(priv),
  ]);
  const b64 = body.toString('base64').match(/.{1,70}/g)!.join('\n');
  return {
    pem: `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`,
    pub: `${type} ${pubBlob.toString('base64')} ${comment}`,
  };
}

/**
 * 这台机器的临时密钥：12 小时内复用同一把，过期（或文件不见了）就换一把。
 *
 * 目录 0700、私钥 0600（ssh 对太宽的私钥权限直接拒用）。**文件名带时间戳、换钥匙不覆盖旧文件**：
 * 一条连接的 ProxyCommand 推的公钥和它 `-i` 读的私钥必须是同一把，原地覆盖的话换钥匙那一瞬
 * 正在建的连接会对不上。旧文件过了两个周期再删。私钥内容不进日志、不进 config.json。
 */
export function ensureSsmKey(remote: KeyFields, now = Date.now()): SsmKey {
  const dir = ssmKeyDir(remote);
  const cached = keyCache.get(dir);
  if (cached && now - cached.createdAt < SSM_KEY_TTL_MS && fs.existsSync(cached.privateKey)) return cached;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  /* mkdir 的 mode 受 umask 影响、对已存在的目录不生效，所以再 chmod 一次 */
  try { fs.chmodSync(ssmKeyRoot, 0o700); fs.chmodSync(dir, 0o700); } catch { /* Windows 上 chmod 只认只读位 */ }
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { /* 刚建的空目录 */ }
  const stamps = names.map((n) => /^k-(\d+)$/.exec(n)).filter(Boolean).map((m) => Number(m![1])).sort((a, b) => b - a);
  /* 重启之后接着用盘上那把还没过期的 */
  const fresh = stamps.find((t) => t <= now && now - t < SSM_KEY_TTL_MS && fs.existsSync(path.join(dir, `k-${t}.pub`)));
  let key: SsmKey;
  if (fresh !== undefined) {
    const privateKey = path.join(dir, `k-${fresh}`);
    key = { privateKey, publicKey: fs.readFileSync(`${privateKey}.pub`, 'utf8').trim(), createdAt: fresh };
  } else {
    const { pem, pub } = generateEd25519();
    const privateKey = path.join(dir, `k-${now}`);
    fs.writeFileSync(privateKey, pem, { mode: 0o600 });
    try { fs.chmodSync(privateKey, 0o600); } catch { /* 同上 */ }
    fs.writeFileSync(`${privateKey}.pub`, `${pub}\n`, { mode: 0o600 });
    key = { privateKey, publicKey: pub, createdAt: now };
  }
  for (const t of stamps) {
    if (now - t >= 2 * SSM_KEY_TTL_MS) {
      for (const f of [`k-${t}`, `k-${t}.pub`]) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* 删不掉下次再删 */ } }
    }
  }
  keyCache.set(dir, key);
  return key;
}

/** `user@i-…` 里的登录用户（缺省 ec2-user）。和 `validateTarget` 同一个白名单 —— 它要拼进 ProxyCommand。 */
export function ssmOsUser(remote: Pick<RemoteTarget, 'sshHost'>): string {
  const h = String(remote.sshHost || '');
  const at = h.lastIndexOf('@');
  const user = at > 0 ? h.slice(0, at) : 'ec2-user';
  if (!/^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(user)) throw new Error(tr('The login user may only contain letters, digits and `. _ -` ({user}).', { user: user.slice(0, 40) }));
  return user;
}

/**
 * `aws ec2-instance-connect send-ssh-public-key` 的参数（不含 `aws` 本身）。
 * region / profile 与这台机器的 SSM 设置相同。「测试连接」（`ssmPreflight`）和 ProxyCommand 用同一份。
 */
export function sendKeyArgs(remote: SsmFields & Pick<RemoteTarget, 'sshHost'>, publicKey: string): string[] {
  const why = ssmFieldError(remote);
  if (why) throw new Error(why);
  return [
    'ec2-instance-connect', 'send-ssh-public-key',
    '--instance-id', String(remote.ssmInstanceId),
    '--instance-os-user', ssmOsUser(remote),
    '--ssh-public-key', publicKey,
    '--region', String(remote.ssmRegion),
    ...(remote.ssmProfile ? ['--profile', String(remote.ssmProfile)] : []),
  ];
}

/**
 * **认证用哪把钥匙**：SSM 临时公钥模式下是 `-i <临时私钥> -o IdentitiesOnly=yes`，**不带**用户配置里的
 * identityFile（老配置里留着它，只有勾了「改用自己的私钥」才用）；其余照旧 `-i identityFile`。
 */
export function identityArgs(remote: Pick<RemoteTarget, 'identityFile'> & KeyFields): string[] {
  /* mi- 又没勾「改用自己的私钥」：拒绝，不悄悄退回配置里的旧私钥 */
  assertSsmKeyUsable(remote);
  if (usesSsmTempKey(remote)) return ['-i', ensureSsmKey(remote).privateKey, '-o', 'IdentitiesOnly=yes'];
  return remote.identityFile ? ['-i', remote.identityFile] : [];
}

/** 实例的 ARN。账号 ID / 分区从 AWS 的报错里认（`User: arn:aws:iam::123…`），认不出就写 `*`。 */
export function instanceArn(remote: Pick<RemoteTarget, 'ssmInstanceId' | 'ssmRegion'>, stderr = ''): string {
  const id = remote.ssmInstanceId || 'i-…';
  const safeId = id.replace(/[^A-Za-z0-9-]/g, '');
  const hit = safeId && new RegExp(`arn:aws[a-z-]*:ec2:[a-z0-9-]+:\\d{12}:instance/${safeId}\\b`).exec(stderr);
  if (hit) return hit[0];
  const who = /arn:(aws[a-z-]*):(?:iam|sts)::(\d{12}):/.exec(stderr);
  return `arn:${who?.[1] || 'aws'}:ec2:${remote.ssmRegion || '*'}:${who?.[2] || '*'}:instance/${id}`;
}

/**
 * **推临时公钥失败的人话** —— 不是 SendSSHPublicKey 的报错返回 `null`。
 * AccessDenied 时给最小策略：Resource 是这台实例的 ARN，Condition 是 `ec2:osuser=<登录用户>`；
 * 另一个办法是在「高级」里改用自己的私钥。
 */
export function ssmKeyPushFailure(stderr: string, remote: SsmFields & Pick<RemoteTarget, 'sshHost'>): { why: string; hint: string } | null {
  const s = String(stderr || '');
  if (!/SendSSHPublicKey/i.test(s)) return null;
  const id = remote.ssmInstanceId || 'i-…';
  let user = 'ec2-user';
  try { user = ssmOsUser(remote); } catch { /* 只是提示里的用户名 */ }
  const own = tr('Or, under Advanced, choose "Use my own private key (no temporary key)".');
  if (/AccessDenied|not authorized to perform/i.test(s)) {
    const policy = JSON.stringify({
      Effect: 'Allow',
      Action: 'ec2-instance-connect:SendSSHPublicKey',
      Resource: instanceArn(remote, s),
      Condition: { StringEquals: { 'ec2:osuser': user } },
    });
    return {
      why: tr('your AWS identity is not allowed to push a temporary SSH key to {id} (missing ec2-instance-connect:SendSSHPublicKey)', { id }),
      hint: trConcat(tr('Add this minimal permission to your IAM user/role: {policy}', { policy }), ' ', own),
    };
  }
  const line = s.split('\n').map((x) => x.trim()).find((x) => /SendSSHPublicKey/i.test(x)) || '';
  return {
    why: tr('pushing the temporary SSH key with EC2 Instance Connect failed ({err})', { err: line.slice(0, 300) }),
    hint: own,
  };
}

/**
 * **建连接那一路的传输参数**：SSM 时是 ProxyCommand + HostKeyAlias，否则就是原来的跳板参数
 * （没跳板 = 空数组，直连那条路一个字节都不变）。`buildSshArgs` 和 mux 的 master 都走这里。
 *
 * `HostKeyAlias=<instance-id>`：known_hosts 按实例记主机密钥 —— IP 怎么变都是同一台。
 *
 * 临时公钥模式下 ProxyCommand 先推公钥、成功了再 `exec` start-session（见上面 `usesSsmTempKey`）。
 * ssh 是用 `sh -c "exec <ProxyCommand>"` 跑它的：开头那个 `exec` 后面只跟一个重定向时
 * 不替换 shell、只把重定向留在当前 shell 上，于是后面的 `;` / `&&` 照常执行 ——
 * 所以值以 `9>/dev/null;` 开头（fd 9 没人用）。推送的输出（一段 JSON）丢进 /dev/null：
 * ProxyCommand 的 stdout 就是 ssh 的传输通道，不能有杂字节；报错走 stderr，留给 `ssmKeyPushFailure` 认。
 *
 * 上面这套是 `posix`（sh 跑 ProxyCommand）的写法；选中的 ssh 是 Win32-OpenSSH 时换成 cmd.exe 的写法（`sshFlavor`）。
 */
export function transportArgs(remote: Pick<RemoteTarget, 'proxyJump' | 'identityFile' | 'sshHost'> & SsmFields & KeyFields): string[] {
  if (!isSsm(remote)) return proxyArgs(remote);
  assertSsmKeyUsable(remote);
  const aws = findLocalTool('aws') || 'aws';
  const flavor = sshFlavor();
  const pluginDir = pluginDirIfOffPath(process.env, flavor);
  if (flavor === 'win32') {
    /*
      Win32-OpenSSH：`cmd.exe /d /s /c ""<aws>" ec2-instance-connect … >NUL && "<aws>" ssm start-session …"`。
      公钥用 `file://<k-….pub>` 传：公钥那行有空格，放进 cmd 的引号里不如给一个路径省心。
      推送失败 `&&` 后面不跑，报错走 stderr（`ssmKeyPushFailure` 照样认）。
    */
    const start = `${winRun(aws)} ${startSessionArgs(remote).join(' ')}`;
    const segs = usesSsmTempKey(remote)
      ? [`${winRun(aws)} ${sendKeyArgs(remote, `file://${ensureSsmKey(remote).privateKey}.pub`).map((a) => (a.startsWith('file://') ? `"${a}"` : winq(a))).join(' ')} >NUL`, start]
      : [start];
    return [
      '-o', `ProxyCommand=${winProxyCommand(segs, { pluginDir })}`,
      '-o', `HostKeyAlias=${remote.ssmInstanceId}`,
    ];
  }
  let proxy = ssmProxyCommand(remote, { aws, pluginDir });
  if (usesSsmTempKey(remote)) {
    const push = [shq(aws), ...sendKeyArgs(remote, ensureSsmKey(remote).publicKey).map(shq)].join(' ');
    proxy = `9>/dev/null; ${push} >/dev/null && exec ${proxy}`;
  }
  return [
    '-o', `ProxyCommand=${proxy}`,
    '-o', `HostKeyAlias=${remote.ssmInstanceId}`,
  ];
}

/**
 * 一次性 ssh 命令（预检 / 测试连接）外层的 `execFile` 超时（毫秒）：直连照旧 30 秒；
 * SSM 多给 30 秒 —— 光握手就可能用满 `ConnectTimeout=30`，外层同样 30 秒的话握手一慢就被杀。
 */
export function execTimeoutFor(remote: Pick<RemoteTarget, 'connectVia'>, base = 30_000): number {
  return isSsm(remote) ? base + SSM_CONNECT_TIMEOUT_S * 1000 : base;
}

/** 建连接的超时（秒）：SSM 放宽到 30，直连照旧 10。 */
export function connectTimeoutFor(remote: Pick<RemoteTarget, 'connectVia'>): number {
  return isSsm(remote) ? SSM_CONNECT_TIMEOUT_S : 10;
}
