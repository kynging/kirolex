import { mergeNotice } from './noticeMerge.ts';

/**
 * 状态行提示（`useSessionNotice`）的**会话级**那一半：收主进程 / 渲染端发来的每一句，记住每条会话还挂着的
 * sticky 提示，再分给每个订阅的聊天格。纯逻辑，不碰 React / window（IPC 怎么挂由调用方传进来），能直接单测。
 *
 * 为什么记的是**合并后**的那句：重连提示显示「×3」时，次数原来只在组件状态里，会话缓存存的是最后到的原句 ——
 * 切到别的会话再切回来，次数就没了。
 *
 * 为什么只挂**一个** IPC 监听：分屏下每一格都有一个 `useSessionNotice`；要是每格各自更新缓存，同一句会被合并两次
 * （×2 记成 ×4）。所以缓存在这里更新一次，再分给各格。
 */

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
  /** 同类提示的键（主进程给的「类型:对象」）—— 还挂着时又来同类的一句只计数（`noticeMerge`） */
  group?: string;
  /** 还挂着时又来了同类的这一句 —— 第几次（显示成「×N」，见 `noticeMerge`）；1 次不写 */
  count?: number;
}

/** 主进程 `session:notice` / 渲染端 `noteSessionLocally` 发来的原样 */
export interface RawSessionNotice {
  sessionId: string; text: string; ts: number;
  copyRemote?: string[]; sticky?: boolean; variants?: { zh: string; en: string }; group?: string;
}

export function toSessionNotice(d: RawSessionNotice): SessionNotice {
  return {
    text: d.text, ts: d.ts || Date.now(),
    ...(Array.isArray(d.copyRemote) && d.copyRemote.length ? { copyRemote: d.copyRemote } : {}),
    ...(d.sticky ? { sticky: true } : {}),
    ...(typeof d.group === 'string' && d.group ? { group: d.group } : {}),
    ...(d.variants && typeof d.variants.zh === 'string' && typeof d.variants.en === 'string' ? { variants: { zh: d.variants.zh, en: d.variants.en } } : {}),
  };
}

export type NoticeListener = (sessionId: string, next: SessionNotice) => void;

export function createNoticeHub(attach: (fn: (d: RawSessionNotice) => void) => (() => void) | void) {
  /** 每条会话还挂着的那句 sticky 提示（合并后的）—— **所有会话的都记**：切走再切回来它要还在 */
  const stickyBySession = new Map<string, SessionNotice>();
  const listeners = new Set<NoticeListener>();
  let detach: (() => void) | null = null;

  function ingest(d: RawSessionNotice): void {
    if (!d?.text) return;
    const next = toSessionNotice(d);
    /* 这条会话的下一句提示（不管是不是 sticky）都把上一句 sticky 换掉；同类的 sticky 接着计数 */
    if (next.sticky) stickyBySession.set(d.sessionId, mergeNotice(stickyBySession.get(d.sessionId) ?? null, next));
    else stickyBySession.delete(d.sessionId);
    for (const fn of listeners) { try { fn(d.sessionId, next); } catch { /* 一个监听坏了不影响别的 */ } }
  }

  return {
    ingest,
    subscribe(fn: NoticeListener): () => void {
      listeners.add(fn);
      if (!detach) {
        try { detach = attach(ingest) || (() => {}); } catch { detach = () => {}; }
      }
      return () => {
        listeners.delete(fn);
        if (!listeners.size && detach) {
          const off = detach; detach = null;
          try { off(); } catch { /* 卸载时 preload 可能已经没了 */ }
        }
      };
    },
    stickyFor: (sessionId: string): SessionNotice | undefined => stickyBySession.get(sessionId),
    clearSticky: (sessionId: string): void => { stickyBySession.delete(sessionId); },
  };
}
