import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { reconcileWithStore, storeMismatch } from '../src/renderer/messageReconcile.ts';
import { findRecoveryTarget } from '../src/renderer/turnRecovery.ts';

/*
  「新会话 contains many historical records」「我切换过也还在」（10-19 18:33，会话 s_1792405989036_iq5q03）。

  盘上、控制入口的 tail、last-injection 都只有它自己的 6 条 —— 坏的是渲染层那份按会话 id 存的缓存。
  同一时刻 CDE（刚从远程切到本机）在后台跑完一轮：旧执行器迟到的 `disconnected` → 断线恢复 →
  `recoverInterruptedTurn(CDE)` → `rerunFromMessage(CDE)`，而 9f68aec 里那一步是 `setMessages(retained)`：
  焦点那条（新会话）的界面被换成了 CDE 的历史，归属记成新会话，缓存 effect 把它存进新会话的格子；
  切走切回时缓存非空、不读盘，于是一直错。

  useAcp.ts 测试 import 不了（React hook + 无扩展名的 import），所以：
  1. 对账本身是纯函数，直接测；
  2. 用一个照着 hook 写的最小状态模型重放那次事件交错（归属在 setMessages 时记、缓存 effect 只在
     归属 == 焦点时写、switchSession 先用缓存再对账），旧写法 / 新写法 / 有无对账各跑一遍；
  3. 源码扫描钉住 hook 里真的是这么接的线。
*/

type M = { id: string; role: 'user' | 'assistant'; content: string; timestamp: number; steer?: 'pending' | 'consumed' | 'failed' };
const u = (id: string, ts: number, content = id): M => ({ id, role: 'user', content, timestamp: ts });
const a = (id: string, ts: number, content = id): M => ({ id, role: 'assistant', content, timestamp: ts });

/* 新会话 N 自己的 6 条（18:33–18:40） */
const N_STORE: M[] = [u('n_u1', 1), a('n_a1', 2), u('n_u2', 3), a('n_a2', 4), u('n_u3', 5), a('n_a3', 6)];
/* CDE 的历史：一大串，时间都比 N 的早 */
const CDE_STORE: M[] = Array.from({ length: 40 }, (_, i) => (i % 2 ? a(`c_a${i}`, -100 + i) : u(`c_u${i}`, -100 + i)));

// ---------------------------------------------------------------------------
// 1. 纯函数
// ---------------------------------------------------------------------------

test('对账：缓存和 store 的用户消息一致 → 不动（返回 null，保持数组同一性）', () => {
  assert.equal(reconcileWithStore(N_STORE, N_STORE), null);
  /* 助手消息 id 不同（流式时的临时 id vs 落盘的 id）不算不一致 */
  const live = N_STORE.map((m) => (m.id === 'n_a3' ? { ...m, id: 'msg_123' } : m));
  assert.equal(reconcileWithStore(live, N_STORE), null);
});

test('对账：缓存被整份换成别的会话的历史 → 以 store 为准重载', () => {
  const polluted = CDE_STORE.slice(0, 39);
  assert.equal(storeMismatch(polluted, N_STORE), true);
  assert.deepEqual(reconcileWithStore(polluted, N_STORE)!.map((m) => m.id), N_STORE.map((m) => m.id));
});

test('对账：别的会话的历史混在自己的消息前面（自己的都在）→ 也认出来，丢掉别人的', () => {
  const polluted = [...CDE_STORE, ...N_STORE];
  const healed = reconcileWithStore(polluted, N_STORE)!;
  assert.deepEqual(healed.map((m) => m.id), N_STORE.map((m) => m.id));
  /* 同 id 沿用界面那份对象 */
  assert.equal(healed[0], polluted[CDE_STORE.length]);
});

test('对账：store 里有、缓存里没有的用户消息（缓存旧了）→ 重载', () => {
  const stale = N_STORE.slice(0, 4);
  assert.deepEqual(reconcileWithStore(stale, N_STORE)!.map((m) => m.id), N_STORE.map((m) => m.id));
});

test('对账：只在界面上的消息不算不一致 —— 追加指令、这条会话登记过的（本地回显、发送失败没落盘的）', () => {
  const withSteer = [...N_STORE.slice(0, 5), { ...u('steer_x', 5.5), steer: 'consumed' as const }, N_STORE[5]];
  assert.equal(storeMismatch(withSteer, N_STORE), false);
  const echo = [...N_STORE.slice(0, 2), u('user_usage', 2.1), a('msg_usage', 2.2), ...N_STORE.slice(2)];
  assert.equal(storeMismatch(echo, N_STORE, new Set(['user_usage', 'msg_usage'])), false);
  assert.equal(storeMismatch(echo, N_STORE), true, '没登记成 localOnly 的中间那条就是对不上');
  const failedTail = [...N_STORE, u('user_failed', 7), a('err_1', 8)];
  assert.equal(storeMismatch(failedTail, N_STORE, new Set(['user_failed', 'err_1'])), false);
  assert.equal(storeMismatch(failedTail, N_STORE), true, '没登记的就算时间更晚也不豁免');
  /* store 是空的（新会话第一条发送失败、还没落盘）：登记过的那条照样留着 */
  assert.equal(storeMismatch([u('user_first', 1)], [], new Set(['user_first'])), false);
});

test('对账：比 store 最新还晚的外来消息混在自己的后面 → 认出来，丢掉', () => {
  const later = CDE_STORE.slice(0, 6).map((m, i) => ({ ...m, timestamp: 100 + i }));
  const polluted = [...N_STORE, ...later];
  assert.equal(storeMismatch(polluted, N_STORE), true);
  assert.deepEqual(reconcileWithStore(polluted, N_STORE)!.map((m) => m.id), N_STORE.map((m) => m.id));
});

test('对账：缓存整份被时间更晚的外来消息换掉 → 重载后一条外来的都不留', () => {
  const later = CDE_STORE.slice(0, 10).map((m, i) => ({ ...m, timestamp: 100 + i }));
  assert.deepEqual(reconcileWithStore(later, N_STORE)!.map((m) => m.id), N_STORE.map((m) => m.id));
});

test('对账：store 是空的（新会话还没落盘）而缓存全是别人的 → 清成空的', () => {
  assert.equal(storeMismatch(CDE_STORE, []), true);
  assert.deepEqual(reconcileWithStore(CDE_STORE, []), []);
  /* 混着这条会话自己登记过的那条：只留它 */
  assert.deepEqual(reconcileWithStore([...CDE_STORE, u('user_first', 1)], [], new Set(['user_first']))!.map((m) => m.id), ['user_first']);
});

test('对账：助手消息 —— 流式分段、id 和落盘的不同、💭 思考段都算对得上', () => {
  const stored = [u('n_u1', 1), a('a_disk', 2, '先看一下文件。\n\n改好了，测试也过了。')];
  const live = [u('n_u1', 1), { ...a('think_1', 1.1), content: '💭 想一想' }, a('msg_1', 1.2, '先看一下文件。'), a('msg_2', 1.5, '改好了，测试也过了。')];
  assert.equal(storeMismatch(live, stored), false);
  assert.equal(reconcileWithStore(live, stored), null);
});

test('对账：缓存里缺了一轮的回复 / 只有回复的前半截（不同的流式 id、同 id 截短）→ 以 store 为准补全', () => {
  const stored = [u('n_u1', 1), a('a_disk', 2, '先看一下文件。\n\n改好了，测试也过了。')];
  /* 缺了整条回复 */
  assert.equal(storeMismatch([u('n_u1', 1)], stored), true);
  assert.deepEqual(reconcileWithStore([u('n_u1', 1)], stored)!.map((m) => m.content), ['n_u1', '先看一下文件。\n\n改好了，测试也过了。']);
  /* 只有第一段（流式 id 不同） */
  const half = [u('n_u1', 1), a('msg_1', 1.2, '先看一下文件。')];
  assert.equal(storeMismatch(half, stored), true);
  assert.deepEqual(reconcileWithStore(half, stored)!.map((m) => m.id), ['n_u1', 'a_disk']);
  /* 同 id 但正文被截短 */
  assert.equal(storeMismatch([u('n_u1', 1), a('a_disk', 2, '先看一下')], stored), true);
  const truncated = [u('n_u1', 1), a('a_disk', 2, '先看一下')];
  const healed = reconcileWithStore(truncated, stored)!;
  assert.equal(healed[1].content, '先看一下文件。\n\n改好了，测试也过了。', '同 id 截短时用 store 的正文，不沿用残缺的那份');
  assert.equal(healed[0], truncated[0], '正文一致的照样沿用界面那份对象');
  assert.equal(reconcileWithStore(healed, stored), null, '补全后再对账就对得上了');
});

test('对账：store 里单独成条的追加指令把一轮分成两段，缓存里是一轮 —— 照样对得上', () => {
  const stored = [u('n_u1', 1), a('a1', 2, '第一段'), u('steer_1', 3, '再加一点'), a('a2', 4, '第二段')];
  const live = [u('n_u1', 1), a('msg_1', 1.5, '第一段'), { ...u('steer_1', 3, '再加一点'), steer: 'consumed' as const }, a('msg_2', 3.5, '第二段')];
  assert.equal(storeMismatch(live, stored), false);
});

test('对账：自己的完整消息后面混进一条外来的助手回复 → 认出来，丢掉', () => {
  const polluted = [...N_STORE, a('foreign_a', 7, '这是 CDE 那条会话的回复')];
  assert.equal(storeMismatch(polluted, N_STORE), true);
  assert.deepEqual(reconcileWithStore(polluted, N_STORE)!.map((m) => m.id), N_STORE.map((m) => m.id));
  /* 正文对得上那一轮、只是 id 不同的照样不算（和上一条对照） */
  assert.equal(storeMismatch([...N_STORE.slice(0, 5), a('msg_x', 6, 'n_a3')], N_STORE), false);
});

test('对账：外来的助手回复挂在这条会话没有的用户消息之后、或前面根本没有用户消息 → 不一致', () => {
  assert.equal(storeMismatch([a('foreign_a', 1, '别人的回复')], []), true);
  assert.deepEqual(reconcileWithStore([a('foreign_a', 1, '别人的回复')], []), []);
  /* 登记过的（本地回显 / 报错气泡）照样留 */
  assert.equal(storeMismatch([a('err_1', 1, '⚠️ 发送失败')], [], new Set(['err_1'])), false);
});

test('对账：重载时保留只在界面上的那几条，按时间插回原位；别的会话的丢掉', () => {
  const cached = [...CDE_STORE.slice(0, 4), N_STORE[0], N_STORE[1], u('user_usage', 2.1), a('msg_usage', 2.2), ...N_STORE.slice(2), u('user_failed', 7)];
  const healed = reconcileWithStore(cached, N_STORE, new Set(['user_usage', 'msg_usage', 'user_failed']))!;
  assert.deepEqual(healed.map((m) => m.id), ['n_u1', 'n_a1', 'user_usage', 'msg_usage', 'n_u2', 'n_a2', 'n_u3', 'n_a3', 'user_failed']);
});

test('对账：复制出来的会话带过来的历史（登记成 localOnly）不会被当成别人的丢掉', () => {
  const copied = CDE_STORE.slice(0, 6);
  const own = [u('d_u1', 10), a('d_a1', 11)];
  const local = new Set(copied.map((m) => m.id));
  assert.equal(storeMismatch([...copied, ...own], own, local), false);
  /* 缓存旧了要重载时，复制来的那段也留着、排在前面 */
  assert.deepEqual(reconcileWithStore(copied, own, local)!.map((m) => m.id), [...copied.map((m) => m.id), 'd_u1', 'd_a1']);
});

// ---------------------------------------------------------------------------
// 2. 事件交错：照 hook 写的最小状态模型
// ---------------------------------------------------------------------------

/**
 * 照 useAcp 的语义：
 * - `setMessages` 在**调用时**把归属记成当前焦点（`setMessagesOwner(currentSessionRef.current)`）；
 * - 缓存 effect：`currentSessionId && messagesOwner === currentSessionId && messages.length > 0` 才写缓存；
 * - `mutateSessionMessages(sid, f)`：sid 是焦点 → setMessages 并同步写缓存；否则只写 sid 的缓存；
 * - `switchSession(sid)`：焦点 = sid，先 `setMessages(cache[sid] || [])`；缓存空 → 读盘；
 *   非空且这条静止 → 读盘对账（`reconcileWithStore`）。
 */
function makeView(disk: Record<string, M[]>, opts: { reconcile: boolean }) {
  const cache = new Map<string, M[]>();
  let focus: string | null = null;
  let messages: M[] = [];
  let owner: string | null = null;
  const streaming = new Set<string>();
  const effect = () => { if (focus && owner === focus && messages.length > 0) cache.set(focus, messages); };
  const setMessages = (next: M[]) => { owner = focus; messages = next; effect(); };
  const mutate = (sid: string, f: (m: M[]) => M[]) => {
    if (sid === focus) { const next = f(messages); cache.set(sid, next); setMessages(next); }
    else cache.set(sid, f(cache.get(sid) || []));
  };
  const switchSession = (sid: string) => {
    focus = sid;
    const cached = cache.get(sid);
    setMessages(cached || []);
    const stored = (disk[sid] || []).slice();
    if (!cached || !cached.length) {
      cache.set(sid, stored);
      if (focus === sid) setMessages(stored);
    } else if (opts.reconcile && !streaming.has(sid)) {
      const healed = reconcileWithStore(cached, stored);
      if (healed) { cache.set(sid, healed); if (focus === sid) setMessages(healed); }
    }
  };
  return {
    cache, streaming, switchSession, mutate, setMessages,
    get focus() { return focus; },
    shown: () => messages.map((m) => m.id),
    /** 主进程推来的流式 chunk：按事件里的 sid 落地（onUpdate 那段） */
    chunk: (sid: string, m: M) => {
      if (sid === focus && streaming.has(sid)) setMessages([...messages, m]);
      else cache.set(sid, [...(cache.get(sid) || []), m]);
    },
  };
}

/**
 * 那次的交错：N 在前台；CDE 在后台跑完一轮（chunk 进它自己的缓存）；
 * 旧执行器迟到的 disconnected → 断线恢复 → 对 CDE 重跑 → 截短 CDE 的视图（这一步是新旧写法的区别）。
 */
function replayIncident(view: ReturnType<typeof makeView>, legacyRerunWrite: boolean) {
  view.switchSession('CDE');
  view.switchSession('N');
  assert.deepEqual(view.shown(), N_STORE.map((m) => m.id));
  /* CDE 后台一轮 */
  view.streaming.add('CDE');
  view.chunk('CDE', u('c_new', 0));
  view.chunk('CDE', a('c_new_a', 0.5));
  view.streaming.delete('CDE');
  /* recoverInterruptedTurn(CDE) → rerunFromMessage(…, 'CDE') */
  const current = view.cache.get('CDE')!;
  const retained = current.slice(0, current.length - 2);
  if (legacyRerunWrite) {
    /* 9f68aec：messagesCacheRef.current.set(sid, retained); setMessages(retained); */
    view.cache.set('CDE', retained);
    view.setMessages(retained);
  } else {
    /* 74a459a：mutateSessionMessages(sid, () => retained) */
    view.mutate('CDE', () => retained);
  }
}

test('交错：后台会话跑完一轮并断线重跑时，前台新会话的界面和缓存只有它自己的消息；切走切回仍然对', () => {
  const view = makeView({ N: N_STORE, CDE: CDE_STORE }, { reconcile: true });
  replayIncident(view, false);
  assert.equal(view.focus, 'N');
  assert.deepEqual(view.shown(), N_STORE.map((m) => m.id));
  assert.deepEqual(view.cache.get('N')!.map((m) => m.id), N_STORE.map((m) => m.id));
  /* CDE 截短后的那份进了 CDE 自己的缓存 */
  assert.deepEqual(view.cache.get('CDE')!.map((m) => m.id), CDE_STORE.map((m) => m.id));
  view.switchSession('CDE');
  view.switchSession('N');
  assert.deepEqual(view.shown(), N_STORE.map((m) => m.id));
});

test('交错（复现 9f68aec）：旧写法把 CDE 的历史写进 N 的缓存；没有对账时切走切回还在', () => {
  const view = makeView({ N: N_STORE, CDE: CDE_STORE }, { reconcile: false });
  replayIncident(view, true);
  assert.ok(view.shown().includes('c_u0'), '前台 N 的界面被换成了 CDE 的历史');
  assert.ok(view.cache.get('N')!.some((m) => m.id === 'c_u0'), '而且污染进了 N 的缓存格子');
  view.switchSession('CDE');
  view.switchSession('N');
  assert.ok(view.shown().includes('c_u0'), '切走切回还在 —— 用户看到的就是这个');
});

test('交错：就算缓存已经被污染，切到这条会话时和 store 对账，自愈成它自己的消息', () => {
  const view = makeView({ N: N_STORE, CDE: CDE_STORE }, { reconcile: true });
  replayIncident(view, true);
  assert.ok(view.cache.get('N')!.some((m) => m.id === 'c_u0'));
  view.switchSession('CDE');
  view.switchSession('N');
  assert.deepEqual(view.shown(), N_STORE.map((m) => m.id));
  assert.deepEqual(view.cache.get('N')!.map((m) => m.id), N_STORE.map((m) => m.id));
  /* 再切一次也稳定（对得上就不动） */
  const before = view.cache.get('N');
  view.switchSession('CDE');
  view.switchSession('N');
  assert.equal(view.cache.get('N'), before);
});

test('交错：新会话一条都还没落盘时缓存被别人的历史污染 → 切走切回清回空的', () => {
  const view = makeView({ N: [], CDE: CDE_STORE }, { reconcile: true });
  view.switchSession('CDE');
  view.switchSession('N');
  /* 9f68aec 的写法：CDE 截短后的历史写进了焦点 N */
  view.setMessages(CDE_STORE.slice(0, 30));
  assert.ok(view.cache.get('N')!.length > 0, '污染进了 N 的缓存');
  view.switchSession('CDE');
  view.switchSession('N');
  assert.deepEqual(view.shown(), []);
  assert.deepEqual(view.cache.get('N'), []);
});

test('交错：只混进一条外来的助手回复（自己的消息都在 / store 为空）→ 切走切回清掉', () => {
  for (const own of [N_STORE, [] as M[]]) {
    const view = makeView({ N: own, CDE: CDE_STORE }, { reconcile: true });
    view.switchSession('CDE');
    view.switchSession('N');
    view.setMessages([...own, a('foreign_a', 7, 'CDE 的回复')]);
    assert.ok(view.cache.get('N')!.some((m) => m.id === 'foreign_a'));
    view.switchSession('CDE');
    view.switchSession('N');
    assert.deepEqual(view.shown(), own.map((m) => m.id));
    assert.deepEqual(view.cache.get('N')!.map((m) => m.id), own.map((m) => m.id));
  }
});

test('交错：缓存里缺了 / 截断了回复（流式尾巴没收到）→ 切走切回恢复成盘上的完整记录', () => {
  const full = [u('n_u1', 1), a('a_disk', 2, '第一段。\n\n第二段，完整的结尾。')];
  for (const partial of [[u('n_u1', 1)], [u('n_u1', 1), a('msg_9', 1.5, '第一段。')], [u('n_u1', 1), a('a_disk', 2, '第一段。')]]) {
    const view = makeView({ N: full, CDE: CDE_STORE }, { reconcile: true });
    view.switchSession('N');
    view.setMessages(partial);
    view.switchSession('CDE');
    view.switchSession('N');
    assert.deepEqual(view.shown(), ['n_u1', 'a_disk']);
    assert.equal(view.cache.get('N')![1].content, '第一段。\n\n第二段，完整的结尾。');
  }
});

test('交错：正在流式的会话不对账（盘上还没有这一轮，不能把正在出的回复冲掉）', () => {
  const view = makeView({ N: N_STORE, CDE: CDE_STORE }, { reconcile: true });
  view.switchSession('N');
  view.streaming.add('N');
  view.mutate('N', (m) => [...m, u('n_u4', 7)]);
  view.switchSession('CDE');
  /* 盘上还没有 n_u4 —— 但它比盘上最新的晚，本来也不算不一致；这里再加一条更早的外来消息，确认流式时整段跳过 */
  view.cache.set('N', [u('c_u0', -100), ...view.cache.get('N')!]);
  view.switchSession('N');
  assert.ok(view.shown().includes('c_u0'), '流式中不动缓存');
  assert.ok(view.shown().includes('n_u4'));
});

// ---------------------------------------------------------------------------
// 2b. 事件交错：带上自动重发（recoverInterruptedTurn → rerunFromMessage）的真实顺序
// ---------------------------------------------------------------------------

/**
 * 照 hook 的异步顺序：
 * - `recover(sid, msgs)`：在**这一刻的列表**上用真的 `findRecoveryTarget` 捕获目标和正文，起一个异步任务；
 *   任务先等 main 的 peek（这里是一个由测试放行的 promise），再（新写法）`recoveryTargetIsOwn` 读盘对账确认归属，
 *   然后 `rerunFromMessage`：在缓存里按 id 找目标、找不到退回最后一条用户消息，截短 → rewriteTranscript
 *   （带主进程「一条都不认识就拒绝」的守卫）→ 发送捕获的正文。
 * - `switchSession(sid)`：新写法先读盘对账、再拿对过账的那份 recover；旧写法先拿缓存 recover、再对账。
 * - 每次读盘都挂起，由测试决定放行顺序（读盘早于 / 晚于恢复检查）。
 */
function makeRecoveryView(disk: Record<string, M[]>, opts: { fixed: boolean }) {
  const cache = new Map<string, M[]>();
  const sent: { sid: string; text: string }[] = [];
  const rewrites: { sid: string; ids: string[] }[] = [];
  const pending: { label: string; resolve: () => void }[] = [];
  const gate = (label: string) => new Promise<void>((resolve) => pending.push({ label, resolve }));
  const tasks: Promise<void>[] = [];
  const readDisk = async (sid: string, label: string) => { await gate(label); return (disk[sid] || []).slice(); };
  const reconcileFromStore = async (sid: string, label: string) => {
    const before = cache.get(sid);
    const stored = await readDisk(sid, label);
    if (cache.get(sid) !== before) return null;
    const healed = reconcileWithStore(before || [], stored);
    if (healed) cache.set(sid, healed);
    return { messages: healed || before || [], storedIds: new Set(stored.map((m) => m.id)) };
  };
  const rerun = (sid: string, targetId: string, text: string) => {
    const current = cache.get(sid) || [];
    let i = current.findIndex((m) => m.id === targetId);
    if (i < 0) for (let j = current.length - 1; j >= 0; j--) if (current[j].role === 'user') { i = j; break; }
    if (i < 0) return;
    const retained = current.slice(0, i);
    const have = new Set((disk[sid] || []).map((m) => m.id));
    if (!(disk[sid]?.length && retained.length && !retained.some((m) => have.has(m.id)))) {
      disk[sid] = retained.slice();
      rewrites.push({ sid, ids: retained.map((m) => m.id) });
    }
    cache.set(sid, retained);
    sent.push({ sid, text });
  };
  const recover = (sid: string, msgs: M[], label: string) => {
    const found = findRecoveryTarget(msgs as any);
    if (found.kind !== 'unanswered') return;
    const target = msgs[found.base];
    const text = target.content;
    tasks.push((async () => {
      await gate(`${label}:peek`);
      if (opts.fixed) {
        const v = await reconcileFromStore(sid, `${label}:verify`);
        if (!v || !v.messages.some((m) => m.id === target.id) || !v.storedIds.has(target.id)) return;
      }
      rerun(sid, target.id, text);
    })());
  };
  const switchSession = async (sid: string) => {
    const cached = cache.get(sid);
    if (!opts.fixed && cached?.length) recover(sid, cached, 'switch');
    const v = await reconcileFromStore(sid, 'switch:read');
    if (opts.fixed && v) recover(sid, v.messages, 'switch');
  };
  /** 放行名字以 label 开头的那个挂起点，等微任务跑完 */
  const release = async (label: string) => {
    for (let k = 0; k < 20; k++) {
      const i = pending.findIndex((p) => p.label === label);
      if (i >= 0) { pending.splice(i, 1)[0].resolve(); break; }
      await new Promise((r) => setImmediate(r));
    }
    for (let k = 0; k < 10; k++) await new Promise((r) => setImmediate(r));
  };
  const releaseAll = async () => {
    for (let k = 0; k < 50 && pending.length; k++) await release(pending[0].label);
    await Promise.all(tasks);
  };
  return { cache, sent, rewrites, disk, recover, switchSession, release, releaseAll, pending };
}

/* 污染：N 自己的 6 条后面接上 CDE 的历史，末尾是 CDE 一条没答的提问 */
const FOREIGN_Q = u('c_q', 50, 'CDE 那条会话没答的提问');
const pollutedN = (): M[] => [...N_STORE, ...CDE_STORE.slice(0, 6), FOREIGN_Q];

test('交错（复现）：旧顺序 —— 先在污染缓存上查恢复，外来的提问被当成这条会话的重发，污染历史还写进了干净的 transcript', async () => {
  const disk = { N: N_STORE.slice(), CDE: CDE_STORE.slice() };
  const view = makeRecoveryView(disk, { fixed: false });
  view.cache.set('N', pollutedN());
  const sw = view.switchSession('N');
  /* 恢复检查先返回，读盘后返回 */
  await view.release('switch:peek');
  await view.release('switch:read');
  await sw; await view.releaseAll();
  assert.deepEqual(view.sent, [{ sid: 'N', text: 'CDE 那条会话没答的提问' }]);
  assert.ok(view.disk.N.some((m) => m.id === 'c_u0'), '干净的 transcript 被写进了 CDE 的消息');
});

test('交错：污染历史末尾是外来的未答提问，读盘早于恢复检查 —— 不发外来正文，不重写 transcript', async () => {
  const disk = { N: N_STORE.slice(), CDE: CDE_STORE.slice() };
  const view = makeRecoveryView(disk, { fixed: true });
  view.cache.set('N', pollutedN());
  const sw = view.switchSession('N');
  await view.release('switch:read');
  await sw; await view.releaseAll();
  assert.deepEqual(view.sent, []);
  assert.deepEqual(view.rewrites, []);
  assert.deepEqual(view.disk.N.map((m) => m.id), N_STORE.map((m) => m.id));
  assert.deepEqual(view.cache.get('N')!.map((m) => m.id), N_STORE.map((m) => m.id));
});

test('交错：恢复已经在污染缓存上捕获了外来提问（例如断线恢复），恢复检查先于读盘返回 —— 重发前确认归属，不发也不重写', async () => {
  for (const order of [['r:peek', 'r:verify', 'switch:read'], ['r:peek', 'switch:read', 'r:verify'], ['switch:read', 'r:peek', 'r:verify']]) {
    const disk = { N: N_STORE.slice(), CDE: CDE_STORE.slice() };
    const view = makeRecoveryView(disk, { fixed: true });
    view.cache.set('N', pollutedN());
    view.recover('N', view.cache.get('N')!, 'r');   // 别的入口在对账前起的恢复任务
    const sw = view.switchSession('N');
    for (const label of order) await view.release(label);
    await sw; await view.releaseAll();
    assert.deepEqual(view.sent, [], `顺序 ${order.join(' → ')}：发出了外来正文`);
    assert.deepEqual(view.rewrites, [], `顺序 ${order.join(' → ')}：重写了 transcript`);
    assert.deepEqual(view.disk.N.map((m) => m.id), N_STORE.map((m) => m.id));
  }
});

test('交错：这条会话自己没答的提问照旧自动重发，截短只截它自己的', async () => {
  const own = [...N_STORE, u('n_q', 7, 'N 自己没答的提问')];
  const disk = { N: own.slice(), CDE: CDE_STORE.slice() };
  const view = makeRecoveryView(disk, { fixed: true });
  view.cache.set('N', own.slice());
  const sw = view.switchSession('N');
  await view.release('switch:read');
  await sw; await view.releaseAll();
  assert.deepEqual(view.sent, [{ sid: 'N', text: 'N 自己没答的提问' }]);
  assert.deepEqual(view.disk.N.map((m) => m.id), N_STORE.map((m) => m.id));
});

// ---------------------------------------------------------------------------
// 3. hook 里的接线
// ---------------------------------------------------------------------------

const H = fs.readFileSync(new URL('../src/renderer/hooks/useAcp.ts', import.meta.url), 'utf8');

test('接线：switchSession 有缓存时也读盘对账，只在这条会话静止、读盘期间缓存没变时才换', () => {
  const at = H.indexOf('const switchSession = useCallback(');
  assert.ok(at >= 0);
  const body = H.slice(at, H.indexOf('// Attach the executor on switch', at));
  assert.match(body, /!streamingIdsRef\.current\.has\(sessionId\)/);
  /* 正在建的会话也对账（不再整段跳过），但不查自动重发 —— 见上面「新会话第一次打开」那几条 */
  assert.match(body, /const creating = creatingRef\.current\.has\(sessionId\);/);
  const gate = body.slice(body.indexOf('const reconcileFirst'), body.indexOf('const reconcileFirst') + 300);
  assert.doesNotMatch(gate, /creatingRef/);
  assert.match(body, /pendingSteersRef\.current\.get\(sessionId\)/);
  /* 静止的会话：先对账，再只拿对过账的那份查自动重发（不在对账前对缓存查）；正在建的一律不查 */
  assert.match(body, /if \(cached && cached\.length > 0 && !reconcileFirst && !creating\) recoverInterruptedTurn\(sessionId, cached/);
  assert.match(body, /\} else if \(reconcileFirst\) \{[\s\S]*?const verified = await reconcileCacheFromStore\(sessionId\);\s*if \(verified && !creating\) recoverInterruptedTurn\(sessionId, verified\.messages, \{ assumeCurrent: true \}\);/);
  const helper = H.slice(H.indexOf('const reconcileCacheFromStore = async'), H.indexOf('const recoverInterruptedTurn = ('));
  assert.match(helper, /reconcileWithStore\(/);
  /* 读盘回来后缓存还是对账时那一份、而且没在跑，才换（期间有新消息就不碰） */
  assert.match(helper, /if \(messagesCacheRef\.current\.get\(sid\) !== before \|\| streamingIdsRef\.current\.has\(sid\)\) return null;/);
  assert.match(helper, /if \(currentSessionRef\.current === sid\) setMessages\(healed\)/);
  /* 读到空数组也要对账（新会话还没落盘时被污染） */
  assert.doesNotMatch(helper, /transcript\.length > 0/);
});

test('接线：自动重发前先和 store 对账，问题不是这条会话的就不发（发生在截短 / rewriteTranscript 之前）', () => {
  const rec = H.slice(H.indexOf('const recoverInterruptedTurn = ('), H.indexOf('const rerunFromMessageRef'));
  const guard = rec.indexOf('if (!(await recoveryTargetIsOwn(sid, target.id))) {');
  assert.ok(guard > 0, '重发前没有确认归属');
  assert.ok(guard < rec.indexOf('rerunFromMessageRef.current?.('), '确认必须在重发之前');
  const own = H.slice(H.indexOf('const recoveryTargetIsOwn = async'), H.indexOf('const recoverInterruptedTurn = ('));
  assert.match(own, /await reconcileCacheFromStore\(sid\)/);
  assert.match(own, /verified\.storedIds\.has\(targetId\) \|\| !!localOnlyIdsRef\.current\.get\(sid\)\?\.has\(targetId\)/);
});

test('接线：只在界面上的消息登记成 localOnly（本地回显、复制会话带过来的历史），pending → 真 id 时跟着搬', () => {
  assert.match(H, /const localOnlyIdsRef = useRef<Map<string, Set<string>>>\(new Map\(\)\);/);
  const send = H.slice(H.indexOf('const sendMessage = useCallback('), H.indexOf('const sendMessage = useCallback(') + 20000);
  assert.match(send, /if \(localResponse\) \{[\s\S]{0,400}markLocalOnly\(sid, \[userMessageId, response\.id\]\)/);
  assert.match(send, /moveLocalOnly\(prevId, sid\)/);
  /* 发出的那条用户消息、发送失败的报错气泡：为这条会话写的，没落盘也认 */
  assert.match(send, /if \(sid\) markLocalOnly\(sid, \[userMessageId\]\);\s*if \(sid\) mutateSessionMessages\(sid, \(current\) => \[\.\.\.current, optimisticUserMessage\]\)/);
  assert.match(send, /markLocalOnly\(sid!, \[`err_\$\{errTs\}`\]\);\s*mutateSessionMessages\(sid!, \(prev\) => \[\s*\.\.\.prev,\s*\{ id: `err_\$\{errTs\}`/);
  const queued = H.slice(H.indexOf('const sendQueuedMessage = useCallback('), H.indexOf('const sendQueuedMessage = useCallback(') + 6000);
  assert.match(queued, /if \(!options\?\.mergeIntoMessageId\) markLocalOnly\(sessionId, \[userMessageId\]\)/);
  const dup = H.slice(H.indexOf('const newId = `pending_dup_'), H.indexOf('const newId = `pending_dup_') + 3000);
  assert.match(dup, /markLocalOnly\(newId, copied\.map\(\(m\) => m\.id\)\)/);
  assert.match(dup, /markLocalOnly\(newId, restored\.map\(\(m\) => m\.id\)\)/);
});
