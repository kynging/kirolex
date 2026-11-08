/**
 * **恢复时会话放在哪儿（项目 + 是否归档）** —— 纯逻辑，`index.ts` 的 `s3:list-backups` / `s3:restore` 用。
 *
 * 规则是「谁后挪用谁」，判据和同步时的位置跟随同一套（`placementToFollow`，只看 `placementChangedAt`）：
 * catalog 里这条的 `placementChangedAt` 比本机（合并**之前**）那份新 → 用 catalog 的项目和归档；
 * 否则保持本机原来的（包括本机归档的继续归档）。catalog 条目没有这个字段（老备份）当 0 → 保持本机的。
 * 本机原来没有这条 → 不管（直接用备份里的记录），返回 null。
 */
import { placementOf, placementToFollow, type CatalogEntry, type Placement } from './s3Sync.ts';
import { looksLikeSessionId } from './projectSanity.ts';

export interface RestorePlacement {
  /** 恢复后记录应该是的位置 */
  placement: Placement;
  /** 合并之前本机的位置 */
  before: Placement;
  /** 项目或归档状态和本机原来的不一样 */
  changed: boolean;
}

export function restorePlacement(
  localBefore: { profile?: any; archived?: any; placementChangedAt?: any } | null | undefined,
  entry: CatalogEntry | null | undefined,
  /** 不许跟进去的项目（见 `placementToFollow`）—— 跟不了就保持本机的位置 */
  refuseProject?: (projectId: string) => boolean,
): RestorePlacement | null {
  if (!localBefore) return null;
  const before = placementOf(localBefore);
  const placement = placementToFollow(localBefore, entry, refuseProject) || before;
  return { placement, before, changed: placement.projectId !== before.projectId || placement.archived !== before.archived };
}

/**
 * 恢复页里这条备份算哪个项目 —— 按云上（catalog）的；`undefined` = 未分组。
 *
 * 只有**老 catalog 条目**（`project` 那一版之前写的）才拿本机记录补：那时候不记项目，全挤进未分组没法看。
 * 新格式的条目未分组时是**不写** `project` 字段的（`projectOf(r) || undefined`），所以不能拿"没有 project"
 * 判断老条目 —— 新格式总会写 `archived` / `placementChangedAt`，有其中一个就是新条目，没 project 就是云上未分组。
 * `project` 是空串（明确未分组）同理。
 */
export function catalogProject(
  entry: { project?: unknown; archived?: unknown; placementChangedAt?: unknown },
  localProject: string | undefined,
): string | undefined {
  if (typeof entry.project === 'string') return entry.project.trim() || undefined;
  const isNewFormat = entry.archived !== undefined || entry.placementChangedAt !== undefined;
  if (isNewFormat) return undefined;
  return localProject || undefined;
}

/**
 * **从云端恢复的会话放在哪儿** ——「一恢复就该默认在未分组」。
 *
 * 现场：恢复 s_1790502638964_in82ze 之后它落进了 Blog（备份里那份记录 / catalog 里是别的设备上的项目）。
 * 规则：
 *   · 本机原来**没有**这条（新恢复）→ 一律未分组，不继承 catalog / 备份记录里的项目；
 *     只有用户在恢复对话框里勾了「放回原项目」、并且本机有同名项目时才放回去。
 *     未分组要标 `unassigned`（`acp:move-session` 移出项目也是这么标的），否则 attach 时又会按目录反推出一个项目。
 *   · 本机**有**这条（合并）→ 同样一律未分组（归档状态保持本机的）；勾了「放回原项目」就放回云上的原项目，
 *     不看时间戳谁新（勾选是明确的指示），那个项目本机也得有，没有就进未分组（标 unassigned）。
 *
 * `placementChangedAt` 新恢复时取备份记录和 catalog 里较新的那个，**不取现在**：取现在就比别的设备新，
 * 那边下一次同步会跟着把它也挪进未分组（只是在这台机器上恢复了一份，不该改别的设备上的分组）；
 * 取旧值又可能比 catalog 旧，下一次同步按「谁后挪用谁」又把它拉回原项目（「老往 Blog 跑」）。
 */
export interface RestoreTargetInput {
  /** 合并之前本机这条的记录；没有 = 新恢复 */
  localBefore: { profile?: any; archived?: any; placementChangedAt?: any } | null | undefined;
  /** 备份里那份记录 */
  backup: { profile?: any; archived?: any; placementChangedAt?: any } | null | undefined;
  /** catalog 里这条 */
  entry: CatalogEntry | null | undefined;
  /** 恢复对话框里勾了「放回原项目」 */
  putBack: boolean;
  /** 本机现有的项目（侧栏的项目列表） */
  localProjects: ReadonlySet<string>;
  /** 不许放进去的项目（advanced 专属） */
  refuseProject?: (projectId: string) => boolean;
}

export interface RestoreTarget {
  /** 恢复后记录应该是的位置 */
  placement: Placement;
  /** 新恢复并且放进了未分组：记录要标 `unassigned` */
  unassigned: boolean;
  /** 云上 / 备份里原来的项目（提示用；未分组 = undefined） */
  origin?: string;
  /** 合并时和本机原来的位置比变了没有；新恢复恒为 false */
  changed: boolean;
  /** 合并之前本机的位置（新恢复没有） */
  before?: Placement;
}

export function restoreTarget(i: RestoreTargetInput): RestoreTarget {
  const okProject = (p: string): boolean =>
    !!p && i.localProjects.has(p) && !looksLikeSessionId(p) && !i.refuseProject?.(p);
  const before = i.localBefore ? placementOf(i.localBefore) : undefined;
  const b = placementOf(i.backup);
  /* 原项目 = 云上的（catalog 新格式说了算，老条目才看备份记录） */
  const origin = (i.entry ? catalogProject(i.entry, b.projectId || undefined) : (b.projectId || undefined)) || undefined;
  const at = Math.max(before?.placementChangedAt || 0, b.placementChangedAt, Number(i.entry?.placementChangedAt) || 0);
  /* 归档状态：合并的保持本机的，新恢复的用备份里的 */
  const archived = before ? before.archived : b.archived;
  /* 勾了就放回原项目，**不再拿时间戳挡**（先默认恢复到未分组、再勾着恢复一次，两边时间戳一样，也要能放回去） */
  const projectId = i.putBack && origin && okProject(origin) ? origin : '';
  return {
    placement: { projectId, archived, placementChangedAt: at },
    unassigned: !projectId, origin,
    changed: !!before && before.projectId !== projectId, before,
  };
}

/**
 * **恢复后在哪儿跑** ——「恢复说『改成在本机跑』却仍连远端」。
 *
 * 定的是：备份记录里那台机器在**本机设置里有**（`resolveSessionRemote` 按 id 认到了设置里的那台）→
 * 保留远端，提示「仍在 <机器名> 上跑」；设置里没有（只剩快照 / 已删）→ 改成本机跑。
 * 提示和实际必须一致：上一版不管认不认得都说「改成在本机跑」。
 *
 * 入参是 `resolveSessionRemote` 的结果；`labelOf` 给机器的显示名。没有远端 → `none`。
 */
export type RestoreRunPlan = { kind: 'none' } | { kind: 'local' } | { kind: 'keep'; label: string };

export function restoreRunPlan(
  resolved: { remote?: { label?: string; sshHost?: string }; source?: 'config' | 'snapshot' } | null | undefined,
  hadRemote: boolean,
  labelOf: (sshHost: string) => string,
): RestoreRunPlan {
  if (!hadRemote) return { kind: 'none' };
  const host = String(resolved?.remote?.sshHost || '').trim();
  if (resolved?.source === 'config' && host) {
    return { kind: 'keep', label: String(resolved.remote?.label || '').trim() || labelOf(host) || host };
  }
  return { kind: 'local' };
}

/**
 * **恢复后的运行位置，连合并那条也管** —— 合并时 `mergeRecords` 会按 updatedAt 拿较新那份的整个 profile，
 * 云端较新的话就把云端的 `remote` 带回来（哪怕那台机器已从本机设置删掉，attach 随后拒连）。
 * 所以：本机原来有这条 → 候选是**本机原来的**运行位置（本机跑就是没有）；新恢复 → 候选是备份里的。
 * 候选再过 `restoreRunPlan`：本机设置里认得才留，不认得改本机跑 —— 提示和实际一致。
 * `resolve` 就是 `resolveSessionRemote` 按本机设置解析（index.ts 的 `sessionRemote`）。
 */
export function restoreRemote(
  localBefore: { profile?: any } | null | undefined,
  restored: { profile?: any } | null | undefined,
  resolve: (remote: any) => { remote?: { label?: string; sshHost?: string }; source?: 'config' | 'snapshot' },
  labelOf: (sshHost: string) => string,
): { remote: any | undefined; plan: RestoreRunPlan } {
  const want = localBefore ? localBefore.profile?.remote : restored?.profile?.remote;
  const hadRemote = !!String(want?.sshHost || '').trim();
  const plan = restoreRunPlan(hadRemote ? resolve(want) : undefined, hadRemote, labelOf);
  return { remote: plan.kind === 'keep' ? want : undefined, plan };
}
