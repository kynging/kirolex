/**
 * 右侧文件预览栏自己的搜索条（Ctrl/Cmd+F）。
 *
 * 归属判据（焦点在不在预览栏里）在 `previewFind.ts`,命中和高亮和聊天格共用
 * `paneFind.ts` / `findHighlight.ts`,只是用自己的 key（`PREVIEW_FIND_KEY`）—— 两边各清各的。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { findLabel, matchOffsets, shouldSearch, stepIndex } from '../paneFind';
import { clearPane, rangesIn, setActive, setPaneRanges, textOf } from '../findHighlight';
import { PREVIEW_FIND_KEY, keepActive } from '../previewFind';
import { scrollHostOf } from '../tabScroll';
import { useLang, useT } from '../hooks/useLang';

/** 正文在哪。路径行、💬 / ◎ 那一行不算正文 —— 搜文件名不该搜出一个命中。 */
const CONTENT_SELECTOR = '.rv-review-blocks, .workspace-viewer-md, pre.workspace-viewer-content';

export const PreviewFind: React.FC<{
  /** 预览栏的滚动容器（`.workspace-file-modal-body`）。 */
  body: HTMLElement | null;
  /** 这一次 Ctrl+F 归预览栏吗（`findOwner`）。 */
  owns: boolean;
  /** 当前这份能不能搜（`previewSearchable`）。 */
  searchable: boolean;
  /** 下面四个任何一个变了都要重算 —— 留着旧的就是把高亮画在别的文件 / 旧内容上。 */
  tabId: string | null;
  raw: boolean;
  commenting: boolean;
  content: string;
}> = ({ body, owns, searchable, tabId, raw, commenting, content }) => {
  const t = useT();
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  /** 当前是第几个命中,1 起;0 = 没有。 */
  const [active, setActiveIndex] = useState(0);
  const [total, setTotal] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rangesRef = useRef<Range[]>([]);
  const activeRef = useRef(0);
  activeRef.current = active;

  const clear = useCallback(() => {
    rangesRef.current = [];
    clearPane(PREVIEW_FIND_KEY);
    setTotal(0);
    setActiveIndex(0);
  }, []);

  /**
   * 算一遍命中。`reset`:换了词 / 换了文件 / 换了模式 → 回到第 1 个并滚过去;
   * 否则（内容原地变了）当前项留在原地、不滚,免得把人拽走。
   */
  const recompute = useCallback((reset: boolean) => {
    const root = body?.querySelector(CONTENT_SELECTOR) as HTMLElement | null;
    if (!root || !body) { clear(); return; }
    const offsets = matchOffsets(textOf(root), query);
    const ranges = rangesIn(root, query, offsets);
    rangesRef.current = ranges;
    setPaneRanges(PREVIEW_FIND_KEY, ranges);
    setTotal(ranges.length);
    const next = reset ? (ranges.length ? 1 : 0) : keepActive(activeRef.current, ranges.length);
    setActiveIndex(next);
    if (reset) setActive(PREVIEW_FIND_KEY, next ? ranges[next - 1] : null, scrollHostOf(body));
    else setActive(PREVIEW_FIND_KEY, next ? ranges[next - 1] : null, null);
  }, [body, query, clear]);

  /*
    换词、换标签页、切原文 / 排版、开关批注、文件内容刷新 → 重算。等两帧,和聊天格同一个理由:
    这些变化让 React 换一棵树,同一帧里量到的还是旧的那棵。
  */
  useEffect(() => {
    if (!open || !searchable || !shouldSearch(query)) { clear(); return; }
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(() => recompute(true)); });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [open, searchable, query, tabId, raw, commenting, content, recompute, clear]);

  /*
    内容在原地慢慢出来（批注视图异步分块、Markdown 里的图片 / 代码块后到）或被就地改了：
    看着 DOM 变化,停一会儿再重算。高亮本身不动 DOM,所以不会自己触发自己。
  */
  useEffect(() => {
    if (!open || !searchable || !body || !shouldSearch(query)) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new MutationObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; recompute(false); }, 200);
    });
    observer.observe(body, { childList: true, subtree: true, characterData: true });
    return () => { observer.disconnect(); if (timer) clearTimeout(timer); };
  }, [open, searchable, body, query, recompute]);

  /** 预览栏整个没了（关掉面板 / 藏起来）就撤掉高亮。 */
  useEffect(() => () => { clearPane(PREVIEW_FIND_KEY); }, []);

  const step = useCallback((direction: 'next' | 'prev') => {
    const ranges = rangesRef.current;
    if (!ranges.length || !body) return;
    const next = stepIndex(activeRef.current, ranges.length, direction);
    setActiveIndex(next);
    setActive(PREVIEW_FIND_KEY, ranges[next - 1] || null, scrollHostOf(body));
  }, [body]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    clear();
  }, [clear]);

  /* capture 阶段,和聊天格同理:批注框之类的 keydown 会先吃掉冒泡阶段的 */
  useEffect(() => {
    if (!owns) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setOpen(true);
        // 已经开着时再按一次 = 选中现有查询词
        setTimeout(() => inputRef.current?.select(), 0);
        return;
      }
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [owns, open, close]);

  if (!open) return null;
  if (!searchable) {
    return (
      <div className="pane-find preview-find" role="search">
        <span className="preview-find-hint">{t('This file type does not support search')}</span>
        <button className="pane-find-btn" onClick={close} title={t('Close (Esc)')}>✕</button>
      </div>
    );
  }
  return (
    <div className="pane-find preview-find" role="search">
      <input
        ref={inputRef}
        className="pane-find-input"
        autoFocus
        placeholder={t('Find in this file…')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            step(e.shiftKey ? 'prev' : 'next');
          }
        }}
      />
      <span className="pane-find-count">{findLabel({ query, active, total }, lang)}</span>
      <button className="pane-find-btn" onClick={() => step('prev')} title={t('Previous (Shift+Enter)')}>↑</button>
      <button className="pane-find-btn" onClick={() => step('next')} title={t('Next (Enter)')}>↓</button>
      <button className="pane-find-btn" onClick={close} title={t('Close (Esc)')}>✕</button>
    </div>
  );
};
