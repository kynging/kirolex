import { projectsToCollapse, projectsToWarmNow } from '../projectActivity';
import { restoreGetJson, restoreSet } from '../uiRestore';
/** 侧栏折叠了哪些组 —— 活过 reload；「重启后恢复界面状态」开着时也活过重启（见 `restoredCollapse`）。 */
const COLLAPSED_KEY = 'kirolex-sidebar-collapsed';
import { kiroTraceOn, setKiroTrace } from '../hooks/useFeatureFlags';
import { useRemoteTargets } from '../hooks/useRemoteTargets';
import { searchSessions } from '../sessionSearch';
import { placeMenu, placeSubmenu } from '../menuPlacement';
import { subagentTag, type SubagentRow } from '../../main/subagents.ts';
import React, { useState, useRef, useEffect, useLayoutEffect, useReducer } from 'react';
import { useT } from '../hooks/useLang';
import {
  DndContext,
  pointerWithin,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragOverlay,
  useDroppable,
  useDraggable,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Session } from '../App';
import type { ScheduleSummary } from '../scheduleView';
import { IconLogs, IconWorkspaceFolder } from './Icons';
import { showToast } from './Toasts';

type SessionStatus = 'idle' | 'streaming' | 'unread' | 'dormant' | 'connecting' | 'warm' | 'alert' | 'rebuilding';


/**
 * A CONTEXT MENU THAT MEASURES ITSELF, then places itself — 「右键菜单仍可能跑出屏幕外」.
 *
 * Its height is not knowable in advance: the session menu grows with the project list, and 「Delete」 sits at the
 * bottom, so overflow costs exactly the items people reach for. So it renders once (invisible, to avoid a visible
 * jump), measures, and then positions with `placeMenu` — which flips up/left rather than sliding away from the
 * row that was right-clicked.
 */
/**
 * 右键菜单里的**子菜单**（悬浮展开到右侧）——「那个按钮应该变成切换 session，右侧展开可以选本地、
 * 远程服务器之类的」。
 *
 * 为什么值得做成子菜单而不是继续平铺：平铺的时候每台机器占一行，和「归到哪个项目」那一堆 🏷️
 * 混在一起，菜单越长越难扫；而"这条会话在哪台机器上跑"是**一个**问题、多个互斥选项 ——
 * 一行加一个展开箭头正好表达这件事，当前在哪儿也能用 ✓ 一眼看出来。
 *
 * 展开方向固定向右、用 CSS 定位（`left: 100%`）：这个菜单本身已经被 `placeMenu` 摆在视口内了，
 * 子菜单跟着它走就行 —— 再写一套边界计算只会多一处会算错的地方。
 * 唯一的例外是**竖直方向**：「移到项目」那个子菜单随项目数变长，从入口往下展开会出屏幕底部，
 * 所以面板限高（CSS，超出的在面板里滚动），展开时量一次高度、用 `placeSubmenu` 往上挪到放得下。
 */
const Submenu: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => {
  const [open, setOpen] = useState(false);
  const row = useRef<HTMLDivElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const [top, setTop] = useState<number | null>(null);
  /* 列表很长时（项目子菜单）往下展开会出屏幕底部：画之前量一次，往上挪到放得下 */
  useLayoutEffect(() => {
    if (!open) { setTop(null); return; }
    const r = row.current, p = panel.current;
    if (!r || !p) return;
    setTop(placeSubmenu({
      rowTop: r.getBoundingClientRect().top,
      height: p.getBoundingClientRect().height,
      viewportHeight: window.innerHeight,
    }));
  }, [open]);
  return (
    <div
      ref={row}
      className={`context-menu-item context-submenu${open ? ' open' : ''}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      /* 点父项不该关掉整个菜单：它只是个入口 */
      onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
    >
      <span className="context-submenu-label">{label}</span>
      <span className="context-submenu-caret">›</span>
      {open && (
        <div ref={panel} className="context-submenu-panel" style={top === null ? undefined : { top }}>
          {children}
        </div>
      )}
    </div>
  );
};

const Menu: React.FC<{ x: number; y: number; children: React.ReactNode }> = ({ x, y, children }) => {
  const box = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPlace(placeMenu({
      x, y, width: r.width, height: r.height,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
    }));
  }, [x, y]);
  return (
    <div
      ref={box}
      className="context-menu"
      style={place ? { left: place.left, top: place.top } : { left: x, top: y, visibility: 'hidden' }}
    >
      {children}
    </div>
  );
};

const UNASSIGNED = '__unassigned__';
const ARCHIVED = '__archived__';

// --- Small inline icons matching the reference (outline, currentColor) -------
const ProjectFolderIcon = () => (
  <svg className="pg-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);
const KebabIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" />
  </svg>
);
const PlusSquareIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="4" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" />
  </svg>
);

interface SidebarProps {
  sessions: Session[];
  projects: string[];
  currentSessionId: string | null;
  status: 'disconnected' | 'connecting' | 'connected';
  streamingSessionIds: string[];
  attachedSessionIds: string[];
  busyBySession?: Record<string, string>;  connectingSessionIds: string[];
  /**
   * **试过、连不上的那些** ——「如果连不上不应该是红色吗」。
   *
   * 和"还没连"必须分开：没打开过的会话是灰的（那是正常状态），而**失败过**的要显眼。
   * 那台机器连不上时每条远程会话都是灰的，和"还没打开"长得一样，只能翻日志才知道坏了。
   */
  failedSessionIds?: string[];
  unreadSessionIds: string[];
  /** kiro 原生子代理名单，按会话。左栏那面 tag 就是它 */
  subagentsBySession?: Record<string, SubagentRow[]>;
  /**
   * 注册表里的 flow，用来在 project 菜单里起跑 —— 「我根本没有方法去用新的flow重新跑这个项目」。
   *
   * 建 run 原来全 App 只有一个入口：运行页里的「重开一次运行」。也就是说一个还没有 run 的 flow 无法开始，
   * 而重新导入过的定义（草稿确认之后）也没有地方能用它开一次新的。
   */
  /**
   * 这个 project 有没有开启 flow 管理 —— 「用户如何打开这个功能或关掉这个功能」。
   *
   * 之前它是**跑出来的**：只要出现过一次 run，拖会话进来就开始被拒、打开就自动建主会话。你没同意过，
   * 行为却变了。现在是一个显式开关，关着的时候这一整套（带状、加 flow、主会话、拖入限制）都不出现。
   */
  executorCap?: number;
  onNewSession: () => void;
  onCreateProject: (name: string) => void;
  /** Move `name` to `target`'s position in the project order (user-adjustable). */
  onReorderProjects?: (name: string, target: string) => void;
  onNewSessionInProject: (project: string) => void;
  onRenameProject: (oldName: string, newName: string) => void;
  onDeleteProject: (name: string) => void;
  onSwitchSession: (id: string) => void;
  /**
   * Connect a project's sessions — called when a collapsed idle project is opened.
   *
   * Idle projects are not warmed at startup any more (`projectActivity`), so the executors they need are
   * started here: 「等用户点开project再创建连接」.
   */
  onWarmProject?: (project: string) => void;
  /** 这个 project 里有多少次运行 —— 只用来判断「能不能把散落会话拖进来」，不再是一个显示用的 tag。 */
  /**
   * 这个 project 现在挂着哪些 flow —— 「哪里选择是什么 flow？」
   *
   * 这个答案原来只在运行页那条带状上,而运行页得先有一次运行才打得开:一个刚开了 flow 管理、还没跑过的
   * project,界面上没有一处说得出它有哪些 flow。配置在这个菜单里,答案也该在这里。
   */
  /** 这个 project 的工作目录（显示用）/ 去改它 */
  projectWorkspace?: (project: string) => string;
  onSetProjectWorkspace?: (project: string) => void;
  /**
   * 这个 flow 在这个 project 里还在用吗 —— 决定它的主会话删不删得动。
   *
   * 「保存 run 的主会话，直到 project 不再使用这个 flow」:所以这条判断不能写在侧栏里(它不知道注册表和
   * 移出名单),由 App 给出。没传就按「还在用」处理,也就是维持原来那条「删不掉」。
   */
  flowStillUsed?: (session: { purpose?: string; flow?: string }) => boolean;
  onDeleteSession: (id: string) => void;
  /** Force-rebuild this chat's backend context from the saved transcript. */
  onRebuildContext?: (id: string, mode?: 'snapshot' | 'full') => void;
  onRenameSession: (id: string, title: string) => void;
  onTogglePin: (id: string) => void;
  /** 1-based grid position per session (0 = not in the split), so the sidebar
   *  can highlight the visible chats in grid order. */
  splitOrder?: (id: string) => number;
  onToggleSplit?: (id: string) => void;
  /** This chat's schedule, or null. Same summary its transcript banner shows — the sidebar is
   *  where you find out a chat you are NOT looking at has a run coming. */
  scheduleFor?: (id: string) => ScheduleSummary | null;
  /** Open a project's workspace (the flow surface). */
  onAssignProject: (sessionId: string, projectId: string) => void;
  onMoveSession: (sessionId: string, projectId: string | null) => void;
  /** 同一组里拖动 = 调前后顺序（整份列表换成新顺序，持久化在 ui-state 里）。 */
  onReorderSessions?: (sessions: Session[]) => void;
  onArchiveSession: (sessionId: string, archived: boolean) => void;
  onSettings: () => void;
  /**
   * 打开 ☁️「从备份恢复」——「这个同步应该在左侧下方有一个入口按钮」，
   * 而「这个云按钮只保留恢复」：配置在 设置 → ☁️ 备份。
   *
   * 和 ⚙️ 分开一个按钮，而不是"进设置自己找"：备份是一件**有状态**的事（上次什么时候成的、
   * 失败了没有），而藏在四层菜单后面的状态等于没有状态。Tabby 那个云同步插件同样把它
   * 放在工具栏上（v1.8.0 的 changelog：`Added toolbar and command-palette actions for syncing`）。
   */
  onOpenBackup: () => void;
  /** 上一次同步的结果 —— 给这个按钮上色和写 title 用。 */
  backupState?: { at: number; uploaded: number; error?: string } | null;
  workspaceOpen: boolean;
  onOpenWorkspace: () => void;
  onOpenLogs: () => void;
  onOpenMemory: () => void;
  /** Register a skill into KiroLex (right-click the skills button). Registration is what makes a
   *  skill selectable by a project. */
  /** Agent config is a global file, so its trigger lives here, not per chat. */
}

/**
 * **点了「运行位置」就立刻打上 tag** ——「点切换了之后没有立刻打上 tag」。
 *
 * 连着的会话换机器要先探远端、在那台机器上起 kiro-cli、建一条新的后端会话，十几秒到一分钟；
 * 真正的 `remoteHost` 要等这些都做完、主进程发 `session:targets-changed` 才变。那之前侧栏毫无
 * 反应，看起来就是"点了没用"。所以点下去那一刻先挂一个 ⏳ 版本的 tag，结束（成功或失败）就撤掉：
 * 成功时真 tag 已经由那个事件换上，失败时回到原样并弹出原因。
 *
 * 放在模块级而不是层层传 prop：会话行在好几层分组组件下面，这个状态只有这里写、只有行读。
 */
const ENGINE_NAMES: Record<'kiro' | 'claude' | 'codex', string> = { kiro: 'Kiro', claude: 'Claude Code', codex: 'Codex' };
const pendingTargets = new Map<string, string | null>();
const PENDING_TARGET_EVT = 'kirolex:pending-target';
function setPendingTarget(sessionId: string, label: string | null | undefined): void {
  if (label === undefined) pendingTargets.delete(sessionId); else pendingTargets.set(sessionId, label);
  window.dispatchEvent(new Event(PENDING_TARGET_EVT));
}
/** `undefined` = 没在切；`null` = 正在切回本地；字符串 = 正在切去那台机器。 */
function usePendingTarget(sessionId: string): string | null | undefined {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    window.addEventListener(PENDING_TARGET_EVT, bump);
    return () => window.removeEventListener(PENDING_TARGET_EVT, bump);
  }, []);
  return pendingTargets.has(sessionId) ? pendingTargets.get(sessionId) : undefined;
}

// Draggable + selectable session row.
const SessionItem: React.FC<{
  session: Session;
  isActive: boolean;
  sessionStatus: SessionStatus;
  busyReason?: string | null;
  onSwitch: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  onDelete: (e: React.MouseEvent, id: string) => void;
  /** 1-based position of this chat in the split grid; 0 = not shown. */
  splitOrder?: number;
  onToggleSplit?: (id: string) => void;
  /** The same summary the chat's own banner shows, or null when nothing is pending. */
  scheduleSummary?: ScheduleSummary | null;
  /** kiro 原生子代理：这一条上挂多少个还在跑的 —— 「直到subagent被关掉」 */
  subagents?: SubagentRow[];
}> = ({ session, isActive, sessionStatus, busyReason, onSwitch, onContextMenu, onDelete, splitOrder = 0, onToggleSplit, scheduleSummary, subagents }) => {
  const t = useT();
  const crew = subagentTag(subagents);
  const pendingTarget = usePendingTarget(session.id);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: session.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  const dotTitle =
    busyReason === 'reconfiguring' ? t('Busy: switching model / agent…')
    : busyReason === 'attaching' ? t('Busy: connecting / reconnecting the backend…')
    : busyReason === 'priming' ? t('Busy: rebuilding history context (retries until done; Stop to abandon)')
    : busyReason === 'prime-pending' ? t('Busy: history context missing, rebuild imminent; new messages queue')
    : busyReason === 'turn' ? t('Busy: turn in progress…')
    : sessionStatus === 'streaming' ? t('Working…')
    : sessionStatus === 'connecting' ? t('Connecting…')
    : sessionStatus === 'unread' ? t('Unread reply')
    : sessionStatus === 'warm' ? t('Live — ready (background)')
    : sessionStatus === 'alert' ? t('Not connected — select to activate')
    : sessionStatus === 'dormant' ? t('Archived — inactive')
    : t('Live — idle');

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`session-item ${isActive ? 'active' : ''}${splitOrder > 0 ? ' in-split' : ''}`}
      // One gesture only: clicking a chat opens it (and, in split view, puts it in
      // the next free slot). "Add without switching focus" was a made-up gesture
      // with no real use case; removing a chat lives on the pane's ✕ / right-click.
      onClick={() => onSwitch(session.id)}
      onContextMenu={(e) => onContextMenu(e, session.id)}
      {...attributes}
      {...listeners}
    >
      {splitOrder > 0 && (
        <span
          className="session-split-order"
          title={t('Split pane {n} · right-click, or the pane ✕, to remove', { n: splitOrder })}
        >{splitOrder}</span>
      )}
      {session.pinned && <span className="session-pin" title={t('Pinned')}>📌</span>}
      {/*
        画布会话那个 🧩 挪到了**右边**那排标记里 —— 「你把 flow 那个 tag 加到会话的右侧，不是左侧」。
        左边这一段是「这一行本身」的东西（分屏序号、📌、状态灯），而 flow 的身份和 worker 的 tag、子代理计数、
        定时器一样，都属于右边那排「它现在是什么状态」。
      */}
      <span className={`session-dot ${sessionStatus}`} title={dotTitle}>
        {sessionStatus === 'streaming' && <><span /><span /><span /></>}
        {/* Rotating arc: unmistakably "work in progress on the history", and not
            the green idle light nor the green reply animation. */}
        {sessionStatus === 'rebuilding' && <span className="session-dot-arc" />}
      </span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {session.title}
      </span>
      {/* The row shows `short` (a countdown, or 已暂停) and carries the full sentence as its
          tooltip: there is no space here for "每天 09:00 · 3 小时 12 分后 · 已运行 2/20", and a
          row that showed nothing was the reason a scheduled chat looked ordinary from outside. */}
      {/*
        子代理在跑的标记 —— 「如果有subagent在运行左侧的会话上也应该有一个tag，直到subagent被关掉」。
        计数只算还没 terminated 的那些；名单是 kiro 自己报的（名字 / worker agent / 状态都在 title 里）。
      */}
      {crew && (
        <span className="session-crew" title={`${t('{n} subagent(s) running:', { n: crew.count })}\n${crew.title}`}>
          🤖 {crew.count}
        </span>
      )}
      {scheduleSummary && (
        <span
          className={`session-schedule${scheduleSummary.paused ? ' paused' : ''}${scheduleSummary.hasError ? ' failing' : ''}`}
          title={scheduleSummary.text}
        >
          {scheduleSummary.paused ? '⏸️' : '⏰'} {scheduleSummary.short}
        </span>
      )}
      {/*
        **这一行跑在哪台机器上** —— 远程会话（`docs/DESIGN_remote_sessions.md`）。
        放在右边那排的**最末**（紧挨删除按钮）——「把 remote 的会话的 tag 放到右侧」。
        它和子代理计数、定时器不同：那两个是"此刻在发生什么"，会来会走；而"这条会话跑在哪台机器上"
        是这条会话的**身份**，从建立到删除都不变。所以给它一个固定的位置，眼睛每次都往同一处看。
        常驻：任何时候都不该去猜这一轮在哪台机器上跑 —— 猜错的代价是对着另一台机器的文件下结论。
      */}
      {/* 不挂引擎 tag ——「左侧会话框不要显示 claude 这个 tag，你应该显示的仍然是远程 tag」。引擎在会话界面左下角看 */}
      {pendingTarget !== undefined ? (
        <span className="session-remote session-remote-switching" title="正在切换运行位置…">
          ⏳ {pendingTarget || '本地'}
        </span>
      ) : session.remoteHost && (
        <span
          className="session-remote"
          title={`这条会话的 kiro-cli 跑在 ${session.remoteHost} 上；文件仍然在你这台机器上 ——`
            + `它通过一条反向隧道调本地工具来读写（不复制文件）。`}
        >
          🌐 {session.remoteHost}
        </span>
      )}
      <button className="session-delete-btn" onClick={(e) => onDelete(e, session.id)} title={t('Delete')}>
        ✕
      </button>
    </div>
  );
};

// A project group. Real projects are drop targets for write-once assignment;
// the Unassigned bucket is NOT (you cannot un-assign — design §6.4).
const ProjectGroup: React.FC<{
  name: string;
  projectKey: string;
  isDropTarget: boolean;
  actionable: boolean; // real projects get kebab + new-chat; Unassigned does not
  showCount?: boolean; // hide the count badge (e.g. for the Archived group)
  sessions: Session[];
  collapsed: boolean;
  currentSessionId: string | null;
  statusFor: (id: string) => SessionStatus;
  busyFor: (id: string) => string | null;
  onToggle: (key: string) => void;
  onSwitch: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  onDelete: (id: string) => void;
  onNewChat: (project: string) => void;
  onProjectMenu: (e: React.MouseEvent, project: string) => void;
  splitOrder?: (id: string) => number;
  onToggleSplit?: (id: string) => void;
  /** Looked up per row rather than passed as a map, matching `statusFor`/`busyFor`. */
  scheduleFor?: (id: string) => ScheduleSummary | null;
  /** kiro 原生子代理，按会话查 —— 行上那面 tag 就是它，同样是查函数而不是 map */
  subagentsFor?: (id: string) => SubagentRow[] | undefined;
  /** Open this project's workspace. NOT `onOpenWorkspace` — that name is already taken by the
   *  sidebar's FILE workspace button, and two things called the same would be read as one. */
  /** 这个 project 处于 flow 管理模式吗 —— 头上那个 🧩 就是它（见下面那段注释）。 */
  /** 这个 project 挂着的那些 flow —— 🧩 旁边那个名字,和 ⋮ 菜单里那一节同源。 */
}> = ({ name, projectKey, isDropTarget, actionable, showCount = true, sessions, collapsed, currentSessionId, statusFor, busyFor, onToggle, onSwitch, onContextMenu, onDelete, onNewChat, onProjectMenu, splitOrder = () => 0, onToggleSplit, scheduleFor, subagentsFor}) => {
  const t = useT();
  const { setNodeRef, isOver } = useDroppable({ id: `project:${projectKey}`, disabled: !isDropTarget });
  // Reorder drag lives on a DEDICATED grip, not the whole header: putting the drag
  // listeners on the header itself would swallow the collapse click, the kebab and
  // the new-chat button. Only real projects are reorderable (the Unassigned and
  // Archived buckets are fixed in place, always last).
  const {
    attributes: gripAttrs,
    listeners: gripListeners,
    setNodeRef: setGripRef,
    isDragging: gripDragging,
  } = useDraggable({ id: `projorder:${name}`, disabled: !actionable });

  return (
    <div ref={setNodeRef} className="project-group">
      <div
        className={`project-header ${isOver && isDropTarget ? 'folder-drop-target' : ''} ${gripDragging ? 'project-header-dragging' : ''}`}
        onClick={() => onToggle(projectKey)}
      >
        {/*
          **拖拽把手那一格永远占位** ——「右边的数字应该和 project 的数字对齐」。
          未分组/已归档没有把手（它们不能重排），原来是整块不渲染，于是这两行比 project 行少一截左缩进，
          右边的计数也就跟着错开一格。现在没有把手时留一个同宽的空位。
        */}
        {actionable ? (
          <span
            ref={setGripRef}
            className="project-drag-handle"
            title={t('Drag to reorder projects')}
            onClick={(e) => e.stopPropagation()}
            {...gripAttrs}
            {...gripListeners}
          >
            ⋮⋮
          </span>
        ) : (
          <span className="project-drag-handle project-drag-handle-placeholder" aria-hidden />
        )}
        <span className="folder-arrow">{collapsed ? '▶' : '▼'}</span>
        {/*
          **未分组不要文件夹图标** ——「我觉得未分组不要那个文件夹的 icon 了」：
          它不是一个文件夹，是"还没归进任何文件夹"的那一堆。图标那一格照样留着，
          否则名字和右边的计数又会比 project 行错开。
        */}
        {actionable ? <ProjectFolderIcon /> : <span className="folder-icon-placeholder" aria-hidden />}
        <span className="folder-name">{name}</span>
        {showCount && <span className="project-count">{sessions.length}</span>}
        {/*
          project 行上那个 ▸(打开工作台)去掉了 —— 「project那里不要放那个什么run按钮」。
          一行里已经有拖拽把手、箭头、图标、计数和 ⋮,再多一个只在有 flow 时才有意义的按钮,谁也看不出它是干什么的。
          进运行页的路仍然有两条:⋮ 菜单里「这个 project 的 flow」点一条,或者点它某一步的 worker 会话。
        */}
        {actionable && (
          <>
            <button
              className="project-action-btn"
              title={t('Project options')}
              onClick={(e) => { e.stopPropagation(); onProjectMenu(e, name); }}
            >
              <KebabIcon />
            </button>
          </>
        )}
      </div>
      {/*
        **在跑的会话不许被折叠藏起来** ——「那个 AI 的会话还在跑但是左侧没有了」/「为什么 dev 是折叠的」。
        实测：它被移进 `Dev`，而 `Dev` 是折叠的 —— 一条正在流式输出的会话就这么从侧栏消失了，
        而"它还在跑"恰恰是你最需要看到它的时候。折叠状态照旧（那是你的选择），
        但**正在跑的那几条照样渲染出来**。
      */}
      {collapsed && sessions.some((s) => statusFor(s.id) === 'streaming' || statusFor(s.id) === 'rebuilding') && (
        <div className="folder-children folder-children-running">
          {sessions.filter((s) => statusFor(s.id) === 'streaming' || statusFor(s.id) === 'rebuilding').map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              isActive={s.id === currentSessionId}
              sessionStatus={statusFor(s.id)}
              busyReason={busyFor(s.id)}
              onSwitch={onSwitch}
              onContextMenu={onContextMenu}
              onDelete={(e, id) => { e.stopPropagation(); onDelete(id); }}
              splitOrder={splitOrder(s.id)}
              onToggleSplit={onToggleSplit}
              scheduleSummary={scheduleFor?.(s.id) ?? null}
              subagents={subagentsFor?.(s.id)}
            />
          ))}
        </div>
      )}
      {!collapsed && (
        <div className="folder-children">
          {actionable && (
            <div
              className="project-newchat"
              onClick={(e) => { e.stopPropagation(); onNewChat(name); }}
            >
              <PlusSquareIcon />
              <span>{t('New chat in project')}</span>
            </div>
          )}
          <SortableContext items={sessions.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            {sessions.map((s) => (
              <SessionItem
                key={s.id}
                session={s}
                isActive={s.id === currentSessionId}
                sessionStatus={statusFor(s.id)}
                busyReason={busyFor(s.id)}
                onSwitch={onSwitch}
                onContextMenu={onContextMenu}
                onDelete={(e, id) => { e.stopPropagation(); onDelete(id); }}
                splitOrder={splitOrder(s.id)}
                onToggleSplit={onToggleSplit}
                scheduleSummary={scheduleFor?.(s.id) ?? null}
                subagents={subagentsFor?.(s.id)}
              />
            ))}
          </SortableContext>
        </div>
      )}
    </div>
  );
};

export const Sidebar: React.FC<SidebarProps> = ({
  sessions,
  onWarmProject,
  projectWorkspace,
  onSetProjectWorkspace,
  projects,
  currentSessionId,
  status,
  streamingSessionIds,
  attachedSessionIds,
  busyBySession,
  connectingSessionIds,
  failedSessionIds,
  unreadSessionIds,
  subagentsBySession,
  executorCap,
  onNewSession,
  onCreateProject,
  onReorderProjects,
  onNewSessionInProject,
  onRenameProject,
  onDeleteProject,
  onSwitchSession,
  onDeleteSession,
  onRebuildContext,
  onRenameSession,
  onTogglePin,
  splitOrder = () => 0,
  onToggleSplit,
  scheduleFor,
  onAssignProject,
  onMoveSession,
  onReorderSessions,
  onArchiveSession,
  onSettings,
  onOpenBackup,
  backupState,
  workspaceOpen,
  onOpenWorkspace,
  onOpenLogs,
  onOpenMemory,
}) => {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; targetId: string } | null>(null);
  const [renamePopup, setRenamePopup] = useState<{ id: string; value: string } | null>(null);
  const [assignPopup, setAssignPopup] = useState<{ sessionId: string } | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ x: number; y: number; project: string } | null>(null);
  const [projectRenamePopup, setProjectRenamePopup] = useState<{ project: string } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const t = useT();
  /** 为什么刚才那一拖没生效 —— 静默拒绝会被当成「拖不动」 */
  const [dropRefusal, setDropRefusal] = useState<string | null>(null);
  /**
   * 搜会话的查询词。**现在没有入口了**（那个输入框按要求去掉了），所以它恒为空串 ——
   * 于是 `searchSessions` 恒返回 `idle`，侧栏显示完整列表、折叠规则照旧。
   * 留着这个变量而不是把过滤代码一并删掉：判据本身是对的，换入口时不必重写。
   */
  const [query] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  /**
   * IDLE PROJECTS START COLLAPSED — 「如果7天project没有活动就自动折叠」.
   *
   * Computed once, from the sessions present when the sidebar first has them: recomputing would fight the
   * user, snapping a project they just expanded shut again. Expanding is what connects it.
   */
  /*
    **重新加载画面时保留你折叠的那些组** ——「重新加载画面的时候能不能不把我之前折叠的侧栏打开」。
    折叠原来只活在这个组件的 state 里，reload 一次就按冷热重算一遍。现在经 `restoreGet`：设置里
    「重启后恢复界面状态」开着（默认）就连重启也保留；关了只活过 reload，重启时照旧按 `projectsToCollapse` 算。
  */
  const restoredCollapse = useRef<string[] | null>((() => {
    const list = restoreGetJson<unknown>(COLLAPSED_KEY);
    return Array.isArray(list) ? list.map(String) : null;
  })());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(restoredCollapse.current || []));
  const autoCollapsed = useRef(false);
  useEffect(() => {
    if (!autoCollapsed.current) return;   // 自动折叠那一遍之前别存（存进去的是一个还没算的空集合）
    restoreSet(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  }, [collapsed]);
  /** kiro trace 日志开着吗（见下面那个 ⚑）—— 跟着 `kirolex:features-changed` 刷新 */
  const [traceOn, setTraceOn] = useState(kiroTraceOn());
  useEffect(() => {
    const sync = () => setTraceOn(kiroTraceOn());
    sync();
    window.addEventListener('kirolex:features-changed', sync);
    /* 开屏时 features 还没取回来，等一拍再读一次 */
    const t = setTimeout(sync, 1500);
    return () => { window.removeEventListener('kirolex:features-changed', sync); clearTimeout(t); };
  }, []);
  /**
   * 启动时**只留热的那个 project 展开**，别的全折起来 —— 「把不用的 project 折叠起来断掉会话，省占用」。
   *
   * 原来这里按 `idleProjects`（7 天没动过）折，而预热那侧已经收紧到「只热上一个活跃的 project」——
   * 于是多出一类**展开着但是冷的**：没到 7 天所以不折，但也不预热了，点上去一片灰点。而这个机制的
   * 不变量本来就是「折起来 = 冷的，展开 = 热的」，两个判据分开那一刻就破了。
   *
   * 所以折叠不再自己判时间，直接用 `projectsToCollapse` —— 和 `sessionsToWarm` 同一份答案，
   * 包括「你落在哪条会话上」这一层（`currentSessionId`，也就是启动时恢复的那条）。
   */
  /**
   * 自动折叠那一刻的 `collapsed` 对象 —— 给下面的预热判「自动折叠落到 state 上了没有」：
   * `collapsed` 换成了别的对象 = 那次 `setCollapsed` 已经生效（哪怕同一轮里又有组被自动展开摘掉了）。
   * 没有要折的（或 reload 回来沿用上次的折叠，它从一开始就在 state 里）就是 null，不用等。
   */
  const collapsedBeforeAuto = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (autoCollapsed.current || sessions.length === 0) return;
    autoCollapsed.current = true;
    /* reload 回来的：用你上次的折叠，不重算 */
    if (restoredCollapse.current) return;
    const cold = projectsToCollapse(sessions, { now: Date.now(), keepId: currentSessionId });
    if (cold.length) {
      collapsedBeforeAuto.current = collapsed;
      setCollapsed((prev) => new Set([...prev, ...cold]));
    }
  }, [sessions, currentSessionId]);

  /**
   * OPENING A PROJECT WARMS IT — 「不折叠的时候就自动预热」。
   *
   * 启动那一遍**只登记、不预热**：启动时该热什么已经由 `sessionsToWarm` 决定了（它只热「上一个活跃的
   * project」），这里再把展开着的全热一遍就把那份收紧抵消掉了，每个约 0.4 GB。
   * 之后任何一个 project 只要**此刻展开着**、这次运行里还没热过，就预热它整组。
   *
   * 判据原来是「折叠 → 展开的**跃变**」——「为什么 blog 这个 project 打开的时候没有预热」。跃变靠
   * 「上一次渲染时它是折叠的」这个记忆，而这个 effect 的依赖里有 `onWarmProject`（App 里是**内联箭头**，
   * 每次渲染都是新引用），于是它每次渲染都跑、每跑一遍就把"上一次"覆盖掉。中间插一次与折叠无关的重渲染
   * （会话状态、标题、busy 都算），那次跃变就被吃掉了 —— 而 `warmed` 里又没记录，这个 project 在这次
   * 运行里**再也不会**被预热。所以改按状态判：「展开着 = 该是热的」本来就是这个机制的不变量。
   *
   * `warmed` 保证每个 project 每次运行只热一次，不会在重渲染里变成 spawn 循环。
   * 判据本身在 `projectsToWarmNow`（含启动那一遍怎么记账、等什么），那里有状态顺序的行为测试。
   */
  const warmed = useRef<Set<string>>(new Set());
  const warmBaselined = useRef(false);
  useEffect(() => {
    if (!onWarmProject || !autoCollapsed.current) return;
    const projects = [...new Set(sessions.map((s) => (s.projectId || '').trim()).filter(Boolean))];
    /* `setCollapsed` 是异步的：自动折叠那一轮里这里看到的还是折叠前的对象，要等它换掉 */
    const landed = collapsed !== collapsedBeforeAuto.current;
    const ledger = { warmed: warmed.current, baselined: warmBaselined.current };
    const toWarm = projectsToWarmNow(projects, collapsed, ledger, landed);
    warmBaselined.current = ledger.baselined;
    for (const project of toWarm) onWarmProject(project);
  }, [collapsed, sessions, onWarmProject]);
  /*
    **有活动会话的组自动展开** ——「我为什么新建 new chat 的时候未分组是折叠的，只要有活动会话所有项目和未分组都应该自动展开」。
    原来折叠只在启动时算一次（只留热的那个 project 展开），之后新建的会话、开始跑的会话所在的组照样折着。
    "活动" = 当前这条、在分屏里、连着（attached）或者正在跑。判据是**新变成活动的那条**所在的组：
    已经活动着的组你手动折起来，不会被立刻弹开；只有它里面又有会话变成活动时才展开。
    自动展开**不算**你点开的，所以不触发整组预热（预热那段只认"你真的点开了它"）—— 否则一条活动会话会把整组都连上。
  */
  const prevActiveIds = useRef<Set<string> | null>(null);
  /*
    reload 之后的头一阵子不算"新变成活动"：那时各条会话在重新连上（attached）、在跑的那轮被接回来
    （streaming）—— 它们不是刚开始活动，只是窗口刚知道。算进去的话，你折起来的组 reload 一次全被弹开。
  */
  const settleUntil = useRef(restoredCollapse.current ? Date.now() + 15000 : 0);
  useEffect(() => {
    if (!autoCollapsed.current) return;
    const active = new Set(sessions.filter((s) => !s.archived && (
      s.id === currentSessionId
      || (splitOrder?.(s.id) || 0) > 0
      || attachedSessionIds.includes(s.id)
      || streamingSessionIds.includes(s.id)
    )).map((s) => s.id));
    const prev = prevActiveIds.current;
    prevActiveIds.current = active;
    if (Date.now() < settleUntil.current) return;
    const groups = new Set<string>();
    for (const s of sessions) {
      if (active.has(s.id) && (!prev || !prev.has(s.id))) groups.add(s.projectId || UNASSIGNED);
    }
    if (!groups.size) return;
    for (const g of groups) warmed.current.add(g);   // 自动展开不触发整组预热
    setCollapsed((cur) => {
      if (![...groups].some((g) => cur.has(g))) return cur;
      const next = new Set(cur);
      for (const g of groups) next.delete(g);
      return next;
    });
  }, [sessions, currentSessionId, attachedSessionIds, streamingSessionIds, splitOrder]);

  const newProjectRef = useRef<HTMLInputElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  useEffect(() => {
    const handler = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener('click', handler);
      return () => document.removeEventListener('click', handler);
    }
  }, [contextMenu]);

  useEffect(() => {
    const handler = () => setProjectMenu(null);
    if (projectMenu) {
      document.addEventListener('click', handler);
      return () => document.removeEventListener('click', handler);
    }
  }, [projectMenu]);

  useEffect(() => {
    if (creatingProject) newProjectRef.current?.focus();
  }, [creatingProject]);

  // Per-session dot priority: streaming (working, any session) > connecting >
  // unread (finished in background) > live (ONLY the current session, and only
  // once its executor is attached) > dormant. Solid green never lingers on an
  // unselected chat — background activity shows as streaming/unread instead.
  const busyFor = (id: string): string | null => busyBySession?.[id] || null;
  const statusFor = (id: string): SessionStatus => {
    const busy = busyBySession?.[id];
    // Rebuild states are checked FIRST and get their own light. Two reasons:
    // 'prime-pending' used to fall through to idle/warm, i.e. a STATIC GREEN dot
    // on a chat that is actually locked and owes a rebuild -- the one state that
    // must never look "connected and idle". And 'priming' previously borrowed the
    // normal turn animation, so a rebuild was indistinguishable from a reply.
    if (busy === 'priming' || busy === 'prime-pending') return 'rebuilding';
    if (streamingSessionIds.includes(id)) return 'streaming';
    // Backend occupancy reported by main: the dot must show it even when this
    // renderer has no local streaming/connecting state for that session.
    if (busy === 'turn') return 'streaming';
    if (busy === 'reconfiguring' || busy === 'attaching') return 'connecting';
    if (connectingSessionIds.includes(id)) return 'connecting';
    /*
      **连不上 → 红**（在 unread/dormant 之前判）。下面那段注释说的"还没 attach 不该报警"仍然成立 ——
      这里判的不是"没连"，是"连过、失败了"（`failedSessionIds` 只在真的抛错时才加，成功就摘）。
    */
    if (failedSessionIds?.includes(id)) return 'alert';
    if (unreadSessionIds.includes(id)) return 'unread';
    const attached = attachedSessionIds.includes(id);
    if (id === currentSessionId && attached) return 'idle';   // focused + live
    if (attached) return 'warm';                              // background, live/ready
    // Not attached: an archived chat is deliberately inert (neutral). A pending
    // fork/new chat has no backend executor until its first message — that is
    // expected, not an error, so show it neutral (dormant) rather than red alert.
    if (String(id).startsWith('pending_')) return 'dormant';
    // Any other not-yet-attached chat is a NORMAL idle state: it attaches on open
    // (or via background eager-warm), so it must not look broken. Show it neutral
    // (dormant/grey), never the alarming orange 'alert' — attached chats are the
    // only ones that go green (warm/idle).
    return 'dormant';
  };

  /**
   * **换机器** ——「AI角色扮演这个应该是远程的」。
   *
   * 直接在这里拿列表、在这里调 IPC：这个动作只有右键菜单用，从 App 一层层传 prop 只会多两处
   * 可以漏掉的地方（`remoteHost` 那次就是在水化的白名单里漏掉的）。
   *
   * **不问目录**：有项目的会话镜像它的项目目录，没项目的镜像它自己的会话目录（和本地那条路一样）——
   * "必须先指定一个项目目录"是上一版加错的要求，把"必须镜像点什么"和"必须有个项目"混成了一件事。
   */
  const remoteTargets = useRemoteTargets().targets;
  /** 换引擎（kiro / Claude Code / Codex）。失败要说出来 —— 它会换执行器，静悄悄失败只会被当成"点了没反应"。 */
  const onSetEngine = async (sessionId: string, engine: 'kiro' | 'claude' | 'codex'): Promise<void> => {
    const api = (window as any).kiroApi;
    if (!api?.switchEngine) return;
    /* 带上项目：还没连上过的新会话没有记录，主进程要给它建一份（见主进程 coldRecordFor） */
    const projectId = sessions.find((s) => s.id === sessionId)?.projectId ?? null;
    const r = await api.switchEngine(sessionId, engine, { projectId }).catch((e: any) => ({ ok: false, error: e?.message || String(e) }));
    if (!r?.ok) showToast(`✗ 切换引擎失败：${String(r?.error || '原因不明').replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
  };
  const onSetTarget = async (sessionId: string, remoteId: string | null): Promise<void> => {
    const api = (window as any).kiroApi;
    if (!api?.setRemoteTarget) return;
    setPendingTarget(sessionId, remoteId ? (remoteTargets.find((t) => t.id === remoteId)?.label || remoteId) : null);
    const projectId = sessions.find((s) => s.id === sessionId)?.projectId ?? null;
    const r = await api.setRemoteTarget(sessionId, remoteId, undefined, { projectId })
      .catch((e: any) => ({ ok: false, error: e?.message || String(e) }))
      .finally(() => setPendingTarget(sessionId, undefined));
    /* 失败要让人看见：这个动作会换执行器，静悄悄失败的话人只会以为"点了没反应" */
    if (!r?.ok && !r?.unchanged) showToast(`✗ 切换运行位置失败：${String(r?.error || '原因不明').replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
  };


  const handleContextMenu = (e: React.MouseEvent, targetId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, targetId });
  };

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  // Drag a session onto a project header (or onto any session in a project) =
  // Drag to MOVE a session between projects (or onto Unassigned to unassign).
  // Executor-reset happens backend-side; a no-op (same project) is ignored.
  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;
    const sessionId = active.id as string;
    const overId = over.id as string;

    // PROJECT REORDER (grip drag). Dropping onto the Unassigned or Archived bucket
    // is refused on purpose: those two groups are rendered after the project list
    // and must stay last, so there is no valid position "below" them for a project.
    if (sessionId.startsWith('projorder:')) {
      const moved = sessionId.slice('projorder:'.length);
      let target: string | null = null;
      if (overId.startsWith('project:')) {
        const key = overId.slice('project:'.length);
        if (key === UNASSIGNED || key === ARCHIVED) return; // never below the buckets
        target = key;
      } else {
        // Dropped on a session row: use that row's project. A row in the
        // Unassigned bucket has no project -> no valid target.
        const row = sessions.find((x) => x.id === overId);
        if (!row || !row.projectId) return;
        target = row.projectId;
      }
      if (!target || target === moved) return;
      onReorderProjects?.(moved, target);
      return;
    }

    // Resolve the destination project from either a project droppable (incl.
    // the Unassigned bucket -> null) or a session row (use that row's project).
    let targetProject: string | null = null;
    let explicitDrop = false;
    if (overId.startsWith('project:')) {
      const key = overId.slice('project:'.length);
      targetProject = key === UNASSIGNED ? null : key;
      explicitDrop = true;
    } else {
      const row = sessions.find((x) => x.id === overId);
      if (row) { targetProject = row.projectId || null; explicitDrop = true; }
    }
    if (!explicitDrop) return;
    const dragged = sessions.find((x) => x.id === sessionId);
    if (!dragged || dragged.id.startsWith('pending_')) return;
    // An archived chat must only leave the archive through the explicit
    // Unarchive action; a stray drag must never silently unarchive it (the
    // backend move handler clears the archived flag).
    if (dragged.archived) return;
    if ((dragged.projectId ?? null) === targetProject) {
      /*
        **同一组里拖 = 调顺序** ——「现在拖拽会话不能调整其前后顺序，这个不对」。
        这里原来直接 `return`（"没换项目 = 没变化"），于是组内拖动放下就弹回原位。
        只在落到**另一条会话**上时才动：落在组头上没有"放在谁前面"可言。
      */
      if (overId === sessionId || overId.startsWith('project:')) return;
      const from = sessions.findIndex((x) => x.id === sessionId);
      const to = sessions.findIndex((x) => x.id === overId);
      if (from < 0 || to < 0) return;
      onReorderSessions?.(arrayMove(sessions, from, to));
      return;
    }
    /**
     * 挂着 skill 的 project 由流程管理：会话是「主会话 + 每步一个」，拖进来的会话不属于任何一步，
     * 回收规则看不见它 —— 所以这里直接拒，并把原因说出来而不是静默不动。
     */
    moveInto(sessionId, targetProject);
  };

  /**
   * 搬会话进一个组 —— **顺手把那个组展开**，「移到 dev 之后 dev 没有自动展开，这个不应该」。
   *
   * 多数 project 是折起来的（启动时只留热的那个展开，见 `projectsToCollapse`），所以往一个折起来的组里
   * 搬东西，界面上的结果是**那条会话当场消失**：它从原来的位置被拿走，而新位置是收起的。你既看不到它
   * 去哪了，也无从确认这次搬动成功了。所有搬动入口（拖放、「移动项目」子菜单、恢复到未分组、指派弹窗）
   * 都走这里，下一个入口才不会漏。展开也会让那一组按「展开 = 热的」被预热（见上面那个 effect）。
   *
   * 未分组（`targetProject === null`）也一样展开：那也是个可折叠的组。
   */
  const moveInto = (sessionId: string, targetProject: string | null) => {
    const key = targetProject ?? UNASSIGNED;
    setCollapsed((prev) => {
      if (!prev.has(key)) return prev;                    // 本来就是开着的，别白改一次状态
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    onMoveSession(sessionId, targetProject);
  };

  // Pinned sessions float to the top of their group.
  const sortForDisplay = (arr: Session[]) =>
    [...arr].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

  // Archived sessions are pulled out of the normal groups into their own
  // collapsible section; everything else groups as usual.
  /**
   * SEARCH FILTERS WHAT THE GROUPS SEE, and opens the groups that have hits.
   *
   * Filtering here rather than inside each group keeps one source of truth for 「什么是命中」 — and the collapse
   * override matters because most projects are folded (untouched for a week), so a match inside one would
   * otherwise be invisible and the search would read as 「找不到」.
   */
  const search = searchSessions(sessions, query);
  const visible = search.idle ? sessions : search.hits;
  const hiddenByQuery = sessions.length - visible.length;
  /**
   * 搜索期间全部展开。上一版按「命中落在哪个 project」来决定展开谁，而那个 key 和会话身上的 projectId 并不总是
   * 同一个字符串 —— 于是「命中 1 个」的那一条留在收起的组里，你看到的是「什么都没找到」。搜索时把折叠这件事
   * 整个让开，比修一层容易再错的映射稳。
   */
  /**
   * **分屏里有会话的组一直展开** ——「我已经在分屏中的会话为什么他的 project 能被折叠呢」。
   * 分屏那几格是你此刻正在看的东西，它所属的组折起来之后，左边就没有任何东西对应屏幕上那一格。
   * 判据用 `splitOrder(id) > 0`（和会话行上那个「分屏第 N 格」角标同一个来源），所以两边永远一致。
   */
  const inSplit = (key: string) => sessions.some(
    (x) => !x.archived && (x.projectId || UNASSIGNED) === key && splitOrder(x.id) > 0,
  );
  const isCollapsed = (key: string) => (search.idle ? (collapsed.has(key) && !inSplit(key)) : false);

  const activeSessions = visible.filter((s) => !s.archived);
  const archivedSessions = sortForDisplay(visible.filter((s) => s.archived));

  // Display order = the ORDER OF `projects` (user-adjustable via the header grip),
  // NOT alphabetical. Projects discovered only from session records are appended
  // at the end so they still show up. The reserved bucket keys are excluded: the
  // Unassigned/Archived groups are rendered separately, always last, so a project
  // can never end up below them.
  const knownProjects = projects.filter((p) => p && p !== UNASSIGNED && p !== ARCHIVED);
  const fromSessions = (activeSessions.map((s) => s.projectId).filter(Boolean) as string[])
    .filter((p) => p !== UNASSIGNED && p !== ARCHIVED && !knownProjects.includes(p));
  const assignedProjects = Array.from(new Set([...knownProjects, ...fromSessions]));

  const unassigned = sortForDisplay(activeSessions.filter((s) => !s.projectId));

  const confirmNewProject = () => {
    if (newProjectName.trim()) onCreateProject(newProjectName.trim());
    setCreatingProject(false);
    setNewProjectName('');
  };

  const ctxSession = contextMenu ? sessions.find((s) => s.id === contextMenu.targetId) : undefined;

  const handleProjectMenu = (e: React.MouseEvent, project: string) => {
    e.preventDefault();
    setProjectMenu({ x: e.clientX, y: e.clientY, project });
  };

  return (
    <div className="sidebar">
      <div className="sidebar-top-btns">
        <button className="new-session-btn no-drag" onClick={onNewSession}>
          ＋ {t('New Session')}
        </button>
        <button
          className="new-project-btn no-drag"
          onClick={() => { setCreatingProject(true); setNewProjectName(''); }}
          title={t('Create a project')}
        >
          ＋ {t('New Project')}
        </button>
      </div>

      {/*
        侧栏原来在这里有一个「搜会话…」的输入框 —— 「左侧这里不要弄搜索框」，去掉了。

        **只去掉入口，不去掉能力**：过滤那一套（`searchSessions`，一个有测试的纯模块）留着，
        因为"什么算命中"和"命中的组要自己展开"这两条判据本身是对的，以后要给它换个入口（命令面板、
        顶栏）时不必重写。`query` 恒为空串 → `search.idle` 恒为真 → 侧栏就是完整列表、折叠照旧生效。
      */}
      {/* 拖拽被拒的原因：静默不动会被当成「拖不动」 */}
      {dropRefusal && (
        <div className="sb-refusal" onClick={() => setDropRefusal(null)} title={t('Dismiss')}>⚠ {dropRefusal}</div>
      )}
      <div className="session-list">
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={(e) => setActiveId(e.active.id as string)}
          onDragCancel={() => setActiveId(null)}
          onDragEnd={handleDragEnd}
        >
          {/* New project input */}
          {creatingProject && (
            <div className="project-header" style={{ background: 'var(--bg-tertiary)' }}>
              <span className="project-icon">▣</span>
              <input
                ref={newProjectRef}
                className="session-rename-input"
                value={newProjectName}
                placeholder={t('Project name…')}
                onChange={(e) => setNewProjectName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmNewProject();
                  else if (e.key === 'Escape') { setCreatingProject(false); setNewProjectName(''); }
                }}
                onBlur={confirmNewProject}
              />
            </div>
          )}

          {/* Project groups (drop targets for write-once assignment) */}
          {assignedProjects.map((pName) => (
            <ProjectGroup
              key={pName}
              name={pName}
              projectKey={pName}
              isDropTarget
              actionable
              sessions={sortForDisplay(activeSessions.filter((s) => s.projectId === pName))}
              collapsed={isCollapsed(pName)}
              currentSessionId={currentSessionId}
              statusFor={statusFor}
            busyFor={busyFor}
              onToggle={toggle}
              onSwitch={onSwitchSession}
              onContextMenu={handleContextMenu}
              splitOrder={splitOrder}
              onToggleSplit={onToggleSplit}
              scheduleFor={scheduleFor}
                subagentsFor={(id) => subagentsBySession?.[id]}
              onDelete={onDeleteSession}
              onNewChat={onNewSessionInProject}
              onProjectMenu={handleProjectMenu}
            />
          ))}

          {/* Unassigned bucket — ALWAYS visible (even when empty) as a drop
              target for un-assigning a chat from a project. */}
          <ProjectGroup
            name={t('Unassigned')}
            projectKey={UNASSIGNED}
            isDropTarget
            actionable={false}
            sessions={unassigned}
            collapsed={isCollapsed(UNASSIGNED)}
            currentSessionId={currentSessionId}
            statusFor={statusFor}
            busyFor={busyFor}
            onToggle={toggle}
            onSwitch={onSwitchSession}
            onContextMenu={handleContextMenu}
            splitOrder={splitOrder}
            onToggleSplit={onToggleSplit}
            scheduleFor={scheduleFor}
              subagentsFor={(id) => subagentsBySession?.[id]}
            onDelete={onDeleteSession}
            onNewChat={onNewSessionInProject}
            onProjectMenu={handleProjectMenu}
          />

          {/* Archived sessions — ALWAYS visible (even when empty), collapsed by
              default; NOT a drop target. Out of the way, not deleted. */}
          <ProjectGroup
            name={t('Archived')}
            projectKey={ARCHIVED}
            isDropTarget={false}
            actionable={false}
            showCount={false}
            sessions={archivedSessions}
            collapsed={!collapsed.has(ARCHIVED)}
            currentSessionId={currentSessionId}
            statusFor={statusFor}
            busyFor={busyFor}
            onToggle={toggle}
            onSwitch={onSwitchSession}
            onContextMenu={handleContextMenu}
            splitOrder={splitOrder}
            onToggleSplit={onToggleSplit}
            scheduleFor={scheduleFor}
              subagentsFor={(id) => subagentsBySession?.[id]}
            onDelete={onDeleteSession}
            onNewChat={onNewSessionInProject}
            onProjectMenu={handleProjectMenu}
          />

          <DragOverlay dropAnimation={null}>
            {activeId && activeId.startsWith('projorder:') ? (
              <div className="session-item drag-overlay-item">
                <span className="folder-name">{activeId.slice('projorder:'.length)}</span>
              </div>
            ) : activeId ? (
              <div className="session-item drag-overlay-item">
                <span className="session-dot idle" />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {sessions.find((s) => s.id === activeId)?.title || 'Chat'}
                </span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      {/* Session context menu: Rename / Pin-Unpin / Delete （归档的多一条「恢复」，且在最上面） */}
      {contextMenu && ctxSession && (
        <Menu x={contextMenu.x} y={contextMenu.y}>
          {/*
            RESTORE, AT THE TOP, and only for an archived chat.
            归档的会话**不能拖** —— 一次误拖就悄悄解档，所以出口只能是一个明确的动作。它放最上面是因为对一个
            归档的会话来说，「拿回来」几乎是你打开这个菜单的唯一理由；放回的是 Unassigned 而不是它原来的
            project：那个 project 可能已经不在了、或者已经挂上 skill 由流程托管，塞回去就成了没人管的会话。
          */}
          {ctxSession.archived && (
            <>
              <div
                className="context-menu-item"
                onClick={() => {
                  onArchiveSession(ctxSession.id, false);
                  moveInto(ctxSession.id, null);
                  setContextMenu(null);
                }}
              >
                {`♻️ ${t('Restore to Unassigned')}`}
              </div>
              <div className="context-menu-divider" />
            </>
          )}
          <div
            className="context-menu-item"
            onClick={() => { setRenamePopup({ id: ctxSession.id, value: ctxSession.title }); setContextMenu(null); }}
          >
            {`✏️ ${t('Rename')}`}
          </div>
          <div
            className="context-menu-item"
            onClick={() => { onTogglePin(ctxSession.id); setContextMenu(null); }}
          >
            {ctxSession.pinned ? '📌 Unpin' : '📌 Pin'}
          </div>
          {/* Deliberately NOT exposed here: 「重建上下文」(snapshot / full replay).
              It is a recovery lever for internal state -- which backend holds which
              history -- and does not map to anything a user can judge from the UI; it
              still runs AUTOMATICALLY when a backend turns out to be missing this
              chat's history. 「换一个干净后端」 was here too and is now gone entirely,
              mechanism included: it only ever existed to compensate for an oversized
              image reaching a backend, which is the wrong layer to fix that.

              A 「清除历史」 entry was here too and is gone, mechanism included: it
              deleted the stored transcript AND sent a hidden `/clear`, which is both
              irreversible from a right-click menu and redundant -- resetting the
              backend context is what the user's own `/clear` message does. */}
          {!ctxSession.id.startsWith('pending_') && (
            <div
              className="context-menu-item"
              onClick={() => { onToggleSplit?.(ctxSession.id); setContextMenu(null); }}
              title={t('Show this chat in a split pane (each pane has its own composer)')}
            >
              {splitOrder(ctxSession.id) > 0 ? `⇆ ${t('Remove from split')}` : `⇆ ${t('Add to split')}`}
            </div>
          )}
          {!ctxSession.id.startsWith('pending_') && (
            <>
              <div className="context-menu-divider" />
              {/* 项目一多，平铺的话菜单在屏幕里放不下 —— 收进一个右侧展开的子菜单（面板自己限高、滚动）。
                  入口名字固定，不带当前项目名：带上的话它看起来就像左边一个能点的项目，其实只是入口。
                  这里不放「移到未分组」，只列其他项目。 */}
              <Submenu label="🏷️ 移动项目">
                {projects.filter((p) => p !== ctxSession.projectId).map((p) => (
                  <div
                    key={p}
                    className="context-menu-item"
                    onClick={() => { moveInto(ctxSession.id, p); setContextMenu(null); }}
                  >
                    🏷️ {p}
                  </div>
                ))}
                {!projects.some((p) => p !== ctxSession.projectId) && (
                  <div className="context-menu-item disabled" onClick={(e) => e.stopPropagation()}>没有其他项目</div>
                )}
              </Submenu>
              {/*
                **换引擎** ——「我还需要现有会话也能切换 agent 运行类型」。和「运行位置」一样：
                连着就换执行器（对话不动，上下文随下一条消息带过去），没连着就只改记录。
              */}
              <div className="context-menu-divider" />
              <Submenu label={`🤖 运行引擎：${ENGINE_NAMES[ctxSession.engine || 'kiro']}`}>
                {(['kiro', 'claude', 'codex'] as const).map((eng) => (
                  <div
                    key={eng}
                    className="context-menu-item"
                    onClick={() => { void onSetEngine(ctxSession.id, eng); setContextMenu(null); }}
                    title={eng === 'kiro' ? '用 kiro-cli 跑（kiro 的模型和 agent）' : `用 ${ENGINE_NAMES[eng]} 跑（它自己的登录和默认模型）`}
                  >
                    {`${(ctxSession.engine || 'kiro') === eng ? '✓ ' : '　'}${ENGINE_NAMES[eng]}`}
                  </div>
                ))}
              </Submenu>
              {/*
                **换机器** ——「AI角色扮演这个应该是远程的」：一条已有会话应该能改成在远端跑，
                而不是"只能重新建一条"（重建会把这条对话在后端的历史扔掉）。
                只在配了远端、且 feature flag 开着时出现（`remoteTargets`）。
              */}
              {remoteTargets.length > 0 && (
                <>
                  <div className="context-menu-divider" />
                  {/*
                    **一个入口、右侧展开**：这是"这条会话在哪台机器上跑"这**一个**问题，
                    多个互斥选项；平铺的话每台机器占一行，和下面那堆 🏷️ 项目混在一起越来越难扫。
                    当前在哪儿用 ✓ 标出来。
                  */}
                  <Submenu label={`${ctxSession.remoteHost ? '🌐' : '💻'} 运行位置：${ctxSession.remoteHost || '本地'}`}>
                    <div
                      className="context-menu-item"
                      onClick={() => { void onSetTarget?.(ctxSession.id, null); setContextMenu(null); }}
                      title="切回本地跑。切之前会先把远端的改动取回来 —— 取不回来就不切。"
                    >
                      {`${ctxSession.remoteHost ? '　' : '✓ '}💻 本地`}
                    </div>
                    {remoteTargets.map((tg) => (
                      <div
                        key={tg.id}
                        className="context-menu-item"
                        onClick={() => { void onSetTarget?.(ctxSession.id, tg.id); setContextMenu(null); }}
                        title={`在 ${tg.sshHost} 上跑（文件仍在本地，每轮前后同步镜像）`}
                      >
                        {`${ctxSession.remoteHost === tg.label ? '✓ ' : '　'}🌐 ${tg.label}`}
                      </div>
                    ))}
                  </Submenu>
                  <div className="context-menu-divider" />
                </>
              )}
              <div
                className="context-menu-item"
                onClick={() => { setAssignPopup({ sessionId: ctxSession.id }); setContextMenu(null); }}
              >
                {`＋ ${t('New project…')}`}
              </div>
            </>
          )}
          {/*
            归档的会话**只有一个出口**：上面那条「恢复到 Unassigned」。

            这里原来还有一条 `♻️ Unarchive（留在原 project）`，它和上面那段注释直接冲突 ——
            那段写的是「放回的是 Unassigned 而不是它原来的 project：那个 project 可能已经不在了、
            或者已经挂上 flow 由流程托管，塞回去就成了没人管的会话」。两个 ♻️ 并排摆着，
            一个说放回 Unassigned、一个说留在原 project，等于把那个判断又交回给了菜单。

            所以归档时这一项整个不渲染，只在**没归档**时给 Archive。
          */}
          {!ctxSession.id.startsWith('pending_') && !ctxSession.archived && (
            <>
              <div className="context-menu-divider" />
              <div
                className="context-menu-item"
                onClick={() => { onArchiveSession(ctxSession.id, true); setContextMenu(null); }}
              >
                🗄️ Archive
              </div>
            </>
          )}
          <div className="context-menu-divider" />
          <div
            className="context-menu-item danger"
            onClick={() => { onDeleteSession(ctxSession.id); setContextMenu(null); }}
          >
            {`🗑️ ${t('Delete')}`}
          </div>
        </Menu>
      )}

      {/* Project kebab menu: New chat / Rename / Delete project */}
      {projectMenu && (
        <Menu x={projectMenu.x} y={projectMenu.y}>
          <div
            className="context-menu-item"
            onClick={() => { onNewSessionInProject(projectMenu.project); setProjectMenu(null); }}
          >
            {`＋ ${t('New chat in project')}`}
          </div>
          <div
            className="context-menu-item"
            onClick={() => { setProjectRenamePopup({ project: projectMenu.project }); setProjectMenu(null); }}
          >
            {`✏️ ${t('Rename project')}`}
          </div>
          {/*
            用某个 flow 在这个 project 里跑一次 —— 这里是唯一的「从零开始一次运行」入口。
            草稿列出来但点不动：没人核对过的结构不许跑（`whyNotRunnable`），而灰着并说明理由
            比干脆不显示有用 —— 后者会让人以为重新导入的东西丢了。
          */}
          {/*
            这个 project 在哪个目录里干活 —— 「加到 project 里面不就好了吗」。
            它管的是**所有**会话的 cwd（不只是 flow 的 worker）：相对路径落在哪、shell 命令在哪跑、
            写入许可以哪儿为基准。空 = 家目录。
          */}
          {onSetProjectWorkspace && (
            <>
              <div className="context-menu-divider" />
              <div
                className="context-menu-item"
                title={projectWorkspace?.(projectMenu.project)
                  ? t('Now at: {dir}', { dir: projectWorkspace(projectMenu.project) })
                  : t("Now at the home directory — click to point at a repo; this project's chats all work there")}
                onClick={() => { onSetProjectWorkspace(projectMenu.project); setProjectMenu(null); }}
              >
                {`📁 ${t('Working directory')}`}
                <span className="context-menu-hint">
                  {projectWorkspace?.(projectMenu.project) || t('(home directory)')}
                </span>
              </div>
            </>
          )}
          <div className="context-menu-divider" />
          <div
            className="context-menu-item danger"
            onClick={() => { onDeleteProject(projectMenu.project); setProjectMenu(null); }}
          >
            {`🗑️ ${t('Delete project')}`}
          </div>
        </Menu>
      )}

      {/* Two groups, not one flat row: the action buttons must reflow to a second
          line as a UNIT when the sidebar is narrow. Flat children would break at
          an arbitrary button and strand one or two on the next line. */}
      <div className="sidebar-status-bar">
        <div className="sidebar-status-info">
          <span className={`status-dot ${status}`} />
          <span className="sidebar-status-label" title={status}>{status}</span>
          {executorCap ? (
            <span className="sidebar-slot-count" title={`已连接 ${attachedSessionIds.length} / 上限 ${executorCap} 个会话执行器`}>
              {attachedSessionIds.length}/{executorCap}
            </span>
          ) : null}
        </div>
        <div className="sidebar-status-actions">
          <button
            className={`sidebar-settings-btn sidebar-workspace-btn${workspaceOpen ? ' active' : ''}`}
            onClick={onOpenWorkspace}
            title={workspaceOpen ? t('Close workspace files') : t('Open workspace files')}
            aria-label={workspaceOpen ? t('Close workspace files') : t('Open workspace files')}
            aria-pressed={workspaceOpen}
          >
            <IconWorkspaceFolder size={19} className="sidebar-workspace-icon" />
          </button>
          {/*
            Agent 配置那个按钮搬到会话界面里了（就在选 agent 的下拉旁边）——「放到会话界面，不过这个配置是全局的」。
            放在这排图标里时，它和 🧠、⚙️ 挤在一起，也看不出改的是「当前这个 agent」；而选 agent 本来就在会话那条工具栏上。
          */}
          <button className="sidebar-settings-btn" onClick={onOpenMemory} title={t('Memory')}>
            🧠
          </button>
          <button className="sidebar-settings-btn" onClick={onSettings} title={t('Settings')}>
            ⚙️
          </button>
          {/*
            **备份入口 + 状态指示是同一个按钮** —— 它要能回答"备份在跑吗、上次成了吗"。
            没配过（`backupState` 为空）时是灰的：那和"配过但失败了"必须看得出区别，
            否则"我以为它在备份"是最贵的一种误解 —— 等你需要恢复时才发现从来没传上去过。
          */}
          <button
            className={`sidebar-settings-btn sidebar-backup-btn${backupState?.error ? ' bad' : backupState ? ' ok' : ''}`}
            onClick={onOpenBackup}
            title={backupState?.error
              ? `备份上次失败了（${new Date(backupState.at).toLocaleString()}）：${backupState.error.split('\n')[0]}`
                + `\n点开是「从备份恢复」；配置在 设置 → ☁️ 备份`
              : backupState
                ? `上次备份：${new Date(backupState.at).toLocaleString()} · 传了 ${backupState.uploaded} 个文件`
                  + `\n点开是「从备份恢复」`
                : '从备份恢复会话（还没配 —— 去 设置 → ☁️ 备份）'}
            aria-label="备份"
          >
            ☁️
          </button>
          <button
            className="sidebar-settings-btn sidebar-workspace-btn"
            onClick={onOpenLogs}
            title={t('Logs')}
            aria-label={t('Logs')}
          >
            <IconLogs size={18} />
          </button>
          {/*
            **trace 开着就必须看得见** ——「配置中未发现人为启用特殊日志级别」。

            那个开关不在 kiro 的配置里（在 `~/.kirolex/kiro-trace`），所以查 kiro 一定查不到；
            而它一开就是每天十几 GB —— 实测一个执行器攥着 7.86 GB 的 kiro-chat.log。
            一个悄无声息、代价按 GB 计的开关，忘了关就是磁盘被填满，所以这里常驻一个红点，点一下就关。
          */}
          {traceOn && (
            <button
              className="sidebar-settings-btn sidebar-trace-on"
              title={'kiro-cli trace 日志**开着** —— 每天十几 GB。点一下关掉（下一次起执行器生效）'}
              aria-label="kiro trace 日志开着，点一下关掉"
              onClick={() => { void setKiroTrace(false).then((on) => setTraceOn(on)); }}
            >
              ⚑
            </button>
          )}
        </div>
      </div>

      {/* Rename popup */}
      {renamePopup && (
        <>
          <div className="overlay" onClick={() => setRenamePopup(null)} />
          <div className="rename-popup">
            <h4>{t('Rename')}</h4>
            <input
              autoFocus
              className="rename-popup-input"
              defaultValue={renamePopup.value}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const val = (e.target as HTMLInputElement).value.trim();
                  if (val) onRenameSession(renamePopup.id, val);
                  setRenamePopup(null);
                } else if (e.key === 'Escape') {
                  setRenamePopup(null);
                }
              }}
            />
            <div className="rename-popup-actions">
              <button className="rename-popup-btn cancel" onClick={() => setRenamePopup(null)}>{t('Cancel')}</button>
              <button
                className="rename-popup-btn confirm"
                onClick={() => {
                  const input = document.querySelector('.rename-popup-input') as HTMLInputElement;
                  const val = input?.value.trim();
                  if (val) onRenameSession(renamePopup.id, val);
                  setRenamePopup(null);
                }}
              >{t('OK')}</button>
            </div>
          </div>
        </>
      )}

      {/* Assign-to-new-project popup (write-once) */}
      {assignPopup && (
        <>
          <div className="overlay" onClick={() => setAssignPopup(null)} />
          <div className="rename-popup">
            <h4>{t('Move to new project')}</h4>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px' }}>
              Creates the project and moves this chat into it (its executor resets to the new memory scope).
            </p>
            <input
              autoFocus
              className="rename-popup-input assign-popup-input"
              placeholder={t('Project name…')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const val = (e.target as HTMLInputElement).value.trim();
                  if (val) moveInto(assignPopup.sessionId, val);
                  setAssignPopup(null);
                } else if (e.key === 'Escape') {
                  setAssignPopup(null);
                }
              }}
            />
            <div className="rename-popup-actions">
              <button className="rename-popup-btn cancel" onClick={() => setAssignPopup(null)}>{t('Cancel')}</button>
              <button
                className="rename-popup-btn confirm"
                onClick={() => {
                  const input = document.querySelector('.assign-popup-input') as HTMLInputElement;
                  const val = input?.value.trim();
                  if (val) moveInto(assignPopup.sessionId, val);
                  setAssignPopup(null);
                }}
              >{t('Move')}</button>
            </div>
          </div>
        </>
      )}

      {/* Rename-project popup */}
      {projectRenamePopup && (
        <>
          <div className="overlay" onClick={() => setProjectRenamePopup(null)} />
          <div className="rename-popup">
            <h4>{t('Rename project')}</h4>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px' }}>
              {t('Renames the project and relabels all its sessions.')}
            </p>
            <input
              autoFocus
              className="rename-popup-input project-rename-input"
              defaultValue={projectRenamePopup.project}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const val = (e.target as HTMLInputElement).value.trim();
                  if (val) onRenameProject(projectRenamePopup.project, val);
                  setProjectRenamePopup(null);
                } else if (e.key === 'Escape') {
                  setProjectRenamePopup(null);
                }
              }}
            />
            <div className="rename-popup-actions">
              <button className="rename-popup-btn cancel" onClick={() => setProjectRenamePopup(null)}>{t('Cancel')}</button>
              <button
                className="rename-popup-btn confirm"
                onClick={() => {
                  const input = document.querySelector('.project-rename-input') as HTMLInputElement;
                  const val = input?.value.trim();
                  if (val) onRenameProject(projectRenamePopup.project, val);
                  setProjectRenamePopup(null);
                }}
              >{t('Rename')}</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
