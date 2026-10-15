import React, { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import { uiGet, uiSet } from '../uiStore';
import { useT } from '../hooks/useLang';
// eslint-disable-next-line import/no-unresolved
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/*
  worker 走 `?url`：Vite 把它当资源发出来，dev 和打包后都是同一个写法。
  不设的话 pdf.js 会去猜一个路径，在 Electron 里猜不到 —— 而它的报错是"setting up fake worker"，
  看着像警告，实际是整份文档都不会解析。设一次就够，放模块级。
*/
(pdfjs as any).GlobalWorkerOptions.workerSrc = workerUrl;

/** 一页 —— 自己画自己，进视口才画。 */
const PdfPage: React.FC<{
  doc: any;
  index: number;
  /** CSS 宽度（不含 dpr）。变了就重画 —— canvas 是位图，拉伸会糊。 */
  width: number;
}> = ({ doc, index, width }) => {
  const t = useT();
  const ref = useRef<HTMLCanvasElement | null>(null);
  /** 这一页按多宽画过（宽度变了要重画；0 = 还没画） */
  const drawnAt = useRef<number>(0);
  const [near, setNear] = useState(false);
  /**
   * 占位用的长宽比 —— **必须先有它**。
   *
   * 没有的话还没画的页高度都是 0，于是整份文档一开始只有几百像素高：滚动条几乎不存在，
   * 往下滚一点它又忽然变长，位置乱跳。所以先按页面比例把高度占住，画完 canvas 再接管。
   * 默认 16:9 —— deck 基本都是这个比例，猜错了也只是第一帧。
   */
  const [ratio, setRatio] = useState(0.5625);
  /**
   * 这一页画坏了的原因。
   *
   * 原来是 `catch {}` 静默吞掉 ——「后面好像渲染失败了」就查不下去：一片空白，而空白和"还没画到"
   * 长得一模一样。一页失败不该带崩整份文档，但**必须说出来**。
   */
  const [pageWhy, setPageWhy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await doc.getPage(index);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        setRatio(base.height / base.width);
      } catch { /* 量不到就用默认比例，不影响别的页 */ }
    })();
    return () => { cancelled = true; };
  }, [doc, index]);

  /* 进视口（或快进了）才画 —— 一份上百页的 PDF 不该在打开那一刻把主线程占满 */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) setNear(true); },
      /* 提前两屏开始画，滚到的时候通常已经画好了 */
      { rootMargin: '200% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!near || !width) return;
    if (drawnAt.current === width) return;
    const canvas = ref.current;
    if (!canvas) return;
    let cancelled = false;
    let task: any = null;
    void (async () => {
      try {
        setPageWhy(null);
        const page = await doc.getPage(index);
        if (cancelled) return;
        /* 乘 dpr 是为了在 Retina 上不糊；封到 2 —— 再高只是多花内存，看不出差别 */
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (width / base.width) * dpr });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        task = page.render({ canvasContext: ctx, viewport });
        await task.promise;
        if (!cancelled) drawnAt.current = width;
      } catch (err: any) {
        /* 单页失败不该带崩整份文档 —— 那一页说明原因，其余照常 */
        const msg = String(err?.message || err);
        /* 取消是我们自己干的（换宽度/切走），不是错误 —— 报出来只会是噪音 */
        if (!cancelled && !/cancel/i.test(msg)) setPageWhy(msg.slice(0, 160));
      }
    })();
    return () => { cancelled = true; try { task?.cancel?.(); } catch {} };
  }, [doc, index, width, near]);

  return (
    <>
      <canvas
        ref={ref}
        className="rv-pdf-page"
        /* CSS 尺寸按比例给：画之前用来占位，画完之后保证不被拉伸变形 */
        style={{ width: `${width || 240}px`, height: `${Math.round((width || 240) * ratio)}px` }}
      />
      {pageWhy && (
        <p className="rv-pdf-page-why">{t('Couldn\'t render page {index}: {why}', { index, why: pageWhy })}</p>
      )}
    </>
  );
};

/**
 * **点开单页看大图** ——「给 ppt 预览加一个能点开单页、zoom in 的功能吧」。
 *
 * 为什么要单独重画一遍而不是把小图 CSS 放大：canvas 是**位图**，拉伸就是糊。评审一页 deck 常常就是
 * 为了看清那几个数字和小字，糊了等于没打开。所以按当前缩放**重新 render** 一次。
 *
 * 缩放上限 4 倍：一页 1152×648 的幻灯片乘 dpr 2 再乘 4 已经是 9216×5184，再往上只是烧内存。
 */
/** 备注栏宽度存在哪 —— 存进 ui-state，下次打开还是你调好的那个。 */
const DECK_SIDE_W_KEY = 'kirolex-deck-side-w';
/** 备注栏最窄多少 —— 再窄就读不了六百字的讲稿，那这一栏就白占地方。 */
const SIDE_MIN = 200;
/** 页那一栏最窄多少 —— 再窄幻灯片就看不出内容，而那是这个界面的主角。 */
const CELL_MIN = 260;

const PdfZoom: React.FC<{
  doc: any;
  page: number;
  pages: number;
  note?: string;
  /**
   * 大图里也要有的**入口和正在写的那个框** ——「如果当前页全屏的话页应该保留两个 comment 按钮
   * 或正在填写的框和内容」。
   *
   * 放大一页通常正是为了对着它挑毛病，而这时唯一能写的地方被盖在遮罩后面 —— 只能先关掉大图再写，
   * 那时你要挑的那个细节已经看不见了。
   */
  tools?: React.ReactNode;
  /**
   * 挂在**备注下面**的那一坨 —— 「改 ppt 的按钮应该在 note 和 ppt 之间，改 note 的在下面」。
   *
   * 两个入口在这里也得各自贴着它评的东西：版面那个在页和备注**之间**（`tools`），备注那个在备注
   * **后面**（这个）。原来两个挤在备注下面，于是"这条意见是对什么说的"又只能靠猜 ——
   * 而位置是这个界面最强的线索（评论不叠在页上，靠的就是位置）。
   */
  noteTools?: React.ReactNode;
  onPage: (page: number) => void;
  onClose: () => void;
}> = ({ doc, page, pages, note, tools, noteTools, onPage, onClose }) => {
  const t = useT();
  const ref = useRef<HTMLCanvasElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  /** 1 = 适应容器宽度。 */
  const [zoom, setZoom] = useState(1);
  const [why, setWhy] = useState<string | null>(null);

  /* 键盘：Esc 关、←/→ 翻页、+/-/0 缩放 —— 看大图时手在键盘上，不该被迫回去点按钮 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      /*
        **正在某个输入框里打字，这些就不是快捷键** ——「为什么再聊天框里输不了 0 这个，什么鬼啊」。
        
        这个放大层只盖住预览那一栏（实测 `position: absolute`、x=835、1057×974），可它的监听挂在
        **window** 上：于是左边聊天框里敲的 `0` 被这儿吞掉（`e.preventDefault()`），
        `+` `-` `=` 同理，方向键变成翻页，Esc 变成关大图。
        
        之前不容易撞上，因为换一次文档就会把放大层关掉；今天改成"改一页不再把你送回开头"
        （放大的那一页留着）之后，它经常一直开着 —— 于是这个洞天天可见。
        
        组合键也一并让开：`⌘0` 之类是别人的快捷键，抢过来只会让人以为那个功能坏了。
      */
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { if (page < pages) onPage(page + 1); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { if (page > 1) onPage(page - 1); }
      else if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(4, z * 1.25));
      else if (e.key === '-' || e.key === '_') setZoom((z) => Math.max(0.5, z / 1.25));
      else if (e.key === '0') setZoom(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [page, pages, onPage, onClose]);

  useEffect(() => {
    const canvas = ref.current;
    const box = boxRef.current;
    if (!canvas || !box) return;
    let cancelled = false;
    let task: any = null;
    void (async () => {
      try {
        setWhy(null);
        const p = await doc.getPage(page);
        if (cancelled) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const base = p.getViewport({ scale: 1 });
        /* 基准是"铺满容器宽度"，`zoom` 在它之上乘 —— 于是 1 永远是"看得见整页宽" */
        const cssWidth = Math.max(240, box.clientWidth - 24) * zoom;
        const viewport = p.getViewport({ scale: (cssWidth / base.width) * dpr });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.round(cssWidth)}px`;
        canvas.style.height = `${Math.round(viewport.height / dpr)}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        task = p.render({ canvasContext: ctx, viewport });
        await task.promise;
      } catch (err: any) {
        const msg = String(err?.message || err);
        if (!cancelled && !/cancel/i.test(msg)) setWhy(msg.slice(0, 160));
      }
    })();
    return () => { cancelled = true; try { task?.cancel?.(); } catch {} };
  }, [doc, page, zoom]);

  return (
    /* 点背景关掉 —— 和别处的浮层一致；点到内容上不关（`stopPropagation`） */
    <div className="rv-zoom" onClick={onClose}>
      <div className="rv-zoom-bar" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="btn" disabled={page <= 1} onClick={() => onPage(page - 1)} title={t('Previous page (←)')}>‹</button>
        <span className="rv-zoom-at">{t('Page {page} / {pages}', { page, pages })}</span>
        <button type="button" className="btn" disabled={page >= pages} onClick={() => onPage(page + 1)} title={t('Next page (→)')}>›</button>
        <span className="rv-zoom-gap" />
        <button type="button" className="btn" onClick={() => setZoom((z) => Math.max(0.5, z / 1.25))} title={t('Zoom out (-)')}>－</button>
        <span className="rv-zoom-at">{Math.round(zoom * 100)}%</span>
        <button type="button" className="btn" onClick={() => setZoom((z) => Math.min(4, z * 1.25))} title={t('Zoom in (+)')}>＋</button>
        <button type="button" className="btn" onClick={() => setZoom(1)} title={t('Fit width (0)')}>{t('Fit width')}</button>
        {/*
          这里**不再放一个刷新** ——「我看错了，放大页面上面有刷新」：顶栏那个 `⟳ 刷新` 就在这个遮罩
          上方、够得着。同一件事两个入口只会让人猜它们有什么区别（「用系统应用打开」那次就是这样）。
          要保证的是**刷完别退回总览** —— 那件事在 `PdfView` 里（不清 `doc`、`zoomAt` 只夹不清）。
        */}
        <button type="button" className="btn" onClick={onClose} title={t('Close preview (Esc)')}>✕</button>
      </div>
      {/* 放大之后要能滚着看 —— 不给滚动容器的话超出的部分根本到不了 */}
      <div className="rv-zoom-body" ref={boxRef} onClick={(e) => e.stopPropagation()}>
        {why && <p className="rv-review-why">{t('Couldn\'t render: {why}', { why })}</p>}
        <canvas ref={ref} className="rv-zoom-page" />
        {/*
          备注跟着一起显示 —— 放大一页通常正是为了对着它读讲稿。只显示不编辑：
          编辑的入口在后面那一行里，两处都能改会让"我刚写的那条在哪"变成一个问题。
        */}
        {/*
          **版面那个入口在页和备注之间** ——「改 ppt 的按钮应该在 note 和 ppt 之间」。
          事件不许冒上去：这一层的 `onClick` 是关掉大图，在框里点一下不该把大图关了
          （那会让你刚写的半句话连着框一起消失）。
        */}
        {tools && (
          <div
            className="rv-zoom-tools"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >{tools}</div>
        )}
        {note && <div className="rv-zoom-note">{note}</div>}
        {/* **备注那个入口在备注后面** —— 和后面那一列（页底下 / 备注框下）同一个分法 */}
        {noteTools && (
          <div
            className="rv-zoom-tools"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >{noteTools}</div>
        )}
      </div>
    </div>
  );
};

/**
 * 一份 PDF，**我们自己画** —— 每页一张 canvas。
 *
 * ## 为什么不用 `<iframe src="blob:…">`
 *
 * 那条路是把 PDF 交给 Chromium 自带的查看器，看着最省事（滚动、缩放、选字、Cmd+F 全都白拿），
 * 实测在 Electron 里它是**一个空框**：iframe 装好了（量到 472×835）、里面的 `<embed>` 也建出来了、
 * blob 读得到（`fetch` 回 1,092,827 字节的 `application/pdf`），**什么都没画**，控制台一个字不报。
 *
 * 原因是 `webPreferences.plugins` 在 Electron 里默认 `false`，而那个查看器就是个 plugin。打开它能修，
 * 但那意味着这个功能挂在一个**主进程开关**上：改它要重启，而且从界面上看不出来是它坏了 ——
 * 前后为它误诊了两次（先怀疑 `file://` 拦截，再怀疑两栏布局）。
 *
 * 自己画换来的还有一件更要紧的事：**每一页都是一个我们能往里放东西的行**（见 `sideFor`）。
 * 让掉的是那个查看器的工具条 —— 缩放和搜索我们暂时没有。
 *
 * ## 顺带去掉一个依赖
 *
 * 页数原来靠 PyMuPDF（`import fitz`）数，拿不到就没有逐页评论。pdf.js 打开文档就有 `numPages`。
 */
/**
 * **上次放大看的是哪一页**，按文件路径记 ——「每次刷新不要总回到之前的总览界面」。
 *
 * 放在模块级而不是组件里：正是要让它**活过一次重挂载**（那才是大图消失的原因）。
 * 也不落盘 —— 窗口重载/重启之后你打开一份 deck 想看的是总览，而不是被直接扔进上次那一页全屏里。
 * 手动关掉（✕ / Esc）会把这一项删掉，所以"我不想看大图了"这个意思留得住。
 */
const lastZoom = new Map<string, number>();

export const PdfView: React.FC<{
  /** PDF 字节。传数组而不是路径：渲染层拿不到 `file://`（跨 scheme 被拦），字节是主进程给的。 */
  bytes: Uint8Array;
  /** 文档打开后报告页数 —— 逐页评论用它，不必再靠 PyMuPDF。 */
  onPages?: (pages: number) => void;
  /**
   * 这份文件的身份（用路径）—— 用来记住"上次放大的是哪一页"，见 `lastZoom`。
   * 不给就没有这份记忆（文本预览那侧压根没有大图）。
   */
  zoomKey?: string;
  /**
   * 摆在这一页**旁边**的东西（备注、💬、✕）。
   *
   * 「note 和页应该是同步的，而不能分开 scroll」—— 所以不是两个各自滚的栏，而是**一个滚动容器、
   * 每行是"这一页 + 这一页的备注"**。对齐是结构给的，不需要 JS 联动 —— 联动一定会漂，
   * 因为备注高度和页高度根本不相等，滚动比例对不上。
   */
  sideFor?: (page: number) => React.ReactNode;
  /** 这一页的演讲者备注原文 —— 放大看的时候一起显示（只显示，不编辑）。 */
  noteFor?: (page: number) => string;
  /**
   * 叠在**这一页上**的东西 —— 通常是"这一页已经有意见了"那个标记。
   *
   * 「已经确认的意见至少要在图上显示一个按钮啊」：意见确认之后收进旁边那一格里，页面本身
   * 一点痕迹都没有 —— 往下翻十四页，哪几页提过意见全靠记。所以标记要在图上。
   */
  overlayFor?: (page: number) => React.ReactNode;
  /**
   * 挂在**这一页正下方**的东西（在页和它的边栏之间那一格里）。
   *
   * 「ppt comment 的在 ppt 下面，note comment 的在 note 下面，不要乱搞」：对**版面**提的意见属于这一页，
   * 所以它的入口要在页底下；对**备注**提的意见在备注底下（那在 `sideFor` 里）。
   * 两个都塞进右边那一格的话，位置就不再说明"这条意见是对什么说的"—— 而位置本来是这里最强的线索。
   */
  belowFor?: (page: number) => React.ReactNode;
  /**
   * 放大看一页时，遮罩里也放上这一页的**入口和正在写的框**。
   *
   * 「如果当前页全屏的话页应该保留两个 comment 按钮或正在填写的框和内容」：放大常常正是为了对着它
   * 挑毛病，而那时唯一能写的地方被盖在遮罩后面。草稿由上层拿着（`ReviewPane.draftLive`），
   * 所以这里和后面那一份显示的是同一句话，在哪边写都一样。
   */
  zoomToolsFor?: (page: number) => React.ReactNode;
  /** 放大时挂在**备注下面**的那一坨（版面那个走 `zoomToolsFor`，在页和备注之间）。 */
  zoomNoteToolsFor?: (page: number) => React.ReactNode;
}> = ({ bytes, onPages, zoomKey, sideFor, overlayFor, noteFor, belowFor, zoomToolsFor, zoomNoteToolsFor }) => {
  const t = useT();
  /**
   * 备注那一栏多宽 —— **中间那条可以左右拖** ——「中间加一个可以左右调整大小的拉拽功能」。
   *
   * 它原来是 `clamp(240px, 34%, 460px)`：一个猜的比例。而这两栏的合适比例取决于你在干什么 ——
   * 对着图挑版面时想把页放大，逐字审讲稿时想把备注拉宽（那份 deck 每页六百字），
   * 而这两件事在同一次审阅里来回切。
   *
   * 宽度是**整列共用**的（一行一个把手，拖哪一行都改同一个值）—— 每页各自宽度不同的话，
   * 滚动时两栏边界会来回跳。存进 ui-state，下次打开还是你调好的那个宽度。
   */
  const [sideW, setSideW] = useState<number | null>(() => {
    const saved = Number(uiGet(DECK_SIDE_W_KEY));
    return Number.isFinite(saved) && saved >= SIDE_MIN ? saved : null;
  });
  const dragRef = useRef<{ x: number; w: number } | null>(null);
  /**
   * 起手拖 —— **move / up 挂在 `window` 上**，不是把手上。
   *
   * 挂在把手上的话，鼠标一旦离开这条 6px 的窄条（拖快一点必然离开）就收不到事件了 ——
   * 那种"拖一下就断"是这类控件最常见的坏法。
   */
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();                                  // 别让它冒到"点开大图"上
    const row = (e.currentTarget as HTMLElement).closest('.rv-pdf-row');
    const side = row?.querySelector('.rv-pdf-side') as HTMLElement | null;
    const startW = side ? side.getBoundingClientRect().width : (sideW || 340);
    dragRef.current = { x: e.clientX, w: startW };
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      /* 往左拖 = 备注变宽：把手在备注左边，方向要跟手 */
      const rowW = row ? row.getBoundingClientRect().width : 0;
      /* 两头都夹住：备注读得了、页也看得出内容（`SIDE_MIN` / `CELL_MIN`） */
      const max = Math.max(SIDE_MIN, rowW - CELL_MIN);
      const next = Math.min(max, Math.max(SIDE_MIN, d.w - (ev.clientX - d.x)));
      setSideW(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('rv-col-resizing');
      /* 松手才落盘 —— 拖动过程里写十几次 ui-state 是白花的磁盘 */
      const d = dragRef.current;
      dragRef.current = null;
      if (d) setSideW((w) => { if (w) uiSet(DECK_SIDE_W_KEY, String(Math.round(w))); return w; });
    };
    /* 拖动时全局改光标、禁选中 —— 不然拖过页面时会把幻灯片上的字选起来 */
    document.body.classList.add('rv-col-resizing');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [doc, setDoc] = useState<any>(null);
  const [pages, setPages] = useState(0);
  const [why, setWhy] = useState<string | null>(null);
  /**
   * 每页按多宽画 —— **canvas 是位图，容器变宽它不会自己变**。
   *
   * 「拖拽宽度好像 pdf 和 note 的大小都不变化？」：原来只在挂载时量一次，拖动分栏之后 PDF
   * 还是老那么宽。所以宽度进 state，`ResizeObserver` 一改就重画。
   */
  const [width, setWidth] = useState(0);
  /**
   * 正在放大看的那一页（`null` = 没开）。
   *
   * **初值从 `lastZoom` 取** ——「总之不要跳回之前的总览界面」。这个 state 原来只活在组件里，
   * 于是这棵子树一被卸掉（面板那句 `!fileViewerLoading && fileViewer &&` 一闪、切了个 tab 再切回来、
   * 开发时一次 HMR）大图就没了，你回到总览还得自己滚回去、再点开、再翻到那一页。
   * 而"刷一下"这件事恰恰最容易碰上这些。判据见 `lastZoom`。
   */
  const [zoomAt, setZoomAt] = useState<number | null>(
    () => (zoomKey ? lastZoom.get(zoomKey) ?? null : null),
  );
  /* 记住/忘掉：开着就记，关掉就删 —— 删掉是必须的，否则下次打开这份文件会直接弹全屏 */
  useEffect(() => {
    if (!zoomKey) return;
    if (zoomAt === null) lastZoom.delete(zoomKey);
    else lastZoom.set(zoomKey, zoomAt);
  }, [zoomKey, zoomAt]);

  useEffect(() => {
    let cancelled = false;
    /*
      **换文档时不清掉旧的那份** ——「放大的时候每次修改 ppt 都会回到之前的页面」。

      这里原来先 `setDoc(null); setPages(0); setZoomAt(null)`，然后才去解析新的字节。代价是三件
      同时发生的事：放大的那一页当场关掉（`doc && zoomAt !== null` 不成立）、十四行页面整个卸载、
      于是滚动位置回到顶部 —— 你刚改完第 9 页的字，改成了，界面却把你送回开头，还得自己滚回去、
      再点开一次。

      而这段时间旧那份**仍然是能看的**（改的是一页上几个 run，其余十三页一模一样）。所以留着它：
      解析在后台跑，好了才换（`cancelled` 挡住换页之后到达的旧结果）。解析失败时也留着 ——
      旁边有一行 `why` 说明，比一个空框好得多。
    */
    setWhy(null);
    /*
      给 pdf.js 的是**一份拷贝**：它会接管这个 buffer（transfer 到 worker），之后原数组就空了。
      不拷的话切走再切回来（同一份 state）第二次就是 0 字节，而症状又是"什么都没画"。
    */
    const task = (pdfjs as any).getDocument({ data: bytes.slice() });
    void (async () => {
      try {
        const d = await task.promise;
        if (cancelled) return;
        setDoc(d);
        setPages(d.numPages);
        onPages?.(d.numPages);
        /*
          放大的那一页跟着留下来，但要**夹住** —— 结构改动可以让页数变少（提交那条路允许加页删页），
          而 `zoomAt` 指到一页不存在的地方，遮罩里就是一块空白。
        */
        setZoomAt((cur) => (cur === null ? null : Math.min(cur, d.numPages)));
      } catch (err: any) {
        if (cancelled) return;
        /* 说出是哪一步坏的 —— 空框不报错正是上一条路最难查的地方 */
        setWhy(t('Failed to render the PDF: {err}', { err: String(err?.message || err).slice(0, 200) }));
      }
    })();
    return () => {
      cancelled = true;
      /* 取消解析，否则切走之后 worker 还在啃一份没人要的文档 */
      try { task.destroy?.(); } catch {}
    };
  }, [bytes, onPages]);

  /*
    量宽度用 `ResizeObserver`，不是 window resize：分栏是拖动**容器**，窗口大小没变，
    监听 window 的话一次都不会触发。
  */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      /* 有备注时这一行要分给右边一份，所以量的是**页那一格**的宽度，不是整行 */
      const cell = host.querySelector('.rv-pdf-cell');
      const w = Math.floor((cell || host).getBoundingClientRect().width) - 2;
      const next = Math.max(240, w);
      /*
        只在**变化够大**时才重画（>16px）：拖动过程中 ResizeObserver 每帧都来，每次重画十几页
        会把主线程钉死。16px 以下的差别在屏幕上看不出来，重画一次的代价是实打实的。
      */
      setWidth((cur) => (Math.abs(next - cur) > 16 ? next : cur));
    };
    measure();
    const ro = new ResizeObserver(measure);
    /*
      **要观察那一格本身，不能只观察外层容器** ——「不是，左边的大小不调整吗」。

      拖中间那条分隔线改的是**页那一格**的宽度，而外层容器宽度一点没变 —— 只观察容器的话观察器一次
      都不触发，于是页永远按老宽度画：你把备注拉宽了，页那一栏的框变窄了，而里面那张图还是原来那么大。
      （这和上面那句"分栏是拖动容器，窗口大小没变"是同一个坑的下一层：那次是从 window 换到容器，
      这次是从容器换到格子。）

      两个都观察：格子管拖分隔线，容器管拖整个面板 / 窗口。
    */
    ro.observe(host);
    const cell = host.querySelector('.rv-pdf-cell');
    if (cell) ro.observe(cell);
    return () => ro.disconnect();
  }, [pages]);

  return (
    <div className="rv-pdf">
      {why && <p className="rv-review-why">{why}</p>}
      {!why && !doc && <p className="rv-pdf-progress">{t('Parsing PDF…')}</p>}
      {/*
        **一个**滚动容器。页和它的备注在同一行里，所以永远对齐 ——
        「note 和页应该是同步的，而不能分开 scroll」。
      */}
      <div
        className="rv-pdf-pages"
        ref={hostRef}
        /* 宽度用 CSS 变量下发 —— 一行一个把手，改的是同一个值（见 `sideW`） */
        style={sideW ? ({ ['--rv-side-w' as any]: `${sideW}px` }) : undefined}
      >
        {doc && Array.from({ length: pages }, (_, i) => (
          <div className="rv-pdf-row" key={i}>
            {/*
              点这一页 = 放大看它 ——「加一个能点开单页、zoom in 的功能」。
              整格可点（不只是 canvas）：点一张幻灯片的空白处也该算点它。
              页上那些标记按钮自己 `stopPropagation`，所以点 💬 不会顺手把大图打开。
            */}
            <div
              className="rv-pdf-cell"
              role="button"
              tabIndex={0}
              title={t('Open page {n} full size', { n: i + 1 })}
              onClick={() => setZoomAt(i + 1)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setZoomAt(i + 1); } }}
            >
              <PdfPage doc={doc} index={i + 1} width={width} />
              {overlayFor?.(i + 1)}
              {/*
                版面那条通道的入口挂在页底下（`belowFor`），而且**它里面的事件不许冒到这一格上**
                ——「为什么我在填写 comment 的时候会自动进入当前页全屏？」

                这一格既 `onClick` 也 `onKeyDown`（Enter / Space = 点开大图）。框就在格子里面，
                于是**打字打到空格**就顺手把大图打开了 —— 按钮自己 `stopPropagation` 挡住了点击那一半，
                键盘那一半没人挡。这里连点击带按键一起挡：入口和框都不是"点这一页"。
              */}
              {belowFor && (
                <div
                  className="rv-pdf-below"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >{belowFor(i + 1)}</div>
              )}
            </div>
            {sideFor && (
              <>
                {/*
                  两栏之间那条**可以左右拖** ——「中间加一个可以左右调整大小的拉拽功能」。

                  `onMouseDown` 起手，动和松手挂在 `window` 上（见 `startDrag`）：只挂在把手上的话，
                  鼠标一旦拖出这条 6px 的窄条就收不到 move 了 —— 那种"拖一下就断"是这类控件最常见的坏法。
                  往左拖 = 备注变宽（`startW - dx`），因为把手在备注左边，方向要跟手。
                */}
                <div
                  className="rv-pdf-grip nopan nodrag"
                  role="separator"
                  aria-orientation="vertical"
                  title={t('Drag to resize the notes column (double-click to reset)')}
                  onMouseDown={(e) => startDrag(e)}
                  onDoubleClick={() => { setSideW(null); uiSet(DECK_SIDE_W_KEY, ''); }}
                />
                <div className="rv-pdf-side">{sideFor(i + 1)}</div>
              </>
            )}
          </div>
        ))}
      </div>
      {doc && zoomAt !== null && (
        <PdfZoom
          doc={doc}
          page={zoomAt}
          pages={pages}
          note={noteFor?.(zoomAt)}
          tools={zoomToolsFor?.(zoomAt)}
          noteTools={zoomNoteToolsFor?.(zoomAt)}
          onPage={setZoomAt}
          onClose={() => setZoomAt(null)}
        />
      )}
    </div>
  );
};
