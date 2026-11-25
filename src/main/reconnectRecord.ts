/**
 * **重连写盘不整份写回开始时那份 profile** ——「frp 那个会话还是有之前权限审批的 bug」
 * （main-20261125-203010.log，s_1795582682473_dj6azu）：切到远端重连期间用户切了「自动」，
 * 写进了记录；重连落定时 `rec.profile = profile`（重连开始时捕获的、permissionMode=ask）整份写回，
 * 把「自动」盖回「先问」，新执行器也按 ask 起 —— 之后连着弹批准，用户等了 531 秒。
 *
 * 所以重连（换模型 / agent / 机器 / 引擎 / 换后端会话 / 模型降级）写盘时：以**写盘那一刻**的记录为底，
 * 只覆盖这次重连自己改了的字段（和它开始时读到的记录比，变了的才算它改的；
 * 忙时登记的切换被「带上」进 profile 的那几样也在其中）。期间别处写进记录的字段（权限、agent、机器…）不动。
 *
 * 纯模块，不 import electron。
 */
import type { PermissionMode } from './config.ts';

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function profileAfterReconnect<P extends object>(latest: P | undefined, startedFrom: P | undefined, next: P): P {
  if (!latest) return { ...next };
  /* 不知道开始时记录长什么样（开始时还没有记录）：只能按这次的为准 */
  if (!startedFrom) return { ...latest, ...next };
  const out: Record<string, unknown> = { ...(latest as Record<string, unknown>) };
  const from = startedFrom as Record<string, unknown>;
  const to = next as Record<string, unknown>;
  for (const k of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (same(to[k], from[k])) continue;           // 这次没改它：以最新记录为准
    if (to[k] === undefined) delete out[k]; else out[k] = to[k];
  }
  return out as P;
}

/** 记录里的权限（没写 = 先问，见 0940b05f）。 */
export function recordPermission(profile: { permissionMode?: string } | undefined): PermissionMode {
  return profile?.permissionMode === 'auto-approve' ? 'auto-approve' : 'ask';
}
