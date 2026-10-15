/**
 * **远程会话：用户要的文件一律落在本机，远端只放缓存** ——
 * 「v1 是经本机工具写到本机的，v3 却落在了 EC2 —— 用户在本机找不到、侧栏预览只能 ssh 读、comment 写不回去」。
 *
 * 远端那条 kiro-cli 自带写文件工具（`fs_write` / `write`；Claude Code 的 Write / Edit 同理），
 * 模型可以在它和本机工具（`local_write`，经反向隧道写到用户机器上）之间任选。选了前者，
 * 交付给用户的文档就落在那台机器上。所以：
 *
 *   · 权限请求那一层（`AcpClient.handleAgentRequest`）：远端自带的写文件工具写到**缓存目录以外** → 拒；
 *   · 缓存目录（`~/.cache/kirolex/<会话>`，也是远端 cwd）、`/tmp`、`/var/tmp` 里的照写 —— 中间文件、
 *     构建产物本来就该在那台机器上；
 *   · 跑命令（execute）不拦 —— 编译、跑脚本照旧在远端做，产出最后用 `local_write` 交回本机；
 *   · 漏过去的（信任了全部工具 / 适配器的 bypass 模式不来问）事后认出来，提示用户并给「复制到本机」。
 *
 * 纯函数，不 import electron：路径判断都是远端的 POSIX 路径（`path.posix`），只有复制回本机的
 * 落点用本机的 `path`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { tr, trList } from './uiText.ts';

/** 远端缓存根（相对远端家目录）。远端 cwd 是它下面每条会话一个子目录（`config.sessionCwd`）。 */
export const REMOTE_CACHE_SUBDIR = '.cache/kirolex';

export function remoteCacheRoot(home: string): string {
  return path.posix.join(home || '~', REMOTE_CACHE_SUBDIR);
}

/** 远端路径规范化：`~` 按远端家目录展开，相对路径按远端 cwd 拼，`..` 消掉。 */
function resolveRemote(p: string, cwd: string, home: string): string {
  let s = String(p || '').trim().replace(/^file:\/\//, '');
  if (s === '~' || s.startsWith('~/')) s = path.posix.join(home || '~', s.slice(1));
  return path.posix.isAbsolute(s) ? path.posix.normalize(s) : path.posix.join(cwd || '/', s);
}

function under(p: string, root: string): boolean {
  const r = root.replace(/\/+$/, '');
  return p === r || p.startsWith(`${r}/`);
}

/** 用完即弃的地方：缓存根（含每条会话的 cwd）、`/tmp`、`/var/tmp`。 */
export function isRemoteDisposablePath(p: string, home: string): boolean {
  const n = path.posix.normalize(String(p || ''));
  return [remoteCacheRoot(home), '/tmp', '/var/tmp'].some((root) => under(n, root));
}

/**
 * **本机工具**（`kirolex-local` 那组 MCP）—— 它们写的就是用户机器，正是要它走的路，永远不拦。
 *
 * 只认**整个**标题 / 工具名就是那个 MCP 工具（kiro：`@kirolex-local/local_write`、
 * `Running local_write from kirolex-local`；Claude Code：`mcp__kirolex-local__local_write`）。
 * 不能在标题里"找到这个词"就放行：远端原生写文件的标题是 `Editing <文件名>`，
 * 文件名叫 `local_write.md` / 路径里带 `kirolex-local` 时就会被误当成本机工具。
 */
const LOCAL_TOOL_RE = /^(?:Running\s+)?(?:@kirolex-local\/|mcp__kirolex-local__)?local_(?:write|read|bash|glob|grep|git)(?:\s+from\s+kirolex-local)?$/;
export function isLocalToolCall(toolCall: any): boolean {
  return [toolCall?.title, toolCall?.toolName, toolCall?.name, toolCall?._meta?.toolName]
    .some((v) => typeof v === 'string' && LOCAL_TOOL_RE.test(v.trim()));
}

/**
 * **权限请求里没有 kind / rawInput** —— `scripts/acp-probe.mjs` 实测：kiro 的
 * `session/request_permission` 只带 `{ toolCallId, title }`，`kind` + `rawInput` 在早 ~1ms 到的
 * 同一 `toolCallId` 的 `tool_call` 通知里。所以按 toolCallId 记下通知里的工具信息，判之前合并。
 * 有上限（只留最近 `max` 个调用）：一条会话一轮可以跑几百个工具。
 */
export class ToolCallLedger {
  private calls = new Map<string, any>();
  private readonly max: number;
  constructor(max = 500) { this.max = max; }

  /** 喂 `tool_call` / `tool_call_update` 的 update；后来的字段补上去，缺的不覆盖。 */
  remember(update: any): void {
    const id = update?.toolCallId;
    if (typeof id !== 'string' || !id) return;
    const next = { ...(this.calls.get(id) || {}) };
    for (const k of ['title', 'kind', 'rawInput', 'locations', 'content', 'status']) {
      if (update[k] !== undefined && update[k] !== null) next[k] = update[k];
    }
    next.toolCallId = id;
    this.calls.delete(id);
    this.calls.set(id, next);
    while (this.calls.size > this.max) this.calls.delete(this.calls.keys().next().value as string);
  }

  /** 权限请求里那个 toolCall + 通知里记下的同一调用 —— 请求自己带的字段优先。 */
  join(toolCall: any): any {
    const id = toolCall?.toolCallId;
    const known = typeof id === 'string' ? this.calls.get(id) : undefined;
    if (!known) return toolCall;
    const out: any = { ...known };
    for (const [k, v] of Object.entries(toolCall || {})) if (v !== undefined && v !== null) out[k] = v;
    return out;
  }
}

/** 写文件类的 ACP tool kind（和 ChatArea 的 MUTATING 同一组，删除 / 移动不算"交付"）。 */
const WRITE_KINDS = new Set(['edit', 'create', 'write']);

function isRemoteWriteCall(toolCall: any): boolean {
  if (!toolCall || typeof toolCall !== 'object') return false;
  if (isLocalToolCall(toolCall)) return false;
  return WRITE_KINDS.has(String(toolCall.kind || '').toLowerCase());
}

/** 一次调用要写的那些路径（远端绝对路径，去重，按出现顺序）。各家字段名不一样，都收。 */
export function writeTargets(toolCall: any, cwd: string, home: string): string[] {
  const raw: string[] = [];
  for (const loc of Array.isArray(toolCall?.locations) ? toolCall.locations : []) {
    raw.push(typeof loc === 'string' ? loc : loc?.path);
  }
  for (const d of Array.isArray(toolCall?.diffs) ? toolCall.diffs : []) raw.push(d?.path);
  for (const c of Array.isArray(toolCall?.content) ? toolCall.content : []) {
    if (c?.type === 'diff') raw.push(c.path);
  }
  const input = toolCall?.rawInput;
  if (input && typeof input === 'object') {
    raw.push(input.path, input.file_path, input.notebook_path);
    if (Array.isArray(input.paths)) raw.push(...input.paths);
    if (input.changes && typeof input.changes === 'object' && !Array.isArray(input.changes)) raw.push(...Object.keys(input.changes));
  }
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r !== 'string' || !r.trim()) continue;
    const abs = resolveRemote(r, cwd, home);
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

export interface RemoteWriteContext {
  /** 远端 cwd（缓存目录下这条会话的那个）—— 相对路径按它拼。 */
  cwd: string;
  /** 远端家目录（`resolveRemoteWorkdir('~', sshHost)`）。 */
  home: string;
}

/**
 * 权限请求那一层的判据：远端自带的写文件工具，只要有一个目标不在用完即弃的地方就拦。
 * 说不出写到哪的写文件调用也拦 —— 它写的一定是远端。
 */
export function remoteWriteVerdict(toolCall: any, ctx: RemoteWriteContext): { block: boolean; paths: string[] } {
  if (!isRemoteWriteCall(toolCall)) return { block: false, paths: [] };
  const paths = writeTargets(toolCall, ctx.cwd, ctx.home);
  if (!paths.length) return { block: true, paths };
  return { block: paths.some((p) => !isRemoteDisposablePath(p, ctx.home)), paths };
}

/**
 * 事后：一次**已经完成**的远端写，落在缓存以外的那些路径（= 交付文件落在了远端）。
 * 被拒 / 失败 / 没跑完的不算 —— 文件并没有写出来。
 */
export function strayRemoteDeliverables(toolCall: any, ctx: RemoteWriteContext): string[] {
  if (toolCall?.status !== 'completed' || !isRemoteWriteCall(toolCall)) return [];
  return writeTargets(toolCall, ctx.cwd, ctx.home).filter((p) => !isRemoteDisposablePath(p, ctx.home));
}

const showPaths = (paths: string[]) => {
  const shown = trList(paths.slice(0, 3).map((p) => `\`${p}\``));
  return paths.length > 3 ? tr('{paths}, etc. ({n} in total)', { paths: shown, n: paths.length }) : shown;
};

/** 拦下时给用户看的那句（状态行）。 */
export function blockedWriteNotice(host: string, paths: string[], filesDir?: string): string {
  const where = paths.length ? tr(' ({paths})', { paths: showPaths(paths) }) : '';
  return filesDir
    ? tr('🛡 Blocked a file write to {host}{where}: in a remote session, files delivered to you must land on your machine. Refused; per its prompt it will use `local_write` to write locally instead (`{dir}`).', { host, where, dir: filesDir })
    : tr('🛡 Blocked a file write to {host}{where}: in a remote session, files delivered to you must land on your machine. Refused; per its prompt it will use `local_write` to write locally instead.', { host, where });
}

/** 事后发现交付文件落在远端时给用户看的那句（状态行，带「复制到本机」按钮）。 */
export function strayWriteNotice(host: string, paths: string[]): string {
  return tr('⚠️ This turn wrote files on {host} ({paths}), not on your machine. Click "⇩ Copy to this machine" to put them in this session\'s local folder; previews and comments will then use the local copy.', { host, paths: showPaths(paths) });
}

/**
 * 复制回本机的落点：会话的 files 目录 + 远端的文件名。本机已有同名文件时**不覆盖**
 * （那可能是 v1 那种本机写的另一份）—— 除非 `sameAs` 说它和远端那份一模一样（重复点就复用）。
 */
export function localCopyPath(filesDir: string, remotePath: string, sameAs: (localPath: string) => boolean): string {
  let name = path.posix.basename(String(remotePath || '')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  if (!name || name === '.' || name === '..') name = 'remote-file';
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 0; i < 100; i += 1) {
    const candidate = path.join(filesDir, i === 0 ? name : `${stem} (远端${i === 1 ? '' : ` ${i}`})${ext}`);
    if (!fs.existsSync(candidate) || sameAs(candidate)) return candidate;
  }
  return path.join(filesDir, `${stem} (远端 ${Date.now()})${ext}`);
}

/**
 * 「⇩ 复制到本机」的落盘那一半：远端读回来的字节写进会话的本机 files 目录（tmp + rename，
 * 不覆盖本机已有的别的文件；内容一样就复用）。回本机路径 —— 之后预览 / comment 都按这一份。
 */
export function saveRemoteCopy(filesDir: string, remotePath: string, bytes: Buffer): string {
  fs.mkdirSync(filesDir, { recursive: true });
  const dest = localCopyPath(filesDir, remotePath, (p) => {
    try { return fs.readFileSync(p).equals(bytes); } catch { return false; }
  });
  const tmp = `${dest}.kx-tmp-${process.pid}`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, dest);
  return dest;
}

/**
 * 读远端前 `maxBytes` 字节时，ssh 那条 `execFile` 的 stdout 上限：`KXSIZE <n>\n` + base64（4/3 倍）+ 余量。
 * 不设的话 Node 默认只给 1 MiB —— base64 之后约 768 KiB 的文件就会报 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`，
 * 「复制到本机」对稍大一点的文件就复制不了。下限不低于默认的 1 MiB。
 */
export function captureBufferFor(maxBytes: number): number {
  const b64 = Math.ceil(Math.max(0, maxBytes) / 3) * 4;
  return Math.max(1024 * 1024, b64 + 64 * 1024);
}
