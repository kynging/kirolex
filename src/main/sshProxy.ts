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

import fs from 'fs';
import type { RemoteTarget } from './config';
import { tr } from './uiText.ts';

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
  const names = win ? [`${name}.exe`, name] : [name];
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
  opts: { aws?: string; pluginDir?: string } = {},
): string {
  const why = ssmFieldError(remote);
  if (why) throw new Error(why);
  const aws = opts.aws || findLocalTool('aws') || 'aws';
  const port = remote.sshPort && remote.sshPort > 0 ? remote.sshPort : 22;
  const parts = [
    shq(aws), 'ssm', 'start-session',
    '--target', String(remote.ssmInstanceId),
    '--document-name', 'AWS-StartSSHSession',
    '--parameters', `portNumber=${port}`,
    '--region', String(remote.ssmRegion),
  ];
  if (remote.ssmProfile) parts.push('--profile', String(remote.ssmProfile));
  const cmd = parts.join(' ');
  return opts.pluginDir ? `env PATH=${shq(opts.pluginDir)}:"$PATH" ${cmd}` : cmd;
}

/** 本机 session-manager-plugin 的目录 —— 只在它不在当前 PATH 上时返回（见 `ssmProxyCommand`）。 */
export function pluginDirIfOffPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (process.platform === 'win32') return undefined;
  const plugin = findLocalTool('session-manager-plugin', env);
  if (!plugin) return undefined;
  const dir = dirOf(plugin);
  const onPath = String(env.PATH || '').split(':').some((d) => d.replace(/\/+$/, '') === dir);
  return onPath ? undefined : dir;
}

/**
 * **建连接那一路的传输参数**：SSM 时是 ProxyCommand + HostKeyAlias，否则就是原来的跳板参数
 * （没跳板 = 空数组，直连那条路一个字节都不变）。`buildSshArgs` 和 mux 的 master 都走这里。
 *
 * `HostKeyAlias=<instance-id>`：known_hosts 按实例记主机密钥 —— IP 怎么变都是同一台。
 */
export function transportArgs(remote: Pick<RemoteTarget, 'proxyJump' | 'identityFile'> & SsmFields): string[] {
  if (!isSsm(remote)) return proxyArgs(remote);
  return [
    '-o', `ProxyCommand=${ssmProxyCommand(remote, { pluginDir: pluginDirIfOffPath() })}`,
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
