/**
 * **正在新建的会话** —— `acp:new-session` 从进来到执行器能接消息之间的那段（远程实测 34 秒）。
 *
 * 用户反馈（2026-10-23，s_1792726606826_e2mprs）：新建远程会话后，界面上没有「正在启动」，
 * 先打的那条消息看着像已经发出去却没反应；同一时间还有一路按**本机 kiro** 去 attach 这条
 * 还没写完的新会话（`attach 失败 engine=kiro remote=local：该会话在磁盘上不存在`）——
 * 渲染层切会话 / 预热时并不知道主进程这边还在建。
 *
 * 这里记下每条正在建的会话走到哪一步，给三处用：
 *   - 界面：阶段（连接远端 → 检查环境 → 启动引擎 → 就绪 / 失败）+ 开始时间，推给渲染层；
 *   - 忙闲：正在建 = 占用（`creating`），新消息进排队而不是直接发；
 *   - attach：正在建的会话不按默认值 attach，**等它建完**（`settle`），建成了它本来就是连着的。
 *
 * 纯模块，不 import electron；推送由调用方在 `onChange` 里做。
 */
import type { Engine } from './engines.ts';

/** connect = 连远端（含预检），check = 准备环境（本机工具 / 隧道 / 组合），start = 起引擎 + session/new */
export type CreateStage = 'connect' | 'check' | 'start' | 'ready' | 'failed';

export interface CreationInfo {
  sessionId: string;
  stage: CreateStage;
  engine: Engine;
  /** 跑在远端（本地会话没有「连接远端」那一步） */
  remote: boolean;
  startedAt: number;
  /** stage === 'failed' 时的原因 */
  error?: string;
  /** stage === 'failed' 时是卡在哪一步失败的 */
  failedAt?: Exclude<CreateStage, 'ready' | 'failed'>;
}

export interface CreationGate {
  /** 跑一次新建：开始就登记，结束（成 / 败）就摘掉；结果原样返回 / 原样抛 */
  run<T>(sessionId: string, meta: { engine: Engine; remote: boolean }, fn: () => Promise<T>): Promise<T>;
  /** 走到下一步（不在建的会话忽略） */
  stage(sessionId: string, stage: Exclude<CreateStage, 'ready' | 'failed'>): void;
  creating(sessionId: string): boolean;
  /** 等这条会话的新建结束；没在建返回 null（调用方照常走） */
  settle(sessionId: string): Promise<{ ok: boolean; error?: string } | null>;
  /** 正在建的那些 + 没建成、还没恢复的那些（窗口刷新后渲染层拿一次快照：失败原因和「重试 / 改成本机运行」不能随刷新丢了） */
  snapshot(): CreationInfo[];
  /** 这条会话连上了（经任何一条路）/ 被删了：失败记录作废 */
  clearFailed(sessionId: string): void;
  ids(): string[];
}

export function createCreationGate(opts: { onChange?: (info: CreationInfo) => void; now?: () => number } = {}): CreationGate {
  const now = opts.now || (() => Date.now());
  const live = new Map<string, { info: CreationInfo; done: Promise<{ ok: boolean; error?: string }> }>();
  /** 没建成的：留到重试开始、连上、或删掉为止 */
  const failed = new Map<string, CreationInfo>();
  const emit = (info: CreationInfo) => { try { opts.onChange?.({ ...info }); } catch { /* 推送失败不影响新建 */ } };
  return {
    async run(sessionId, meta, fn) {
      const info: CreationInfo = { sessionId, stage: meta.remote ? 'connect' : 'check', engine: meta.engine, remote: meta.remote, startedAt: now() };
      let resolveDone!: (r: { ok: boolean; error?: string }) => void;
      const done = new Promise<{ ok: boolean; error?: string }>((r) => { resolveDone = r; });
      failed.delete(sessionId);
      live.set(sessionId, { info, done });
      emit(info);
      try {
        const result = await fn();
        live.delete(sessionId);
        emit({ ...info, stage: 'ready' });
        resolveDone({ ok: true });
        return result;
      } catch (err: any) {
        live.delete(sessionId);
        const error = String(err?.message || err || '');
        const out: CreationInfo = { ...info, stage: 'failed', error, failedAt: info.stage as Exclude<CreateStage, 'ready' | 'failed'> };
        failed.set(sessionId, out);
        emit(out);
        resolveDone({ ok: false, error });
        throw err;
      }
    },
    stage(sessionId, stage) {
      const cur = live.get(sessionId);
      if (!cur || cur.info.stage === stage) return;
      cur.info.stage = stage;
      emit(cur.info);
    },
    creating: (sessionId) => live.has(sessionId),
    settle: async (sessionId) => {
      const cur = live.get(sessionId);
      return cur ? cur.done : null;
    },
    snapshot: () => [...[...live.values()].map((v) => v.info), ...failed.values()].map((i) => ({ ...i })),
    clearFailed: (sessionId) => { failed.delete(sessionId); },
    ids: () => [...live.keys()],
  };
}
