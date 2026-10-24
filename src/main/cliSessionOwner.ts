/**
 * **记录里的后端会话 id 是谁的**（审计 1.1 / 1.2，`docs/engine-audit-claude-codex.md`）。
 *
 * `cliSessionId` 是某个引擎、在某台机器上发的。会话没连着时换引擎（kiro → Claude Code）或换运行位置（本机 ↔ 远端），
 * 记录只改 profile、id 原样留着；下次打开时 attach 拿这个别人家的 id 去 `session/load`：
 * 适配器回 `Resource not found` 白一次请求，kiro 对陌生 id 最坏要等两次 `RESUME_TIMEOUT_MS`（20–90 s）才退回新建。
 *
 * 所以 id 旁边记一笔 `cliSessionOwner = { id, engine, machine }`：
 *   · 只有 `owner.id === cliSessionId` 时这笔才算数 —— 没记过、或者别的路径换了 id 没跟着记，就当不知道，
 *     attach 照旧去 load（老行为，不会因为少记一笔而多扔一次历史）；
 *   · 算数且引擎 / 机器和这次要起的对不上 → 不 load，直接 `session/new`，上下文按快照随下一条消息带过去。
 *
 * 纯模块（不 import electron），测试 `tests/engineAuditFixes4.test.ts`。
 */
import { engineOf, type Engine } from './engines.ts';

export interface CliSessionOwner { id: string; engine: Engine; machine: string }

type ProfileLike = { engine?: string; remote?: { sshHost?: string; sshPort?: number } } | undefined;
type RecordLike = { cliSessionId?: string; cliSessionOwner?: CliSessionOwner; profile?: ProfileLike };

/**
 * 机器的键：本机是 `local`；远端是 `sshHost:端口`（端口缺省 22）—— 同一个地址的不同端口可以是不同的机器
 * （跳板机按端口转到不同的内网机器），只看 sshHost 会把它们当成同一台。
 */
export function ownerMachineOf(profile: ProfileLike): string {
  const host = profile?.remote?.sshHost;
  if (!host) return 'local';
  const port = profile?.remote?.sshPort;
  return `${host}:${typeof port === 'number' && Number.isInteger(port) && port > 0 ? port : 22}`;
}

export function cliSessionOwnerFor(id: string, profile: ProfileLike): CliSessionOwner {
  return { id, engine: engineOf(profile), machine: ownerMachineOf(profile) };
}

/** 记录里那笔「属于谁」还算不算数（必须记的就是当前这个 id）。 */
export function validCliSessionOwner(rec: RecordLike | null | undefined): CliSessionOwner | null {
  const o = rec?.cliSessionOwner;
  if (!rec?.cliSessionId || !o || o.id !== rec.cliSessionId) return null;
  return o;
}

/** 写进新 id 时一起记上：id 是按 `profile` 起的那个执行器发的。 */
export function stampCliSessionOwner(rec: RecordLike, profile: ProfileLike): void {
  if (rec.cliSessionId) rec.cliSessionOwner = cliSessionOwnerFor(rec.cliSessionId, profile);
}

/**
 * 没连着时改引擎 / 机器**之前**调：id 还是按改之前的 profile 起的，先把这一点记下来。
 * 已经有一笔算数的就不动（换过去又换回来，那笔仍指向真正发 id 的那一家）。
 */
export function pinCliSessionOwnerBeforeRetarget(rec: RecordLike): void {
  if (!rec.cliSessionId || validCliSessionOwner(rec)) return;
  stampCliSessionOwner(rec, rec.profile);
}

/** 这次要按 `profile` 起，记录里的 id 能不能拿去 load：对不上返回原因，对得上 / 不知道返回 null。 */
export function cliSessionOwnerMismatch(rec: RecordLike | null | undefined, profile: ProfileLike): 'engine' | 'machine' | null {
  const o = validCliSessionOwner(rec);
  if (!o) return null;
  if (o.engine !== engineOf(profile)) return 'engine';
  if (o.machine !== ownerMachineOf(profile)) return 'machine';
  return null;
}
