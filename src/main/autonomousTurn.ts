/**
 * **后端自己起的一轮**（Claude Code 的 autonomous cycle：CronCreate 到点、后台 Bash / 子代理完成后的跟进…）。
 * 判据（什么时候算它、什么时候算回放）在 `replayGuard.outsideTurnVerdict`；这里只管这一轮的开始和结束。PURE（`tests/autonomousTurn.test.ts`）。
 *
 * 它没有 KiroLex 发的 session/prompt，也就没有响应可等。主进程（index.ts `beginAutonomous` / `autonomousDeps`）把它当成**正常的一轮**：
 * 开始时在会话里落一条来源标记（KiroLex 提示「⏰ 后台触发」，不是伪造的用户消息）、`acp:main-turn` 让界面接管这一轮的流、
 * busy 报 `turn`；输出照常进 `assistantBuf` / 渲染层；结束时 `flushAssistant` 落盘一条带 `origin: 'autonomous'` 的助手消息。
 *
 * 结束信号（谁先到算谁）：
 *   · `usage_update` 带 `cost` —— claude-agent-acp 在每个 result（一轮的结尾，含自发轮）上发，实测 PONG 那次就是第三帧；
 *   · Codex 的 `threadStatus: idle`（`busyEnterCaps.detachedTurnEnded`）；
 *   · 一段时间没有新帧（`AUTONOMOUS_QUIET_MS`）—— 还有工具开着就接着等，最多 `AUTONOMOUS_MAX_MS`；
 *   · 调用方主动收：用户这一轮开始之前、点停止、执行器没了。
 */
import { detachedTurnEnded } from './busyEnterCaps.ts';

export const AUTONOMOUS_QUIET_MS = 90_000;
export const AUTONOMOUS_MAX_MS = 30 * 60_000;

export interface AutonomousTurn {
  startedAt: number;
  lastFrameAt: number;
  /** 来源标记那条 KiroLex 提示的消息 id */
  noteId: string;
  timer?: unknown;
}

export interface AutonomousHost {
  autonomous?: AutonomousTurn;
}

export interface AutonomousDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** 这条会话还有没结束的工具调用（`entry.openToolCalls`） */
  hasOpenTools(): boolean;
  /** 开始：落盘来源标记、告诉界面接管这一轮的流、busy 报 turn */
  announce(turn: AutonomousTurn): void;
  /** 结束：落盘回复（带来源标记）、告诉界面这一轮结束 */
  finish(turn: AutonomousTurn, why: string): void;
}

export function autonomousTurnEnded(update: any): boolean {
  if (update?.sessionUpdate === 'usage_update' && update.cost && typeof update.cost === 'object') return true;
  return detachedTurnEnded(update);
}

function arm(host: AutonomousHost, turn: AutonomousTurn, deps: AutonomousDeps): void {
  if (turn.timer !== undefined) deps.clearTimer(turn.timer);
  turn.timer = deps.setTimer(() => {
    turn.timer = undefined;
    if (host.autonomous !== turn) return;
    if (deps.hasOpenTools() && deps.now() - turn.startedAt < AUTONOMOUS_MAX_MS) { arm(host, turn, deps); return; }
    endAutonomousTurn(host, deps, 'quiet');
  }, AUTONOMOUS_QUIET_MS);
}

/** 起一轮（已经在一轮里就原样返回那一轮） */
export function beginAutonomousTurn(host: AutonomousHost, deps: AutonomousDeps): AutonomousTurn {
  if (host.autonomous) return host.autonomous;
  const now = deps.now();
  const turn: AutonomousTurn = { startedAt: now, lastFrameAt: now, noteId: `u_${now}_${Math.random().toString(36).slice(2, 8)}_auto` };
  host.autonomous = turn;
  deps.announce(turn);
  arm(host, turn, deps);
  return turn;
}

/** 这一轮里的每一帧（转发之前）：见到结束信号就收，否则重新计时 */
export function autonomousFrame(host: AutonomousHost, update: any, deps: AutonomousDeps): void {
  const turn = host.autonomous;
  if (!turn) return;
  if (autonomousTurnEnded(update)) { endAutonomousTurn(host, deps, 'ended'); return; }
  turn.lastFrameAt = deps.now();
  arm(host, turn, deps);
}

/** 收这一轮（只收一次）；返回这次有没有真的收 */
export function endAutonomousTurn(host: AutonomousHost, deps: AutonomousDeps, why: string): boolean {
  const turn = host.autonomous;
  if (!turn) return false;
  host.autonomous = undefined;
  if (turn.timer !== undefined) { deps.clearTimer(turn.timer); turn.timer = undefined; }
  deps.finish(turn, why);
  return true;
}
