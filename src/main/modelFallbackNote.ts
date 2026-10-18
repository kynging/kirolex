/**
 * **自动改用备用模型要留在对话记录里，而且要说对实际用的是哪个** —— 写法见 `docs/notices-glossary.md`。
 *
 * 纯逻辑（不 import electron），`index.ts` 注入"怎么写进对话记录 / 记录在不在 / 怎么说远端那句"。只管"说"，不碰选哪个模型。
 *
 *   · **按实际起来的模型说**：远端 `pickRemoteModel` 挑了备用模型时先记下（`remotePicked`），
 *     连上之后（`remoteStarted`）按真正起来的那个写 —— 挑的那个可能起不来、换成了下一个；全都起不来（`remoteFailed`）就不写。
 *   · **整件事成了才写**：连上执行器之后还有后面几步（建后端会话、换掉旧执行器、写记录），任何一步失败都等于
 *     没换成 —— 所以连上时只是**先记下**（`note` / `remoteStarted`），调用方在整件事成功之后 `commit`，失败就 `discard`。
 *   · **同一对只记一次**：每次连接（打开、重连、换机器）都会走到，同一条会话同一对「想要 → 实际」记过就不再写；
 *     结果变了（换到另一个模型）、或者中间用回了你选的那个（`wantedInUse`），再记。只在真的写进记录之后才登记。
 *   · **新建会话**：连接在记录落盘之前 —— 新建那条路在 `createSession` + `writeRecord` 之后才 `commit`。
 *   · 别的原因写不进（会话是 advanced 的等）→ 只在状态行说。
 */

export interface ModelFallbackDeps {
  /** 写进对话记录（`noteInSession`）；写进去了返回 true */
  note(sessionId: string, text: string, group: string): boolean;
  /** 这条会话的记录已经在盘上了吗（新建中的还没有） */
  recordExists(sessionId: string): boolean;
  /** 只在状态行说一句（写不进记录、又不是新建中的时候） */
  status(sessionId: string, text: string, group: string): void;
  /** 远端那句话（「{host} 上没有模型 X，这条会话改用 Y」+ 详情里的可用清单） */
  remoteText(host: string, wanted: string, used: string, models: string[]): string;
}

export function fallbackGroup(wanted: string, used: string): string {
  return `model-fallback:${wanted}→${used}`;
}

export class ModelFallbackNotes {
  private readonly deps: ModelFallbackDeps;
  /** 每条会话最近一次**真的写进记录**的那一对 */
  private readonly noted = new Map<string, string>();
  /** 连上了、但整件事还没成的那一句（等调用方 commit / discard） */
  private readonly staged = new Map<string, { group: string; text: string }>();
  /** 远端挑了备用模型、还没连上的那几条 */
  private readonly picked = new Map<string, { wanted: string; host: string; models: string[] }>();

  constructor(deps: ModelFallbackDeps) {
    this.deps = deps;
  }

  /** 实际跑的是 `used`、不是你选的 `wanted`：先记下这一句，整件事成了（`commit`）才写 */
  note(sessionId: string, wanted: string, used: string, text: string): void {
    this.staged.set(sessionId, { group: fallbackGroup(wanted, used), text });
  }

  /** 整件事成了（执行器换上、记录写好）：把记下的那句写进对话记录（同一对记过就不再写） */
  commit(sessionId: string): void {
    const s = this.staged.get(sessionId);
    this.staged.delete(sessionId);
    if (!s || this.noted.get(sessionId) === s.group) return;
    if (this.deps.note(sessionId, s.text, s.group)) { this.noted.set(sessionId, s.group); return; }
    /* 记录在、却写不进（advanced 会话等）→ 只在状态行说；记录都没有就不说（会话没建成） */
    if (this.deps.recordExists(sessionId)) this.deps.status(sessionId, s.text, s.group);
  }

  /** 没换成（后面哪一步失败了）：记下的那句作废，不写、也不登记 */
  discard(sessionId: string): void {
    this.staged.delete(sessionId);
    this.picked.delete(sessionId);
  }

  /** 又用上了你选的那个模型：之后再换要重新说 */
  wantedInUse(sessionId: string): void {
    this.noted.delete(sessionId);
  }

  /** `pickRemoteModel` 每次挑之前：上一次没连上留下的那条不能带到这一次 */
  remoteReset(sessionId: string): void {
    this.picked.delete(sessionId);
  }

  /** 远端清单里没有 `wanted`，挑了备用的 —— 等连上再说 */
  remotePicked(sessionId: string, wanted: string, host: string, models: string[]): void {
    this.picked.set(sessionId, { wanted, host, models });
  }

  hasRemotePick(sessionId: string): boolean {
    return this.picked.has(sessionId);
  }

  /** 远程执行器连上了，实际跑的是 `started` */
  remoteStarted(sessionId: string, started: string): void {
    const p = this.picked.get(sessionId);
    this.picked.delete(sessionId);
    if (!p) return;
    if (started === p.wanted) { this.wantedInUse(sessionId); return; }
    this.note(sessionId, p.wanted, started, this.deps.remoteText(p.host, p.wanted, started, p.models));
  }

  /** 一个都没起来：挑过的备用模型不算数，什么都不写 */
  remoteFailed(sessionId: string): void {
    this.picked.delete(sessionId);
  }
}
