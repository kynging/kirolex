/**
 * **新建会话的启动阶段** —— 渲染层这一半（主进程那一半在 `main/creationGate.ts`）。
 *
 * 用户反馈（2026-10-23）：新建远程会话从点「新建」到能发消息要 30 多秒，界面上什么都没有，
 * 先打的那条消息看着像已经发出去却没反应。这里决定：
 *   - 会话顶部那条阶段条画哪几步、走到哪一步（`startupSteps`）；
 *   - 这时候发的消息该不该进排队、排队的什么时候能发（`startupBlocksSend`）；
 *   - 主进程推来的阶段怎么并进每会话的表（`applyCreateStage`）。
 *
 * 纯函数，不依赖 React，测试直接 import。
 */
/** 和 main/creationGate.ts 的 `CreationInfo` 同形（那边 import 了 engines.ts，渲染端不引它） */
export type CreateStage = 'connect' | 'check' | 'start' | 'ready' | 'failed';
export interface CreateStageInfo {
  sessionId: string;
  stage: CreateStage;
  engine: 'kiro' | 'claude' | 'codex';
  remote: boolean;
  startedAt: number;
  error?: string;
  failedAt?: Exclude<CreateStage, 'ready' | 'failed'>;
}
export type StartupStepKey = 'connect' | 'check' | 'start' | 'ready';
export interface StartupStep { key: StartupStepKey; state: 'done' | 'active' | 'todo' | 'failed' }

const ORDER: StartupStepKey[] = ['connect', 'check', 'start', 'ready'];

/** 本地会话没有「连接远端」那一步；其余三个引擎、本地 / 远程都一样 */
export function startupSteps(info: CreateStageInfo): StartupStep[] {
  const keys = info.remote ? ORDER : ORDER.filter((k) => k !== 'connect');
  const at: StartupStepKey = info.stage === 'failed' ? (info.failedAt || keys[0]) : info.stage;
  const idx = keys.indexOf(at);
  return keys.map((key, i) => {
    if (info.stage === 'ready') return { key, state: 'done' as const };
    if (i < idx) return { key, state: 'done' as const };
    if (i === idx) return { key, state: info.stage === 'failed' ? 'failed' as const : 'active' as const };
    return { key, state: 'todo' as const };
  });
}

/** 还没就绪（在建 / 失败了还没重试）：这时发的消息进排队，排队的也不往外发 */
export function startupBlocksSend(info: CreateStageInfo | undefined | null): boolean {
  return !!info && info.stage !== 'ready';
}

export function startupElapsedSeconds(info: CreateStageInfo, now: number): number {
  return Math.max(0, Math.floor((now - info.startedAt) / 1000));
}

/**
 * 主进程推来一次阶段 → 新的表。`ready` 也留着（阶段条显示「就绪」一小会儿，由调用方到点 `clearCreateStage`）。
 * 同一条会话**更早开始**的那次推送晚到了（重试之前那次的失败）不覆盖新的。
 */
export function applyCreateStage(
  map: Record<string, CreateStageInfo>,
  info: CreateStageInfo,
): Record<string, CreateStageInfo> {
  if (!info?.sessionId) return map;
  const cur = map[info.sessionId];
  if (cur && cur.startedAt > info.startedAt) return map;
  return { ...map, [info.sessionId]: info };
}

export function clearCreateStage(map: Record<string, CreateStageInfo>, sessionId: string, onlyIfReady = false): Record<string, CreateStageInfo> {
  const cur = map[sessionId];
  if (!cur || (onlyIfReady && cur.stage !== 'ready')) return map;
  const next = { ...map };
  delete next[sessionId];
  return next;
}

/** 新建一条会话时交给主进程的那几样（`acp:new-session`）；主进程也留一份（`acp:get-create-args`），窗口刷新后重试靠它 */
export interface CreateArgs { cwd: string; model: string; projectId?: string; kiroAgent?: string; remoteId?: string; engine?: 'kiro' | 'claude' | 'codex' }

/**
 * 「重试 / 改成本机运行」照哪份参数再建：渲染层自己记的优先，没有（窗口刷新过）用主进程留的那份；都没有 = null（建不了）。
 * 改成本机就是去掉机器，其余照旧。
 */
export function retryCreateArgs(mine: CreateArgs | undefined | null, fromMain: CreateArgs | undefined | null, local: boolean): CreateArgs | null {
  const base = mine || fromMain;
  if (!base) return null;
  return local ? { ...base, remoteId: undefined } : { ...base };
}

/**
 * 这条会话**连上了**（不管经哪条路：切回来时的 attach、断线恢复、安装适配器后重连）→ 启动阶段条该收掉。
 * 原来只认新建那条路推来的 ready：新建失败后切走再切回、经普通 attach 连上了，失败横幅还挂着，排队也一直被它挡着。
 * 正在由本窗口新建的那条（`creating`）不动：它的 ready 由新建那条路推来，「就绪」要亮一下再收。
 */
export function settleStageOnAttach(map: Record<string, CreateStageInfo>, sessionId: string, creating: boolean): Record<string, CreateStageInfo> {
  if (creating || !map[sessionId]) return map;
  return clearCreateStage(map, sessionId);
}
