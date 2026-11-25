/**
 * **「停止这一轮并立即切换」之后怎么接着做，以及被停那一轮的消息要不要放回输入框** —— PURE。
 *
 * 负责人反馈 2026-11-25：忙时切换弹出的「⏳ 这一轮还在跑…」卡片上点「停止这一轮并立即切换」，原来就是普通 Stop：
 * 切换应用了，可被停的那一轮没有在新模型上继续，会话就停在那；被停那一轮的消息还被塞回输入框、标成「下一条覆盖这一轮」。
 * 这条消息是别的会话（📨 session_send）或定时 / 后台唤醒发来的时候尤其严重：塞回去的是带 `⟨session:… · call:…⟩` 来源标记的原文，
 * 一按 Enter 就以你的名义重发，层数、回复匹配全乱。
 *
 * 规则（判据只在这里）：
 *   · 「停止并切换」，切换成功：这一轮**还没产出**（没正文、没工具调用）→ 原样重发那条（同一个 id）；**已有产出** → 发一句续写提示；
 *     都不放回输入框、不标「下一条覆盖」。循环的一轮交给主进程的 driver（loopDriver.ts `holdForSwitch`）按它的账本做同样的事。
 *   · 切换失败 / 普通 Stop / 断线 / 静默超时：按普通中断处理 —— 但只有**你自己在输入框打的**那条才放回输入框、标「下一条覆盖」；
 *     别处来的（会话 / 控制入口 / 定时 / 后台任务 / 监视 / 循环 / nudge / KiroLex 自动续写）一律不放，中断条给「重跑」，原样重发。
 */

import { isKirolexNote } from '../main/kirolexNote.ts';
import { isAutoContinueMessageId, SWITCH_CONTINUE_PROMPT } from '../main/controlSessions.ts';

export { SWITCH_CONTINUE_PROMPT };

/** 这一轮的基础消息是从哪来的 */
export type TurnOrigin =
  | 'user'           // 你在输入框打的（含排队卡片里你排的）
  | 'session'        // 📨 另一条会话经 session_send
  | 'control'        // 本机工具经控制入口（HTTP）
  | 'schedule'       // ⏰ 定时
  | 'bg'             // 后台任务唤醒
  | 'watch'          // 监视唤醒
  | 'loop'           // 循环的一轮
  | 'nudge'          // KiroLex 的「写成文字」纠正
  | 'auto-continue'; // KiroLex 自动续写

interface OriginMsg { id?: string; content?: string }

/**
 * 按消息 id 的来源标记认（`user_xs_` / `user_ctl_`、`sched_`、`wake_<任务 id>_`、`loop_`、`nudge_`，见 main 的 wakeDeliver）；
 * KiroLex 自动续写那几句按正文认（`autoPrompts`，渲染层传进来）。
 */
export function turnOriginOf(msg: OriginMsg | null | undefined, autoPrompts: readonly string[] = [SWITCH_CONTINUE_PROMPT]): TurnOrigin {
  const id = String(msg?.id || '');
  if (/^(user|steer|queue)_xs_/.test(id)) return 'session';
  if (/^(user|steer|queue)_ctl_/.test(id)) return 'control';
  if (id.startsWith('sched_')) return 'schedule';
  if (id.startsWith('wake_watch_')) return 'watch';
  if (id.startsWith('wake_')) return 'bg';
  /* 循环的一轮（`loop_<开始>_<轮次>`）和 driver 替它发的续写（`loop_<开始>_<轮次>_c<时间>`） */
  if (/^loop_\d+_\d+(_c\d+)?$/.test(id)) return 'loop';
  if (id.startsWith('nudge_')) return 'nudge';
  if (isAutoContinueMessageId(id)) return 'auto-continue';
  const text = String(msg?.content || '').trim();
  if (text && autoPrompts.some((p) => p.trim() === text)) return 'auto-continue';
  return 'user';
}

interface TurnMsg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  steer?: unknown;
  kirolex?: true;
  toolCalls?: unknown[];
}

/**
 * 这一轮的基础消息在哪：最后一条不是追加指令（steer）的用户消息。KiroLex 自己的提示跳过 ——
 * 只有 `nudge_` 那条例外：它显示成 KiroLex 提示，可它就是这一轮的提问。
 */
export function turnBaseIndex(msgs: readonly TurnMsg[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'user' || m.steer) continue;
    if (isKirolexNote(m as any)) { if (String(m.id).startsWith('nudge_')) return i; continue; }
    return i;
  }
  return -1;
}

/** 这一轮（基础消息之后）有没有产出：正文或工具调用。思考段（💭）不算 —— 主进程判「开始做了」也不算它。 */
export function turnProduced(msgs: readonly TurnMsg[], baseIdx: number): boolean {
  if (baseIdx < 0) return false;
  for (let i = baseIdx + 1; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== 'assistant') continue;
    if (m.toolCalls?.length) return true;
    const text = String(m.content || '');
    if (text.trim() && !text.startsWith('💭 ')) return true;
  }
  return false;
}

export interface InterruptPlan {
  /** 把这一轮的原文放回输入框 */
  prefill: boolean;
  /** 标成「下一条覆盖这一轮」（输入框 / 排队的下一条截掉这一轮再发） */
  markInterrupted: boolean;
  /** 中断条给「重跑」按钮：原样重发这条（保留来源标记） */
  offerRerun: boolean;
}

/** 普通中断（Stop、/stop、执行器断开、静默超时、停止并切换但切换失败）：只有你自己打的才放回输入框 */
export function interruptPlanFor(origin: TurnOrigin): InterruptPlan {
  if (origin === 'user') return { prefill: true, markInterrupted: true, offerRerun: false };
  return { prefill: false, markInterrupted: false, offerRerun: true };
}

export interface StopSwitchInput {
  /** 这一轮停下时有没有产出（`turnProduced`） */
  produced: boolean;
  origin: TurnOrigin;
  /** 切换应用的结果：`ok` 全部成功；`failed` 有失败的、或者没等到结果 */
  switched: 'ok' | 'failed';
}

export interface StopSwitchPlan extends InterruptPlan {
  /** `driver`：循环的一轮，交给主进程的循环 driver 接着做（重发 / 续写都在它的账本里记） */
  action: 'resend' | 'continue' | 'none' | 'driver';
}

export function decideStopSwitchFollowUp(input: StopSwitchInput): StopSwitchPlan {
  const { produced, origin, switched } = input;
  /* 循环的一轮归 driver 的账本：渲染层自己重发 / 续写会换 id、绕过账本 —— 交给 driver 做（切换没成它照旧停下并说明），也不放回输入框 */
  if (origin === 'loop') return { action: 'driver', prefill: false, markInterrupted: false, offerRerun: false };
  if (switched !== 'ok') return { action: 'none', ...interruptPlanFor(origin) };
  return { action: produced ? 'continue' : 'resend', prefill: false, markInterrupted: false, offerRerun: false };
}

/**
 * 中断条「重跑」用的新 id：保留来源标记（会话 / 控制入口 / 定时第几次 / 后台任务 id / nudge），只换末尾的时间戳。
 * 重跑要换 id：这一轮已经开始做过的 id，主进程的去重不会再发第二遍（`promptDedupe.ts`）。
 * 没有来源标记的（你自己的、循环的、自动续写的）返回 undefined —— 调用方用普通 id。
 */
export function rerunIdFor(id: string, now = Date.now(), rand = Math.random().toString(36).slice(2, 8)): string | undefined {
  const xs = /^(user|steer|queue)_(xs|ctl)_/.exec(id);
  if (xs) return `user_${xs[2]}_${now}_${rand}`;
  if (/^(sched_|wake_|nudge_)/.test(id)) {
    const swapped = id.replace(/_\d{10,}$/, `_${now}`);
    return swapped === id ? `${id}_${now}` : swapped;
  }
  return undefined;
}
