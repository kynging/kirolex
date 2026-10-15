import { useEffect, useState } from 'react';

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

export interface SessionNotice {
  text: string;
  ts: number;
  /** 远程会话落在远端的交付文件 —— 每个给一颗「⇩ 复制到本机」 */
  copyRemote?: string[];
  /**
   * **不自动消失**，直到这条会话的下一句提示把它换掉 ——「本机工具连接中断，正在重连（第 N 次）」
   * 要一直挂到连上为止（连上时主进程会发一句"回来了"把它顶掉）。
   */
  sticky?: boolean;
  /** 这句话的中英两版（主进程 `bothLangs`）—— 显示时按当前界面语言挑；没有就显示 `text` */
  variants?: { zh: string; en: string };
}

/**
 * 每条会话还挂着的那句 sticky 提示。放在模块级、而且**所有会话的都记**：
 * 切到别的会话再切回来时它要还在 —— 重连那句话说的是这条会话的现状，不是一闪而过的进度。
 */
const stickyBySession = new Map<string, SessionNotice>();

export function useSessionNotice(sessionId: string | null): { notice: SessionNotice | null; dismiss: () => void } {
  const [notice, setNotice] = useState<SessionNotice | null>(null);

  useEffect(() => {
    const off = (window as any).kiroApi?.onSessionNotice?.((d: { sessionId: string; text: string; ts: number; copyRemote?: string[]; sticky?: boolean; variants?: { zh: string; en: string } }) => {
      if (!d?.text) return;
      const next: SessionNotice = {
        text: d.text, ts: d.ts || Date.now(),
        ...(Array.isArray(d.copyRemote) && d.copyRemote.length ? { copyRemote: d.copyRemote } : {}),
        ...(d.sticky ? { sticky: true } : {}),
        ...(d.variants && typeof d.variants.zh === 'string' && typeof d.variants.en === 'string' ? { variants: { zh: d.variants.zh, en: d.variants.en } } : {}),
      };
      /* 这条会话的下一句提示（不管是不是 sticky）都把上一句 sticky 换掉 */
      if (next.sticky) stickyBySession.set(d.sessionId, next); else stickyBySession.delete(d.sessionId);
      /* 只显示**当前这条会话**的：别的会话的进度不该盖住你正在看的东西 */
      if (d.sessionId !== sessionId) return;
      setNotice(next);
    });
    return () => { try { off?.(); } catch { /* 卸载时 preload 可能已经没了 */ } };
  }, [sessionId]);

  /* 换会话就清掉 —— 上一条会话的提示留在这儿只会让人以为是这条的 */
  useEffect(() => { setNotice(null); }, [sessionId]);
  /* ……但这条会话还挂着的 sticky 提示（正在重连）要回来：它说的是这条会话的现状 */
  useEffect(() => {
    const sticky = sessionId ? stickyBySession.get(sessionId) : undefined;
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
    dismiss: () => { if (sessionId) stickyBySession.delete(sessionId); setNotice(null); },
  };
}
