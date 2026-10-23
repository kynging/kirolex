/**
 * 会话记忆的自动维护 —— PURE，「你在 memory 里加一个 session memory，你看看怎么弄」。
 *
 * 先说清已经有的东西,免得重复造:三层记忆(全局 ⊕ project ⊕ 这个会话)早就在了 —— 文件在
 * `~/.kirolex/memory/sessions/<id>/memory.md`,每一轮都会被注入(`buildMemoryInjection`),对话框里也有
 * 那个 tab。缺的是**没人写它**:它是一个手填的文本框,而没有人会在聊天中途停下来去写笔记。
 *
 * 所以这里补的不是存储,是维护:一轮结束、攒够了新消息,就用便宜的一次性调用(`runLiteOneShot`,和生成标题
 * 同一条路)把这段对话压成几行事实,写回那个文件。下一轮的注入就带着它 —— 于是长会话被压缩过之后,
 * 「我们之前定了什么」不再依赖模型还记不记得。
 *
 * 三条克制,都是为了不让它变成负担:
 *   有门槛      每 CONSOLIDATE_EVERY 条新消息才做一次;一句「好」不值得一次模型调用
 *   有上限      记忆本身不许无限长(MAX_CHARS)—— 它每一轮都要被注入,长了就是每一轮都在付钱
 *   只留事实    提示词明说要「决定、约束、路径、名字」,不要过程叙述:注入的是事实,不是日记
 */
import { stripTextToolCalls } from './textToolCall.ts';

export interface SessionMemoryState {
  /** 现在这个会话有多少条消息 */
  messages: number;
  /** 上一次压缩时是多少条（没压缩过就是 0） */
  consolidatedAt?: number;
  /** 正在压缩 —— 一次就够，重入只会写坏同一个文件 */
  inFlight?: boolean;
}

/** 每 12 条新消息压一次。一次调用几分钱，但每一轮的注入都要带着它，所以宁疏不密。 */
export const CONSOLIDATE_EVERY = 12;
/** 会话记忆的上限：它每一轮都要被注入，长了就是每一轮都在付钱。 */
export const MAX_CHARS = 1200;

export function shouldConsolidate(state: SessionMemoryState): boolean {
  if (!state || state.inFlight) return false;
  const now = Math.max(0, Number(state.messages) || 0);
  const then = Math.max(0, Number(state.consolidatedAt) || 0);
  return now - then >= CONSOLIDATE_EVERY;
}

/**
 * 压缩用的提示词。要的是**能在下一轮直接当事实用**的东西,所以点名了该留什么、不该留什么。
 *
 * 带上现有的记忆,并要求「合并而不是重写」:否则每次压缩都会把上一次留下的结论丢掉 —— 那才是最贵的信息,
 * 它们往往来自更早、已经不在这段最近对话里的地方。
 */
export function buildConsolidationPrompt(recent: string, existing: string): string {
  return [
    'Condense this chat into a short memory note that a future turn can rely on as FACT.',
    '',
    'Keep only what stays true: decisions made, constraints agreed, file paths, names, ids, numbers,',
    'and anything the user asked to be remembered. Drop narration, pleasantries, and anything already',
    'obvious from the code. No headings, no preamble — one fact per line, at most 12 lines.',
    'Write the lines in the language the user used.',
    '',
    existing.trim()
      ? `MERGE with the note below — keep every line that is still true, drop what has been superseded:\n${existing.trim()}`
      : 'There is no note yet.',
    '',
    `Recent conversation:\n${recent}`,
  ].join('\n');
}

/**
 * 合并结果并封顶 —— 模型可能什么也没给（那就保持原样，而不是把已有的记忆清成空）。
 *
 * 超长时从**后面**截:一份记忆里越靠前的通常越是早就定下来的约束,而它正是最不该被丢掉的部分。
 */
export function mergeSessionMemory(existing: string, produced: string, cap = MAX_CHARS): string {
  const next = String(produced || '').trim();
  if (!next) return String(existing || '');
  const lines = next
    .split('\n')
    .map((line) => line.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 12);
  const joined = lines.map((line) => `- ${line}`).join('\n');
  return joined.length <= cap ? joined : `${joined.slice(0, cap).replace(/\n[^\n]*$/, '')}`;
}

/**
 * 这一次整理要写回的会话记忆；`null` = 不写。
 *
 * 已有记忆和这次产出里的文字版调用块（`<invoke …>`）都清掉 —— 记忆每一轮都注入，留着就是一轮一轮喂回模型。
 *   · 没变化 → 不写；
 *   · 已有记忆**没清理什么**、这次也没产出 → 不写（`mergeSessionMemory` 保持原样，别把记忆清成空）；
 *   · 已有记忆全是调用块、清完是空的、这次也没产出 → 写回空 —— 不然旧调用块会一直留着被注入；
 *   · 新结果的行数比已有记忆（清过的）少 → 原记忆原样保留，只把新行追加上去（`appendNewMemoryLines`）。
 */
export function consolidatedSessionMemory(existing: string, produced: string, cap = MAX_CHARS): string | null {
  const before = String(existing || '');
  const clean = stripTextToolCalls(before);
  let merged = mergeSessionMemory(clean, stripTextToolCalls(String(produced || '')), cap);
  /* 新结果行数比原记忆少 → 不整份替换，只把新事实追加到原记忆后面（旧行一条不删） */
  if (clean.trim() && memoryLines(merged).length < memoryLines(clean).length) merged = appendNewMemoryLines(clean, merged);
  if (merged === before) return null;
  if (!merged && clean === before) return null;
  return merged;
}

function memoryLines(text: string): string[] {
  return String(text || '').split(/\r?\n/).filter((line) => line.trim());
}

/** 按行比较用的键：去掉列表符号和首尾空白，「- 用 opus」和「用 opus」算同一条。 */
function memoryLineKey(line: string): string {
  return line.replace(/^\s*[-*•]\s*/, '').trim();
}

/** 「只追加新事实、不删旧行」—— 和 `mergeMemoryText`（s3Sync.ts）同一个思路：原文原样保留，按行去重后把新行接在后面。 */
export function appendNewMemoryLines(existing: string, produced: string): string {
  const base = String(existing || '');
  const have = new Set(memoryLines(base).map(memoryLineKey));
  const extra: string[] = [];
  for (const line of memoryLines(produced)) {
    const key = memoryLineKey(line);
    if (!key || have.has(key)) continue;
    have.add(key);
    extra.push(line);
  }
  if (!extra.length) return base;
  return `${base.replace(/\s*$/, '')}\n${extra.join('\n')}`;
}

/**
 * 自动整理要不要跳过；`null` = 照常整理。
 *
 * 已有会话记忆（清掉调用块之后）超过 `MAX_CHARS` 的，多半是用户手写的大份记忆 —— 自动整理只产出 ≤12 行，
 * 写回就是把它整份压没。所以超过上限就不自动整理；用户手动点「压缩」那条路不走这里，不受影响。
 */
export function autoConsolidationSkipReason(existing: string, cap = MAX_CHARS): string | null {
  const size = stripTextToolCalls(String(existing || '')).trim().length;
  return size > cap ? `existing memory is ${size} chars (> ${cap}), skip auto consolidation to protect it` : null;
}

export interface AutoConsolidationIo {
  /** 模型调用返回后**重新读一次**当前的会话记忆 —— 等待那几秒里用户可能刚保存了一份手写记忆 */
  readCurrent(): string;
  /** 用 `backupMemoryLayer` 备份原文件，返回备份路径；没有可备份的 / 失败返回 null */
  backup(): string | null;
  write(text: string): void;
  log(message: string): void;
}

/**
 * 自动整理的写回：超上限跳过 → 算出要写的 → **先备份再写**。
 *
 * `existing` 是模型调用**之前**读的；返回后文件和它不一样（等待期间用户改过）就不写 —— 这次的结果是按旧内容算的，
 * 写回会盖掉刚保存的那份（哪怕原来是空的、连备份都不会做）。
 * 原记忆不空、备份却没成功的，不写 —— 写回之后就找不回原文了。
 * 返回 'skipped'（跳过 / 没备份上）、'unchanged'（不需要写）、'written'。
 */
export function applyAutoConsolidation(existing: string, produced: string, io: AutoConsolidationIo): 'skipped' | 'unchanged' | 'written' {
  const skip = autoConsolidationSkipReason(existing);
  if (skip) { io.log(skip); return 'skipped'; }
  if (io.readCurrent() !== String(existing || '')) {
    io.log('session memory changed while consolidating, skip writing (keep the current file)');
    return 'skipped';
  }
  const merged = consolidatedSessionMemory(existing, produced);
  if (merged === null) return 'unchanged';
  const hadMemory = !!String(existing || '').trim();
  const at = hadMemory ? io.backup() : null;
  if (hadMemory && !at) { io.log('could not back up existing memory, skip writing consolidation'); return 'skipped'; }
  if (at) io.log(`backed up session memory -> ${at}`);
  io.write(merged);
  return 'written';
}
