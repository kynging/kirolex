/**
 * **还没连上过的新会话，冷记录该按哪个引擎、哪台机器建** —— 见 index.ts 的 `coldRecordFor`。
 *
 * 实测（s_1792637464721_r0sfi7）：一条「远程 Codex」的新会话在远端没装适配器、`acp:new-session`
 * 失败之后，右键换工作目录 → `coldRecordFor` 建了一份只带 projectId 的最小记录 → 引擎和机器都丢了，
 * 这条会话悄悄变成了本机 kiro，界面上一个字都没有。
 *
 * 来源按可信度排：
 *   1. 主进程自己记下的「新建时选了什么」（`acp:new-session` 一进来就记，建成才清）；
 *   2. 渲染层随 hint 带来的 engine / remoteId（它新建时就知道，侧栏行上也有）；
 *   3. 都没有 —— 只能按本机 kiro 建，但**要明说**（`lost: true`），不许静默回退。
 *
 * 纯函数，不 import electron；远端目标怎么按 id 查由调用方传进来。
 */
import type { RemoteTarget } from './config';
import { engineOf, type Engine } from './engines.ts';

/** `acp:new-session` 一进来记下的：这条新会话打算用哪个引擎、跑在哪台机器上。 */
export interface NewSessionIntent {
  engine: Engine;
  /** 已解析好的远端目标；本地 = undefined */
  remote?: RemoteTarget;
  /** 渲染层传的 remoteId（配置里查不到时 remote 是 undefined，但人确实选了远程） */
  remoteId?: string;
  projectId?: string | null;
}

/** 渲染层随切换请求带来的提示。字段缺省 = 渲染层也不知道。 */
export interface ColdRecordHint {
  projectId?: string | null;
  engine?: string;
  /** `null` = 渲染层明确知道它是本地的 */
  remoteId?: string | null;
}

export interface ColdProfileBits {
  engine: Engine;
  remote?: RemoteTarget;
  projectId?: string | null;
  /** 从哪儿补出来的（写进日志） */
  source: 'intent' | 'hint' | 'none';
  /** 引擎或机器补不出来、按本机 kiro 建的 —— 调用方要在会话里说一句 */
  lost: boolean;
  /** 人选了远程、但这台机器在配置里已经找不到了 */
  remoteMissing?: string;
}

export function coldProfileBits(
  intent: NewSessionIntent | undefined,
  hint: ColdRecordHint | undefined,
  resolveRemote: (id: string) => RemoteTarget | undefined,
): ColdProfileBits {
  const projectId = intent?.projectId ?? hint?.projectId ?? null;
  if (intent) {
    const remote = intent.remote || (intent.remoteId ? resolveRemote(intent.remoteId) : undefined);
    const remoteMissing = intent.remoteId && !remote ? intent.remoteId : undefined;
    return { engine: intent.engine, remote, projectId, source: 'intent', lost: !!remoteMissing, ...(remoteMissing ? { remoteMissing } : {}) };
  }
  const engineKnown = typeof hint?.engine === 'string' && hint.engine !== '';
  const remoteKnown = hint ? hint.remoteId !== undefined : false;
  if (engineKnown || remoteKnown) {
    const engine = engineOf({ engine: engineKnown ? hint!.engine : undefined });
    const rid = hint?.remoteId || undefined;
    const remote = rid ? resolveRemote(rid) : undefined;
    const remoteMissing = rid && !remote ? rid : undefined;
    return {
      engine, remote, projectId, source: 'hint',
      /* 只知道一半也要说：缺的那一半是按默认（kiro / 本机）补的 */
      lost: !engineKnown || !remoteKnown || !!remoteMissing,
      ...(remoteMissing ? { remoteMissing } : {}),
    };
  }
  return { engine: 'kiro', projectId, source: 'none', lost: true };
}

/**
 * `acp:load-session`（attach）失败时那一行日志 —— 原来一行都没有：日志停在「本地会话挂上 kirolex-local」，
 * 看起来像卡住了（本机 Claude Code 适配器没装，报 adapterMissingMessage 的那次）。
 */
export function attachFailureLine(
  sessionId: string,
  profile: { engine?: string; remote?: { sshHost?: string } | null } | undefined,
  err: unknown,
): string {
  const engine = engineOf(profile || {});
  const remote = profile?.remote?.sshHost || 'local';
  const reason = String((err as any)?.message || err || '(无原因)').replace(/\s+/g, ' ').trim();
  return `attach 失败 sessionId=${sessionId} engine=${engine} remote=${remote}: ${reason}`;
}

/**
 * **给渲染层的会话行带上机器的 id**（审计 10b）—— 行上原来只有显示名（`remoteHost`），分叉一条远程会话时
 * 渲染层不知道该在哪台机器上建，只好退回「新会话默认机器」。
 *
 * 记录里存了 id：只认这个 id（设置里还在就用它；同 host:port 去重掉的那几条由 `resolveId` 认到留下来的那条 ——
 * 那台机器其实没删）；认不出就是**删了**，带出原来的 id 并标 `remoteMissing`，**不**按地址换成另一条同地址的目标
 * （那是另一份配置：别的私钥 / 跳板 / 启动命令）。只有没存 id 的老记录才按 host + 端口认回设置里那台；
 * 也认不出就带出 host 并标 `remoteMissing`。渲染层据此明说，而不是换一台机器。本地会话什么都不带。
 */
export function durableRemoteId(
  remote: { id?: string; sshHost?: string; sshPort?: number } | null | undefined,
  targets: ReadonlyArray<{ id: string; sshHost: string; sshPort?: number }>,
  resolveId?: (id: string) => { id: string } | undefined,
): { remoteId?: string; remoteMissing?: true } {
  const host = String(remote?.sshHost || '').trim();
  if (!host) return {};
  const id = typeof remote?.id === 'string' && remote.id ? remote.id : '';
  if (id) {
    if (targets.some((t) => t.id === id)) return { remoteId: id };
    const kept = resolveId?.(id);
    return kept ? { remoteId: kept.id } : { remoteId: id, remoteMissing: true };
  }
  const port = Number(remote?.sshPort) > 0 ? Number(remote?.sshPort) : 22;
  const byHost = targets.find((t) => t.sshHost === host && (Number(t.sshPort) > 0 ? Number(t.sshPort) : 22) === port);
  if (byHost) return { remoteId: byHost.id };
  return { remoteId: host, remoteMissing: true };
}
