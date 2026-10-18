import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createNoticeHub, type RawSessionNotice, type SessionNotice } from '../src/renderer/sessionNoticeHub.ts';

/**
 * 状态行提示的会话级缓存（`useSessionNotice` 用）。
 * 守的是：重连提示显示「×3」后切到别的会话再切回来，次数还在 —— 缓存里存的是**合并后**的那句，不是最后到的原句。
 */
function fakeIpc() {
  let cb: ((d: RawSessionNotice) => void) | null = null;
  let attached = 0;
  return {
    attach: (fn: (d: RawSessionNotice) => void) => { cb = fn; attached += 1; return () => { cb = null; }; },
    emit: (d: RawSessionNotice) => cb?.(d),
    get attached() { return attached; },
    get live() { return cb !== null; },
  };
}
const reconnect = (n: number, sessionId = 'A'): RawSessionNotice => ({
  sessionId, ts: n, sticky: true, group: 'local-tools-reconnect', text: `⚠️ 本机工具连接中断，正在重连（第 ${n} 次）`,
});

describe('状态行提示：会话级缓存存合并后的那句', () => {
  test('同类 sticky 连来三次 → 缓存里是 ×3（最新那句的文字）；切到别的会话再回来还是 ×3', () => {
    const ipc = fakeIpc();
    const hub = createNoticeHub(ipc.attach);
    const off = hub.subscribe(() => {});
    ipc.emit(reconnect(1)); ipc.emit(reconnect(2)); ipc.emit(reconnect(3));
    /* 别的会话来的提示不动 A 的缓存 */
    ipc.emit({ sessionId: 'B', ts: 9, text: '⏳ 正在推送' });
    const back = hub.stickyFor('A');
    assert.equal(back?.count, 3);
    assert.match(back!.text, /第 3 次/);
    assert.equal(hub.stickyFor('B'), undefined);
    off();
  });

  test('分屏两格都订阅：同一句只记一次（不会 ×2 算成 ×4）', () => {
    const ipc = fakeIpc();
    const hub = createNoticeHub(ipc.attach);
    const seen: Array<[string, SessionNotice]> = [];
    const off1 = hub.subscribe((sid, n) => seen.push([sid, n]));
    const off2 = hub.subscribe((sid, n) => seen.push([sid, n]));
    assert.equal(ipc.attached, 1, '只挂一个 IPC 监听');
    ipc.emit(reconnect(1)); ipc.emit(reconnect(2));
    assert.equal(hub.stickyFor('A')?.count, 2);
    assert.equal(seen.length, 4, '两格各收到两次');
    off1(); off2();
    assert.equal(ipc.live, false, '都退订后摘掉 IPC 监听');
  });

  test('这条会话来了一句不是 sticky 的 → 缓存清掉；关掉（clearSticky）也清掉', () => {
    const ipc = fakeIpc();
    const hub = createNoticeHub(ipc.attach);
    const off = hub.subscribe(() => {});
    ipc.emit(reconnect(1)); ipc.emit(reconnect(2));
    ipc.emit({ sessionId: 'A', ts: 5, text: '✅ 本机工具已重新连上' });
    assert.equal(hub.stickyFor('A'), undefined);
    ipc.emit(reconnect(3));
    assert.equal(hub.stickyFor('A')?.count, undefined, '清掉之后重新从 1 数');
    hub.clearSticky('A');
    assert.equal(hub.stickyFor('A'), undefined);
    off();
  });

  test('渲染端自己说的话（ingest）和主进程来的走同一条路', () => {
    const ipc = fakeIpc();
    const hub = createNoticeHub(ipc.attach);
    const seen: string[] = [];
    const off = hub.subscribe((sid, n) => seen.push(`${sid}:${n.text}`));
    hub.ingest({ sessionId: 'A', ts: 1, text: '这一轮已经结束' });
    assert.deepEqual(seen, ['A:这一轮已经结束']);
    off();
  });
});
