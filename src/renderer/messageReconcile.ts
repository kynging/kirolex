/**
 * 界面上一条会话的消息缓存和主进程 store（盘上的 transcript）对账 —— PURE。
 *
 * 「新会话里出现大量别的会话的历史，切走切回还在」：后台那条会话断线自动重发时，旧代码
 * `setMessages(retained)` 把**前台**会话的界面换成了后台那条的历史，归属记成前台会话，缓存 effect
 * 再把它存进前台会话的缓存格子。之后切走切回，`switchSession` 看到缓存非空就直接用 —— 盘上明明是干净的，
 * 界面却一直错下去。写入那条路已经按会话 id 改掉了（74a459a），这里补的是**自愈**：切到一条会话时，
 * 缓存和 store 对不上就以 store 为准重载，一次污染不会一直错下去。
 *
 * ## 判据：用户消息看 id，助手消息看它属于哪一轮、内容在不在那一轮落盘的回复里
 *
 * 用户消息的 id 由渲染层生成、随 `acp:prompt` 一起落盘（主进程自己发起的那轮也把它的 id 推给界面），
 * 两边一定一致；助手消息的 id 不行（流式时是后端给的或临时生成的，落盘时可能是另一个；界面上一轮回复
 * 还可能在工具调用处分成几段，盘上是一整条）。所以：
 *
 * - store 里有、缓存里没有的用户消息 → 缓存是旧的 / 被整份换掉了；
 * - 缓存里有、store 里没有的用户消息 → 多半是别的会话的。例外（不算不一致）：
 *   - 追加指令（`steer`）：没被吃的不落盘，被吃的并进那一轮的用户消息；
 *   - `localOnly`：渲染层**明确为这条会话**写进去的（发出的那条用户消息 —— 发送失败时不落盘、
 *     `/usage` 这类本地回显、发送失败的报错气泡、复制会话带过来的历史）。按会话登记，
 *     所以别的会话的消息不可能出现在这条会话的登记里。
 *   不按时间豁免：比 store 最新还晚的陌生消息照样可能是别人的。store 是空的（新会话还没落盘）也一样对账。
 * - 缓存里 id 不在 store 里、也没登记 localOnly 的助手消息：找它所属那一轮（往前最近一条不是追加指令的
 *   用户消息）。那条用户消息得是这条会话的（在 store 里或 localOnly），并且：
 *   - 💭 思考段：只在界面上，算对得上；
 *   - 其余：正文（去掉首尾空白）得出现在 store 里**那一轮**落盘的助手回复里（流式分段 / id 不同都兼容）。
 *   找不到所属的那一轮（前面没有用户消息）、那一轮不是这条会话的、或正文对不上 → 不一致。
 * - 反过来：store 里每一轮落盘的每条助手回复，正文都得在缓存那一轮（各段拼起来、去掉空白）里完整出现；
 *   缓存里缺了这条回复、或只有前半截 → 不一致（id 不同、分段、思考段都不影响这个比较）。
 *   store 里单独成条的追加指令按它在缓存里所属的那一轮归，两边按同一个口径分轮。
 *
 * 不一致时的结果：store 的消息（同 id 的沿用界面那份对象，保持同一性）+ localOnly 的那几条，
 * 按时间并进去。其余的（别的会话的）丢掉。
 */
import type { Message } from './App';

type Msg = Pick<Message, 'id' | 'role' | 'timestamp'> & { steer?: Message['steer']; content?: string };

/** 这条只在界面上的消息重载时要不要留着：只认这条会话自己登记过的。 */
function keepsLocally(m: Msg, localOnly?: ReadonlySet<string>): boolean {
  return !!localOnly?.has(m.id);
}

/** 比较正文时去掉所有空白：界面上分段显示的几段拼起来，和盘上那一整条只差段间的换行。 */
const squash = (text: string): string => text.replace(/\s+/g, '');
const isThinking = (m: Msg): boolean => String(m.content ?? '').startsWith('💭 ');

/**
 * 按**缓存里的轮次**分组：每条不是追加指令的用户消息开一轮（key 是它的 id，第一条用户消息之前的归 `''`）。
 * 追加指令在 store 里可能是单独一条用户消息（没有并进那一轮的），在缓存里它属于所在的那一轮 ——
 * 所以 store 的消息也按「这条用户消息在缓存里属于哪一轮」归过来，两边才是同一个口径。
 */
function turnsByCache(cached: readonly Msg[], stored: readonly Msg[]) {
  const owner = new Map<string, string>();
  const cachedText = new Map<string, string>();
  let base = '';
  for (const m of cached) {
    if (m.role === 'user') {
      if (!m.steer) base = m.id;
      owner.set(m.id, base);
      continue;
    }
    if (m.role === 'assistant' && !isThinking(m)) cachedText.set(base, `${cachedText.get(base) || ''}${squash(String(m.content ?? ''))}`);
  }
  const storedText = new Map<string, string>();
  const storedMsgs: { turn: string; m: Msg }[] = [];
  let turn = '';
  for (const m of stored) {
    if (m.role === 'user') { turn = owner.get(m.id) ?? m.id; continue; }
    if (m.role !== 'assistant') continue;
    storedText.set(turn, `${storedText.get(turn) || ''}${squash(String(m.content ?? ''))}`);
    storedMsgs.push({ turn, m });
  }
  return { cachedText, storedText, storedMsgs };
}

/** 缓存和 store 对不对得上（判据见文件头）。 */
export function storeMismatch(
  cached: readonly Msg[],
  stored: readonly Msg[],
  localOnly?: ReadonlySet<string>,
): boolean {
  const cachedIds = new Set(cached.map((m) => m.id));
  for (const m of stored) {
    if (m.role === 'user' && !cachedIds.has(m.id)) return true;
  }
  const storedIds = new Set(stored.map((m) => m.id));
  for (const m of cached) {
    if (m.role !== 'user' || m.steer || storedIds.has(m.id)) continue;
    if (keepsLocally(m, localOnly)) continue;
    return true;
  }
  const { cachedText, storedText, storedMsgs } = turnsByCache(cached, stored);
  /* 缓存 → store：每条助手消息都得属于这条会话的某一轮，正文在那一轮落盘的回复里 */
  let base = '';
  let baseIsOurs = true;   // 第一条用户消息之前：只有 store 里有的 / 登记过的才算
  let beforeFirstUser = true;
  for (const m of cached) {
    if (m.role === 'user') {
      if (!m.steer) { base = m.id; baseIsOurs = storedIds.has(m.id) || keepsLocally(m, localOnly); beforeFirstUser = false; }
      continue;
    }
    if (m.role !== 'assistant' || storedIds.has(m.id) || keepsLocally(m, localOnly)) continue;
    if (beforeFirstUser || !baseIsOurs) return true;
    if (isThinking(m)) continue;
    const body = squash(String(m.content ?? ''));
    if (!body) continue;
    if (!(storedText.get(base) || '').includes(body)) return true;
  }
  /* store → 缓存：每一轮落盘的回复都得在缓存那一轮里完整出现（缺了、截短了都算对不上） */
  for (const { turn, m } of storedMsgs) {
    const body = squash(String(m.content ?? ''));
    if (!body) continue;
    if (!(cachedText.get(turn) || '').includes(body)) return true;
  }
  return false;
}

/**
 * 对得上 → `null`（缓存照用，不动它的同一性）；对不上 → 以 store 为准的新列表。
 * `stored` 是已经按界面格式转好的 transcript。
 */
export function reconcileWithStore<T extends Msg>(
  cached: readonly T[],
  stored: readonly T[],
  localOnly?: ReadonlySet<string>,
): T[] | null {
  if (!storeMismatch(cached, stored, localOnly)) return null;
  const liveById = new Map(cached.map((m) => [m.id, m]));
  const storedIds = new Set(stored.map((m) => m.id));
  /* 同 id 的只在正文和角色都一致时沿用界面那份对象（保持同一性）；不一致（例如同 id 被截短）就用 store 的 */
  const base = stored.map((m) => {
    const live = liveById.get(m.id);
    return live && live.role === m.role && live.content === m.content ? live : m;
  });
  const extras = cached.filter((m) => !storedIds.has(m.id) && !m.steer && keepsLocally(m, localOnly));
  if (!extras.length) return base;
  /* 按时间插回去：每条放在第一条比它晚的 store 消息前面（同时刻的排在 store 那条后面） */
  const out: T[] = [];
  let i = 0;
  for (const m of base) {
    while (i < extras.length && extras[i].timestamp < m.timestamp) out.push(extras[i++]);
    out.push(m);
  }
  while (i < extras.length) out.push(extras[i++]);
  return out;
}
