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
}

export function useSessionNotice(sessionId: string | null): { notice: SessionNotice | null; dismiss: () => void } {
  const [notice, setNotice] = useState<SessionNotice | null>(null);

  useEffect(() => {
    const off = (window as any).kiroApi?.onSessionNotice?.((d: { sessionId: string; text: string; ts: number }) => {
      /* 只显示**当前这条会话**的：别的会话的进度不该盖住你正在看的东西 */
      if (!d?.text || d.sessionId !== sessionId) return;
      setNotice({ text: d.text, ts: d.ts || Date.now() });
    });
    return () => { try { off?.(); } catch { /* 卸载时 preload 可能已经没了 */ } };
  }, [sessionId]);

  /* 换会话就清掉 —— 上一条会话的提示留在这儿只会让人以为是这条的 */
  useEffect(() => { setNotice(null); }, [sessionId]);

  useEffect(() => {
    if (!notice) return;
    const warn = /⚠️/.test(notice.text);
    const timer = setTimeout(() => setNotice(null), warn ? WARN_MS : FADE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  return { notice, dismiss: () => setNotice(null) };
}
