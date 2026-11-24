/**
 * 目标型定时任务的 `checkCommand` 跑一次 —— index.ts 的 `runScheduledJob` 在记账发送之前调它。
 *
 * 存储、跑命令、广播、提示用户都经 `deps` 注入（index.ts 接到 scheduleStore / `BgJobManager.runCheck` /
 * `schedule:changed` / `noteInSession`），这里只管顺序：
 *   检查时间先落盘（崩溃 / 退出后不会马上重跑）→ 跑命令 → 以盘上为准（期间被删 / 暂停就到此为止）→
 *   按 `planScheduleCheck` 落盘并**每次都广播**（跳过的那次也要：界面靠它换成下一次检查的倒计时）→
 *   连续出错自动暂停时提示用户，**同时**照样交回一条错误汇报叫醒模型。
 * 返回 null = 这一次不叫醒模型；否则是要接着记账发送的状态和附在消息里的检查结果。
 */

import { planScheduleCheck, type ScheduleCheckResult, type ScheduleState } from './schedule.ts';
import type { UiLang } from './uiText.ts';

export interface ScheduleCheckDeps {
  now(): number;
  read(id: string): ScheduleState | null;
  write(id: string, state: ScheduleState): void;
  /** 在本机跑检查命令（`BgJobManager.runCheck`）。`stopped`：退出 KiroLex / 删会话时被结束了。 */
  runCheck(state: ScheduleState): Promise<ScheduleCheckResult | { status: 'stopped'; output: string }>;
  /** 广播 `schedule:changed`。 */
  changed(id: string, state: ScheduleState): void;
  /** 在会话里给用户留一句（不叫醒模型）。 */
  noteUser(sessionId: string, text: string): void;
  log(message: string): void;
  /** 本机现在还是不是它的执行者（跨电脑同步，`scheduleSync.ts`）。检查命令跑的这段时间里可能被别的电脑接管了：
   *  是 false 就丢掉这次结果 —— 不落盘、不广播、不提示，免得把别人的任务写成「已达成」/ 自动暂停。不给 = 总是本机。 */
  stillRunsHere?(id: string, state: ScheduleState): boolean;
  lang?: UiLang;
}

export async function runScheduleCheck(id: string, state: ScheduleState, deps: ScheduleCheckDeps):
  Promise<{ state: ScheduleState; text: string } | null> {
  const startedAt = deps.now();
  deps.write(id, { ...state, lastRunAt: startedAt });
  const result = await deps.runCheck(state);
  /* 退出 KiroLex / 删会话时被结束了：不算出错，下一次照常检查 */
  if (result.status === 'stopped') return null;
  /* 检查期间被删 / 暂停 / 结束了：以盘上为准，什么都不做 */
  const latest = deps.read(id);
  if (!latest || latest.paused || latest.terminal) return null;
  /* 检查期间执行权交给了别的电脑：这次的结果不算数（新执行者自己会检查） */
  if (deps.stillRunsHere && !deps.stillRunsHere(id, latest)) {
    deps.log(`handover: check id=${id} session=${state.sessionId} 跑完时本机已不是执行者，结果丢弃（不落盘、不叫醒）runner=${latest.runner ?? '?'}`);
    return null;
  }
  const plan = planScheduleCheck(latest, result, startedAt, deps.lang);
  deps.write(id, plan.state);
  deps.log(`check id=${id} session=${state.sessionId} status=${result.status}${result.status === 'exited' ? ` exit=${result.code}` : ''} → ${plan.action}`);
  deps.changed(id, plan.state);
  if (plan.action === 'skip') return null;
  if (plan.action === 'paused' && plan.note) deps.noteUser(state.sessionId, plan.note);
  return { state: plan.state, text: plan.text };
}
