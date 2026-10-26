/**
 * **各台机器最近一次的 Codex Bedrock 权限预检**（机器 id → 结果，主进程 `bedrock:checks` / `bedrock:check`）——
 * 会话里的缺权限卡用它判断「之后预检通过了没有」，通过了就撤掉（`main/bedrockIam.ts` 的 bedrockNoteActive）。
 * 第一次有人订阅时取一份、开始听推送；只在内存里（主进程那份本来也只在内存里）。
 */
import type { NoteCheck } from '../main/bedrockIam.ts';

type Checks = Record<string, NoteCheck>;

let state: Checks = {};
let started = false;
const listeners = new Set<() => void>();
const emit = (): void => { for (const fn of listeners) fn(); };

function start(): void {
  if (started) return;
  started = true;
  const api = (window as any).kiroApi;
  api?.onBedrockCheck?.((d: { machine?: string; check?: NoteCheck }) => {
    if (!d?.machine || !d.check) return;
    state = { ...state, [d.machine]: d.check };
    emit();
  });
  void api?.bedrockChecks?.().then((all: Checks | undefined) => {
    if (!all || typeof all !== 'object') return;
    /* 推送先到的那份更新，不被这份初始快照盖掉 */
    state = { ...all, ...state };
    emit();
  }).catch(() => { /* 取不到就等推送 */ });
}

export const bedrockCheckStore = {
  subscribe(fn: () => void): () => void { start(); listeners.add(fn); return () => { listeners.delete(fn); }; },
  get(): Checks { return state; },
};
