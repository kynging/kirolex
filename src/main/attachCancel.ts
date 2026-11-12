/**
 * **会话删除 / 归档之后，正在路上的 attach 一律作废** ——（第 3 轮实测：06:34:34 删掉的会话，06:34:57「本地工具已备好」、
 * 06:34:59 又去选模型起后端，06:35:07 才在最后一步报「连接过程中会话被删除了」）。
 *
 * attach 是一串要等的步骤（等换模型结束 → 远端预检 → 准备本地工具 → 按候选模型逐个起执行器 → resume），原来只在开头和
 * 最后各查一次「删了没有」：中间删掉的，照样把本地工具备好、把执行器起起来，最后才拆掉。这里给每一步之间一个检查点：
 * 删了（或者归档了）就立刻停，后面的步骤一个都不做。
 *
 * 纯逻辑，不 import electron：「删了没有 / 归档了没有」由调用方现读（index.ts 的 deletedSessionIds、记录里的 archived）。
 */

export class AttachCancelled extends Error {
  readonly sessionId: string;
  readonly stage: string;
  readonly why: 'deleted' | 'archived';
  constructor(sessionId: string, stage: string, why: 'deleted' | 'archived', message: string) {
    super(message);
    this.name = 'AttachCancelled';
    this.sessionId = sessionId;
    this.stage = stage;
    this.why = why;
  }
}

export interface AttachLiveness {
  deleted: (id: string) => boolean;
  /** 归档的会话不 attach（和本机原有归档会话一样只读看记录）；不给 = 不查 */
  archived?: (id: string) => boolean;
  /** 抛出时的提示（按语言），`why` = 删了 / 归档了 */
  message: (why: 'deleted' | 'archived') => string;
}

/** 一个检查点：删了 / 归档了就抛 `AttachCancelled`（`stage` 进日志，说清停在哪一步）。 */
export function attachCheckpoint(live: AttachLiveness, sessionId: string, stage: string): void {
  if (live.deleted(sessionId)) throw new AttachCancelled(sessionId, stage, 'deleted', live.message('deleted'));
  if (live.archived?.(sessionId)) throw new AttachCancelled(sessionId, stage, 'archived', live.message('archived'));
}

/**
 * **resume（最多两次）→ 不行就新起后端会话**，每一步要等的之间都过检查点（审查意见：resume 要等几十秒，这期间删了 / 归档了，
 * 原来照样重试、照样 `newSession`，最后还把执行器登记上去）。`checkpoint` 抛 `AttachCancelled` 时**原样往外抛**，
 * 不当成「resume 失败」去新起；调用方负责断开执行器、释放本地工具。
 *
 * 返回 `{ fresh: false }` = resume 成功（cliSessionId 不变）；`{ fresh: true, cliSessionId }` = 新起了一个。
 */
export async function resumeOrFresh(io: {
  tryResume: () => Promise<unknown>;
  newSession: () => Promise<string>;
  checkpoint: (stage: string) => void;
  /** 这个失败是确定的答案（例如 `Resource not found`），不必重试 */
  definitiveMiss: (err: any) => boolean;
  onFirstFail?: (err: any) => void;
  onRetryOk?: () => void;
  onGiveUp?: (err: any) => void;
}): Promise<{ fresh: false } | { fresh: true; cliSessionId: string }> {
  try {
    try {
      await io.tryResume();
    } catch (first: any) {
      if (first instanceof AttachCancelled) throw first;
      if (io.definitiveMiss(first)) throw first;
      io.onFirstFail?.(first);
      io.checkpoint('before resume retry');
      await io.tryResume();
      io.onRetryOk?.();
    }
  } catch (err: any) {
    if (err instanceof AttachCancelled) throw err;
    io.onGiveUp?.(err);
    io.checkpoint('before fresh backend session');
    const id = await io.newSession();
    io.checkpoint('fresh backend session started');
    return { fresh: true, cliSessionId: id };
  }
  io.checkpoint('resumed');
  return { fresh: false };
}
