/**
 * **恢复卡上的「回滚到某条消息」的执行步骤**（main `acp:rollback-to-message` 调它）。不 import electron，依赖都从外面传进来，能直接单测。
 *
 * 目标：回滚之后，新的后端会话只带上**到那一条为止**的内容 —— 之后的对话一个字都不能再进模型。所以：
 *   1. 先把会注入上下文的文件原样备份进回收站（`BACKUP_FILES`；备份不成就什么都不动）；
 *   2. 截短 transcript（编辑重跑同一个 `rewriteTranscript`）；
 *   3. 手改保存的上下文快照（`context-override.md`）作废（`clearContextOverride`）—— 否则 ride-along（`buildHistoryRideAlong`）
 *      优先用它，绕过截短后的记录把回滚点之后的内容又带给新后端。它在第 1 步已经备份过，可以找回；
 *   4. 换新的后端会话（new-backend 同一个 `swapBackendSessionWhenIdle`）。
 *      **这一步失败就整个撤回**：把第 1 步备份的 transcript / history / 快照原样放回去，报失败 —— 旧后端还记得全部对话，
 *      而界面若显示「回滚完成」，下一条就会带着本该去掉的对话执行。
 */
import fs from 'fs';
import path from 'path';

/** 回滚会动、而且会进模型上下文的文件（record.json 只备份不放回：换后端失败时它可能已经记了别的后端 id）。 */
export const BACKUP_FILES = ['record.json', 'transcript.jsonl', 'history.md', 'context-override.md'] as const;
const RESTORE_FILES = ['transcript.jsonl', 'history.md', 'context-override.md'] as const;

export interface RollbackDeps<M extends { id: string }> {
  /** `~/.kirolex/sessions/<id>/` */
  sessionDir: string;
  /** 回收站里这次的备份目录（`sessionRecovery.rollbackBackupDir`） */
  backupDir: string;
  readTranscript: () => M[];
  rewriteTranscript: (kept: M[]) => void;
  clearContextOverride: () => void;
  swapBackend: () => Promise<unknown>;
}

export type RollbackOutcome =
  | { ok: true; removed: number; backupDir: string; overrideCleared: boolean }
  | { ok: false; stage: 'not-found' | 'backup' | 'truncate' | 'swap'; error: string; restored?: boolean; backupDir?: string };

function copyAtomic(from: string, to: string): void {
  const tmp = `${to}.rollback-tmp`;
  fs.copyFileSync(from, tmp);
  fs.renameSync(tmp, to);
}

/** 把备份里有的放回去；备份里没有（当时就不存在）的就删掉现在的（比如回滚中途没生成过的，留着也无害，但要回到原样）。 */
function restoreFromBackup(sessionDir: string, backupDir: string): boolean {
  let ok = true;
  for (const f of RESTORE_FILES) {
    const saved = path.join(backupDir, f);
    const live = path.join(sessionDir, f);
    try {
      if (fs.existsSync(saved)) copyAtomic(saved, live);
      else if (fs.existsSync(live)) fs.rmSync(live, { force: true });
    } catch { ok = false; }
  }
  return ok;
}

export async function performRollback<M extends { id: string }>(messageId: string, deps: RollbackDeps<M>): Promise<RollbackOutcome> {
  const existing = deps.readTranscript();
  const at = existing.findIndex((m) => m.id === messageId);
  if (at < 0) return { ok: false, stage: 'not-found', error: messageId };
  const kept = existing.slice(0, at + 1);
  const removed = existing.length - kept.length;
  try {
    fs.mkdirSync(deps.backupDir, { recursive: true });
    for (const f of BACKUP_FILES) {
      const p = path.join(deps.sessionDir, f);
      if (fs.existsSync(p)) fs.copyFileSync(p, path.join(deps.backupDir, f));
    }
    if (fs.existsSync(path.join(deps.sessionDir, 'transcript.jsonl')) && !fs.existsSync(path.join(deps.backupDir, 'transcript.jsonl'))) {
      throw new Error('transcript backup missing');
    }
  } catch (err: any) {
    return { ok: false, stage: 'backup', error: String(err?.message || err) };
  }
  const overrideExisted = fs.existsSync(path.join(deps.sessionDir, 'context-override.md'));
  try {
    deps.rewriteTranscript(kept);
    deps.clearContextOverride();
    /*
      **确认快照真的没了**：`store.clearContextOverride` 删不掉（权限、Windows 上文件被占用）时不抛、只回 false ——
      它还在的话 ride-along 会优先用它，把回滚点之后的内容带回新后端。那就别换后端，整个撤回。
    */
    if (fs.existsSync(path.join(deps.sessionDir, 'context-override.md'))) {
      throw new Error('context-override.md could not be removed');
    }
  } catch (err: any) {
    return { ok: false, stage: 'truncate', error: String(err?.message || err), restored: restoreFromBackup(deps.sessionDir, deps.backupDir), backupDir: deps.backupDir };
  }
  try {
    await deps.swapBackend();
  } catch (err: any) {
    return { ok: false, stage: 'swap', error: String(err?.message || err), restored: restoreFromBackup(deps.sessionDir, deps.backupDir), backupDir: deps.backupDir };
  }
  return { ok: true, removed, backupDir: deps.backupDir, overrideCleared: overrideExisted };
}
