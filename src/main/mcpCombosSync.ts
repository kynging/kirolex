/**
 * **`mcp-combos.json` 跟着 S3 同步** ——「组合那里明明写的投研，为什么显示是通用」：组合是在台式机上存的，
 * 这份文件以前不在同步白名单里，换一台电脑就只剩内置「通用」。
 *
 * 和会话同一个桶、同一个 key 布局（`<prefix>/v1/mcp-combos.json`）。"谁动过"按**内容摘要**比（`planComboSync`）：
 * 只有一边动过就用那一边；**两边都动过 / 本机第一次同步但两边都有** 时
 * 不是"谁新用谁"，而是**合并**（`mergeComboTexts`）—— 组合是一条一条的，按 id 并起来不丢东西；
 * 同一个 id 两边内容不同时两份都留（桶里那份换个 id 和名字），不静默覆盖任何一边。
 *
 * 纯逻辑，不碰 electron、不碰网络；`index.ts` 的 `syncMcpCombosWithBucket` 负责读写和上传。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { parseMcpCombos } from './mcpCombos.ts';
import { tr, trIn } from './uiText.ts';

/** 相对 `~/.kirolex` 的路径（也是 S3 key 里 `v1/` 之后那段）。 */
export const MCP_COMBOS_REL = 'mcp-combos.json';

/**
 * 上一次同步完两边各是什么内容（内容摘要）。**不用大小 / 时间判断"变没变"** —— 另一台电脑传一份
 * 大小相同、内容不同的文件，按大小比就会当成没变，本机再一改就直接把对方那份盖掉。文件很小，每轮整份拉下来算摘要。
 */
export interface ComboSyncMark { localHash: string; remoteHash: string }

export function comboHash(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export type ComboSyncPlan = {
  action: 'none' | 'pull' | 'upload' | 'merge' | 'skip';
  /** 要写到本机的内容（不写 = undefined） */
  writeLocal?: string;
  /** 要传到桶里的内容（不传 = undefined） */
  upload?: string;
  /** skip 的原因（某一边文件有错：两边都不动） */
  error?: string;
  added: string[];
  conflicts: Array<{ id: string; keptAs: string }>;
};

/**
 * 这一轮怎么同步组合文件。`local` / `remote` 是两边的原文（没有 = undefined），`last` 是上次同步完记下的摘要。
 *   · 本机第一次同步、两边都有 → 合并（直接拉会盖掉本机的，直接传会盖掉别的电脑的）；
 *   · 只有一边变过 → 用那一边；两边都变过 → 合并；
 *   · **要传 / 要拉 / 要合并的那份先校验**，不合格就整轮不动（不把坏文件传上去盖掉桶里好的，也不把坏的拉下来）。
 */
export function planComboSync(local: string | undefined, remote: string | undefined, last: ComboSyncMark | undefined): ComboSyncPlan {
  const plan = (action: ComboSyncPlan['action'], extra: Partial<ComboSyncPlan> = {}): ComboSyncPlan => ({ action, added: [], conflicts: [], ...extra });
  if (local === undefined && remote === undefined) return plan('none');
  if (local !== undefined && remote !== undefined && local === remote) return plan('none');
  const localChanged = local !== undefined && (!last || comboHash(local) !== last.localHash);
  const remoteChanged = remote !== undefined && (!last || comboHash(remote) !== last.remoteHash);
  const checkLocal = (): string | null => { const r = parseMcpCombos(local!); return r.ok ? null : tr('The combo file on this machine has an error: {error}', { error: r.error }); };
  const checkRemote = (): string | null => { const r = parseMcpCombos(remote!); return r.ok ? null : tr('The combo file in the bucket has an error: {error}', { error: r.error }); };
  const upload = (): ComboSyncPlan => { const e = checkLocal(); return e ? plan('skip', { error: e }) : plan('upload', { upload: local }); };
  const pull = (): ComboSyncPlan => { const e = checkRemote(); return e ? plan('skip', { error: e }) : plan('pull', { writeLocal: remote }); };
  if (remote === undefined) return upload();            // 桶里没有（新桶 / 被删了）：传
  if (local === undefined) return pull();               // 本机没有：拉
  if ((!last || localChanged) && (!last || remoteChanged)) {
    const m = mergeComboTexts(local, remote);
    if (!m.ok) return plan('skip', { error: m.error });
    return plan('merge', {
      ...(m.text !== local ? { writeLocal: m.text } : {}),
      ...(m.text !== remote ? { upload: m.text } : {}),
      added: m.added, conflicts: m.conflicts,
    });
  }
  if (localChanged) return upload();
  if (remoteChanged) return pull();
  return plan('none');
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** 字段顺序无关的比较用：对象的 key 排好序再序列化。 */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function rawList(text: string): unknown[] {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown[];
}

/** `n` 是合并时给桶里那份起的名字吗（`mergeComboTexts` 里那两种写法，中英文都认 —— 界面语言可能换过）。 */
function isCopyName(n: string, base: string): boolean {
  for (const lang of ['zh', 'en'] as const) {
    if (n === trIn(lang, '{name} (from another computer)', { name: base })) return true;
    const pre = trIn(lang, '{name} (from another computer {n})', { name: base, n: '\u0000' }).split('\u0000');
    if (pre.length === 2 && n.startsWith(pre[0]) && n.endsWith(pre[1]) && /^\d+$/.test(n.slice(pre[0].length, n.length - pre[1].length))) return true;
  }
  return false;
}

/**
 * 副本 id 的生成和识别**共用这一条规则**：`<原 id 的前 60 个字符>-<n>`（截到 60 是为了加上编号后不超过 64 字符的上限）。
 * 认的时候也按截过的前缀比 —— 只按完整原 id 比的话，61–64 字符的合法 id 认不出自己的副本，交替同步会越滚越多。
 */
const COPY_ID_BASE_LEN = 60;
function copyIdFor(id: string, n: number): string {
  return `${id.slice(0, COPY_ID_BASE_LEN)}-${n}`;
}
/** `cand` 是 `orig` 本身或它的副本 id 吗。id 已经过校验（只有字母、数字、- 和 _），可以直接拼进正则。 */
function isCopyIdOf(cand: string, orig: string): boolean {
  return cand === orig || new RegExp(`^${orig.slice(0, COPY_ID_BASE_LEN)}-\\d+$`).test(cand);
}

export type ComboMerge =
  | { ok: true; text: string; added: string[]; conflicts: Array<{ id: string; keptAs: string }> }
  | { ok: false; error: string };

/**
 * 把桶里那份并进本机这份。本机的条目原样、原顺序在前；桶里有而本机没有的追加在后面。
 *   · 同 id、内容一样（字段顺序无关）→ 算一条；
 *   · 同 id、内容不同 → 本机的留在原 id，桶里那份换成 `<id>-2`（撞了再往上加）、名字后面注明「另一台电脑的版本」；
 *   · 不同 id 但名字撞了 → 桶里那份同样改名（名字重复的文件存不过校验，下拉也分不清）。
 * 没有要加的 → `text` 就是本机原文（不重新排版）。任一边解析 / 校验不过 → 不合并，说是哪一边。
 */
export function mergeComboTexts(localText: string, remoteText: string): ComboMerge {
  const lp = parseMcpCombos(localText);
  if (!lp.ok) return { ok: false, error: tr('The combo file on this machine has an error: {error}', { error: lp.error }) };
  const rp = parseMcpCombos(remoteText);
  if (!rp.ok) return { ok: false, error: tr('The combo file in the bucket has an error: {error}', { error: rp.error }) };
  const local = rawList(localText);
  const remote = rawList(remoteText);
  const ids = new Set(lp.combos.map((c) => c.id));
  const names = new Set(lp.combos.map((c) => c.name));
  const localIds = new Set(local.filter(isObj).map((c) => String(c.id)));
  const out: unknown[] = [...local];
  const added: string[] = [];
  const conflicts: Array<{ id: string; keptAs: string }> = [];
  /* 去掉 id / name 之后的内容 —— 认"这是之前合并时改过名的那份副本" */
  const body = (c: Record<string, unknown>): string => { const { id: _i, name: _n, ...rest } = c; return canonical(rest); };
  for (const r of remote) {
    if (!isObj(r)) continue;
    const id = String(r.id);
    const name = String(r.name).trim();
    if (out.some((e) => canonical(e) === canonical(r))) continue;   // 一模一样（字段顺序无关）
    /*
      **反方向：桶里这条是另一台电脑合并时给「我这边某条原条目」起的副本** —— 名字是那条的副本名、
      id 是那条的 id 或 `<那条 id>-n`、内容一样 → 就是我自己那份转了一圈回来，不再加。
      不认的话两台电脑交替同步，同一份内容会多出第三条（`research-2-2`）。
    */
    if (out.some((e) => isObj(e) && body(e) === body(r) && isCopyName(name, String(e.name).trim())
      && isCopyIdOf(id, String(e.id)))) continue;
    let entry: Record<string, unknown> = r;
    if (ids.has(id) || names.has(name)) {
      /*
        之前合并时**生成过**这一份副本 → 不再加。只认能确认是副本的：内容一样、名字正是合并时起的那种名字
        （「<原名>（另一台电脑的版本[ n]）」，两种语言都认），id 是 `<id>-n`，或者是原 id
        （只有名字撞了的那种）。名字不是这种写法的（例如本机同 id 改了名）不是副本，是真冲突 —— 照样两份都留。
      */
      const already = out.some((e) => isObj(e) && body(e) === body(r)
        && isCopyName(String(e.name), name)
        && isCopyIdOf(String(e.id), id));
      if (already) continue;
      let newId = id;
      for (let n = 2; ids.has(newId); n += 1) newId = copyIdFor(id, n);
      /* 副本**一律**用副本名（哪怕原名没撞）—— 和上面认副本的 `isCopyName` 同一条规则，再合并一次才认得出来 */
      let newName = tr('{name} (from another computer)', { name });
      for (let n = 2; names.has(newName); n += 1) newName = tr('{name} (from another computer {n})', { name, n });
      entry = { ...r, id: newId, name: newName };
      if (localIds.has(id)) conflicts.push({ id, keptAs: newId });
    }
    ids.add(String(entry.id));
    names.add(String(entry.name).trim());
    out.push(entry);
    added.push(String(entry.id));
  }
  if (!added.length) return { ok: true, text: localText, added, conflicts };
  const text = `${JSON.stringify(out, null, 2)}\n`;
  const check = parseMcpCombos(text);
  if (!check.ok) return { ok: false, error: tr('The merged combo file did not pass validation: {error}', { error: check.error }) };
  return { ok: true, text, added, conflicts };
}

/** 上次同步完的摘要存在 `~/.kirolex/s3-combos-sync.json`（路径由调用方给，测试用临时目录）。读不到 = 没同步过。 */
export function readComboMark(file: string): ComboSyncMark | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return typeof v?.localHash === 'string' && typeof v?.remoteHash === 'string' ? { localHash: v.localHash, remoteHash: v.remoteHash } : undefined;
  } catch { return undefined; }
}

export function writeComboMark(file: string, mark: ComboSyncMark): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(mark));
  fs.renameSync(tmp, file);
}

/** `syncComboFile` 要的读写口子 —— index.ts 接 S3 和磁盘，测试接内存里的假桶。 */
export interface ComboSyncIo {
  /** 桶里那份和它的 ETag；没有 = null */
  get: () => Promise<{ text: string; etag: string } | null>;
  /** 条件写入：`ifMatch` = 刚读到的 ETag；`ifNoneMatch` = 桶里还不能有。别人先写了 → 'conflict' */
  put: (text: string, cond: { ifMatch: string } | { ifNoneMatch: '*' }) => Promise<'ok' | 'conflict'>;
  readLocal: () => string | undefined;
  writeLocal: (text: string, plan: ComboSyncPlan) => void;
  readMark: () => ComboSyncMark | undefined;
  writeMark: (mark: ComboSyncMark) => void;
}

export const COMBO_SYNC_ATTEMPTS = 3;

/**
 * **一轮组合同步：下载 → 决定 → 条件上传；上传时发现别人刚传过就重新下载、重新合并再试**。
 * 下载和上传之间另一台电脑传了新的，条件写入会失败（而不是盖掉它）；重试时本机这份已经是合并过的，
 * 摘要没更新，所以会按"两边都改过"再和对方的新版本合一次。试满 `attempts` 次还冲突：这一轮不传，下一轮再说。
 * 摘要只在上传成功（或不用传）之后才记。
 */
export async function syncComboFile(io: ComboSyncIo, attempts = COMBO_SYNC_ATTEMPTS): Promise<{
  uploaded: boolean; plans: ComboSyncPlan[]; gaveUp?: boolean;
}> {
  const plans: ComboSyncPlan[] = [];
  for (let i = 0; i < attempts; i += 1) {
    const got = await io.get();
    const remoteText = got?.text;
    const localText = io.readLocal();
    const plan = planComboSync(localText, remoteText, io.readMark());
    plans.push(plan);
    if (plan.action === 'skip') return { uploaded: false, plans };
    if (plan.writeLocal !== undefined) io.writeLocal(plan.writeLocal, plan);
    if (plan.upload !== undefined) {
      const r = await io.put(plan.upload, got ? { ifMatch: got.etag } : { ifNoneMatch: '*' });
      if (r === 'conflict') continue;
    }
    const finalLocal = plan.writeLocal ?? localText;
    const finalRemote = plan.upload ?? remoteText;
    if (finalLocal !== undefined && finalRemote !== undefined) {
      io.writeMark({ localHash: comboHash(finalLocal), remoteHash: comboHash(finalRemote) });
    }
    return { uploaded: plan.upload !== undefined, plans };
  }
  return { uploaded: false, plans, gaveUp: true };
}
