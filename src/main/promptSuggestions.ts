/**
 * 追问建议（输入框上面那排按对话生成的 chip）—— 「Claude Code / Codex 会话用它们**自己的**机制生成」。
 *
 * 三家各走各的，**不把会话内容交给它以外的那一家**：
 *   · kiro       → kiro-cli 一次性调用（index.ts `runLiteOneShot`，原样不动）；
 *   · Claude Code → CLI 自己的下一句预测（`prompt_suggestion`，怎么拿到的见 `claudeSuggestionTap.ts`），
 *                   适配器 / 旁听把它放在 `session_info_update._meta.promptSuggestions` 里；这里只存、只读，不起任何进程；
 *   · Codex      → 同一台机器上的 `codex exec`，同一套 model / provider（`codexSuggestions.ts`）。
 * 不认识是哪条会话（老调用方没带 id）→ 当 kiro（原来的行为）。
 *
 * 不 import electron：测试直接 import。
 */

export type SuggestionSource = 'native-claude' | 'codex-exec' | 'kiro';

/** 这条会话的追问建议由谁来出。`undefined` = 不知道是哪条会话 / 哪家引擎 → kiro（原样）。 */
export function suggestionSourceFor(engine: string | undefined): SuggestionSource {
  if (engine === 'claude') return 'native-claude';
  if (engine === 'codex') return 'codex-exec';
  return 'kiro';
}

/** 生成追问建议的提示词 —— kiro 和 Codex 用的是**同一份**（3 条、和对话同一种语言）。 */
export function suggestionsPrompt(convo: string): string {
  return `Based on the conversation below, propose 3 short follow-up prompts the user might send next. Each must be a concrete, actionable next step in the SAME language as the conversation, max 12 words, no numbering, no quotes. Reply with ONLY the 3 prompts, one per line.\n\n${convo}`;
}

/** 模型回的那几行 → 最多 3 条建议（去掉列表符号 / 编号 / 引号，太长的不要）。 */
export function parseSuggestionLines(clean: string): string[] {
  return String(clean || '')
    .split('\n')
    // Per line, on top of the leading marker cleanLiteOutput already removed:
    // list bullets/numbering, and a marker on any line but the first.
    .map((l) => l.replace(/^\s*(?:>\s*)?[-*\d.)、]*\s*/, '').replace(/^["'“”「『]+|["'“”」』]+$/g, '').trim())
    .filter((l) => l.length > 0 && l.length <= 80)
    .slice(-3);
}

/**
 * 一条 `session/update` 的 update 是不是「下一句预测」：是 → 那几条文字（`[]` = 清掉上一条）；不是 → null。
 * 形状（claude-agent-acp 0.94 `prompt-suggestions.js`）：
 * `{ sessionUpdate: 'session_info_update', _meta: { promptSuggestions: { suggestions: [{ text }] } } }`。
 * 空白的 text 不算一条（CLI 可能预测出一串空格）。
 */
export function promptSuggestionsFromUpdate(update: any): string[] | null {
  if (update?.sessionUpdate !== 'session_info_update') return null;
  const ps = update?._meta?.promptSuggestions;
  if (!ps || typeof ps !== 'object' || !Array.isArray(ps.suggestions)) return null;
  return ps.suggestions
    .map((s: any) => (typeof s?.text === 'string' ? s.text.trim() : ''))
    .filter((t: string) => t.length > 0);
}

/** 每条会话最新的那一份原生预测。空列表 = 清掉（这一轮没有预测，不能留着上一轮的）。 */
export class PromptSuggestionStore {
  private bySession = new Map<string, string[]>();
  set(sessionId: string, suggestions: string[]): void {
    if (suggestions.length) this.bySession.set(sessionId, suggestions.slice());
    else this.bySession.delete(sessionId);
  }
  get(sessionId: string): string[] {
    return (this.bySession.get(sessionId) || []).slice();
  }
  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

/**
 * 已经聊过的会话，这一轮没有动态建议时要不要显示那几条固定的（`PROMPT_SUGGESTIONS`）：
 * Claude Code / Codex 是（没有预测 / 生成失败或超时 / 还在生成时照旧显示固定建议）；kiro 不变（原来就是空着）。
 * `turnKey` 为 null = 这一轮还没回复完，什么都不显示。
 */
export function fixedSuggestionFallback(engine: string | undefined, turnKey: string | null): boolean {
  return !!turnKey && (engine === 'claude' || engine === 'codex');
}

/**
 * **每条会话每一轮只生成一次**（Codex 的 `codex exec`）：成功、失败、超时都记下，同一轮再来问（切走会话再切回来、
 * 分屏重新挂载）就直接给记下的结果，不再起进程。`turn` 由调用方给（主进程用「这条会话发过几轮 + 消息条数」）。
 * 同一轮正在生成时再来问 → 拿到的是同一个 Promise（不另起一个，也不返回一个让界面误以为失败的空结果）。
 * 每条会话只留最近一轮。
 */
export class SuggestionTurnLedger<T> {
  private bySession = new Map<string, { turn: string; result: Promise<T> }>();
  run(sessionId: string, turn: string, produce: () => Promise<T>): { result: Promise<T>; reused: boolean } {
    const prev = this.bySession.get(sessionId);
    if (prev && prev.turn === turn) return { result: prev.result, reused: true };
    const result = produce();
    this.bySession.set(sessionId, { turn, result });
    return { result, reused: false };
  }
}

/**
 * 界面某一格要显示某一轮的追问建议时怎么拿（ChatArea 的生成 effect 用）：
 *   · Claude Code → 一律问主进程（`ask`）：主进程那份（推送和清空都写进去，后台会话也一样）才是准的；问它只是读，不起任何进程。
 *     所以切回来 / 重新挂载时，后台到的新预测能显示，后台被清掉的旧预测不会再显示。
 *   · 别的引擎 → 本地缓存有就用（`use-cache`）；Codex 这一轮已经试过没拿到 → 不再问（`skip`，每轮只生成一次）；否则 `ask`。
 */
export type SuggestionLookup = { kind: 'use-cache'; items: string[] } | { kind: 'skip' } | { kind: 'ask' };
export function planSuggestionLookup(o: { engine?: string; cached?: string[]; tried: boolean }): SuggestionLookup {
  if (o.engine === 'claude') return { kind: 'ask' };
  if (o.cached?.length) return { kind: 'use-cache', items: o.cached };
  if (o.tried) return { kind: 'skip' };
  return { kind: 'ask' };
}

/**
 * **kiro 会话的追问建议少调几次**（token 优化 5/5）：每次都是一次辅助模型调用（远程会话还要在远端起一个 kiro-cli），
 * 所以只在回复确实在等用户接话时才生成。Claude Code / Codex 走它们自己的（上面），不经过这里。
 */
export const SUGGESTION_CONTEXT_MAX_PCT = 70;

/** 对话文字（`User: … \n\nAssistant: …`）里最后一条助手回复；没有就是空串。 */
export function lastAssistantReplyOf(convo: string): string {
  const s = String(convo || '');
  const at = s.lastIndexOf('Assistant: ');
  if (at < 0) return '';
  const tail = s.slice(at + 'Assistant: '.length);
  const nextUser = tail.indexOf('\n\nUser: ');
  return (nextUser < 0 ? tail : tail.slice(0, nextUser)).trim();
}

/** 等用户拍板的说法（只看最后一段） */
const DECISION_WORDS = /要不要|需不需要|是否需要|是否要|你定|您定|你决定|您决定|由你|看你|选哪|哪个更|哪一个|哪种|哪一种|你看呢|你觉得呢|您看|可以吗|行吗|好吗|请确认|确认一下|告诉我|let me know|would you like|do you want|should i\b|shall i\b|which (?:one|option|approach)|your call|you decide|prefer/i;
/** 编号 / 字母 / 圈号选项：`1.` `2)` `A.` `b、` `①` */
const NUMBERED_ITEM = /^\s*(?:\d{1,2}|[A-Za-z])[.)、:：]\s*\S|^\s*[①-⑩]\s*\S/;
const BULLET_ITEM = /^\s*[-*•+]\s+\S/;
const OPTION_INTRO = /选项|方案|做法|选择|选一|二选一|options?\b|choices?\b|alternatives?\b|either/i;

/**
 * 回复是不是在等用户接话：最后一段以问号结尾 / 末尾是一组编号选项（或「选项 / 方案」引出的列表）/ 最后一段明确在等用户决定。
 * 普通的陈述、普通的变更清单都不算。
 */
export function replyInvitesFollowUp(reply: string): boolean {
  const text = String(reply || '').replace(/```[\s\S]*?```/g, '').trim();
  if (!text) return false;
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const last = paras[paras.length - 1] || '';
  /* 结尾的 markdown 标记 / 括号 / 引号 / emoji 不算 */
  const bare = last.replace(/[\s*_`~)）\]】」』"'”’\p{Extended_Pictographic}️]+$/u, '');
  if (/[?？]$/.test(bare)) return true;
  if (DECISION_WORDS.test(last)) return true;
  /* 末尾这一块是列表：编号的 ≥ 2 条就算选项；无序列表要有「选项 / 方案」之类引出（不然多半是变更清单） */
  const lines = text.split('\n');
  let i = lines.length - 1;
  while (i >= 0 && !lines[i].trim()) i--;
  let numbered = 0, bullets = 0;
  for (; i >= 0; i--) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (NUMBERED_ITEM.test(l)) numbered++;
    else if (BULLET_ITEM.test(l)) bullets++;
    else if (/^\s{2,}\S/.test(l)) continue;   // 列表项的续行
    else break;
  }
  if (numbered >= 2) return true;
  if (bullets >= 2 && i >= 0 && OPTION_INTRO.test(lines[i])) return true;
  return false;
}

export type SuggestionGate = { ok: true } | { ok: false; reason: 'off' | 'context-high' | 'not-a-question' };

/** 要不要为这一轮生成（kiro）：设置里关了 → off；上下文 ≥ 70% → context-high；回复不是在等用户接话 → not-a-question。 */
export function suggestionGate(o: { enabled: boolean; contextPct?: number | null; reply: string }): SuggestionGate {
  if (!o.enabled) return { ok: false, reason: 'off' };
  if (typeof o.contextPct === 'number' && Number.isFinite(o.contextPct) && o.contextPct >= SUGGESTION_CONTEXT_MAX_PCT) return { ok: false, reason: 'context-high' };
  if (!replyInvitesFollowUp(o.reply)) return { ok: false, reason: 'not-a-question' };
  return { ok: true };
}
