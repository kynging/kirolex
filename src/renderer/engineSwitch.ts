/**
 * **换引擎的结果也算数** —— 「点『切到 Kiro』不生效」：会话其实已经是 kiro，主进程回 `unchanged`，
 * 而界面只等 `session:engine-changed`（以前 unchanged 时不发），列表里那个旧的 claude 就一直挂着。
 *
 * 侧栏右键菜单、失败卡片上的「换引擎」调完 `acp:switch-engine` 把返回交给这里：有生效的引擎（成功 / unchanged，
 * 不是 pending）就通知订阅者（`useAcp` 用它改列表），和 `session:engine-changed` 走同一个口径。
 */
import { engineFromSwitchResult, type SyncEngine } from '../main/profileSync.ts';

type Listener = (sessionId: string, engine: SyncEngine) => void;
const listeners = new Set<Listener>();

export function onEngineSwitchResult(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** 把一次换引擎的返回交给订阅者（返回里没有生效的引擎就什么都不做）。返回生效的那个引擎。 */
export function noteEngineSwitchResult(sessionId: string, result: unknown): SyncEngine | undefined {
  const engine = engineFromSwitchResult(result);
  if (!sessionId || !engine) return undefined;
  for (const cb of listeners) { try { cb(sessionId, engine); } catch { /* 一个订阅者出错不影响别的 */ } }
  return engine;
}
