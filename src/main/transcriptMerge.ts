/**
 * **把桶里那份和本地那份并成一条** ——「另外备份是不是应该有合并的功能」。
 *
 * ## 为什么这件事是**可以**做对的
 *
 * `transcript.jsonl` 是 append-only 的事件流，每行一个 JSON，每条都带 `id` 和 `ts`。
 * 所以"合并"不是启发式：**按 `id` 去重、按 `ts` 排序**就是精确答案。
 * `history.md` 本来就是从 transcript 渲染出来的（重建即可），
 * 只有 `record.json` 需要一条策略（见 `mergeRecords`）。
 *
 * ## 必须在**原始行**上合并，不能在读出来的消息上合
 *
 * `readTranscript()` 会把 `mergeIntoMessageId` 那种事件**折叠**进它指向的那条用户消息里
 * （"把这段文字并进前面那条"）。在折叠后的视图上合并，那些事件就消失了 ——
 * 于是合并回去的 transcript 少掉几段用户实际发过的内容，而且**看不出来**
 * （文件是完整的、能解析、只是内容少了）。所以这里一律处理原始行。
 *
 * 顺带：**保留原始行的文本本身**，不重新序列化。re-stringify 会改掉字段顺序，
 * 也会让任何将来新增、这一版还不认识的字段承担风险 —— 而这里根本不需要理解内容。
 *
 * ## 同 id 不同内容时**本地赢**
 *
 * 消息 id 是 `a_${Date.now()}` 这类，两台机器在同一毫秒各产生一条是可能的（罕见）。
 * 这种情况下保留本地那条：悄悄用远端的覆盖掉用户眼前看到的内容是这里面最坏的结果。
 * 但要**数出来**报给人 —— "合并完少了一条"必须能解释。
 *
 * ## 一个诚实的边界
 *
 * 合并修好的是**人看的那份记录**，不是**模型的上下文**。模型记的是 kiro-cli 自己那套 session
 * （按 `cliSessionId` 存，在跑过它的那台机器上）—— 合并 transcript 不会合并那个，
 * 合进来的那半段只能靠随消息带的快照进到模型眼里。调用方要把这件事说给用户。
 */

/** 一行原始事件 —— 只解析出排序和去重需要的那两个字段。 */
interface RawEvent {
  id: string;
  ts: number;
  /** 原始那一行（不含换行）。合并输出用它，不重新序列化。 */
  line: string;
}

/** 解析一份 `transcript.jsonl`。解析不了的行**丢掉**（末尾被截断的那半行就是这种）。 */
export function parseRawEvents(text: string): RawEvent[] {
  const out: RawEvent[] = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const id = typeof obj?.id === 'string' ? obj.id : '';
    if (!id) continue;                     // 没有 id 就没法去重，只能丢
    const ts = Number(obj?.ts);
    out.push({ id, ts: Number.isFinite(ts) ? ts : 0, line });
  }
  return out;
}

export interface MergeResult {
  /** 合并后的整份文件内容（末尾带换行，和 `appendMessage` 的写法一致）。 */
  text: string;
  /** 从远端并进来的条数。 */
  added: number;
  /** 本地原有的条数。 */
  kept: number;
  /** 同 id 但内容不同、因此保留了本地那条的条数。 */
  clashed: number;
}

/**
 * 合并两份 transcript。
 *
 * 排序**稳定**（`ts` 相同就保持"本地在前、远端在后"）：`mergeIntoMessageId` 那种事件必须排在
 * 它指向的那条消息之后，而同一毫秒内的两条事件谁先谁后是无从判断的 —— 不稳定的排序
 * 会让同一次合并在两台机器上给出不同结果，那比"顺序可能不完美"糟得多。
 */
export function mergeTranscripts(localText: string, remoteText: string): MergeResult {
  const local = parseRawEvents(localText);
  const remote = parseRawEvents(remoteText);
  const byId = new Map<string, RawEvent>();
  /* 先放本地的 —— 后面同 id 的一律不覆盖 */
  for (const e of local) if (!byId.has(e.id)) byId.set(e.id, e);
  let added = 0;
  let clashed = 0;
  for (const e of remote) {
    const mine = byId.get(e.id);
    if (!mine) { byId.set(e.id, e); added += 1; continue; }
    /* 同 id：内容一样就是同一条（正常情况），不一样才是真撞上了 */
    if (mine.line !== e.line) clashed += 1;
  }
  /* `index` 只用来让排序稳定 —— Array.prototype.sort 在 V8 上已经是稳定的，
     但依赖"实现恰好稳定"不是一件该写进数据处理里的事 */
  const all = [...byId.values()].map((e, index) => ({ e, index }));
  all.sort((a, b) => (a.e.ts - b.e.ts) || (a.index - b.index));
  const text = all.length ? `${all.map((x) => x.e.line).join('\n')}\n` : '';
  return { text, added, kept: local.length, clashed };
}

/**
 * 合并 `record.json`。
 *
 * 策略：**`updatedAt` 新的那份赢**（标题、模型、profile 这些"最后一次是什么样"的字段），
 * 但三件事例外：
 *
 * · 项目 / 归档（`profile.projectId`、`archived`、`placementChangedAt`）按 `placementChangedAt` 新的那份；
 * · `createdAt` 取**更早**的那个 —— 这条会话是什么时候开始的，不随谁后改一次而变；
 * · 数组型的（`tags` 之类）取**并集** —— 两台机器各加过一个标签时，
 *   按"新的赢"会把另一台那个丢掉，而那是用户明确加过的东西。
 *
 * `cliSessionId` / `executorState` 一律**保留本地的**：它们指向的是**这台机器上**那个后端会话,
 * 把另一台的 id 抄过来会让下一次 attach 去 load 一个这里不存在的 session。
 */
export function mergeRecords(local: any, remote: any): any {
  if (!local) return remote;
  if (!remote) return local;
  const localNewer = (Number(local.updatedAt) || 0) >= (Number(remote.updatedAt) || 0);
  const winner = localNewer ? local : remote;
  const loser = localNewer ? remote : local;
  const out: any = { ...loser, ...winner };

  const createdA = Number(local.createdAt) || 0;
  const createdB = Number(remote.createdAt) || 0;
  if (createdA && createdB) out.createdAt = Math.min(createdA, createdB);

  /* `filesDirs`：两台机器各自用过的路径都要留着（见 SessionRecord.filesDirs） */
  for (const key of ['tags', 'filesDirs']) {
    const a = Array.isArray(local[key]) ? local[key] : [];
    const b = Array.isArray(remote[key]) ? remote[key] : [];
    const union = [...a, ...b].filter((v, i, arr) => arr.indexOf(v) === i);
    if (union.length) out[key] = union;
    else delete out[key];
  }

  /*
    **位置（项目 / 归档）按 `placementChangedAt` 谁新用谁** —— 不跟着整份记录的 `updatedAt` 走：
    A 移过项目、B 之后又聊过一句，按 updatedAt 就是 B 的旧项目赢，A 的移动被盖掉。
    一样新（包括两边都是没有这个字段的老记录）就保持上面按 updatedAt 的结果。
  */
  const placedA = Number(local.placementChangedAt) || 0;
  const placedB = Number(remote.placementChangedAt) || 0;
  if (placedA !== placedB) {
    const src = placedA > placedB ? local : remote;
    const profile = { ...(out.profile || {}) };
    if (src.profile && src.profile.projectId !== undefined) profile.projectId = src.profile.projectId;
    else delete profile.projectId;
    out.profile = profile;
    if (src.archived !== undefined) out.archived = src.archived;
    else delete out.archived;
    out.placementChangedAt = src.placementChangedAt;
  }

  /* 这台机器的东西不许被另一台的覆盖 */
  if ('cliSessionId' in local) out.cliSessionId = local.cliSessionId;
  else delete out.cliSessionId;
  out.executorState = 'detached';   // 刚合并完，谁也没连着
  /* 合并本身是一次改动 */
  out.updatedAt = Math.max(Number(local.updatedAt) || 0, Number(remote.updatedAt) || 0, Date.now());
  return out;
}
