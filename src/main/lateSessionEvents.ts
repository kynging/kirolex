/**
 * 删掉以后才到的适配器回调一律丢掉 —— 纯逻辑，不 import electron。
 *
 * 实测（advanced 删 flow 执行会话）：05:30:16 三条会话进了回收站，05:30:20 适配器那边的 session/new 才返回、
 * available_commands_update 跟着到，new-session 那条路看「记录不在」就 `createSession` 建了一份新的
 * （「New Chat」、没有 purpose、attached），还占着执行器 ——「周报」这个 advanced 专属项目于是在标准版冒了出来。
 *
 * 判据「删了没有」由调用方现读（index.ts 的 `deletedSessionIds` / 墓碑）；`discard` 是调用方自己的收尾
 * （断开那个刚起来的执行器 / detach）。同一条会话同一种事件只记一行日志：迟到的流式更新可能一连串。
 */
export interface LateEventGate {
  /** 会话已删 → 调 `discard`、记日志、返回 true（调用方别再往下走）；没删返回 false */
  drop(sessionId: string, what: string, discard?: () => void): boolean;
}

/**
 * **登记执行器之前过门**：换模型 / 换 agent / 换机器 / 回滚 / attach 都是「await connect + session/load → 登记」，
 * 等的那几秒里会话可能被删了 —— 删了就 `discard`（断开刚起来的执行器）、不 `register`，返回 false。
 */
export function adoptUnlessDeleted(
  gate: LateEventGate, sessionId: string, what: string,
  io: { register: () => void; discard: () => void },
): boolean {
  if (gate.drop(sessionId, what, io.discard)) return false;
  io.register();
  return true;
}

export function lateEventGate(deps: { isDeleted: (sessionId: string) => boolean; log: (line: string) => void }): LateEventGate {
  const logged = new Set<string>();
  return {
    drop(sessionId, what, discard) {
      if (!deps.isDeleted(sessionId)) return false;
      const key = `${sessionId}\n${what}`;
      if (!logged.has(key)) {
        logged.add(key);
        deps.log(`late event for deleted session ${sessionId} (${what}) ignored`);
      }
      try { discard?.(); } catch { /* 收尾失败不影响「丢掉」 */ }
      return true;
    },
  };
}
