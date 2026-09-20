import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { RemoteSyncStatus } from '../App';

/**
 * **每条远程会话的同步状态** —— `docs/DESIGN_remote_sessions.md`。
 *
 * 为什么必须显出来：远程会话里"本地文件是不是最新的"不再是显然的事。`stale`（远端有改动没取回来）
 * 时如果界面什么都不说，人就会对着上一版 review，而那些建议再被送回模型就变成一串谁都对不上的修改。
 * 所以它和"有东西在跑"一样属于**常驻状态**，不是一次性的提示。
 *
 * 用 context 而不是把 prop 一层层传下去：会话行长在嵌套的分组里、有多个渲染点，
 * 而这是一份全局的、按 sessionId 索引的状态 —— 每加一个渲染点都要补一次 prop 的东西迟早会漏一个，
 * 漏掉的那个就是"看起来一切正常，其实本地是旧的"。
 */
const RemoteSyncContext = createContext<{
  map: Record<string, RemoteSyncStatus>;
  ask(sessionId: string): void;
}>({ map: {}, ask: () => {} });

export const RemoteSyncProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [map, setMap] = useState<Record<string, RemoteSyncStatus>>({});
  const asked = useRef(new Set<string>());

  useEffect(() => {
    const off = (window as any).kiroApi?.onRemoteSync?.((s: RemoteSyncStatus) => {
      if (!s?.sessionId) return;
      setMap((prev) => ({ ...prev, [s.sessionId]: s }));
    });
    return () => { try { off?.(); } catch { /* 卸载时 preload 可能已经没了 */ } };
  }, []);

  const value = useMemo(() => ({
    map,
    /**
     * 挂载时主动问一次 —— 只订阅事件会丢掉挂载之前发生的那些
     * （例如启动后第一轮就同步失败，界面上会一片安静）。每条会话只问一次。
     */
    ask: (sessionId: string): void => {
      if (!sessionId || asked.current.has(sessionId)) return;
      asked.current.add(sessionId);
      const q = (window as any).kiroApi?.remoteStatus;
      if (!q) return;
      void q(sessionId).then((s: RemoteSyncStatus | null) => {
        if (s?.sessionId) setMap((prev) => (prev[sessionId] ? prev : { ...prev, [sessionId]: s }));
      }).catch(() => {});
    },
  }), [map]);

  return React.createElement(RemoteSyncContext.Provider, { value }, children);
};

/** 这条会话此刻的同步状态（本地会话永远是 `undefined`）。 */
export function useRemoteSyncFor(sessionId: string | undefined, isRemote: boolean): RemoteSyncStatus | undefined {
  const { map, ask } = useContext(RemoteSyncContext);
  useEffect(() => {
    if (isRemote && sessionId) ask(sessionId);
  }, [sessionId, isRemote, ask]);
  return sessionId ? map[sessionId] : undefined;
}

/** 徽标上那几个字。`idle` 不加字 —— 一切正常的时候不该有东西在动。 */
export function syncBadgeSuffix(state: RemoteSyncStatus['state'] | undefined): string {
  switch (state) {
    case 'pushing': return ' ↑';
    case 'pulling': return ' ↓';
    case 'stale': return ' ⚠️';
    case 'conflict': return ' ⚠️';
    default: return '';
  }
}

/** 鼠标停上去说清这一刻在发生什么、以及本地这份能不能信。 */
export function syncBadgeTitle(hostLabel: string, s?: RemoteSyncStatus): string {
  const head = `这条会话的 kiro-cli 跑在 ${hostLabel} 上；文件仍然存在本地（每一轮前后自动同步）`;
  switch (s?.state) {
    case 'pushing': return `${head}\n正在把本地推上去…`;
    case 'pulling': return `${head}\n正在把远端的改动取回来…`;
    case 'stale': return `${head}\n⚠️ 远端有改动没取回来（${s.error || '同步失败'}）—— `
      + '本地这份不是最新的，先别 review。连接恢复后会自动再试。';
    case 'conflict': return `${head}\n⚠️ 这些文件你和远端都改过，本地那份没有动，远端那份在 .remote 里：\n`
      + (s.conflicts || []).join('\n');
    default: return head;
  }
}
