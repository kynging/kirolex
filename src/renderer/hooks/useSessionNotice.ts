import { useEffect, useState } from 'react';
import { mergeNotice } from '../noticeMerge.ts';
import { createNoticeHub, type SessionNotice } from '../sessionNoticeHub.ts';

/**
 * **KiroLex 自己对你说的那句话** ——「你自己写的那个提示什么的不要中断弄回对话框」。
 *
 * 这些提示（⏳ 正在推/拉、⚠️ 本地不是最新的、🔀 换了机器）以前是作为 `kirolex` 消息写进
 * transcript 的。三个代价：打断对话的读法；把 transcript 撑大（远程会话每轮都要推它）；
 * 以及"KiroLex 说的话不许发给模型"那条规则要一直靠过滤兜着 —— 那个坑今天刚踩过一次。
 *
 * 所以改成**不进对话**：只在输入框上方显示一条，自己会消失。
 * · 进度类（⏳）短一点就走（`FADE_MS`）—— 它下一条马上就来。
 * · 警告类（⚠️）留久一点：它影响你接下来的判断（"本地不是最新的，先别 review"）。
 */
const FADE_MS = 12_000;
const WARN_MS = 45_000;

export type { SessionNotice } from '../sessionNoticeHub.ts';

/**
 * 每条会话还挂着的那句 sticky 提示（合并后的，带「×N」）记在模块级的 hub 里、而且**所有会话的都记**：
 * 切到别的会话再切回来时它要还在 —— 重连那句话说的是这条会话的现状，不是一闪而过的进度。
 * 分屏下几格共用这一个 hub（只挂一个 IPC 监听），同一句不会被记两次。
 */
const hub = createNoticeHub((fn) => (window as any).kiroApi?.onSessionNotice?.(fn));

/** 渲染端自己要在状态行说的一句（例如「这一轮已经结束，刚才那条作为新消息发出」）—— 和主进程发来的同一个落点。 */
export function noteSessionLocally(sessionId: string, text: string): void {
  hub.ingest({ sessionId, text, ts: Date.now() });
}

export function useSessionNotice(sessionId: string | null): { notice: SessionNotice | null; dismiss: () => void } {
  const [notice, setNotice] = useState<SessionNotice | null>(null);

  useEffect(() => {
    return hub.subscribe((noticeSessionId, next) => {
      /* 只显示**当前这条会话**的：别的会话的进度不该盖住你正在看的东西 */
      if (noticeSessionId !== sessionId) return;
      /* 还挂着的那句和新来的同类（同 group，没有 group 就一字不差）→ 显示新的这句、计数（「×3」），不刷屏 */
      setNotice((prev) => mergeNotice(prev, next));
    });
  }, [sessionId]);

  /* 换会话就清掉 —— 上一条会话的提示留在这儿只会让人以为是这条的 */
  useEffect(() => { setNotice(null); }, [sessionId]);
  /* ……但这条会话还挂着的 sticky 提示（正在重连）要回来：它说的是这条会话的现状（带着切走前的「×N」） */
  useEffect(() => {
    const sticky = sessionId ? hub.stickyFor(sessionId) : undefined;
    if (sticky) setNotice(sticky);
  }, [sessionId]);

  useEffect(() => {
    if (!notice || notice.sticky) return;
    const warn = /⚠️/.test(notice.text);
    const timer = setTimeout(() => setNotice(null), warn ? WARN_MS : FADE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  return {
    notice,
    dismiss: () => { if (sessionId) hub.clearSticky(sessionId); setNotice(null); },
  };
}
