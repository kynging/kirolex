/**
 * **恢复时会话放在哪儿（项目 + 是否归档）** —— 纯逻辑，`index.ts` 的 `s3:list-backups` / `s3:restore` 用。
 *
 * 规则是「谁后挪用谁」，判据和同步时的位置跟随同一套（`placementToFollow`，只看 `placementChangedAt`）：
 * catalog 里这条的 `placementChangedAt` 比本机（合并**之前**）那份新 → 用 catalog 的项目和归档；
 * 否则保持本机原来的（包括本机归档的继续归档）。catalog 条目没有这个字段（老备份）当 0 → 保持本机的。
 * 本机原来没有这条 → 不管（直接用备份里的记录），返回 null。
 */
import { placementOf, placementToFollow, type CatalogEntry, type Placement } from './s3Sync.ts';

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
): RestorePlacement | null {
  if (!localBefore) return null;
  const before = placementOf(localBefore);
  const placement = placementToFollow(localBefore, entry) || before;
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
