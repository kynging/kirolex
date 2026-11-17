/**
 * **模型安全过滤的「会话级」拦截** —— PURE 判据，和 `staleSession.ts` / `transientError.ts` 并列。
 *
 * ## 实测
 *
 * 后端（经 Bedrock 的 Claude）回的是这样一段（多行，原样进了气泡）：
 *
 *   API Error: 400 … Our safeguards flagged this session … (https://www.anthropic.com/legal/aup). Details: [cyber]
 *   Request ID: req_…
 *   Message ID: msg_…
 *
 * 或者 `Cyber safeguards flagged this message. … apply for the Cyber Verification Program: https://support.claude.com/…`。
 *
 * 它不是 `Internal error`、不是 `EmptyResponse`、也不是传输层抖动，所以那两套判据一类都不认：没有自愈，
 * 只有一整段原文。而它是**整条会话**的标记 —— 中招之后发什么（哪怕一个字）都回同一个错；上下文压缩（compact）
 * 本身也是一次模型调用，同样被挡，于是看起来像"这一轮什么都没出、断线了"（那条会话先 3 轮 Compact 失败、再 2 轮直接被拦）。
 *
 * ## 为什么不重发、不换后端会话
 *
 * 换一个带着同样上下文、同样模型的新后端会话，多半照样被拦 —— 白拆白装（`staleSession.ts` 的 `lastRecreateAgoMs`
 * 那次实测：空历史照样失败就别再换）。能动的是**模型**，所以卡片首选「换模型」，其次才是「换后端会话」，
 * 最后是正当安全工作可以申请的 Cyber Verification Program。
 *
 * 匹配要**窄**：只认 `safeguards flagged`（含 `Cyber safeguards flagged`），或者 AUP 链接和 `[cyber]` 同时出现。
 * 单独的 `flagged` / `safeguards` / `[cyber]` 都不算。
 *
 * 纯模块（不 import electron / tr）：主进程和渲染层都直接 import。
 */

/** 原文里没给链接时用的 Cyber Verification Program 申请页。 */
export const CYBER_VERIFICATION_URL = 'https://support.claude.com/en/articles/14604842-cyber-verification-program';

export function isSafeguardBlock(text: unknown): boolean {
  const t = String(text ?? '');
  if (!t) return false;
  if (/safeguards\s+flagged/i.test(t)) return true;          // 含 "Cyber safeguards flagged"
  return /anthropic\.com\/legal\/aup/i.test(t) && /\[cyber\]/i.test(t);
}

/**
 * 主进程拦下之后抛给界面的是一句短话（不是原文，原文进了卡片的详情）—— 渲染层要认得它，
 * 好不再「重连再发一次」、也不再把它铺成气泡。中英两版都认（tr() 按设置的语言出）；原文本身也算。
 */
export function isSafeguardReport(text: unknown): boolean {
  const t = String(text ?? '');
  return isSafeguardBlock(t)
    || /safety filter (flagged this whole chat|blocked context compaction)/i.test(t)
    || /被模型的安全过滤(整条标记|拦下)/.test(t);
}

/** 申请链接：原文里给了 support.claude.com 的就用它（只收这个域名），否则用默认的。 */
export function cyberVerificationUrl(text: unknown): string {
  const m = /https:\/\/support\.claude\.com\/[^\s)"'\]<>]+/i.exec(String(text ?? ''));
  return m ? m[0].replace(/[.,;:!?]+$/, '') : CYBER_VERIFICATION_URL;
}

/** 会话里那张卡片的 `noteGroup`（界面据此画卡片；相邻同类并成「×N」）。 */
const SAFEGUARD_GROUP = 'safeguard-block';
export const COMPACT_FAILED_NOTE_GROUP = 'compact-failed';

export function safeguardNoteGroup(compact: boolean): string {
  return compact ? `${SAFEGUARD_GROUP}:compact` : SAFEGUARD_GROUP;
}
export function isSafeguardNoteGroup(group: unknown): boolean {
  const g = String(group ?? '');
  return g === SAFEGUARD_GROUP || g.startsWith(`${SAFEGUARD_GROUP}:`);
}
/** 这张卡说的是压缩那一下（安全过滤挡了压缩，或者压缩本身失败了）。 */
export function isCompactNoteGroup(group: unknown): boolean {
  const g = String(group ?? '');
  return g === COMPACT_FAILED_NOTE_GROUP || g === safeguardNoteGroup(true);
}

/** 这一条是 `/compact` 命令（界面上的「压缩」按钮发的也是它）。 */
export function isCompactCommand(text: unknown): boolean {
  return /^\s*\/compact(\s|$)/i.test(String(text ?? ''));
}

/** 报错自己说了"压缩失败"（`Error during compaction` / `compaction failed` / `failed to compact`）。 */
export function mentionsCompactionFailure(text: unknown): boolean {
  const t = String(text ?? '');
  return /\b(error|failed|failure)\s+(during|while|in|to)\s+(the\s+)?compact(ion|ing)?\b/i.test(t)
    || /\bcompaction\b[^\n]{0,40}\b(error|failed|failure)\b/i.test(t);
}

/** 流里"正在压缩上下文"的那句（kiro-cli 把它当普通文字发；渲染层同一条判据显示「⏳ 正在压缩」）。 */
export function isCompactionSignal(text: unknown): boolean {
  return /compacting|compact(ing)? (the )?conversation|compact(ing)? context|正在压缩|压缩上下文|压缩对话/i.test(String(text ?? ''));
}

/** 这一轮流出的文字最多记多少（`turnTextHead`）—— 超过就肯定不只是一句「正在压缩」了。 */
export const TURN_TEXT_HEAD_MAX = 4000;

/**
 * 这一轮流出的文字里**除了「正在压缩上下文」那几句状态提示之外**还有没有真正的回复。
 * kiro-cli 把压缩状态当普通文字发（`isCompactionSignal`），而 `textThisTurn` 把它也算成「出过字」——
 * 用那个判「压缩失败、什么都没出」就会漏掉只有状态提示的那一轮。按行去掉状态提示后看还剩不剩非空白。
 * `truncated` = 记的那段已经截断（文字很多），当然算有回复。
 */
export function hasReplyBeyondCompaction(text: unknown, truncated = false): boolean {
  if (truncated) return true;
  return String(text ?? '').split(/\r?\n/).some((line) => line.trim() !== '' && !isCompactionSignal(line));
}

export type TurnFailureCard = 'safeguard' | 'compact-failed' | null;

/**
 * 一轮报错收尾时，会话里要不要放一张可操作的卡片、放哪张：
 *   · 安全过滤拦截 → `safeguard`（不管是不是压缩那一下）；
 *   · 压缩失败、并且这一轮什么都没产出 → `compact-failed`（不留一条空白死轮）；
 *   · 别的 → null，照旧。
 */
export function turnFailureCard(input: { error: unknown; compactTurn: boolean; produced: boolean }): TurnFailureCard {
  if (isSafeguardBlock(input.error)) return 'safeguard';
  if (input.compactTurn && !input.produced) return 'compact-failed';
  return null;
}

export interface ModelChoice { value: string; name: string; disabled?: boolean }

/** 卡片上「换一个模型」能选的：去掉当前这个、去掉不可用的，顺序照模型下拉。 */
export function safeguardModelChoices(current: string | null | undefined, options: readonly ModelChoice[]): ModelChoice[] {
  return (options || []).filter((o) => o && o.value && o.value !== current && !o.disabled);
}
