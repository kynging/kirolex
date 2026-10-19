/**
 * **把工具调用写成文字反复发作时，会话自己恢复** ——「这个只是改了个工具调用写成了文字，没有解决我的问题啊」。
 *
 * 只纠正一句不够：CDE 那条会话，kiro-cli 自己的上下文里已经堆了 20 多条文字版调用，纠正一句只顶一轮，
 * 下一轮又犯；原来第二次就停下、让人手动换后端会话，活一直停着。所以：
 *
 *   · 第一次（这条会话里）→ `nudge`：补发一次纠正（`TEXT_TOOL_NUDGE_PROMPT`，老规矩）；
 *   · 第二次（含跨轮次：中间隔了正常的一轮、你说了句「继续」都算）→ `swap`：换新的后端会话
 *     （和 EmptyResponse / 连续拒绝同一套，上下文带过去，历史里那段已折叠），再把卡住的那一步发给新后端；
 *   · 防循环：30 分钟内最多自动换 `SWAP_MAX` 次；再犯 → `halt`：会话里一句 ⚠️，之后**不再自动纠正**，
 *     直到你发下一条消息（`afterUserMessage`）。
 *
 * 纯逻辑（不 import electron，有测试）：状态由 index.ts 按会话存在内存里，时间作为参数传进来。
 */

import { TEXT_TOOL_NUDGE_ID_PREFIX, TEXT_TOOL_NUDGE_PROMPT, type TextToolAction, type TextToolCall } from './textToolCall.ts';

/** 自动换后端会话的窗口和上限：30 分钟内最多 2 次。 */
export const SWAP_WINDOW_MS = 30 * 60_000;
export const SWAP_MAX = 2;

/** 换完后端续发那一步的消息 id 前缀 —— 以纠正的前缀开头，所以「不算新的一轮 / 显示成 KiroLex 提示 / 再犯算纠正那一轮」全都照旧认得。 */
export const TEXT_TOOL_SWAP_ID_PREFIX = `${TEXT_TOOL_NUDGE_ID_PREFIX}swap_`;

export interface TextToolRecoveryState {
  /** 自上次换后端会话以来（或这次启动以来）检测到几次「写成文字」 */
  detections: number;
  /** 自动换后端会话的时间（epoch ms），只留窗口里的 */
  swaps: number[];
  /** 到了上限停下了：你发下一条消息之前不再自动处理 */
  halted: boolean;
  /** 最近一次想调用的工具 */
  lastTools: string[];
  /** 换后端会话那一条已经排进投递队列、还没真换：这期间再判出来不重复排（换成 / 没换成都会清掉） */
  swapPending?: boolean;
}

export function emptyRecoveryState(): TextToolRecoveryState {
  return { detections: 0, swaps: [], halted: false, lastTools: [] };
}

export type RecoveryAction = 'none' | 'nudge' | 'swap' | 'halt';

export interface RecoveryDecision {
  action: RecoveryAction;
  state: TextToolRecoveryState;
  /** `nudge` / `swap` 要发的那一句（发给模型，也作为 KiroLex 提示显示） */
  prompt?: string;
  /** 窗口里已经自动换过几次（`halt` 的详情用） */
  swapsInWindow: number;
  tools: string[];
}

/** 从标记块里取「这一步是干什么的」：工具名 +（`__tool_use_purpose` 有就带上）。 */
export function describeTextToolStep(markup: string, tools: string[]): string {
  const names = tools.length ? tools.join('、') : '';
  const m = /<(?:[a-z][\w-]*:)?parameter\s+name\s*=\s*["']__tool_use_purpose["']\s*>([\s\S]*?)<\/(?:[a-z][\w-]*:)?parameter>/i.exec(String(markup || ''));
  const purpose = (m?.[1] || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (names && purpose) return `${names}（${purpose}）`;
  if (names) return names;
  return purpose ? `工具调用（${purpose}）` : '刚才那次工具调用';
}

/** 换完后端会话续发的那一句。 */
export function textToolContinuePrompt(step: string): string {
  return `已换新的后端会话，继续刚才没执行的那一步：${step}。请直接调用工具。`;
}

/** 这一轮的「用户消息」是不是你自己发的（输入框 / 排队 / 控制入口）—— 只有它解除 `halted`。唤醒、定时、纠正都不算。 */
export function isUserTurnMessageId(id: string | null | undefined): boolean {
  return typeof id === 'string' && /^(user|queue)_/.test(id);
}

/** 你发了下一条消息：停下的状态解除。检测计数不清 —— 「第二次」本来就含跨轮次。 */
export function afterUserMessage(prev: TextToolRecoveryState | undefined): TextToolRecoveryState {
  const s = prev ?? emptyRecoveryState();
  return s.halted ? { ...s, halted: false, detections: 0 } : s;
}

/** 后端会话换过了（控制入口那条路）：新的后端是干净的，计数从头来；停下的状态不动（等你发消息）。 */
export function afterBackendSwap(prev: TextToolRecoveryState | undefined): TextToolRecoveryState {
  return { ...(prev ?? emptyRecoveryState()), detections: 0 };
}

/** 自动换后端会话**真的换成了**：这时才记一次（30 分钟 `SWAP_MAX` 次的上限按实际换成的算）。 */
export function recordAutoSwap(prev: TextToolRecoveryState | undefined, now: number): TextToolRecoveryState {
  const s = prev ?? emptyRecoveryState();
  return { ...s, detections: 0, swapPending: false, swaps: [...s.swaps.filter((t) => now - t < SWAP_WINDOW_MS), now] };
}

/** 排着的换后端那一条没换成（被你的新消息取代 / 出错）：不记次数；计数留着，下次再犯直接换。 */
export function swapAbandoned(prev: TextToolRecoveryState | undefined): TextToolRecoveryState {
  return { ...(prev ?? emptyRecoveryState()), swapPending: false };
}

/**
 * 排着的那一条（纠正 / 换后端续做）还该不该发 —— 返回原因 = 不发。
 *   · 纠正：排着的时候开了**任何**别的一轮（你发的、排队的、后台结果、定时任务）就过时 —— 那一轮已经接上了；
 *   · 换后端续做：只有**你自己发了一条**才过时。后台结果 / 定时任务先到、先跑一轮不取消它 ——
 *     后端会话还是坏的、那一步还卡着（`turns` / `userTurns` 是排的那一刻的计数，`ref` 记在唤醒项上）。
 */
export function textToolWakeStale(item: { swap?: boolean; ref?: string }, now: { turns: number; userTurns: number }): string | null {
  if (item.swap) return String(now.userTurns) === String(item.ref) ? null : 'you sent another message';
  return String(now.turns) === String(item.ref) ? null : 'another turn started';
}

/**
 * 一轮以「写成文字的工具调用」结束（`textToolCallVerdict` 判出 `nudge` / `stop`）之后怎么办。
 *
 * `verdict.action === 'stop'` 是「纠正那一轮（含续发那一轮）还这样」—— 至少算第二次。
 */
export function decideTextToolRecovery(
  prev: TextToolRecoveryState | undefined,
  o: { verdict: { action: TextToolAction; hit?: TextToolCall }; text: string; now: number },
): RecoveryDecision {
  const base = prev ?? emptyRecoveryState();
  const swaps = base.swaps.filter((t) => o.now - t < SWAP_WINDOW_MS);
  const hit = o.verdict.hit;
  if (o.verdict.action === 'none' || !hit) {
    return { action: 'none', state: { ...base, swaps }, swapsInWindow: swaps.length, tools: [] };
  }
  const tools = hit.tools;
  if (base.halted || base.swapPending) {
    return { action: 'none', state: { ...base, swaps, lastTools: tools }, swapsInWindow: swaps.length, tools };
  }
  const detections = Math.max(base.detections + 1, o.verdict.action === 'stop' ? 2 : 1);
  if (detections < 2) {
    return {
      action: 'nudge', prompt: TEXT_TOOL_NUDGE_PROMPT,
      state: { ...base, swaps, detections, lastTools: tools }, swapsInWindow: swaps.length, tools,
    };
  }
  if (swaps.length >= SWAP_MAX) {
    return { action: 'halt', state: { detections: 0, swaps, halted: true, lastTools: tools }, swapsInWindow: swaps.length, tools };
  }
  const step = describeTextToolStep(String(o.text || '').slice(hit.start, hit.end), tools);
  /* 次数等真的换成了再记（`recordAutoSwap`）；排着的期间不重复排 */
  return {
    action: 'swap', prompt: textToolContinuePrompt(step),
    state: { ...base, swaps, detections, halted: false, lastTools: tools, swapPending: true }, swapsInWindow: swaps.length, tools,
  };
}
