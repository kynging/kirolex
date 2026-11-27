/**
 * **大份记忆的整理** —— PURE（不 import node 内置模块；读写文件都经调用方注入的 io）。token 优化 4/5。
 *
 * 背景：`sessionMemory.ts` 的自动整理超过 `MAX_CHARS`（1200 字符）就跳过 —— 那是为了防「大份手写记忆被整份换成 12 行」
 * （b5c98bfa）。结果大份记忆从不整理、只涨不缩（实测一条会话 29k 字符，每一轮都整份注入）。
 * 用户 2026-11-27 同意：大份记忆也要整理，但要先备份。
 *
 * 这里是那条「大份」路径，和 1200 字符以下的旧路径互不相干：
 *   · 什么时候：会话 / 项目层超过 `LARGE_MEMORY_BYTES`（32 KB，沿用 12512cd2 的提醒阈值）、一层一天最多一次、
 *     设置里可关；**全局层从不自动整理**（`autoCompactDue`）。
 *   · 怎么整理：提示词里写死只做三件事（合并重复 / 删已标注合并·完成·过期的过程记录 / 多行压一行），
 *     含「用户口径」等字样的行一律原样保留（`buildLargeCompactPrompt`）。
 *   · 不许整份换成几行（b5c98bfa 那条保护在这里的实现）：结果不得少于原文的 40%、不得丢任何二级标题，
 *     不满足就作废、原文件不动（`checkLargeCompaction`）—— 整份和每一段都查，**任何一段**不合格整次作废。
 *   · 受保护的条目**整条**不交给模型（`protectedBlocks`：含关键词的那一条连同续行、缩进的子项；以冒号结尾的
 *     连同后面列出来的几项），换成一行占位 `⟦KEEP-n⟧`，模型交回后原样换回去（`maskProtected` / `unmaskProtected`）。
 *     占位行丢了 / 重复了 / 被改了 → 整次作废。模型因此根本改不到这些条目。
 *   · 文件太大，一次塞不进一条命令行（Windows 命令行上限 32767 字符，辅助模型的 prompt 是一个 argv）：
 *     按行切成几段（`splitMemoryChunks`）分别整理；某一段的辅助调用报错 / 超时就那一段照抄原文（没碰任何内容）。
 */

export type CompactScope = 'session' | 'project';

/** 超过这么多**字节**才自动整理（和 12512cd2 的会话记忆提醒阈值同一个数）。 */
export const LARGE_MEMORY_BYTES = 32 * 1024;
/** 整理结果至少保留原文的这个比例（按字节）。 */
export const MIN_KEEP_RATIO = 0.4;
/** 每段最多这么多字符：加上提示词也远在 Windows 命令行上限（32767）以内，一段的输出也能在超时内写完。 */
export const CHUNK_CHARS = 6000;

/** 含这些字样的行一律原样保留。 */
export const PROTECTED_MARKERS = ['用户口径', '用户要求', '用户决定', '推翻', '不要', '必须', '硬规矩'] as const;

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(String(text || '')).length;
}

export function isProtectedLine(line: string): boolean {
  return PROTECTED_MARKERS.some((m) => line.includes(m));
}

function isHeading(line: string): boolean {
  return /^#{1,6}\s/.test(line.trim());
}

/** 二级标题（`## …`，不含 `###`），按去掉首尾空白后的整行比。 */
export function level2Headings(text: string): string[] {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^##(?!#)\s*\S/.test(l));
}

/** 本地日期 `YYYY-MM-DD`（一天一次按本机的日子算）。 */
export function localDay(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** 备份文件名：同目录 `memory.md.bak-<YYYYMMDD-HHmm>`（本地时间）。 */
export function compactBackupName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `memory.md.bak-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/** 认得出的备份文件名（同一分钟里第二份带 `-2`、`-3` 后缀）。 */
export const COMPACT_BACKUP_RE = /^memory\.md\.bak-\d{8}-\d{4}(?:-\d+)?$/;

/** 一天一次的账本键。 */
export function compactLedgerKey(scope: CompactScope, id: string): string {
  return `${scope}:${id}`;
}

/**
 * 这一层现在该不该自动整理；`null` = 该，否则是不整理的原因（写日志用）。
 * 全局层永远不自动整理；`<=` 阈值不整理；同一层今天已经整理过（不管成没成）不再来。
 */
export function autoCompactDue(o: {
  scope: 'global' | CompactScope;
  bytes: number;
  enabled: boolean;
  /** 这一层上次自动整理是哪一天（`localDay`），没整理过就不给 */
  lastDay?: string | null;
  today: string;
}): string | null {
  if (o.scope === 'global') return 'global memory is never compacted automatically';
  if (!o.enabled) return 'large memory compaction is turned off in settings';
  if (!(o.bytes > LARGE_MEMORY_BYTES)) return `memory is ${o.bytes} bytes (<= ${LARGE_MEMORY_BYTES})`;
  if (o.lastDay && o.lastDay === o.today) return `already compacted today (${o.today})`;
  return null;
}

/**
 * 按行切段，每段不超过 `max` 字符（单独一行就超过的，那一行自成一段）。
 * 过了半段遇到标题就提前断开 —— 尽量让一节落在同一段里，合并重复时看得到同一节的条目。
 * 切开再按 `\n` 拼回去和原文一字不差。
 */
export function splitMemoryChunks(text: string, max = CHUNK_CHARS): string[] {
  const lines = String(text || '').split('\n');
  const out: string[] = [];
  let cur: string[] = [];
  let len = 0;
  for (const line of lines) {
    const add = line.length + 1;
    const breakHere = cur.length > 0 && (len + add > max || (len > max / 2 && isHeading(line)));
    if (breakHere) { out.push(cur.join('\n')); cur = []; len = 0; }
    cur.push(line);
    len += add;
  }
  if (cur.length) out.push(cur.join('\n'));
  return out;
}

const LAYER_NAME: Record<CompactScope, string> = { session: '会话记忆（只注入这一条会话）', project: '项目记忆（注入该项目下每条会话）' };

/** 给辅助模型的提示词：整理规则写死在这里。 */
export function buildLargeCompactPrompt(chunk: string, o: { scope: CompactScope; index: number; total: number }): string {
  return [
    `你在整理一份${LAYER_NAME[o.scope]}文件的第 ${o.index + 1}/${o.total} 段。这份记忆每一轮都整份发给模型，太大了，要瘦身，但不能丢信息。`,
    '',
    '只允许做这三件事：',
    '1. 合并重复的条目（意思相同的几条合成一条；路径、ID、命令、数字、名字照抄原文）；',
    '2. 删掉已经标注「已合并」「已完成」「已过期」、并且没有口径含义的过程记录；',
    '3. 把同一条目的多行压成一条一行。',
    '',
    '硬性要求：',
    `- 凡是写着${PROTECTED_MARKERS.map((m) => `「${m}」`).join('')}的条目，一字不改、原样保留；`,
    '- 形如 ⟦KEEP-3⟧ 的占位行代表必须原样保留的条目：每一个都单独占一行、原样留在原来的位置，不要改、不要删、不要合并、不要挪到别的行里；',
    '- 所有标题行（# 开头）原样保留，顺序不变；',
    '- 其余仍然成立的内容不要改写、概括、翻译；拿不准能不能删的，保留；',
    '- 结果不得少于原文的 40%。',
    '只输出整理后的这一段 Markdown 正文：不要解释、不要前言、不要代码块围栏。',
    '',
    '----- 原文开始 -----',
    chunk,
    '----- 原文结束 -----',
  ].join('\n');
}

/** 模型输出的清理：剥掉整段包着的代码块围栏、首尾空行。 */
export function cleanCompactOutput(out: string): string {
  let s = String(out || '').replace(/\r\n/g, '\n').trim();
  const fence = s.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fence) s = fence[1].trim();
  return s;
}

const LIST_ITEM_RE = /^(?:[-*+]|\d+[.)])\s/;

function headingLevel(line: string): number {
  return (line.trim().match(/^(#{1,6})\s/)?.[1].length) ?? 0;
}

/**
 * 受保护的条目（行号范围 [start, end)），宁可多保护、不可漏：
 *   · 标题（任何级别）含 `PROTECTED_MARKERS` → **整节**：从这个标题到下一个同级或更高级的标题之前（标题本身也原样保留）；
 *   · 别的条目：一条 = 一个不是标题的非空行，连同它后面的续行（非空、不是标题、不是顶格的新列表项 —— 缩进的子项算它的）。
 *     这一条里任何一行含关键词就整条受保护；并且它是**引出下文**的（任何一行以冒号结尾，或者它是一段说明文字而不是列表项，
 *     例如「用户要求：\n说明文字\n- 部署规则\n- 验收规则」），后面紧跟着的几行（直到空行 / 标题）也一并算进来。
 */
export function protectedBlocks(text: string): Array<{ start: number; end: number }> {
  const lines = String(text || '').split('\n');
  const out: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) { i += 1; continue; }
    const level = headingLevel(lines[i]);
    if (level) {
      if (!isProtectedLine(lines[i])) { i += 1; continue; }
      let j = i + 1;
      while (j < lines.length && !(headingLevel(lines[j]) && headingLevel(lines[j]) <= level)) j += 1;
      out.push({ start: i, end: j });
      i = j;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && lines[j].trim() && !isHeading(lines[j]) && !LIST_ITEM_RE.test(lines[j])) j += 1;
    const entry = lines.slice(i, j);
    if (entry.some(isProtectedLine)) {
      const leadsIn = entry.some((l) => /[:：]\s*$/.test(l)) || !LIST_ITEM_RE.test(lines[i].trimStart());
      if (leadsIn) {
        while (j < lines.length && lines[j].trim() && !isHeading(lines[j])) j += 1;
      }
      out.push({ start: i, end: j });
    }
    i = j;
  }
  return out;
}

const keepToken = (n: number): string => `⟦KEEP-${n}⟧`;

/** 把受保护的条目换成占位行；`blocks[n]` 是第 n 个占位代表的原文（多行）。 */
export function maskProtected(text: string): { masked: string; blocks: string[] } {
  const lines = String(text || '').split('\n');
  const ranges = protectedBlocks(text);
  const blocks: string[] = [];
  const out: string[] = [];
  let at = 0;
  for (const r of ranges) {
    out.push(...lines.slice(at, r.start));
    out.push(keepToken(blocks.length));
    blocks.push(lines.slice(r.start, r.end).join('\n'));
    at = r.end;
  }
  out.push(...lines.slice(at));
  return { masked: out.join('\n'), blocks };
}

/** 占位行换回原文；每个占位必须正好单独出现一次，否则返回 null（这次整理作废）。 */
export function unmaskProtected(text: string, blocks: string[]): string | null {
  const lines = String(text || '').split('\n');
  const seen = new Array(blocks.length).fill(0);
  const out: string[] = [];
  for (const line of lines) {
    const m = line.trim().match(/^⟦KEEP-(\d+)⟧$/);
    if (m && Number(m[1]) < blocks.length) { seen[Number(m[1])] += 1; out.push(blocks[Number(m[1])]); continue; }
    if (/⟦KEEP-\d+⟧/.test(line)) return null;   // 占位被并进了别的行 / 改了编号
    out.push(line);
  }
  return seen.every((n) => n === 1) ? out.join('\n') : null;
}

/** 整理结果能不能用：不少于原文 40%（字节）、二级标题一个不少、受保护的条目整条原样都在。`null` = 能用。 */
export function checkLargeCompaction(original: string, result: string): string | null {
  const before = utf8Bytes(original);
  const after = utf8Bytes(result);
  if (!String(result || '').trim()) return 'result is empty';
  if (after < before * MIN_KEEP_RATIO) return `result is ${after} bytes, below ${Math.round(MIN_KEEP_RATIO * 100)}% of ${before}`;
  const resultLines = String(result).split(/\r?\n/);
  const have = new Set(resultLines.map((l) => l.trim()));
  const lost = level2Headings(original).filter((h) => !have.has(h));
  if (lost.length) return `result lost level-2 heading(s): ${lost.slice(0, 3).join(' | ')}`;
  const origLines = String(original).split(/\r?\n/);
  const joined = `\n${resultLines.join('\n')}\n`;
  const dropped = protectedBlocks(origLines.join('\n')).filter((r) => !joined.includes(`\n${origLines.slice(r.start, r.end).join('\n')}\n`));
  if (dropped.length) return `result dropped or changed ${dropped.length} protected entr${dropped.length === 1 ? 'y' : 'ies'}`;
  return null;
}

export interface LargeCompactIo {
  /** 当前文件内容（原样，不 trim） */
  read(): string;
  /** 一次辅助模型调用 */
  ask(prompt: string): Promise<string>;
  /** 把当前文件备份成同目录 `memory.md.bak-…`，返回备份路径；失败返回 null */
  backup(): string | null;
  write(text: string): void;
  log(message: string): void;
}

export type LargeCompactOutcome =
  | { status: 'written'; beforeBytes: number; afterBytes: number; backupPath: string; text: string }
  | { status: 'rejected' | 'unchanged' | 'skipped'; reason: string; beforeBytes: number };

/**
 * 整理一层：受保护的条目换成占位 → 分段问模型（**任何一段**少于 40% / 丢了标题 / 动了占位 → 整次作废）→
 * 换回受保护的条目 → 整份校验（不过关作废）→ 调用期间文件被改过就不写 → **先备份**（备份不上不写）→ 写。
 * 某一段的辅助调用报错 / 超时：那一段照抄（它的内容一个字没动，不算触犯保护条件）。
 */
export async function runLargeCompaction(scope: CompactScope, io: LargeCompactIo): Promise<LargeCompactOutcome> {
  const raw = io.read();
  const original = raw.replace(/\r\n/g, '\n');
  const beforeBytes = utf8Bytes(raw);
  if (!original.trim()) return { status: 'skipped', reason: 'memory is empty', beforeBytes };
  const { masked, blocks } = maskProtected(original);
  const chunks = splitMemoryChunks(masked);
  const parts: string[] = [];
  const reject = (reason: string): LargeCompactOutcome => { io.log(`rejected: ${reason}`); return { status: 'rejected', reason, beforeBytes }; };
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    if (!chunk.trim()) { parts.push(chunk); continue; }
    let produced = '';
    try {
      produced = cleanCompactOutput(await io.ask(buildLargeCompactPrompt(chunk, { scope, index: i, total: chunks.length })));
    } catch (err: any) {
      io.log(`chunk ${i + 1}/${chunks.length}: helper failed (${err?.message || err}), keep it as is`);
      parts.push(chunk);
      continue;
    }
    const bad = checkLargeCompaction(chunk, produced);
    if (bad) return reject(`chunk ${i + 1}/${chunks.length}: ${bad}`);
    parts.push(produced);
  }
  const unmasked = unmaskProtected(parts.join('\n'), blocks);
  if (unmasked === null) return reject('a protected entry placeholder was dropped, duplicated or changed');
  const result = `${unmasked.replace(/\s+$/, '')}\n`;
  const bad = checkLargeCompaction(original, result);
  if (bad) return reject(bad);
  const afterBytes = utf8Bytes(result);
  if (afterBytes >= beforeBytes || result.trim() === original.trim()) {
    return { status: 'unchanged', reason: 'nothing to compact', beforeBytes };
  }
  if (io.read() !== raw) {
    io.log('memory changed while compacting, skip writing (keep the current file)');
    return { status: 'skipped', reason: 'memory changed while compacting', beforeBytes };
  }
  const backupPath = io.backup();
  if (!backupPath) {
    io.log('could not back up memory, skip writing');
    return { status: 'skipped', reason: 'backup failed', beforeBytes };
  }
  io.write(result);
  return { status: 'written', beforeBytes, afterBytes, backupPath, text: result };
}

export interface CompactGate {
  /** 正在整理的层（`compactLedgerKey`）—— 同一层同时只跑一份 */
  inFlight: Set<string>;
  /** **拿到这一层的锁之后**现读：今天的账本、当前文件大小、开关 —— 不能用进来之前读的快照 */
  recheck(): { lastDay?: string | null; bytes: number; enabled: boolean; today: string };
  /** 记下「这一层今天整理过了」 */
  record(day: string): void;
}

/**
 * 一层的整理闸门：拿锁 →（自动的）按**现读**的账本 / 大小重新判一次要不要整理 → 记账 → 整理 → 放锁。
 *
 * 为什么要在锁里重判：同一个项目的会话 A、B 先后结束一轮，A 进来时读的账本还是旧的；A 在等会话层整理的时候
 * B 把项目层整理完、记了账，A 接着按旧账本再整理一次项目层 —— 一天两次。锁只挡得住「同时」，挡不住「先后」。
 * 手动（`auto: false`）不看账本和大小，但同样记账（今天不再自动来）。
 */
export async function gatedCompaction<T>(
  scope: CompactScope, key: string, auto: boolean, gate: CompactGate, work: () => Promise<T>,
): Promise<T | { status: 'busy' | 'not-due'; reason: string }> {
  if (gate.inFlight.has(key)) return { status: 'busy', reason: 'already compacting' };
  gate.inFlight.add(key);
  try {
    const now = gate.recheck();
    if (auto) {
      const why = autoCompactDue({ scope, ...now });
      if (why) return { status: 'not-due', reason: why };
    }
    gate.record(now.today);
    return await work();
  } finally {
    gate.inFlight.delete(key);
  }
}
