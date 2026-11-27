/**
 * **本机工具输出截断 + 完整输出落盘**（上限和设置见 `toolOutputLimits.ts`）。
 *
 * 超过上限时交给模型的是：开头 1/3 + 一行「…省略 N KB，完整输出在 <路径>，需要时用 local_read 按 offset 读」+ 结尾 2/3。
 * 完整输出写到会话 files 目录下的 `.kirolex-tool-output/<时间>-<id>.txt`，7 天后清掉（每次写之前顺手清）。
 * 只影响交给模型的那份 —— 界面里的完整输出不经过这里。
 *
 * 切点一律落在 UTF-8 字的边界上：切出半个字，模型看到的是一个替换字符，而 Windows 上那一行还会被当成「不是 UTF-8」按代码页解。
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { toolOutputSplit } from './toolOutputLimits.ts';

/** 会话 files 目录下放完整输出的那个子目录。 */
export const TOOL_OUTPUT_DIR = '.kirolex-tool-output';
/** 完整输出留多久。 */
export const TOOL_OUTPUT_KEEP_MS = 7 * 24 * 3600 * 1000;

/** `buf` 的前面最多 `max` 字节，往回退到一个完整的字为止。 */
export function utf8Head(buf: Buffer, max: number): Buffer {
  if (buf.length <= max) return buf;
  let end = max;
  /* buf[end] 是续字节（10xxxxxx）= 切在一个字的中间：退到这个字的首字节之前 */
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end);
}

/** 从 `start` 开始往后跳过续字节，返回下一个字的起点。 */
export function utf8TailStart(buf: Buffer, start: number): number {
  let s = Math.max(0, start);
  while (s < buf.length && (buf[s] & 0xc0) === 0x80) s += 1;
  return s;
}

const pad = (n: number): string => String(n).padStart(2, '0');
function stamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 清掉 `dir` 里超过 7 天的文件。出错不管（下次再清）。 */
export function pruneToolOutputs(dir: string, now = Date.now()): void {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const f = path.join(dir, n);
    try {
      const st = fs.statSync(f);
      if (st.isFile() && now - st.mtimeMs > TOOL_OUTPUT_KEEP_MS) fs.unlinkSync(f);
    } catch { /* 正被别人删 / 没权限：跳过 */ }
  }
}

export const countLines = (s: string): number => {
  let n = 1;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n += 1;
  return n;
};

/**
 * 超过 `maxBytes` 就截成头 + 一行提示 + 尾，完整的写进 `dir/.kirolex-tool-output/`。
 * 没给 `dir` / 写不进去：照样截断，提示里说没能保存。
 */
export function capToolOutput(text: string, opts: { maxBytes: number; dir?: string; id?: string; now?: Date }): { text: string; cut: boolean; file?: string } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= opts.maxBytes) return { text, cut: false };
  const { head: headMax, tail: tailMax } = toolOutputSplit(opts.maxBytes);
  const head = utf8Head(buf, headMax).toString('utf8');
  const tailStart = utf8TailStart(buf, buf.length - tailMax);
  const tail = buf.subarray(tailStart).toString('utf8');
  const headBytes = Buffer.byteLength(head);
  const omittedKb = Math.max(1, Math.round((tailStart - headBytes) / 1024));
  /* 省略的是第几行到第几行：模型拿去当 local_read 的 offset */
  const fromLine = countLines(head);
  const toLine = countLines(buf.subarray(0, tailStart).toString('utf8'));
  let file: string | undefined;
  if (opts.dir) {
    try {
      const f = newOutputFile(opts.dir, opts.id, opts.now ?? new Date());
      fs.writeFileSync(f, buf);
      file = f;
    } catch { file = undefined; }
  }
  return { text: `${head}\n${omitNote(omittedKb, fromLine, toLine, file)}\n${tail}`, cut: true, file };
}

/** 中间那一行提示（`capToolOutput` 和 `OutputSpool` 共用）。 */
function omitNote(omittedKb: number, fromLine: number, toLine: number, file: string | undefined): string {
  const lines = `约第 ${fromLine}–${toLine} 行`;
  return file
    ? `…省略 ${omittedKb} KB（${lines}），完整输出在 ${file}，需要时用 local_read 按 offset 读（offset / limit 按行）…`
    : `…省略 ${omittedKb} KB（${lines}），完整输出没能保存到文件 —— 需要中间部分就缩小输出范围重跑…`;
}

/** 新建一个完整输出文件的路径（顺手清掉 7 天前的）。建不了目录就抛。 */
function newOutputFile(dir: string, id: string | undefined, now: Date): string {
  const out = path.join(dir, TOOL_OUTPUT_DIR);
  fs.mkdirSync(out, { recursive: true });
  pruneToolOutputs(out, now.getTime());
  return path.join(out, `${stamp(now)}-${id || crypto.randomBytes(4).toString('hex')}.txt`);
}

const newlinesIn = (b: Buffer): number => {
  let n = 0;
  for (let i = b.indexOf(0x0a); i !== -1; i = b.indexOf(0x0a, i + 1)) n += 1;
  return n;
};

/** `OutputSpool` 落盘之后在内存里留多少开头 / 结尾 —— 要够上限的最大值（128KB）拆出来的头 / 尾。 */
const SPOOL_HEAD_KEEP = 64 * 1024;
const SPOOL_TAIL_KEEP = 128 * 1024;
/** 输出在这么多以内只放内存（不落盘）；超过才开文件 —— 一定比上限的最大值大，所以「没截断」的输出永远不落盘。 */
export const SPOOL_MEMORY_BYTES = 256 * 1024;
/** 给了 `decode` 时，一直不换行的半行最多攒这么多就先解掉。 */
const SPOOL_PENDING_MAX = 64 * 1024;

/** `buf` 末尾有几个字节是一个**还没收全**的 UTF-8 字（0–3）。不是 UTF-8 的（本机代码页）按这个规则最多也只多压 3 个字节到下一块。 */
export function incompleteUtf8Tail(buf: Buffer): number {
  for (let back = 1; back <= Math.min(4, buf.length); back++) {
    const b = buf[buf.length - back];
    if ((b & 0xc0) === 0x80) continue;   // 续字节：再往前找首字节
    const need = b >= 0xf0 && b <= 0xf7 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? back : 0;
  }
  return 0;
}

/**
 * **长时间跑的命令（`bg_run` / 定时任务的 `checkCommand`）的输出收集**：最后要按 `capToolOutput` 的规则交给模型，
 * 但输出可能是几个小时的日志，不能全攒在内存里。所以：
 *   · 不超过 `SPOOL_MEMORY_BYTES` 的全在内存，结束时交给 `capToolOutput`（超了上限才落盘，没超不落盘）；
 *   · 超过了就开文件，把已有的和之后的全写进去，内存里只留开头 / 结尾。
 * **存的一律是 UTF-8**：给了 `decode`（Windows 上是 `decodeLocalOutput`：按行判断 UTF-8 / 本机代码页）就按整行解码之后再存 / 再留头尾 ——
 * 不然 GBK 输出原样落盘，模型按提示用 `local_read`（按 UTF-8 读）读到的是乱码，按 UTF-8 边界切头尾也会切坏双字节字。
 */
export class OutputSpool {
  private mem: Buffer[] = [];
  private memBytes = 0;
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private total = 0;
  private newlines = 0;
  private fd: number | null = null;
  /** 已经转成「落盘 + 头尾」模式（文件没开成也算：那样就只有头尾）。 */
  private spooled = false;
  private closed = false;
  private file: string | undefined;
  /** 还没凑成整行、没解码的原始字节（只在给了 `decode` 时用）。 */
  private pending = Buffer.alloc(0);
  private readonly opts: { dir: () => string | undefined; id?: string; memoryBytes?: number; decode?: (b: Buffer) => string };

  constructor(opts: { dir: () => string | undefined; id?: string; memoryBytes?: number; decode?: (b: Buffer) => string }) {
    this.opts = opts;
  }

  /** 收一块原始输出。给了 `decode`：凑成整行再解码成 UTF-8（一个字 / 一行被拆在两块里不会解坏）。 */
  write(chunk: Buffer): void {
    if (!chunk.length) return;
    if (!this.opts.decode) { this.writeUtf8(chunk); return; }
    const bytes = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let cut = bytes.lastIndexOf(0x0a) + 1;
    /* 一直不换行：半行不能无限攒，到上限就解掉（末尾没收全的 UTF-8 字留到下一块） */
    if (!cut && bytes.length > SPOOL_PENDING_MAX) cut = bytes.length - incompleteUtf8Tail(bytes);
    this.pending = Buffer.from(bytes.subarray(cut));
    if (cut) this.writeUtf8(Buffer.from(this.opts.decode(bytes.subarray(0, cut)), 'utf8'));
  }

  /** 剩下的半行也解掉（结束时）。 */
  private flushPending(): void {
    if (!this.pending.length || !this.opts.decode) return;
    const rest = this.pending;
    this.pending = Buffer.alloc(0);
    this.writeUtf8(Buffer.from(this.opts.decode(rest), 'utf8'));
  }

  private writeUtf8(chunk: Buffer): void {
    if (!chunk.length) return;
    this.total += chunk.length;
    this.newlines += newlinesIn(chunk);
    if (!this.spooled) {
      if (this.memBytes + chunk.length <= (this.opts.memoryBytes ?? SPOOL_MEMORY_BYTES)) {
        this.mem.push(chunk);
        this.memBytes += chunk.length;
        return;
      }
      this.startSpool();
    }
    if (this.fd !== null) {
      try { fs.writeSync(this.fd, chunk); } catch { this.dropFile(); }
    }
    this.keep(chunk);
  }

  private startSpool(): void {
    this.spooled = true;
    const all = Buffer.concat(this.mem);
    this.mem = [];
    this.memBytes = 0;
    this.keep(all);
    if (this.closed) return;
    try {
      const dir = this.opts.dir();
      if (!dir) return;
      const f = newOutputFile(dir, this.opts.id, new Date());
      this.fd = fs.openSync(f, 'w');
      this.file = f;
      fs.writeSync(this.fd, all);
    } catch { this.dropFile(); }
  }

  /** 写不进去了：关掉、删掉半份文件（半份完整输出比没有更误导），之后只留头尾。 */
  private dropFile(): void {
    if (this.fd !== null) { try { fs.closeSync(this.fd); } catch { /* 已经关了 */ } }
    this.fd = null;
    if (this.file) { try { fs.unlinkSync(this.file); } catch { /* 没建成 */ } }
    this.file = undefined;
  }

  private keep(chunk: Buffer): void {
    if (this.head.length < SPOOL_HEAD_KEEP) this.head = Buffer.concat([this.head, chunk.subarray(0, SPOOL_HEAD_KEEP - this.head.length)]);
    const t = Buffer.concat([this.tail, chunk]);
    this.tail = t.length > SPOOL_TAIL_KEEP ? Buffer.from(t.subarray(t.length - SPOOL_TAIL_KEEP)) : t;
  }

  /** 不再收输出（命令结束 / 被结束）：关文件。之后照样能 `render`。 */
  close(): void {
    if (!this.closed) this.flushPending();
    this.closed = true;
    if (this.fd !== null) { try { fs.closeSync(this.fd); } catch { /* 已经关了 */ } }
    this.fd = null;
  }

  /** 交给模型的那份：没超 `maxBytes` 原样，超了头 + 一行提示 + 尾。末尾空白去掉（同 `outputTail`）。 */
  render(maxBytes: number): { text: string; cut: boolean; file?: string } {
    this.close();
    if (!this.spooled) {
      const text = Buffer.concat(this.mem).toString('utf8').replace(/\s+$/, '');
      return capToolOutput(text, { maxBytes, dir: this.opts.dir(), id: this.opts.id });
    }
    const { head: headMax, tail: tailMax } = toolOutputSplit(maxBytes);
    const head = utf8Head(this.head, headMax);
    const tail = this.tail.subarray(utf8TailStart(this.tail, this.tail.length - tailMax));
    const omittedKb = Math.max(1, Math.round((this.total - head.length - tail.length) / 1024));
    const fromLine = newlinesIn(head) + 1;
    const toLine = this.newlines - newlinesIn(tail) + 1;
    const body = tail.toString('utf8').replace(/\s+$/, '');
    return { text: `${head.toString('utf8')}\n${omitNote(omittedKb, fromLine, toLine, this.file)}\n${body}`, cut: true, file: this.file };
  }
}

/** 按行取一段：`offset` 从 1 开始（默认 1），`limit` 是行数（默认到结尾）。`to` 是取到的最后一行。 */
export function sliceLines(text: string, offset?: number, limit?: number): { text: string; from: number; to: number; total: number } {
  const all = text.split('\n');
  const total = all.length;
  const from = Math.max(1, Math.floor(Number(offset) || 1));
  const n = Number(limit) > 0 ? Math.floor(Number(limit)) : Infinity;
  const picked = all.slice(from - 1, n === Infinity ? undefined : from - 1 + n);
  return { text: picked.join('\n'), from, to: from - 1 + picked.length, total };
}

/** 中间那一行提示（`omitNote` 有文件的那种）→ 文件路径。 */
const OMIT_NOTE_RE = /^…省略 \d+ KB（约第 \d+–\d+ 行），完整输出在 (.+?)，需要时用 local_read 按 offset 读（offset \/ limit 按行）…$/m;

/** 界面上一份工具输出最多显示多少（同截断之前 MCP 结果的硬上限，`localMcp.ts` 的 `HARD_OUTPUT_BYTES`）。 */
export const DISPLAY_OUTPUT_BYTES = 128 * 1024;

/**
 * **界面上的那份换回完整输出** —— 截断只影响交给模型的那份。执行器把工具结果原样转回来（ACP 的 tool_call_update），
 * 界面显示的就是模型看到的头 + 尾；这里认出中间那行提示，读回完整输出文件给界面。
 *
 * 只认 `allowedDir`（这条会话自己的 `.kirolex-tool-output/`）里的文件，而且头 / 尾必须和文件对得上（被执行器改过形状的就不动）。
 * 完整输出超过 `DISPLAY_OUTPUT_BYTES` 时同截断之前：只给前面那么多，后面留着那行提示（说完整的在哪）。
 * 认不出 / 读不到 / 对不上：原样返回。
 */
export function expandToolOutputForDisplay(text: string, allowedDir: string): string {
  const m = OMIT_NOTE_RE.exec(text);
  if (!m) return text;
  const file = path.resolve(m[1]);
  const same = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!same(path.dirname(file), path.resolve(allowedDir))) return text;
  let full: Buffer;
  try {
    if (fs.statSync(file).size > 64 * 1024 * 1024) return text;
    full = fs.readFileSync(file);
  } catch { return text; }
  const fullText = full.toString('utf8');
  const before = text.slice(0, m.index).replace(/\n$/, '');
  const after = text.slice(m.index + m[0].length).replace(/^\n/, '');
  if (!fullText.startsWith(before.replace(/^\s+/, '')) || !fullText.trimEnd().endsWith(after.trimEnd())) return text;
  if (full.length <= DISPLAY_OUTPUT_BYTES) return fullText;
  return `${utf8Head(full, DISPLAY_OUTPUT_BYTES).toString('utf8')}\n${m[0]}`;
}
