import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CommentBox, CommentOpener } from './CommentBox';
import { PdfView } from './PdfView';
import { pageBlocks, lineBlocks, dropSpan, displayGroups, groupAnchorOf, mdLine, spanRange, shouldBumpMark, sliceLines, spliceLines, insertAfterLines, deleteLines, patchReplyOutcome, locateBlock, backupThenSend, clearSent, createSubmitGate, submitFromBox, type ReviewBlock } from '../reviewBlocks';
import { rewritePatch, singleRange, exactKeep, type EditRange } from '../rewritePatch';
import { diffChanges, trustedChanges, remapChanges, planUndo, markLayout, UNDO_REFUSED, type AiMark, type AiMarkState } from '../aiChanges';
import { lostFields, lostFieldsByChange } from '../../main/reviseBlock.ts';
import { getAiMarks, updateAiMarks, subscribeAiMarks, aiRoundOf, beginAiRound, recordAiWrite } from '../aiMarkStore';
import { MarkdownView } from './ChatArea';
import { restoreGetJson, restoreSet } from '../uiRestore';
import { reviewSelectAll, lastInteraction, coversWhole } from '../selectAllScope';
import { putReviewItem, patchReviewItem, removeReviewItem, remapReviewLines, liveReviewItems, useReviewQueueForPath, reviewItemLine, reviewItemLost, liveMarkKey, type ReviewQueueItem } from '../reviewQueue';
import { forgetRetryTicket, rememberRetryTicket, remapResumable, resumableFrom, resumableTicket, reusableAfterReload, type Resumable } from '../reviewResume';
import { useLang, useT } from '../hooks/useLang';
import { noteVariants, t as translate, type Lang } from '../i18n';

/**
 * 走逐页预览的那些 —— `.pdf` 直接画，其余先由主进程用 LibreOffice 转成 PDF。
 * 必须和主进程 `deckPreview.CONVERTIBLE_EXTS` 那张表一致（测试钉着）：这边多一个，那个文件就会卡在
 * "转不了"；少一个，它就被甩给系统应用。
 */
export const DECK_EXTS = ['pdf', 'pptx', 'ppt', 'ppsx', 'pps', 'odp', 'docx', 'doc', 'odt', 'rtf'];
export function isDeckPath(p: string): boolean {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(p || '').trim());
  return !!m && DECK_EXTS.includes(m[1].toLowerCase());
}

/**
 * **没提交的标记活过重启** ——「右侧 comment 中有哪些内容，这个 kirolex 一重启就重置了，应该记录下来自动恢复」。
 * 按文件路径存一份（`restoreSet`：设置里「重启后恢复界面状态」开着才落盘，关着只活过 reload）。
 *
 * 文本那侧的标记挂在行号上，而重启之间文件可能被改过 —— 所以连同那一行的**原文**一起存，读回来时按原文
 * 重新找它现在在第几行（几处一样就取离原来最近的）；找不到的那条丢掉，不把意见挂到别的段上。
 */
const MARKS_KEY = 'kirolex-review-marks';

/*
  **按文件、不按 pane 的那几样** ——「为什么我点删除的时候 queue 里增加了两条消息？」
  队列是闭包，pane 卸掉（换标签、藏预览栏）它照样跑。所以它要的东西都不能放在 pane 自己身上：
    · `chains`   这份文件的「读→问→写」串行链 —— 新挂上的 pane 另起一条链的话，两条链会对同一份文件同时写；
    · `fileText` 这份文件**此刻**的正文 —— 卸掉的那个 pane 的 textRef 不再更新，拿它当底稿会把后来的改动盖掉；
    · `paneApis` 此刻挂着的那个 pane 的 setter —— 后台那条跑完要放回标记、挂原因、清草稿，得落到你看得见的那个 pane 上。
*/
const chains = new Map<string, Promise<unknown>>();
function serializeFor<T>(path: string, job: () => Promise<T>): Promise<T> {
  /* 前一个不管成没成都接着跑 —— 一次失败不该把后面排着的都堵死 */
  const next = (chains.get(path) || Promise.resolve()).then(job, job);
  chains.set(path, next.catch(() => {}));
  return next;
}
const fileText = new Map<string, string>();
/** 上一次从 props 收到的正文 —— 只有 props 真的变了才覆盖 `fileText`（落盘后、上层还没把新正文传下来的那一帧，props 还是旧的）。 */
const lastPropText = new Map<string, string>();
type PaneApi = {
  setDraftLive: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setApplyNote: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setDropped: React.Dispatch<React.SetStateAction<Record<number, true>>>;
  setWholeDraft: React.Dispatch<React.SetStateAction<string>>;
  setMarkOrder: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  setNotes: React.Dispatch<React.SetStateAction<string[] | null>>;
  typeDraft: (key: string, next: string) => void;
  clearDraft: (key: string) => void;
  setWriteWarn: React.Dispatch<React.SetStateAction<string>>;
};
const paneApis = new Map<string, PaneApi>();
/**
 * 每个（会话, 文件）**第一次提交前重新读一次** —— 主进程的写回白名单只在内存里：重启之后恢复出来的标签页、
 * 当时没读成的远端文件都不在上面，不读一次的话模型改好了也写不回去。读一次（`workspaceRead`）就按这条会话登记了。
 * 读成了记住，读不成下次提交再试；返回读不成的原因。
 */
const registered = new Set<string>();
const registerOnce = async (sessionId: string | undefined, path: string, lang: Lang = 'zh'): Promise<string | null> => {
  const key = `${sessionId || ''}\n${path}`;
  if (registered.has(key)) return null;
  try {
    await window.kiroApi.workspaceRead(sessionId, path);
    registered.add(key);
    return null;
  } catch (err: any) {
    /* 去掉 Electron 套的那层「Error invoking remote method 'workspace:read': Error: 」，只留真正的原因 */
    return String(err?.message || err || translate(lang, 'Couldn\'t read it')).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
  }
};
/** 「AI 刚改过」的编号 —— 撤销按它认那一处。标记本身按文件存在 `aiMarkStore`（pane 卸掉也还在）。 */
let aiMarkSeq = 0;
const NO_AI_MARKS: AiMarkState = { base: '', marks: [] };
/** 被取消的那些（按 ticket）—— 和队列本身一样跟着文件走，不跟着 pane。 */
const cancelledTickets = new Set<string>();
/**
 * **没做成、可以按同一次提交再来的那些** —— 路径 → 标记 → ticket + 当时的意见。主进程回了 `retrySame`
 * （那一问没拿到完整回复：网络断了、超时、被停掉 / 截断）时记下；意见一字没改再点 ✓ 就用回这张 ticket
 * （同一个 messageId，会话里不再多一条、答过的那一问也不再问一遍）。模块级：pane 卸掉还在；跟着标记落盘（`retryTickets`）。
 */
const retryTicketsByPath = new Map<string, Resumable>();
/** 这几张 ticket 的某一问没拿到完整回复（主进程回 `retrySame`）—— 失败放回标记时据此记进 `retryTicketsByPath`。 */
const retrySameTickets = new Set<string>();
/** 所有 `reviseInSession` 都走这里：记下主进程说"可以按同一次再来"的那些 ticket。 */
async function reviseVia(input: Parameters<NonNullable<typeof window.kiroApi.reviseInSession>>[0]): Promise<any> {
  return trackRetry(input.ticket, await window.kiroApi.reviseInSession?.(input));
}
/** deck 一页版面文字的改写也走同一套（`deck:revise-slide-text` 和 `review:revise-in-session` 去重规则一样）。 */
async function slideVia(input: Parameters<NonNullable<typeof window.kiroApi.deckReviseSlideText>>[0]): Promise<any> {
  return trackRetry(input.ticket, await window.kiroApi.deckReviseSlideText?.(input));
}
function trackRetry(ticket: string | undefined, res: any): any {
  if (res?.retrySame && ticket) retrySameTickets.add(ticket);
  /* 模型答了却没做成（不带 retrySame 的错误）：这张 ticket 不再沿用（`forgetRetryTicket`，在 enqueue 跑完时摘） */
  else if (ticket && res && !res.ok && !res.cancelled && res.error) finalTickets.add(ticket);
  return res;
}
/** 这几张 ticket 的结局是"模型答了却没做成"—— 跑完时从 `retryTicketsByPath` 里摘掉，再提交就是新的一次。 */
const finalTickets = new Set<string>();
/** 失败、意见放回标记 `key` 时调：这张 ticket 能按同一次再来就记下（`rememberRetryTicket`）。 */
function rememberRetry(path: string, key: string, text: string, ticket: string): void {
  if (!retrySameTickets.delete(ticket)) return;
  retryTicketsByPath.set(path, rememberRetryTicket(retryTicketsByPath.get(path) || {}, key, text, ticket));
}
/** deck 那侧「整批交给会话」的那道门 —— 按文件、不按 pane：等备份期间换了 pane 再点提交，也不会把同一批再发一遍。 */
const handoffGates = new Map<string, ReturnType<typeof createSubmitGate>>();
function handoffGateFor(path: string) {
  let g = handoffGates.get(path);
  if (!g) { g = createSubmitGate(); handoffGates.set(path, g); }
  return g;
}

/**
 * 一块的 Markdown —— **按内容记住**，内容没变就不重渲染。「为什么直接编辑文字这么卡」：每敲一个字这个 pane
 * 整个重渲染，而 `MarkdownView` 不是 memo 的 —— 一份几百块的文档，每个按键都把几百块重新解析、重新画一遍。
 */
const MdBlock = memo(({ md }: { md: string }) => <MarkdownView content={md} />);
type SavedMarks = {
  drafts: Record<string, string>;
  dropped: number[];
  whole: string;
  order: Record<string, number>;
  /** 行号 → 那一行的原文（只有文本那侧有）。 */
  anchors?: Record<string, string>;
  /**
   * **提交了、还没写进文件的那些**（标记的键）—— 它们也照标记的样子存在上面几样里。
   *
   * 「我之前提交给 ontap 这个会话的要求加一段怎么消失了」「我提交的删除也没生效」：队列跑在窗口里，
   * 一次 reload（实测是改代码触发的整页刷新）把排着的、在跑的全抹了 —— 而提交那一刻标记已经清掉了，
   * 什么都没剩。现在没写完的那些照样落盘，reload / 重启回来时**作为标记放回去**，挂一句"上次没做完"，
   * 你再提交一次就行。（在跑的那一轮回复到了也没人接，所以不能假装它会自己续上。）
   */
  interrupted?: string[];
  /** `interrupted` 里每一条是哪一张 ticket —— 回来时问主进程它是不是其实已经写完了（`review:tickets-done`）。 */
  interruptedTickets?: Record<string, string>;
  /** 没做成、可以按同一次提交再来的那些（标记 → ticket + 意见，见 `retryTicketsByPath`）—— reload 回来再点 ✓ 也还是同一次。 */
  retryTickets?: Resumable;
};
const EMPTY_MARKS = { drafts: {} as Record<string, string>, dropped: {} as Record<number, true>, whole: '', order: {} as Record<string, number>, interrupted: [] as string[], interruptedTickets: {} as Record<string, string>, retryTickets: {} as Resumable };

export function loadMarks(path: string, text: string | null): typeof EMPTY_MARKS {
  const saved = restoreGetJson<Record<string, SavedMarks>>(MARKS_KEY)?.[path];
  if (!saved || typeof saved !== 'object') return { ...EMPTY_MARKS };
  /* 旧行号 → 新行号。deck 那侧是页号，原样用 */
  const move = (line: number): number | null => {
    if (text === null) return line;
    const want = saved.anchors?.[String(line)];
    if (want === undefined) return null;
    let best: number | null = null;
    for (const b of lineBlocks(text)) {
      if (b.kind !== 'line' || b.text !== want) continue;
      if (best === null || Math.abs(b.index - line) < Math.abs(best - line)) best = b.index;
    }
    return best;
  };
  const rekey = (k: string): string | null => {
    const m = /^(\+|=|drop:)?(\d+)$/.exec(k);
    if (!m) return k;                       // `note:页`、整篇 —— 不随正文挪
    const to = move(Number(m[2]));
    return to === null ? null : `${m[1] || ''}${to}`;
  };
  const drafts: Record<string, string> = {};
  for (const [k, v] of Object.entries(saved.drafts || {})) {
    const nk = rekey(k);
    if (nk && String(v || '').trim()) drafts[nk] = String(v);
  }
  const dropped: Record<number, true> = {};
  for (const line of saved.dropped || []) { const to = move(Number(line)); if (to !== null) dropped[to] = true; }
  const order: Record<string, number> = {};
  for (const [k, v] of Object.entries(saved.order || {})) { const nk = rekey(k); if (nk) order[nk] = Number(v) || 0; }
  const interrupted: string[] = [];
  const interruptedTickets: Record<string, string> = {};
  for (const k of saved.interrupted || []) {
    const nk = rekey(String(k));
    if (!nk) continue;
    interrupted.push(nk);
    const tk = saved.interruptedTickets?.[String(k)];
    if (tk) interruptedTickets[nk] = tk;
  }
  const retryTickets: Resumable = {};
  for (const [k, v] of Object.entries(saved.retryTickets || {})) {
    const nk = rekey(k);
    if (nk && v && typeof v.ticket === 'string' && typeof v.text === 'string') retryTickets[nk] = { ticket: v.ticket, text: v.text };
  }
  return { drafts, dropped, whole: String(saved.whole || ''), order, interrupted, interruptedTickets, retryTickets };
}

function saveMarks(path: string, marks: SavedMarks | null): void {
  const all = restoreGetJson<Record<string, SavedMarks>>(MARKS_KEY) || {};
  if (marks) all[path] = marks; else delete all[path];
  restoreSet(MARKS_KEY, Object.keys(all).length ? JSON.stringify(all) : null);
}

/**
 * 看一个文本 / Markdown 文件，并**逐行（逐块）提意见** ——「像门一样增加一个评论然后提交修改」。
 *
 * 从 feature/flow 搬过来。两种文件共用一个 pane，因为它们本来是一件事：你看，然后你说哪里要改。
 *
 *   文本 / Markdown     每行一块（标题带整节、列表项带子项、围栏带整段），块和评论在一起
 *   `.pdf` / deck       `.pdf` 直接、`.pptx` 等先由主进程用 LibreOffice 转成 PDF，**pdf.js 自己画**
 *                       （每页一张 canvas，见 `PdfView` 为什么不用内置查看器）；有讲稿时讲稿和它的意见在右栏，
 *                       版面的评论入口在每页底下。`.pptx` 还能当场改一页的字/版面、改一页讲稿（要 python-pptx）
 *
 * ## 积累模式 —— 先标记，一次提交
 *
 * 「把 comment 功能做成积累模式，也就是填写的 comment 或删除先标记，不管在哪一处点确认按钮的时候一起提交修改」。
 *
 *   · **标记**：💬 框里写的字就是这一段的修改意见、＋ 框里写的是要加在这一段后面的内容、✕ 把这一段标成删除
 *     （再点一次 ↩ 取消）。写完不用按任何东西 —— 点别处框就收起，意见留在那一段下面（点它接着改，✕ 去掉）。
 *     草稿就是标记（`draftLive`），所以没有「记下」那一步。
 *   · **提交**：任何一个框里的「✓ 确认」、或者最下面的「提交」，提交的都是**全部标记**（`submitAll`）。
 *
 * 提交之后每一处排进这份文件的队列，一条一条做（读→问→写 串行，见 `serialize`）：文本那侧 ＋ → 💬 → ✕ → 整篇，
 * 都由**打开这份文件的那条会话**生成、KiroLex 写回（`reviewWriteFile`，写前备份）；位置按原文找，前面的改动
 * 挪了行号也找得到。deck 那侧当场改得了的（`.pptx` 一页的字、一页讲稿）照样当场改，改不了的（加页、删页、
 * `.pdf`、整份的意见）拼成**一条**消息发给那条会话。
 */
export const ReviewPane: React.FC<{
  path: string;
  /** 文本文件的正文。按**行**切块在 `lineBlocks` 里做。PDF / deck 不传。 */
  text?: string;
  /**
   * 这份文件在盘上最后一次变化的时间 —— **deck 靠它重取预览**。文本那侧不需要（正文是 `text` 传进来的，
   * 一变就重渲染）；deck 的 PDF 和讲稿是这里自己取的，不放进依赖的话会话改完 pptx 屏幕上还是旧那十四页。
   */
  changedAt?: number;
  /** 文件名像不像 Markdown —— 是就逐行渲染成 Markdown，否则 `<pre>` 原文。 */
  markdown?: boolean;
  /**
   * 把 KiroLex 自己改不了的那些发给**打开这份文件那条会话**（它的 `sendMessage`，不是此刻选中的那条）。
   *
   * 「是不是应该给这个 tab 记录它是从哪个会话打开的，就从这个会话提交更改」：那条会话才见过这份文件。
   * 只有 deck 那侧用（加页/删页、`.pdf`、整份的意见、改不了这一页的那种）—— 普通消息，进 transcript。
   */
  onSubmit?: (prompt: string) => void;
  /** 在不在 comment 模式。默认关 —— 大多数时候你只是想看一眼。 */
  commenting?: boolean;
  /**
   * 这个标签页的**主人会话** —— 改写在它里面问，写回也以它的名义（路径按它解析、白名单按它查）。
   * 不传就只能看：没有地方能让这些意见生效，给入口只会让人以为改了。
   */
  sessionId?: string;
  /**
   * 改完写回文件之后通知上层，把新正文交回去 —— 否则你看的还是旧那份（监听也会刷，但那要等一拍）。
   *
   * 落盘由 KiroLex 做（`reviewWriteFile`），不让那条会话自己动文件：两个写者对同一个文件
   * 要么改两遍要么互相覆盖。
   */
  onRewritten?: (text: string) => void;
}> = ({ path, text = '', markdown, onSubmit, commenting, sessionId, onRewritten, changedAt }) => {
  const t = useT();
  const lang = useLang();
  const isDeck = isDeckPath(path);
  /**
   * PDF 字节 —— **不是 blob URL / file://**：渲染层取不到 `file://`（dev 下 origin 是 localhost:5173），
   * 而 Chromium 自带的 PDF 查看器在 Electron 里是个空框（`plugins` 默认关）。字节交给 `PdfView` 自己画。
   */
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  /** `bytes` 的镜像 —— "同一份 PDF 就别重画"那个判断要读它，而它不该进 effect 的依赖。 */
  const bytesRef = useRef<Uint8Array | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  /** 每页的演讲者备注 —— PDF 里看不到它们，而讲稿正是要审的东西 */
  const [notes, setNotes] = useState<string[] | null>(null);
  /** 讲稿为什么没有（多半是没装 python-pptx）—— 说出来，而不是让那一列悄悄不见 */
  const [notesWhy, setNotesWhy] = useState('');
  /** 这份 deck 能不能当场改（只有 `.pptx`）—— 主进程说了算 */
  const [editable, setEditable] = useState(false);
  /** 转不出来的原因 + 装什么（没有 LibreOffice 时那条命令单独给，配一个复制按钮） */
  const [why, setWhy] = useState<string | null>(null);
  const [install, setInstall] = useState('');
  const [copied, setCopied] = useState(false);
  /** 上一次拿到的那份 PDF 的路径 / 内容指纹 —— 判断"这次要不要重画十四页"（改讲稿不改 PDF） */
  const lastPdfRef = useRef<string | null>(null);
  const lastHashRef = useRef<string | null>(null);
  /** 哪一块的 💬 框开着（deck：哪一页的版面框）。 */
  const [openAt, setOpenAt] = useState<number | null>(null);
  /** 哪一块后面的 ＋ 框开着 —— 和 💬 互斥（同一时刻只开一个框，见 `openBox`）。 */
  const [insertAt, setInsertAt] = useState<number | null>(null);
  /**
   * 哪一块的 **✎ 直接改** 框开着 ——「应该加一个直接修改的按钮」（门上那个「✎ 改正文」）：你自己改这一块的
   * Markdown，不经过模型。同样先标记（键 `=行号`），提交时 KiroLex 直接把这一块换成你写的那份。
   */
  const [editAt, setEditAt] = useState<number | null>(null);
  /** 讲稿那条通道哪一页的框开着。 */
  const [noteOpenAt, setNoteOpenAt] = useState<number | null>(null);
  /**
   * **标记**（= 草稿）—— 键：💬 是锚点行号 / 页号，＋ 是 `+行号`，讲稿是 `note:页`。写了字就算标记了。
   *
   * 这一层拿着、不放在 `CommentBox` 里：框挂在**别的行**下面（整节的框挂在整节末尾），上层任何一次让它
   * 重挂载的重渲染都会把框里的 `useState` 重跑一遍 —— 正在写的字当场变回空
   * （「打断了之后之前写的东西没有保存」）。提上来之后重渲染、关掉再点开都还在。
   */
  /** 上次没提交的标记 —— 「重启后恢复界面状态」（见 `loadMarks`）。只在挂载时读一次。 */
  const [initialMarks] = useState(() => {
    const m = loadMarks(path, isDeck ? null : text);
    /*
      "上次没做完"的那些里，**还在后台排 / 在跑的**不是没做完 —— 它们只是换了个 pane 在显示。不把它们当标记放回去，
      否则你下一次提交会把同一条再排一遍（实测：点了个删除，queue 里多出一条重复的改写）。
    */
    /* 按此刻的行号认（`liveMarkKey`）—— 存的时候也是按它存的，前面的改动挪过行号也对得上 */
    const live = new Set(liveReviewItems(path).filter((i) => i.persist?.key).map((i) => liveMarkKey(i)));
    if (!live.size) return m;
    for (const k of live) {
      if (k.startsWith('drop:')) delete m.dropped[Number(k.slice(5))];
      else if (k === 'whole') m.whole = '';
      else delete m.drafts[k];
    }
    m.interrupted = m.interrupted.filter((k) => !live.has(k));
    return m;
  });
  /*
    上次没做成、可以按同一次再来的那些：模块里还没有（这是 reload / 重启之后第一次打开）就从落盘的那份接上 ——
    **连同"上次没做完"的那些**（`interruptedTickets`）：reload 之后那一次可能还在跑、也可能已经因为网络失败结束了
    （那时没有窗口，收不到 `retrySame`）。先一律当成"还是那一次"记下（跟着标记落盘，再 reload 也不丢），
    下面问过主进程再把**已经写完**的、**模型答了却没做成**的摘掉（`reusableAfterReload`）。沿用是安全的：
    主进程按 messageId 去重 —— 盘上有的不再追加，答完的那一问用盘上的回复，不会再发一遍。
  */
  if (!retryTicketsByPath.has(path)) {
    const carried = resumableFrom(initialMarks.interruptedTickets, new Set(Object.values(initialMarks.interruptedTickets)), (k) => (
      k.startsWith('drop:') ? '' : k === 'whole' ? initialMarks.whole : initialMarks.drafts[k]
    ));
    const all = { ...initialMarks.retryTickets, ...carried };
    if (Object.keys(all).length) retryTicketsByPath.set(path, all);
  }
  const [draftLive, setDraftLive] = useState<Record<string, string>>(initialMarks.drafts);
  /*
    "上次没做完"的那些里，有的其实**做完了**：回复到的时候窗口不在，主进程自己拼、自己写了（`apply`）。
    问主进程一句，做完的那几条从标记里摘掉 —— 否则你再提交一次，同一处就改了两遍。
  */
  /**
   * 你再提交同一条（意见没改）时 `enqueue` 用回哪张 ticket —— 上次没做成的、reload 前没做完的都在 `retryTicketsByPath` 里
   * （还在主进程里跑的，主进程合并到原来那一次；已经结束的，按同一个 messageId 重试）。用一次就摘掉。
   */
  const takeResumable = (key: string, text: string): string | undefined => {
    /* 只看不摘：这次重试要是又没做成（远端还连不上之类），下次还得是这张 —— 做成了 / 答了却没做成才摘（见 enqueue） */
    return resumableTicket(retryTicketsByPath.get(path) || {}, key, text);
  };
  useEffect(() => {
    const byTicket = initialMarks.interruptedTickets;
    const tickets = Object.values(byTicket);
    if (!tickets.length) return;
    /* 问主进程这几张后来怎样了：写完了 / 模型答了却没做成的不再沿用（`reusableAfterReload`）；还在跑、没拿到完整回复、不知道的留着 */
    void window.kiroApi.reviewTicketsStatus?.(tickets).then((status) => {
      const drop = Object.entries(byTicket).filter(([, t]) => !reusableAfterReload(status?.[t])).map(([k]) => k);
      if (!drop.length) return;
      const cur = { ...(retryTicketsByPath.get(path) || {}) };
      for (const k of drop) if (cur[k]?.ticket === byTicket[k]) delete cur[k];
      retryTicketsByPath.set(path, cur);
    }).catch(() => {});
    void window.kiroApi.reviewTicketsDone?.(tickets).then((done) => {
      const finished = new Set(done || []);
      const keys = Object.entries(byTicket).filter(([, t]) => finished.has(t)).map(([k]) => k);
      if (!keys.length) return;
      setDraftLive((cur) => { const n = { ...cur }; for (const k of keys) if (!k.startsWith('drop:') && k !== 'whole') delete n[k]; return n; });
      setDropped((cur) => { const n = { ...cur }; for (const k of keys) if (k.startsWith('drop:')) delete n[Number(k.slice(5))]; return n; });
      if (keys.includes('whole')) setWholeDraft('');
      setApplyNote((cur) => { const n = { ...cur }; for (const k of keys) delete n[k]; return n; });
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /**
   * 每条标记**最后一次被动的先后** —— 提交按钮摆在**最新改的那一段下面**
   * （「comment 和删除的提交按钮还是在最新修改那一段落的下方就行，不要在底部单独设置按钮」）。
   * 键和标记同一套（`38` / `+38` / `note:3` / `drop:38`），值是序号，越大越新。
   */
  const [markOrder, setMarkOrder] = useState<Record<string, number>>(initialMarks.order);
  const markSeq = useRef(Math.max(0, ...Object.values(initialMarks.order)));
  /*
    只在"最新的那条"换了时才动 —— 同一个框里每敲一个字都改一次 markOrder，就是每个字多一轮整页重渲染。
    比的是此刻的 markOrder，不只是 lastBumped：提交清空、落盘挪行号之后同一个键再标要重新记（见 `shouldBumpMark`）。
  */
  const lastBumped = useRef<string | null>(null);
  const bumpMark = (key: string) => {
    if (!shouldBumpMark(markOrder, key, lastBumped.current)) return;
    lastBumped.current = key;
    setMarkOrder((cur) => ({ ...cur, [key]: ++markSeq.current }));
  };
  const draftOf = (key: string) => draftLive[key] ?? '';
  const typeDraft = (key: string, next: string) => {
    setDraftLive((cur) => ({ ...cur, [key]: next }));
    if (next.trim()) bumpMark(key);
  };
  const clearDraft = (key: string) => setDraftLive((cur) => { const n = { ...cur }; delete n[key]; return n; });
  /** 此刻的草稿 —— 等备份回来之后（异步）判断哪些还和提交时一样，见 `submitAll` 的 `clearHanded` */
  const draftRef = useRef(draftLive);
  draftRef.current = draftLive;
  /** 标了删的那些 —— 键是你点 ✕ 的那个锚点（标题就带整节，见 `spans`）/ 页号。 */
  const [dropped, setDropped] = useState<Record<number, true>>(initialMarks.dropped);
  /**
   * **AI 刚改过的那几处** —— 底色 +「AI 刚改过」+ 撤销。留到下一次提交（`submitAll` 清掉），撤销了的那处随之摘掉。
   * 行号是此刻文件里的：之后每次落盘都按 `remapChanges` 跟着挪（见 `writeBack`）。
   * **按文件存**（`aiMarkStore`），不是这个 pane 的 state —— 切文件、退出批注、切原文视图都会卸掉 pane，标记不能跟着没了。
   */
  const subscribeAi = useCallback((cb: () => void) => subscribeAiMarks(path, cb), [path]);
  const aiState = useSyncExternalStore(subscribeAi, () => getAiMarks(path) ?? NO_AI_MARKS, () => getAiMarks(path) ?? NO_AI_MARKS);
  const aiMarks = aiState.marks;
  /* 文件在 KiroLex 外面被改了（或者 pane 挂回来时正文已经变了）：标记跟着挪，被改到的那几处**留着**（撤销时说清楚，见 `remapChanges.keepTouched`） */
  useEffect(() => {
    if (isDeck) return;
    updateAiMarks(path, (cur) => (!cur || cur.base === text ? cur : { base: text, marks: remapChanges(cur.marks, cur.base, text, true) }));
  }, [text, isDeck, path]);
  /** 最下面那个「整篇的意见」框 —— 不挂在任何一段上。 */
  const [wholeDraft, setWholeDraft] = useState(initialMarks.whole);
  const wholeRef = useRef(wholeDraft);
  wholeRef.current = wholeDraft;
  /**
   * 鼠标停在哪一块上 —— **给"标题带整段"做动手前的预览**：✕ 一个标题会带走十几行，
   * 范围必须在点之前就看得见。纯 CSS 做不到：一行亮不亮取决于"盖住它的那个锚点是不是正被 hover"。
   */
  const [hoverAt, setHoverAt] = useState<number | null>(null);
  /** 刚发给会话过一条 —— 显示一句确认，而不是让界面**看起来毫无变化**（否则你会再点一次）。 */
  const [justSent, setJustSent] = useState(false);
  /** 发给会话前那次备份没成 —— 说出来，因为接下来是会话自己改文件，改坏了没有副本。 */
  const [backupWarn, setBackupWarn] = useState('');
  /** 一批正在等备份、准备交给会话 —— 说一句，免得你以为没反应又点一次（再点也不会重复发，见 `handoffGateFor`） */
  const [handingOff, setHandingOff] = useState(false);
  /** 提交前读不到这份文件（远端连不上……）—— 什么都没发，标记留着；原因摆出来，而不是让人反复点。 */
  const [writeWarn, setWriteWarn] = useState('');
  /**
   * **提交之后排着队的那些** —— 每一处一个条目，各自显示排队 / 进行中，结束各自摘掉。
   * `line` 是它**此刻**指的那一行 —— 前面的改动落盘后按 `patch.keep` 跟着挪（见 `writeBack`）。
   * deck 那侧 `line` 是页号，讲稿那条通道用 `note`（同一页的版面和讲稿各锁各的）。
   */
  type Job = ReviewQueueItem;
  /* 不是这个 pane 自己的 state —— 见 `reviewQueue.ts`：pane 换了，还在跑的那些照样看得见 */
  const jobs = useReviewQueueForPath(path);
  const jobSeq = useRef(0);
  /** 没做成的原因，按标记的键记（💬 / ＋ / 讲稿 / `drop:行` / `whole`）。 */
  const [applyNote, setApplyNote] = useState<Record<string, string>>(() => Object.fromEntries(
    /* 上次提交了、没写完就被 reload / 重启打断的那些 —— 标记已经放回去了，这里说一句为什么它们又出现了 */
    initialMarks.interrupted.map((k) => [k, t('The last submission didn\'t finish (interrupted by a window reload or restart). The marks are back; submit again.')]),
  ));

  /** 同一时刻只开一个框 —— 别的框收起，**它们写的字留着**（那就是标记）。 */
  const openBox = (kind: 'comment' | 'insert' | 'edit', at: number) => {
    setOpenAt(kind === 'comment' ? at : null);
    setInsertAt(kind === 'insert' ? at : null);
    setEditAt(kind === 'edit' ? at : null);
    setNoteOpenAt(null);
  };
  const closeBoxes = () => { setOpenAt(null); setInsertAt(null); setEditAt(null); setNoteOpenAt(null); };

  /* 换文件时把镜像清掉 —— 不清的话新文件会被"同一份"那个判断当成旧的，于是不重画 */
  useEffect(() => { lastPdfRef.current = null; lastHashRef.current = null; bytesRef.current = null; }, [path]);

  useEffect(() => {
    if (!isDeck) return;
    let cancelled = false;
    /* **只在换了文件时清空** —— 无条件清空会让每次"文件变了"都闪一下白 */
    if (lastPdfRef.current === null) { setBytes(null); setPageCount(null); setNotes(null); }
    setWhy(null);
    setInstall('');
    void (async () => {
      /**
       * 拿 PDF：**读不到就重转一次**（带 `force`），而不是把"读不到这个 PDF"甩给人看 —— 那是
       * `~/.kirolex/previews` 里我们自己的中间产物，坏了是我们的问题，原文件一直在。
       * 没有转换器（`noConverter`）就不重试：再转一次结果一样。
       */
      const fetchDeck = async (force?: boolean): Promise<any> => {
        const r: any = await window.kiroApi.previewDeck?.(sessionId, path, force);
        if (!r?.ok || !r.pdf) return { why: r?.why || t('Failed to convert to PDF'), install: r?.install || '', final: true };
        const b: any = await window.kiroApi.previewPdfBytes?.(sessionId, r.pdf);
        if (!b?.ok || !b.base64) return { why: b?.why || t('Couldn\'t read the converted PDF'), deck: r };
        return { deck: r, base64: String(b.base64) };
      };
      let got: any = await fetchDeck();
      if (!cancelled && !got.base64 && !got.final) got = await fetchDeck(true);
      if (cancelled) return;
      if (!got.base64 || !got.deck) { setWhy(got.why || t('Failed to convert to PDF')); setInstall(got.install || ''); return; }
      const res = got.deck;
      if (res.pages) setPageCount(res.pages);
      setNotes(res.notes ?? null);
      setNotesWhy(String(res.notesWhy || ''));
      setEditable(!!res.editable);
      /* **比内容，不比路径** —— 同一份 PDF 躺在哪个缓存 key 下面都一样；指纹拿不到时退回比路径 */
      const stamp = res.pdfHash || undefined;
      const same = stamp ? lastHashRef.current === stamp : lastPdfRef.current === res.pdf;
      if (same && bytesRef.current) return;
      lastPdfRef.current = res.pdf || null;
      lastHashRef.current = stamp || null;
      const bin = atob(got.base64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i);
      bytesRef.current = buf;
      setBytes(buf);
    })();
    return () => { cancelled = true; };
    /* `changedAt` 在依赖里：文件被改过就重取 PDF 和讲稿 */
  }, [path, isDeck, changedAt, sessionId]);

  const blocks: ReviewBlock[] = useMemo(
    () => (isDeck ? pageBlocks(pageCount) : lineBlocks(text)),
    [isDeck, pageCount, text],
  );
  /**
   * 显示用的分组 —— **围栏里的行合成一块**。见 `displayGroups`：不合的话每一行都单独渲染成 Markdown，
   * 一个代码块被撕成 N 个，而 ``` 那两行渲染出来是空的 `<pre>` —— 那就是「黑色空行」。
   */
  const groups = useMemo(() => (isDeck ? [] : displayGroups(blocks)), [isDeck, blocks]);
  /** 「AI 刚改过」挂在哪几块上、标记行摆在哪 —— 见 `markLayout`。 */
  const aiLayout = useMemo(() => markLayout(aiMarks, groups), [aiMarks, groups]);
  /**
   * **行号竖着居中在这一块排出来的第一行上** ——「行号现在在字号很大的时候看起来很奇怪，应该让他在排版的第一行的居中位置」。
   *
   * 纯 CSS 给不出这个位置：第一行可能是正文、可能是一个大号标题、可能是代码块里的等宽字，各自的行高和上边距
   * 都不一样，字号设置一改又全变。所以量：找这一块里第一个有字的文本节点，取它第一个字的那个框，
   * 把行号的中线对到那个框的中线上。版面一变（字号、栏宽、换文件）就重量一遍（`ResizeObserver`）。
   */
  const listRef = useRef<HTMLOListElement | null>(null);
  useLayoutEffect(() => {
    const ol = listRef.current;
    if (!ol) return;
    /*
      先全部量、再全部写：量一个写一个的话，每写一次 `style.top` 下一次读就得重新排版 —— 几百块就是几百次整页排版。
      而且一帧只量一次（ResizeObserver 在打字时框一长高就会触发）。
    */
    let frame = 0;
    const place = () => {
      const writes: Array<[HTMLElement, string]> = [];
      for (const li of Array.from(ol.children) as HTMLElement[]) {
        const no = li.querySelector(':scope > .rv-line-no') as HTMLElement | null;
        /* ✎ 正在改的那一块：行号对到框里第一行字的中线（框里没有文本节点可量，按它的内边距和行高算） */
        const ta = li.querySelector(':scope > .rv-edit-slot textarea') as HTMLTextAreaElement | null;
        if (no && ta) {
          const cs = getComputedStyle(ta);
          const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.75;
          const mid = ta.getBoundingClientRect().top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0) + lh / 2;
          writes.push([no, `${Math.round(mid - li.getBoundingClientRect().top - no.offsetHeight / 2)}px`]);
          continue;
        }
        const body = li.querySelector(':scope > .rv-review-md, :scope > .rv-review-text') as HTMLElement | null;
        if (!no || !body) continue;
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
          acceptNode: (n) => (/\S/.test(n.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
        });
        const node = walker.nextNode() as Text | null;
        if (!node) { writes.push([no, '']); continue; }
        const at = (node.nodeValue || '').search(/\S/);
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + 1);
        const r = range.getBoundingClientRect();
        if (!r.height) continue;
        const liTop = li.getBoundingClientRect().top;
        writes.push([no, `${Math.round(r.top + r.height / 2 - liTop - no.offsetHeight / 2)}px`]);
      }
      for (const [el, top] of writes) if (el.style.top !== top) el.style.top = top;
    };
    place();
    const ro = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; place(); });
    });
    ro.observe(ol);
    return () => { ro.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [groups, commenting, sessionId]);
  /**
   * **侧栏里的 Ctrl+A 只选这份文件的正文** —— 聊天区在 document 上挂着一个全局 Ctrl+A（选聊天记录）。
   * 最后一次点在 / 焦点落在侧栏里时这里先接住（window 捕获阶段，比 document 上那个早），`preventDefault`
   * 之后聊天区看到 `defaultPrevented` 就让开。焦点在输入框里时不管 —— 浏览器只全选那个框。
   * 行号、按钮、标记、意见框都是 `user-select: none`（global.css），高亮只落在正文上；复制时写**文件原文**，
   * 不靠浏览器从渲染出来的 Markdown 里拼。deck 是画出来的页，没有文字层：吞掉这一下，什么也不选。
   */
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key !== 'a' || e.defaultPrevented) return;
      const root = rootRef.current;
      const act = reviewSelectAll({
        zone: root?.closest('.workspace-file-panel') ?? root,
        last: lastInteraction(),
        active: document.activeElement as HTMLElement | null,
        deck: isDeck,
      });
      if (act === 'ignore') return;
      e.preventDefault();
      const ol = listRef.current;
      const sel = window.getSelection();
      if (act !== 'select' || !ol || !sel) return;
      const range = document.createRange();
      range.selectNodeContents(ol);
      sel.removeAllRanges();
      sel.addRange(range);
    };
    const onCopy = (e: ClipboardEvent) => {
      const sel = window.getSelection();
      if (isDeck || !e.clipboardData || !sel || sel.rangeCount !== 1) return;
      if (!coversWhole(sel.getRangeAt(0), listRef.current)) return;
      e.clipboardData.setData('text/plain', textRef.current);
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('copy', onCopy);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('copy', onCopy);
    };
  }, [isDeck]);
  /**
   * 锚点 → 它实际覆盖的行号。**代码围栏**（那一整段代码）、**标题**（它下面整节）、**列表项**（它的子项）
   * 会超过一行 ——「comment 的是标题的话应该视为整段」，所以它们进这张表。
   */
  const spans = useMemo(() => {
    const out: Record<number, number[]> = {};
    for (const g of groups) {
      const span = g.span.length > 1 ? g.span : dropSpan(blocks, g.anchor);
      if (span.length > 1) out[g.anchor] = span;
    }
    return out;
  }, [groups, blocks]);
  /** 行号 → 它所在显示组的锚点 —— 见 `groupAnchorOf`。 */
  const anchorOfLine = useMemo(() => groupAnchorOf(groups), [groups]);
  /**
   * 挂在某个锚点**覆盖范围末行**下面的东西（框、提交行、状态行）实际摆在哪一组 ——
   * 末行落在代码围栏里时换成那个围栏的锚点，因为只有组锚点才有自己的 `<li>`。
   */
  const hostOf = (anchor: number): number => {
    const span = spans[anchor];
    const last = span && span.length > 1 ? span[span.length - 1] : anchor;
    return anchorOfLine.get(last) ?? last;
  };
  /** 行号 → 是**哪一行**把它盖住的（最内层那个）。 */
  const coveredBy = useMemo(() => {
    const out = new Map<number, number>();
    for (const [anchorKey, span] of Object.entries(spans)) {
      const anchor = Number(anchorKey);
      for (const line of span) if (line !== anchor) out.set(line, anchor);
    }
    return out;
  }, [spans]);
  /**
   * 这一行在不在**那个锚点自己的 span** 里 —— 多级标题必须按"包含"判（`##` 的节包含它下面所有 `###`），
   * 不能只看 `coveredBy` 记的最内层那一个。
   */
  const covers = useCallback(
    (anchor: number | null | undefined, line: number): boolean => {
      if (anchor === null || anchor === undefined) return false;
      if (anchor === line) return true;
      return (spans[anchor] || []).includes(line);
    },
    [spans],
  );
  /** 这一行有没有被某个标了删的锚点带走（自己被标，或者在一个被标删的整节里）。 */
  const droppedBy = (line: number): number | null => {
    for (const k of Object.keys(dropped)) if (covers(Number(k), line)) return Number(k);
    return null;
  };
  /**
   * **同一份文件的改动一条一条来**。每次都是"读这份文件 → 问模型（几十秒）→ 写回去"；两条重叠的话
   * 后写的那次基于**它自己开始时读到的那一版**，先落盘的那次就被静默盖掉。主进程那道队列只管"问模型"，
   * 管不到这里的拼接和写盘，所以这里按这一份文件把整段 读→问→写 串起来。
   */
  /* 按文件串（`serializeFor`），不按 pane —— 换了 pane 也还是同一条链 */
  const serialize = useCallback(<T,>(job: () => Promise<T>): Promise<T> => serializeFor(path, job), [path]);
  /**
   * **排队的那一条要读到前一条写完之后的正文**，而不是它被提交那一刻的 —— 所以正文走一个 ref，
   * 每次真正开跑时再取。拿闭包里那份的话，第二条会对着旧文拼接，把第一条的改动整个盖掉。
   */
  const textRef = useRef(text);
  textRef.current = text;
  if (!isDeck && lastPropText.get(path) !== text) { lastPropText.set(path, text); fileText.set(path, text); }
  /** 这份文件此刻的正文 —— 排着的那些开跑时读它（见 `fileText`）。 */
  const currentText = () => fileText.get(path) ?? textRef.current;
  /**
   * 这一刻要不要显示批注控件。**没有主人会话就不给** —— 没有会话就没有地方能让这些标记生效；
   * 给一个按下去什么都不发生的入口，比明说"只能看"更糟。deck 永远算开着（PDF 本身就是阅读视图）。
   */
  const on = (isDeck || !!commenting) && !!sessionId;
  /** 这份 deck **到底有没有讲稿** —— 没有就不出右边那一栏（一列"没写备注"的空框白占地方还把页挤窄） */
  const hasNotes = !!notes?.some((t) => t.trim());
  /** 能不能当场改：有主人会话 + `.pptx`（主进程判的）。否则 deck 那侧的标记拼成一条消息发给会话。 */
  const live = !!sessionId && editable;
  const fileName = path.split(/[\\/]/).pop() || path;

  /** 一个位置的说法（跟着界面语言）：整节写范围，单行写行号 —— 框上、标记、排队那一行、会话里显示的 label 都用它。 */
  const whereAt = (from: number, to: number) => (isDeck
    ? (from !== to ? t('pages {from}–{to}', { from, to }) : t('page {n}', { n: from }))
    : (from !== to ? t('lines {from}–{to}', { from, to }) : t('line {n}', { n: from })));
  const spanWhere = (anchor: number) => {
    const span = spans[anchor];
    return span && span.length > 1 ? t('{where} (this whole section)', { where: whereAt(span[0], span[span.length - 1]) }) : whereAt(anchor, anchor);
  };
  /** 一条排着的改动做的是什么（排队那一行、会话那边的队列都用它）。 */
  const kindLabel = (kind: Job['kind']) => (kind === 'insert' ? (isDeck ? t('Add a page') : t('Add a paragraph')) : kind === 'delete' ? t('Delete')
    : kind === 'whole' ? t('Whole-document rewrite') : kind === 'note' ? t('Edit speaker notes') : kind === 'edit' ? t('Direct edit') : t('Rewrite'));

  /**
   * **全部标记** —— 提交的就是这一份。草稿里写了字的、标了删的、整篇那一框。
   * 落在一个标了删的整节**里面**的意见不算：那一节都要走了，对它改一句没有意义。
   */
  const marks = useMemo(() => {
    const revise: Array<[number, string]> = [];
    const insert: Array<[number, string]> = [];
    const note: Array<[number, string]> = [];
    const edit: Array<[number, string]> = [];
    for (const [k, v] of Object.entries(draftLive)) {
      const t = String(v || '').trim();
      if (k.startsWith('=')) {
        /* 直接改：和这一块现在的原文一样就不算改（打开框不动它不该变成一处标记）；改成空 = 不要了，那是 ✕ 的事 */
        const line = Number(k.slice(1));
        if (t && t !== blockSource(line).trim()) edit.push([line, String(v)]);
        continue;
      }
      if (!t) continue;
      if (k.startsWith('note:')) note.push([Number(k.slice(5)), t]);
      else if (k.startsWith('+')) insert.push([Number(k.slice(1)), t]);
      else revise.push([Number(k), t]);
    }
    const inDropped = (line: number) => Object.keys(dropped).some((d) => covers(Number(d), line));
    const drops = Object.keys(dropped).map(Number).sort((a, b) => a - b);
    const byLine = (a: [number, string], b: [number, string]) => a[0] - b[0];
    const edited = new Set(edit.map(([l]) => l));
    return {
      edit: edit.filter(([l]) => !inDropped(l)).sort(byLine),
      /* 同一块你自己直接改了，就不再让模型按意见改它 —— 你写的那份说了算 */
      revise: revise.filter(([l]) => !inDropped(l) && !edited.has(l)).sort(byLine),
      insert: insert.filter(([l]) => !inDropped(l)).sort(byLine),
      note: note.sort(byLine),
      drops,
      whole: wholeDraft.trim(),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftLive, dropped, wholeDraft, covers, text]);
  const markCount = marks.edit.length + marks.revise.length + marks.insert.length + marks.note.length + marks.drops.length + (marks.whole ? 1 : 0);
  const confirmLabel = markCount > 1 ? t('✓ Confirm ({n})', { n: markCount }) : t('✓ Confirm');
  const confirmTitle = t('Submit all marks: each one is queued, generated by the session that opened this file, and written back by KiroLex (⌘/Ctrl + Enter)');

  /**
   * 把 KiroLex 自己改不了的那些**一条消息**发给那条会话，由它自己改文件（deck 那侧）。
   * 先备份再发：这条路是会话自己写这个文件，走不到 `reviewWriteFile` 那道「写前拷一份」。
   * **等备份回来、成了才发**（`backupThenSend`）：没成就不发，原因摆出来，标记由调用方留着（返回 false）。
   */
  const sendToSession = async (message: string): Promise<boolean> => {
    if (!onSubmit) return false;
    const r = await backupThenSend(() => window.kiroApi.reviewBackupFile?.(sessionId, path), () => onSubmit(message));
    if (!r.ok) {
      setBackupWarn(r.why || t('Backup failed'));
      return false;
    }
    setBackupWarn('');
    setJustSent(true);
    window.setTimeout(() => setJustSent(false), 4000);
    return true;
  };

  /** 标记的键在改动之后要跟着它那一行走（`patch.keep`：旧行号 → 新行号）；对不上的就丢掉。 */
  const remapKeyed = <V,>(cur: Record<string, V>, keep: Record<number, number>, done: string): Record<string, V> => {
    const out: Record<string, V> = {};
    for (const [k, v] of Object.entries(cur)) {
      if (k === done) continue;
      const m = /^(\+|=|drop:)?(\d+)$/.exec(k);
      if (!m) { out[k] = v; continue; }   // 讲稿 `note:页`、`whole` 不随正文挪
      const toLine = keep[Number(m[2])];
      if (toLine) out[`${m[1] || ''}${toLine}`] = v;
    }
    return out;
  };

  /*
    此刻挂着的那个 pane 的 setter（见 `paneApis`）—— 后台那条跑完时，这个 pane 可能已经卸掉、换成了新的一个；
    放回标记、挂原因要落到你看得见的那一个上。一个都没挂着时落回自己（那时也没人看）。
  */
  const own: PaneApi = { setDraftLive, setApplyNote, setDropped, setWholeDraft, setMarkOrder, setNotes, typeDraft, clearDraft, setWriteWarn };
  useLayoutEffect(() => {
    paneApis.set(path, own);
    return () => { if (paneApis.get(path) === own) paneApis.delete(path); };
  });
  const livePane = (): PaneApi => paneApis.get(path) ?? own;

  /** 写回 + 报一句 + 交回上层 —— 每一处收尾都一样。 */
  /**
   * `alreadyWritten`：主进程已经拼好、写好了（`apply` 那条路，窗口不在也不丢）—— 这里只跟着刷新界面，
   * 不再写一遍，会话里那句"落盘完成"也由主进程说过了。
   * `ai`：这次是 AI 改的 —— 改了的那几处挂上「AI 刚改过」（`changes` 是主进程回的那份，对不上就自己比）。
   * `ai.lost`：这次改写删掉的字段（见 `lostOf`）—— 每一处标记只说**它自己**删掉的那几个（`lostFieldsByChange`），
   *   点它旁边的撤销，回来的正好是它说的那几个。
   * `round` 是这条任务入队时的提交轮次：已经不是当前这一轮（之后又提交过）就照常写回、不挂标记（见 `recordAiWrite`）。
   * `undid`：这次是撤销那一处 —— 它的标记摘掉。
   * `expectBase`：盘上此刻必须正好是这一份才写（主进程读、比、写一气呵成）—— 撤销用它，不会盖掉预览还没刷出来的改动。
   */
  const writeBack = async (
    base: string, fullText: string, key: string, what: string, alreadyWritten = false,
    opts: { ai?: { changes?: unknown; round: number; lost?: string[] }; undid?: number; expectBase?: string; edited?: EditRange[] } = {},
  ): Promise<boolean> => {
    if (!alreadyWritten) {
      const wrote: any = await window.kiroApi.reviewWriteFile?.(sessionId, path, fullText, opts.expectBase);
      if (!wrote?.ok && wrote?.mismatch && opts.undid !== undefined) {
        noteAiMark(opts.undid, t('This passage was changed again afterward, so it wasn\'t undone'));
        return false;
      }
      if (!wrote?.ok) {
        livePane().setApplyNote((cur) => ({ ...cur, [key]: t('Couldn\'t write to this file: {err}', { err: wrote?.error || t('unknown reason') }) }));
        return false;
      }
    }
    /*
      旧行号 → 新行号。**知道这次实际改了哪一段时按那一段算**（`exactKeep`）：只按全文文字对齐的话，两处一样的 `- TODO`
      删掉第一处之后，留下的那一处会被认成"第一处还在"，排在后面对第一处的删除就删到了第二处。
      不知道改了哪一段（主进程回的 changes 对不上）才退回全文对齐。
    */
    const edited = opts.edited ?? (opts.ai ? trustedChanges(opts.ai.changes, base, fullText)?.map((c) => ({ oldFrom: c.origFrom, oldTo: c.origTo, newFrom: c.from, newTo: c.to })) : undefined);
    const patch = edited
      ? { keep: exactKeep(base, fullText, edited) }
      : rewritePatch(
        lineBlocks(base).flatMap((b) => (b.kind === 'line' ? [{ index: b.index, text: b.text }] : [])),
        fullText,
      );
    /* 提交之后又标的那些、没做成退回来的那些、排在后面的那些 —— 全都跟着它们那一行走 */
    livePane().setDraftLive((cur) => remapKeyed(cur, patch.keep, ''));
    livePane().setMarkOrder((cur) => remapKeyed(cur, patch.keep, ''));
    livePane().setApplyNote((cur) => remapKeyed(cur, patch.keep, key));
    livePane().setDropped((cur) => {
      const out: Record<number, true> = {};
      for (const k of Object.keys(cur)) { const to = patch.keep[Number(k)]; if (to) out[to] = true; }
      return out;
    });
    remapReviewLines(path, patch.keep);
    /* 可沿用的那些（没做成、放回去的意见对应的原 ticket）也跟着它那一行走 —— 不然挪了行再提交就换了编号（`remapResumable`） */
    { const r = retryTicketsByPath.get(path); if (r) retryTicketsByPath.set(path, remapResumable(r, patch.keep)); }
    const changes = opts.ai ? (trustedChanges(opts.ai.changes, base, fullText) ?? diffChanges(base, fullText)) : [];
    const perChange = lostFieldsByChange(changes, opts.ai?.lost ?? []);
    const fresh: AiMark[] = changes
      .map((c, i) => ({ ...c, id: ++aiMarkSeq, ...(perChange[i].length ? { warn: lostWarnText(perChange[i]) } : null) }));
    recordAiWrite(path, { base, fullText, fresh, round: opts.ai?.round, undid: opts.undid });
    /*
      在会话里报一句 ——「不然不知道修改成功了没有」。报的是**已经发生的事实**（写进了哪个文件、
      做了什么），而不是让模型说一句它看不见的"已修改"。这句标成 KiroLex 自己说的话，不发给模型。
    */
    if (!alreadyWritten) {
      const note = t('✅ {what} (now {n} chars)\nFile: {path}\nKiroLex saved it to disk (backed up first to ~/.kirolex/backups/review-files/).', { what, n: fullText.length, path });
      void window.kiroApi.sessionNote?.(sessionId!, note, noteVariants(note));
    }
    textRef.current = fullText;
    fileText.set(path, fullText);
    onRewritten?.(fullText);
    return true;
  };

  /*
    这一块在**此刻**的文件里占哪一段 —— **按原文找，不按行号**（`locateBlock`，reviewBlocks.ts，纯的、有测试）。
    找的时候给的是这一条**此刻**的行号（`reviewItemLine`：队列里跟着前面的落盘挪过的那个），不是提交那一刻的 ——
    一份里有两行一样的（`- TODO`）时，拿老行号去找会对上另一处。
  */
  /** 一块在**此刻屏幕上**的原文 —— 提交那一刻记下来，排队期间行号怎么挪都按它找。 */
  const anchorTextOf = (anchor: number): string | undefined => {
    const b = blocks.find((x) => x.index === anchor);
    return b && b.kind === 'line' ? b.text : undefined;
  };
  /** 这一块（标题连整节、围栏连整段）此刻的 Markdown 原文 —— ✎ 框里一开始放的就是它。 */
  function blockSource(anchor: number): string {
    const span = spans[anchor] && spans[anchor].length > 1 ? spans[anchor] : [anchor];
    const { from, to } = spanRange(span);
    return sliceLines(text, from, to).replace(/\n+$/, '');
  }

  /*
    标记一变就存（连同每个行号此刻的原文，见 `loadMarks`）；一条都没有就把这份文件的那一项删掉。
    **停下来 0.4 秒才写** —— 每个按键都把整张表 parse 一遍、stringify 一遍、再经主进程写一次盘，打字就卡。
    pane 卸掉（换标签、藏预览栏）时把还没写的那一份立刻写掉，不丢。
  */
  const pendingSave = useRef<(() => void) | null>(null);
  useEffect(() => () => { pendingSave.current?.(); pendingSave.current = null; }, []);
  useEffect(() => {
    const run = () => {
      pendingSave.current = null;
    const drafts: Record<string, string> = Object.fromEntries(Object.entries(draftLive).filter(([, v]) => String(v || '').trim()));
    const drops = Object.keys(dropped).map(Number);
    let whole = wholeDraft;
    /* 提交了还没写完的那些也照标记的样子存 —— 窗口在这期间 reload 了，它们回来时还是标记 */
    const interrupted: string[] = [];
    const interruptedTickets: Record<string, string> = {};
    for (const j of jobs) {
      if (!j.persist?.key) continue;
      /* 按此刻的行号存 —— 前面的改动挪了行号，放回来的意见还挂在它那一行上 */
      const k = liveMarkKey(j);
      interrupted.push(k);
      if (j.persist?.ticket) interruptedTickets[k] = j.persist.ticket;
      if (k.startsWith('drop:')) { const n = Number(k.slice(5)); if (!drops.includes(n)) drops.push(n); }
      else if (k === 'whole') whole = whole.trim() ? whole : j.persist!.text;
      else if (!String(drafts[k] || '').trim()) drafts[k] = j.persist!.text;
    }
    if (!Object.keys(drafts).length && !drops.length && !whole.trim()) { saveMarks(path, null); return; }
    const anchors: Record<string, string> = {};
    if (!isDeck) {
      const lines = [...drops, ...Object.keys(drafts).map((k) => /^[+=]?(\d+)$/.exec(k)?.[1]).filter(Boolean).map(Number)];
      for (const line of lines) { const t = anchorTextOf(line); if (t !== undefined) anchors[String(line)] = t; }
    }
    saveMarks(path, {
      drafts, dropped: drops, whole, order: markOrder,
      ...(interrupted.length ? { interrupted, interruptedTickets } : {}),
      ...(Object.keys(retryTicketsByPath.get(path) || {}).length ? { retryTickets: retryTicketsByPath.get(path) } : {}),
      ...(isDeck ? {} : { anchors }),
    });
    };
    pendingSave.current = run;
    const timer = window.setTimeout(run, 400);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftLive, dropped, wholeDraft, markOrder, path, jobs]);

  /**
   * **撤销 AI 改的那一处** —— 只把这一段换回原文，别的行逐字照抄；写盘走 `writeBack`（写前备份、内容不变不写）。
   * 和排着的改动走同一条链（`serialize`），读到的是前面那些写完之后的正文。这一段之后又被改过就不写，说一句。
   */
  function noteAiMark(id: number, why: string) {
    updateAiMarks(path, (cur) => cur && { ...cur, marks: cur.marks.map((x) => (x.id === id ? { ...x, note: why } : x)) });
  }
  /*
    **以盘上此刻那一份为准**，不信预览缓存（`currentText`）：文件可能刚在外面被改过、预览还没刷。读盘 → 把标记挪到那一份上
    再核对（`planUndo`）→ 写的时候带上 `expectBase`，读完到写之间又变了主进程就不写。哪一步对不上都只说一句，什么都不动。
  */
  const undoAi = (id: number) => serialize(async () => {
    const state = getAiMarks(path);
    if (!state) return false;
    let disk: string;
    try {
      const r: any = await window.kiroApi.workspaceRead(sessionId, path);
      if (!r || r.binary || r.truncated || typeof r.content !== 'string') { noteAiMark(id, t('Couldn\'t read this file from disk, so nothing was undone')); return false; }
      disk = r.content;
    } catch (err: any) {
      noteAiMark(id, t('Couldn\'t read this file from disk ({err}), so nothing was undone', { err: String(err?.message || err) }));
      return false;
    }
    const plan = planUndo(state, id, disk, lang);
    if (!plan.ok) { noteAiMark(id, plan.why); return false; }
    const m = plan.mark;
    const where = m.to >= m.from ? whereAt(m.from, m.to) : (isDeck ? t('before page {n}', { n: m.from }) : t('before line {n}', { n: m.from }));
    return writeBack(disk, plan.text, `ai:${id}`, t('Undid the AI change to {file} {where} and restored the original', { file: fileName, where }), false, { undid: id, expectBase: disk, edited: [singleRange(disk, plan.text, m.from, m.to)] });
  });

  /** 排进这份文件的队列 —— 提交那一刻全部排上，轮到了才真的开跑。 */
  /**
   * 排进队列。每一条带一张 **ticket**（主进程按它认这一次改写 —— 取消只取消它，不碰你正在跑的那一轮对话），
   * 同时登记进 `reviewQueue`：会话那边的队列旁边也看得见、也能取消（「为什么不直接用会话的 queue 功能」）。
   *
   * 取消：还没轮到的直接跳过；已经在跑的让主进程停掉**这一次**改写（`reviewCancel`）。两种都把标记放回去
   * （`restore`）—— 取消是"这次先别做"，不是"这条意见不要了"，要不要再提交你自己定。
   */
  const enqueue = (kind: Job['kind'], line: number, run: (ticket: string) => Promise<boolean>, putBack: (ticket: string) => void, persist?: Job['persist']) => {
    const id = ++jobSeq.current;
    /*
      窗口 reload 前提交的这一条还在主进程里排着 / 跑着（`resumableRef`）、意见一字没改：**用回原来那张 ticket** ——
      主进程把这次合并到原来那一次、等它的结果（`review:revise-in-session` 按 ticket 合并），不再另起一次、再发一遍。
    */
    const resumed = persist ? takeResumable(persist.key, persist.text) : undefined;
    const ticket = resumed ?? `rv:${path}#${id}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`;
    /* 放回标记：放在这一条**此刻**指的那一行（`reviewItemLine(ticket)`）—— 排队期间前面的改动可能已经挪了它 */
    const restore = () => putBack(ticket);
    const what = kindLabel(kind);
    const where = kind === 'whole' ? '' : ` · ${whereAt(line, line)}`;
    let running = false;
    const cancel = () => {
      cancelledTickets.add(ticket);
      if (running) void window.kiroApi.reviewCancel?.(ticket).catch?.(() => {});
    };
    putReviewItem({
      id: ticket, sessionId: sessionId || '', path, file: fileName, kind, line,
      label: `${what}${where}`, state: 'queued', cancel, ...(persist ? { persist: { ...persist, ticket } } : {}),
    });
    void serialize(async () => {
      try {
        if (cancelledTickets.has(ticket)) { restore(); return false; }
        running = true;
        patchReviewItem(ticket, { state: 'running' });
        /* 第一次提交前重新登记（见 `registerOnce`）；读不到就不发 —— 发了模型改好了也写不回去 */
        const why = isDeck ? null : await registerOnce(sessionId, path, lang);
        if (why) {
          restore();
          livePane().setWriteWarn(why);
          return false;
        }
        livePane().setWriteWarn('');
        const ok = await run(ticket);
        /* 做成了、或者模型答了却没做成：这张 ticket 不再沿用；别的失败（没拿到完整回复、没问到模型）留着，下次还是同一次 */
        if (ok || finalTickets.delete(ticket)) {
          const cur = retryTicketsByPath.get(path);
          if (cur) retryTicketsByPath.set(path, forgetRetryTicket(cur, ticket));
        }
        /* 跑完才发现被取消了（主进程回了 cancelled，或者取消落在两次往返之间）—— 标记放回去 */
        if (!ok && cancelledTickets.has(ticket)) restore();
        return ok;
      } catch {
        return false;
      } finally {
        cancelledTickets.delete(ticket);
        removeReviewItem(ticket);
      }
    });
  };
  /*
    pane 卸掉（藏起预览栏、换标签）**不取消**排着的那些：队列是闭包，照样一条条跑完、写回、从清单里摘掉
    （`finally`）。藏一下侧栏就把你提交的改动全撤了，那才是意外。
  */

  /**
   * block 档整节改写：原节（`where`）里的 `- **字段**:` 回复（主进程补过标题的 `res.text`）里漏了的那几个。
   * 判据是 `reviseBlock.lostFields`（纯的、有测试）；归到哪一处标记上见 `writeBack`。
   */
  const lostOf = (where: string, res: any): string[] => (typeof res?.text === 'string' ? lostFields(where, res.text) : []);
  /** 挂在那一处标记下面的那句提示 —— 只列这一处删掉的。 */
  const lostWarnText = (fields: string[]) =>
    t('⚠ This rewrite deleted the field(s) {fields}. Click Undo to bring them back.', { fields: fields.join(lang === 'zh' ? '、' : ', ') });

  /**
   * **一处 💬 / ＋** —— 轮到了发给打开这份文件的那条会话，KiroLex 拼回整份、写回文件。
   *
   * 💬：先只要**这一块**（快），它回 `CANNOT-REVISE-LOCALLY` 才走 `patch`（加段/删段/合并/挪位置 —— 只交回要换的那几处）。
   * ＋：只要**新加的那部分**，插在这一块（标题就是整节）后面 —— 原文不经过模型，就不会被顺手润色。
   * 没做成的：标记放回去、原因挂在那一段下面，下次提交会再带上它。
   */
  const queueText = (anchor: number, instruction: string, mode: 'revise' | 'insert') => {
    const anchorText = anchorTextOf(anchor);
    if (anchorText === undefined) return;
    /* 入队这一刻是第几轮提交 —— 写完时已经不是这一轮了就不挂「AI 刚改过」 */
    const round = aiRoundOf(path);
    const key = mode === 'insert' ? `+${anchor}` : String(anchor);
    livePane().clearDraft(key);
    livePane().setApplyNote((cur) => { const n = { ...cur }; delete n[key]; return n; });
    /* 此刻指的那一行 —— 排队期间前面的改动挪过它（见 `enqueue` 的 `restore`） */
    const restoreAt = (ticket: string) => reviewItemLine(ticket) ?? anchor;
    const keyAt = (line: number) => (mode === 'insert' ? `+${line}` : String(line));
    enqueue(mode, anchor, async (ticket) => {
      const near = reviewItemLine(ticket) ?? anchor;
      let failKey = keyAt(near);
      const fail = (why: string) => {
        rememberRetry(path, failKey, instruction, ticket);
        livePane().typeDraft(failKey, instruction);
        livePane().setApplyNote((cur) => ({ ...cur, [failKey]: why }));
        return false;
      };
      /*
        渲染层自己写的那一次（主进程没写：老主进程，或者盘上和 base 对不上）**写不进去时把意见放回去** ——
        原来只挂了一句原因，意见本身（提交时已经从标记里清掉了）就这么没了。
      */
      const landed = (ok: boolean) => { if (!ok) livePane().typeDraft(failKey, instruction); return ok; };
      const base = currentText();
      /* 要改的那一行已经被前面的改动改掉 / 删掉了：不再按原文去找（会找到另一处一样的），当成冲突 */
      const at = reviewItemLost(ticket) ? null : locateBlock(base, anchorText, near);
      if (!at) return fail(t('This passage was changed by an earlier edit. Look at the new text and comment on it again.'));
      const { from, to } = at;
      failKey = mode === 'insert' ? `+${at.anchor}` : String(at.anchor);
      /* 按闭区间取原文、按闭区间换回去 —— 段落之间的空行照带（见 `spanRange`） */
      const where = sliceLines(base, from, to);
      /* 位置写进显示文本 —— 回头翻会话要看得出说的是哪儿 */
      const label = `${fileName} ${whereAt(from, to)}`;
      if (mode === 'insert') {
        const res: any = await reviseVia({
          sessionId: sessionId!, where, note: instruction, about: path, label: t('{label} (add after)', { label }), scope: 'insert', ticket,
          apply: { path, mode: 'insert', to, base },
        });
        if (res?.cancelled) return false;
        if (!res?.ok || typeof res.text !== 'string') {
          return fail(res?.cannot ? t('Couldn\'t add it: {why}', { why: res.cannot }) : t('Generation failed: {err}', { err: res?.error || t('no response') }));
        }
        /*
          主进程得真的走了 insert 那一档 —— 旧的主进程不认它、按 block 改，回来的是**改过的原文**，
          插进去就是同一段出现两遍。没回报 scope 的一律不写。
        */
        if (res.scope !== 'insert') {
          return fail(t('The main process is still the old version and doesn\'t support "Add a paragraph". Restart KiroLex and try again (nothing was written this time).'));
        }
        if (res.written && typeof res.fullText === 'string') return writeBack(base, res.fullText, failKey, '', true, { ai: { changes: res.changes, round }, edited: [singleRange(base, res.fullText, to + 1, to)] });
        const fullText = insertAfterLines(base, to, String(res.text));
        /*
          **带 expectBase 写**：主进程没写、把结果交回来，多半是因为盘上已经不是 `base` 了（等回复期间被外面 / 模型的工具 /
          另一条会话改过）—— 不带的话这一次就拿旧底稿拼的整份把那次改动静默盖掉。对不上就不写、意见放回去。
        */
        return landed(await writeBack(base, fullText, failKey, t('Added a paragraph after {file} {where}', { file: fileName, where: whereAt(from, to) }), false, { ai: { round }, expectBase: base, edited: [singleRange(base, fullText, to + 1, to)] }));
      }
      let res: any = await reviseVia({
        sessionId: sessionId!, where, note: instruction, about: path, label, scope: 'block', ticket,
        apply: { path, mode: 'splice', from, to, base },
      });
      if (res?.cancelled) return false;
      if (res?.cannot) {
        /*
          跨段的意见（合并、拆分、挪位置）：**不整篇重写**（长文件会撞上 8 分钟超时），
          给它带行号的全文，它只交回要换的那几处，主进程拼回去（见 `parsePatchReply` / `applyPatch`）。
        */
        res = await reviseVia({
          sessionId: sessionId!, where, note: instruction, about: path, label: t('{label} (across sections)', { label }), scope: 'patch',
          /* 以**盘上此刻**这一份为基准、按它编行号 */
          full: base, fromLine: from, toLine: to, ticket,
          apply: { path, mode: 'patch', base },
        });
        /*
          patch 只认**主进程已经写了**的结果 —— 这里不再自己写：渲染层那次写不带 expectBase，
          文件在等回复期间被动过的话会被旧 base 拼的整份盖掉（见 `patchReplyOutcome`）。
        */
        const out = patchReplyOutcome(res, lang);
        if (out.kind === 'cancelled') return false;
        if (out.kind === 'fail') return fail(out.why);
        return writeBack(base, out.fullText, failKey, '', true, { ai: { changes: res.changes, round } });
      }
      if (!res?.ok || typeof res.text !== 'string') {
        return fail(res?.cannot ? t('Couldn\'t change it: {why}. Try wording it differently.', { why: res.cannot }) : t('Rewrite failed: {err}', { err: res?.error || t('no response') }));
      }
      const lost = lostOf(where, res);
      if (res.written && typeof res.fullText === 'string') return writeBack(base, res.fullText, failKey, '', true, { ai: { changes: res.changes, round, lost }, edited: [singleRange(base, res.fullText, from, to)] });
      /* 只回了这一块（快的那一档）时，先把它拼回整份 —— 写盘要的是完整正文 */
      const fullText = spliceLines(base, from, to, String(res.text));
      /* 带 expectBase 写（同上面 ＋ 那一处）：盘上已经不是 `base` 就不写、意见放回去 */
      return landed(await writeBack(base, fullText, failKey, t('Revised {file} {where} as commented', { file: fileName, where: whereAt(from, to) }), false, { ai: { round, lost }, expectBase: base, edited: [singleRange(base, fullText, from, to)] }));
    }, (ticket) => livePane().typeDraft(keyAt(restoreAt(ticket)), instruction), { key, text: instruction });
  };

  /**
   * **一处 ✎ 直接改** —— 不问模型：这一块（标题就是整节）原样换成你写的那份。排在 ＋ 后面、💬 前面：
   * ＋ 要按这一块的**原文**找位置，先换掉就找不到了。同样排队、按原文找、写前备份；没做成就把标记放回去。
   */
  const queueEdit = (anchor: number, replacement: string) => {
    const anchorText = anchorTextOf(anchor);
    if (anchorText === undefined) return;
    const key = `=${anchor}`;
    livePane().clearDraft(key);
    livePane().setApplyNote((cur) => { const n = { ...cur }; delete n[key]; return n; });
    const restoreAt = (ticket: string) => reviewItemLine(ticket) ?? anchor;
    enqueue('edit', anchor, async (ticket) => {
      const base = currentText();
      const near = reviewItemLine(ticket) ?? anchor;
      /* 要改的那一行已经被前面的改动改掉 / 删掉了：不再按原文去找（会找到另一处一样的），当成冲突 */
      const at = reviewItemLost(ticket) ? null : locateBlock(base, anchorText, near);
      if (!at) {
        livePane().typeDraft(`=${near}`, replacement);
        livePane().setApplyNote((cur) => ({ ...cur, [`=${near}`]: t('This passage was changed by an earlier edit, so it wasn\'t replaced. Look at the new text and edit again.') }));
        return false;
      }
      const fullText = spliceLines(base, at.from, at.to, replacement.replace(/\n+$/, ''));
      /* 带 expectBase 写：预览还没刷出外面那次改动时，不拿旧底稿把它盖掉；写不进去就把你写的那份放回去 */
      const ok = await writeBack(base, fullText, `=${at.anchor}`, t('Replaced {file} {where} with what you wrote', { file: fileName, where: whereAt(at.from, at.to) }), false, { expectBase: base, edited: [singleRange(base, fullText, at.from, at.to)] });
      if (!ok) livePane().typeDraft(`=${at.anchor}`, replacement);
      return ok;
    }, (ticket) => livePane().typeDraft(`=${restoreAt(ticket)}`, replacement), { key, text: replacement });
  };

  /** **一处 ✕** —— 不问模型：删是确定的操作。同样排队、按原文找、写前备份；没做成就把删除标记放回去。 */
  const queueDelete = (anchor: number) => {
    const anchorText = anchorTextOf(anchor);
    if (anchorText === undefined) return;
    const restoreAt = (ticket: string) => reviewItemLine(ticket) ?? anchor;
    enqueue('delete', anchor, async (ticket) => {
      const base = currentText();
      const near = reviewItemLine(ticket) ?? anchor;
      /* 要改的那一行已经被前面的改动改掉 / 删掉了：不再按原文去找（会找到另一处一样的），当成冲突 */
      const at = reviewItemLost(ticket) ? null : locateBlock(base, anchorText, near);
      if (!at) {
        livePane().setApplyNote((cur) => ({ ...cur, [`drop:${near}`]: t('This passage was changed by an earlier edit, so it wasn\'t deleted. Look at the new text and mark it again.') }));
        return false;
      }
      /* 带 expectBase 写（同 ✎）；写不进去就把删除标记放回去 */
      const ok = await writeBack(base, deleteLines(base, at.from, at.to), `drop:${at.anchor}`, t('Deleted {file} {where}', { file: fileName, where: whereAt(at.from, at.to) }), false, { expectBase: base, edited: [singleRange(base, deleteLines(base, at.from, at.to), at.from, at.to)] });
      if (!ok) livePane().setDropped((cur) => ({ ...cur, [at.anchor]: true }));
      return ok;
    }, (ticket) => livePane().setDropped((cur) => ({ ...cur, [restoreAt(ticket)]: true })), { key: `drop:${anchor}`, text: '' });
  };

  /**
   * **整篇的意见** —— 带盘上此刻的正文（带行号）当基准，它只交回要换的那几处（`patch`），不整篇重写。
   * 排在最后：先让逐段的那些落定。
   */
  const queueWhole = (note: string) => {
    const round = aiRoundOf(path);
    livePane().setApplyNote((cur) => { const n = { ...cur }; delete n.whole; return n; });
    enqueue('whole', 0, async (ticket) => {
      const base = currentText();
      const res: any = await reviseVia({
        sessionId: sessionId!, where: '（整篇 —— 这条意见不针对某一处）', note, about: path,
        label: t('{file} (whole document)', { file: fileName }), scope: 'patch', full: base, ticket,
        apply: { path, mode: 'patch', base },
      });
      /* 只认主进程已经写了的结果，渲染层不再自己写（见 `patchReplyOutcome`） */
      const out = patchReplyOutcome(res, lang);
      if (out.kind === 'cancelled') return false;
      if (out.kind === 'fail') {
        rememberRetry(path, 'whole', note, ticket);
        livePane().setWholeDraft((cur) => cur || note);
        livePane().setApplyNote((cur) => ({ ...cur, whole: out.why }));
        return false;
      }
      return writeBack(base, out.fullText, 'whole', '', true, { ai: { changes: res.changes, round } });
    }, () => livePane().setWholeDraft((cur) => cur || note), { key: 'whole', text: note });
  };

  /**
   * **deck 一页的版面文字**（`.pptx`，当场改）—— 一次往返：这一页现有的文字（按 run 地址编号）连同意见发给
   * 那条会话，它只回 `地址<TAB>新文本` 和几条版面指令，KiroLex 按地址写进去（字号、加粗、字体不动）。
   * 改不了的（换图、动别的页）退回给会话自己改。改完 mtime 变了，`changedAt` 一变预览就重转重画。
   */
  const queueSlide = (page: number, instruction: string) => {
    livePane().clearDraft(String(page));
    enqueue('revise', page, async (ticket) => {
      const res: any = await slideVia({ sessionId: sessionId!, filePath: path, page, note: instruction, ticket });
      if (res?.cancelled) return false;
      if (!res?.ok) {
        if (res?.cannot) {
          const sent = await sendToSession(`请改「${path}」第 ${page} 页：${instruction}\n（KiroLex 当场改不了这一条：${res.cannot}）\n改完保存这个文件。`);
          /* 备份没成就没发 —— 意见放回去（原因在底下那行备份提示里） */
          if (!sent) livePane().typeDraft(String(page), instruction);
          return sent;
        }
        /* 没拿到完整回复（网络断了之类）：这张 ticket 留着，意见不改再点 ✓ 还是同一次提交（`rememberRetry`） */
        rememberRetry(path, String(page), instruction, ticket);
        livePane().typeDraft(String(page), instruction);
        livePane().setApplyNote((cur) => ({ ...cur, [String(page)]: t('Rewrite failed: {err}', { err: res?.error || t('no response') }) }));
        return false;
      }
      {
        const note = t('✅ Updated slide {page} ({n} changes){partial}\nFile: {path}\nKiroLex wrote it to disk by run address (backed up first; font size and bold untouched).', { page, n: res.changed, partial: res.partial ? t('; {partial}', { partial: res.partial }) : '', path });
        void window.kiroApi.sessionNote?.(sessionId!, note, noteVariants(note));
      }
      return true;
    }, () => livePane().typeDraft(String(page), instruction), { key: String(page), text: instruction });
  };

  /**
   * **deck 一页的演讲者备注**（`.pptx`，当场改）—— 要回这一页的新讲稿，KiroLex 用 python-pptx 只改这一页的
   * 备注，版面和别的页不动。PDF 不用重转（讲稿不在 PDF 里）。
   */
  const queueNote = (page: number, instruction: string) => {
    const key = `note:${page}`;
    livePane().clearDraft(key);
    const before = notes?.[page - 1] || '';
    /* 讲稿读到过才拿它核对（`deck:write-note` 的 `expect`）—— 没读到时 `before` 只是个空串，拿它比会把每次都判成冲突 */
    const expectNote = Array.isArray(notes) ? before : undefined;
    enqueue('note', page, async (ticket) => {
      const fail = (why: string) => { rememberRetry(path, key, instruction, ticket); livePane().typeDraft(key, instruction); livePane().setApplyNote((cur) => ({ ...cur, [key]: why })); return false; };
      const res: any = await reviseVia({
        sessionId: sessionId!,
        where: before || '（这一页原来没写备注）',
        note: instruction,
        /* 带上全路径：一条会话里可能同时开着几份 deck，只说"第 3 页"它分不出是哪一份 */
        about: `${path} 第 ${page} 页的演讲者备注（讲稿，不是幻灯片上的字）`,
        label: t('{file} page {page} notes', { file: fileName, page }),
        ticket,
      });
      if (res?.cancelled) return false;
      if (!res?.ok || typeof res.text !== 'string') return fail(res?.cannot ? t('Couldn\'t change it: {why}', { why: res.cannot }) : t('Rewrite failed: {err}', { err: res?.error || t('no response') }));
      const wrote: any = await window.kiroApi.deckWriteNote?.(sessionId, path, page, res.text, expectNote);
      if (!wrote?.ok) return fail(t('Couldn\'t write this page\'s notes: {err}', { err: wrote?.error || t('unknown reason') }));
      /* 用**重抽出来的**那一份，不是我们以为写进去的那份 */
      if (Array.isArray(wrote.notes)) livePane().setNotes(wrote.notes);
      {
        const note = t('✅ Wrote the speaker notes for page {page} ({n} chars)\nFile: {path}\nKiroLex saved it to disk (backed up first to ~/.kirolex/backups/review-files/).', { page, n: String(res.text).length, path });
        void window.kiroApi.sessionNote?.(sessionId!, note, noteVariants(note));
      }
      return true;
    }, () => livePane().typeDraft(key, instruction), { key, text: instruction });
  };

  /**
   * **提交全部标记** —— 任何一个框的「✓ 确认」和最下面的「提交」都是它。
   *
   * 文本那侧的顺序：＋ → 💬 → ✕ → 整篇。＋ 在 💬 前面：同一段既要改又要在后面加时，＋ 按这一段的**原文**找位置，
   * 先改了它就找不到了；✕ 和整篇放最后，让逐段的那些先落定。位置都按原文找（`locate`），谁先谁后不会错位。
   */
  /*
    返回值给框（`CommentBox.onApply`）用：真 = 已经交出去了，框把它那份草稿清掉。deck 那批要**等备份回来**才知道发没发出去
    （见 `sendToSession`），所以那时返回 Promise —— 备份没成就是 false，框里写的字留着。
  */
  const submitAll = (): boolean | Promise<boolean> => {
    if (!sessionId || markCount === 0) return false;
    closeBoxes();
    if (!isDeck) {
      /* 上一轮的「AI 刚改过」到此为止 —— 这一轮改完再标新的 */
      beginAiRound(path);
      for (const [line, t] of marks.insert) queueText(line, t, 'insert');
      for (const [line, t] of marks.edit) queueEdit(line, t);
      for (const [line, t] of marks.revise) queueText(line, t, 'revise');
      for (const line of marks.drops) queueDelete(line);
      if (marks.whole) queueWhole(marks.whole);
      /* 落在标了删的整节里的那些意见作废 —— 那一节都要走了 */
      livePane().setDraftLive((cur) => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(cur)) {
          const m = /^[+=]?(\d+)$/.exec(k);
          if (m && Object.keys(dropped).some((d) => covers(Number(d), Number(m[1])))) continue;
          out[k] = v;
        }
        return out;
      });
      livePane().setDropped({});
      livePane().setWholeDraft('');
      livePane().setMarkOrder({});
      return true;
    }
    /*
      deck：当场改得了的（`.pptx` 一页的字、一页讲稿）一页一页排队改；其余的 —— 加页、删页、`.pdf` / 不能改的
      deck 上的意见、整份的意见 —— 拼成**一条**消息发给会话，由它一次改完（拆成几条发，它就得改几遍、存几遍）。
    */
    /* 上一批还在等备份 / 在发：这一次什么都不做、标记照留（框里的字也不清）—— 否则同一批意见会发两遍 */
    if (handoffGateFor(path).busy) return false;
    const handOff: string[] = [];
    /* 交给会话的那几条的草稿键 —— **发出去了才清**：备份没成就没发，标记得留着让你再提交（见 `sendToSession`） */
    const handedKeys: string[] = [];
    for (const [page, t] of marks.revise) {
      if (live) queueSlide(page, t);
      else { handOff.push(`· 第 ${page} 页（版面）：${t}`); handedKeys.push(String(page)); }
    }
    for (const [page, t] of marks.note) {
      if (live) queueNote(page, t);
      else { handOff.push(`· 第 ${page} 页（演讲者备注）：${t}`); handedKeys.push(`note:${page}`); }
    }
    for (const [page, t] of marks.insert) { handOff.push(`· 在第 ${page} 页后面新加一页：${t}`); handedKeys.push(`+${page}`); }
    for (const page of marks.drops) handOff.push(`· 删掉第 ${page} 页（版面和演讲者备注一起）`);
    if (marks.whole) handOff.push(`· 整份：${marks.whole}`);
    /*
      **提交这一刻的快照** —— 发出去之后只清这一批里此刻还和快照一样的那些（`clearSent`）：
      等备份的那几秒里你新写的、改过的不在发出去的那条消息里，不能跟着清掉。
    */
    const sentDrafts: Record<string, string> = Object.fromEntries(handedKeys.map((k) => [k, draftLive[k]]));
    const sentDrops: Record<string, true> = Object.fromEntries(marks.drops.map((p) => [String(p), true as const]));
    const sentWhole = wholeDraft;
    const clearHanded = () => {
      const nowDrafts = draftRef.current;
      const cleared = [
        ...handedKeys.filter((k) => nowDrafts[k] === sentDrafts[k]),
        ...marks.drops.map((p) => `drop:${p}`),
        ...(wholeRef.current === sentWhole ? ['whole'] : []),
      ];
      livePane().setDraftLive((cur) => clearSent(cur, sentDrafts));
      livePane().setDropped((cur) => clearSent(cur as Record<string, true>, sentDrops) as Record<number, true>);
      livePane().setWholeDraft((cur) => (cur === sentWhole ? '' : cur));
      livePane().setMarkOrder((cur) => { const n = { ...cur }; for (const k of cleared) delete n[k]; return n; });
    };
    if (handOff.length) {
      setHandingOff(true);
      /* 页号按**提交这一刻**的说 —— 删页、加页会让后面的页号变，所以叫它整批按这份清单一次改完 */
      const send = () => sendToSession(`请按下面这几条改「${path}」（页号都是改之前的），一次改完、保存这个文件：\n${handOff.join('\n')}`);
      const sent = handoffGateFor(path).run(send).then((ok) => !!ok);
      void sent.then((ok) => { if (ok) clearHanded(); }).finally(() => setHandingOff(false));
      return sent;
    }
    clearHanded();
    return true;
  };


  /** 排着的改动锁住的行 —— **整节一起锁**：标题那条意见改的是整节，节内任何一行都不能同时再标。 */
  const lockedLines = new Set<number>();
  /** 行 → 挂在它下面的那几条状态（排队中 / 进行中）—— 摆在那一节的**末行**，和框原来的位置同一处。 */
  const statusAt = new Map<number, Job[]>();
  if (!isDeck) {
    for (const j of jobs) {
      if (j.kind === 'whole') continue;
      const span = spans[j.line] && spans[j.line].length > 1 ? spans[j.line] : [j.line];
      for (const l of span) lockedLines.add(l);
      const host = hostOf(j.line);
      statusAt.set(host, [...(statusAt.get(host) || []), j]);
    }
  }
  /** 一条排着的改动那一行：前面还有几条、在做什么 —— 队在哪儿得看得见。 */
  const jobRow = (j: Job) => {
    const ahead = jobs.findIndex((x) => x.id === j.id);
    const what = kindLabel(j.kind);
    const where = j.kind === 'whole' ? '' : `${isDeck ? whereAt(j.line, j.line) : spanWhere(j.line)} · `;
    return (
      <div key={j.id} className={`rt-block-lock${j.state === 'queued' ? ' queued' : ''}`} aria-live="polite">
        {j.state === 'running'
          ? t('{where}{what} in progress… (running in that session, written back when done)', { where, what })
          : t('{where}{what} queued ({n} ahead)', { where, what, n: ahead })}
        {/* 取消这一条 —— 没轮到的不发，在跑的只停它自己那一轮；标记放回去（会话那边的队列旁边也有同一个按钮） */}
        {j.cancel && (
          <button type="button" className="rt-hist-btn rv-job-cancel nopan nodrag" title={t('Cancel this one (its mark will be restored)')}
            onClick={() => j.cancel!()}>{t('Cancel')}</button>
        )}
      </div>
    );
  };

  /** 一条标记收起后的样子：点它接着改，✕ 去掉这条标记。没做成的原因跟在后面。 */
  const markChip = (key: string, markGlyph: string, reopen: () => void) => {
    const said = String(draftLive[key] || '').trim();
    const failed = applyNote[key];
    if (!said && !failed) return null;
    return (
      <div key={key} className="rt-brief-row">
        {said && (
          <span className="rt-hist-one">
            <button type="button" className="rt-note-brief nopan nodrag" title={t('Keep editing this mark')} onClick={reopen}>
              <span className="rt-note-brief-mark">{markGlyph}</span>
              <span className="rt-note-brief-text">{said.replace(/\s+/g, ' ')}</span>
            </button>
            {/* 「已经写完的 comment 缺少一个修改按钮」—— 点摘要本身也能改，但那不是一眼看得出来的入口 */}
            <button type="button" className="rt-hist-btn nopan nodrag" title={t('Edit this mark')} onClick={reopen}>✎</button>
            <button type="button" className="rt-hist-btn rt-hist-del nopan nodrag" title={t('Remove this mark')}
              onClick={() => { clearDraft(key); setApplyNote((cur) => { const n = { ...cur }; delete n[key]; return n; }); }}>✕</button>
          </span>
        )}
        {failed && <div className="rt-note-applied">{failed}</div>}
      </div>
    );
  };

  /** 一个标记框 —— 写的字就是标记；「✓ 确认」提交全部；「取消」丢掉**这一条**。顶上写明它管的是哪几行。 */
  const markBox = (key: string, header: string, placeholder: string, markGlyph: string, onClose: () => void) => (
    <div className={`rv-note-slot${key.startsWith('+') ? ' rv-insert-slot' : ''}`}>
      <div className="rv-box-target">{header}</div>
      <CommentBox
        value=""
        mark={markGlyph}
        draft={draftOf(key)}
        onDraft={(next) => typeDraft(key, next)}
        startOpen
        /* 对着一行写的意见通常是一句话 —— 不要一个突然出现的大方块 */
        rows={2}
        placeholder={placeholder}
        onApply={() => submitFromBox(submitAll)}
        applyWhenEmpty={markCount > 0}
        applyLabel={confirmLabel}
        applyTitle={confirmTitle}
        applyNote={applyNote[key] || ''}
        onChange={() => {}}
        /* 取消 = 丢掉这一条（CommentBox 把草稿退回空）；框关掉要通知这一层，不然这一块再也点不开 */
        onDismiss={onClose}
      />
    </div>
  );

  /** 文本那侧每一块的按钮，从左到右：✎ 直接改、✕ 标删（↩ 取消）、＋ 在后面加、💬 改这一块。框不在这里，见 `boxFor`。 */
  const tools = (block: ReviewBlock) => {
    const where = spanWhere(block.index);
    const gone = !!dropped[block.index];
    const boxOpen = openAt === block.index || insertAt === block.index || editAt === block.index;
    const editedHere = !!marks.edit.find(([l]) => l === block.index);
    return (
      <div className="rv-review-tools">
        {!boxOpen && !gone && (
          <button
            type="button"
            className={`rv-edit-btn${editedHere ? ' has-note' : ''} nopan nodrag`}
            title={t('Edit the original text of {where} directly (no model; marked now, submitted together)', { where })}
            onClick={(e) => {
              e.stopPropagation();
              /* 第一次打开时框里放这一块现在的原文 —— 你在它上面改，而不是对着空框重打一遍 */
              if (!draftLive[`=${block.index}`]) setDraftLive((cur) => ({ ...cur, [`=${block.index}`]: blockSource(block.index) }));
              openBox('edit', block.index);
            }}
          >✎</button>
        )}
        {!boxOpen && (
          <button
            type="button"
            className={`rt-block-drop${gone ? ' on' : ''} nopan nodrag`}
            title={gone ? t('Keep it') : t('Mark {where} for deletion (submitted together when you click "✓ Confirm")', { where })}
            onClick={(e) => {
              e.stopPropagation();
              setDropped((cur) => { const n = { ...cur }; if (gone) delete n[block.index]; else n[block.index] = true; return n; });
              if (!gone) bumpMark(`drop:${block.index}`);
            }}
          >{gone ? '↩' : '✕'}</button>
        )}
        {!boxOpen && !gone && (
          <button
            type="button"
            className={`rv-insert-btn${draftOf(`+${block.index}`).trim() ? ' has-note' : ''} nopan nodrag`}
            title={t('Add new content after {where} (marked now, submitted together)', { where })}
            onClick={(e) => { e.stopPropagation(); openBox('insert', block.index); }}
          >＋</button>
        )}
        {!boxOpen && !gone && (
          <CommentOpener onClick={() => openBox('comment', block.index)} active={!!draftOf(String(block.index)).trim()}
            title={t('Comment on {where} (marked now, submitted together when you click "✓ Confirm")', { where })} />
        )}
      </div>
    );
  };

  /**
   * 该在**这一行下面**渲染输入框吗 —— 渲染在打开的那个锚点**覆盖的最后一行**下面：
   * 普通行就是它自己，标题就是整节的末尾。＋ 的框也在那里 —— 新内容就是要加在那个位置。
   * 框顶上**写明它管的是哪几行** ——「现在这些 comment 功能没有选择行号」。
   */
  const boxFor = (line: number) => {
    const anchor = openAt ?? insertAt;
    if (anchor === null) return null;
    if (hostOf(anchor) !== line) return null;
    const where = spanWhere(anchor);
    const insert = insertAt === anchor;
    return markBox(
      insert ? `+${anchor}` : String(anchor),
      insert ? t('+ Add after {where}', { where }) : t('💬 Revise {where}', { where }),
      insert ? t('Write what to add, or describe what it should write') : t('How should this passage change?'),
      insert ? '＋' : '💬',
      () => { setOpenAt(null); setInsertAt(null); },
    );
  };

  /**
   * **✎ 直接在原文上改** ——「这个修改按钮的效果不对，应该是直接在原文上修改，上方为什么还显示原文」。
   * 框**顶替**这一块（标题就是整节）：原文不再另外摆一份在上面，你改的就是它本身。
   */
  const editBox = (anchor: number) => {
    const where = spanWhere(anchor);
    return (
        <div className="rv-note-slot rv-edit-slot">
          <div className="rv-box-target">{t('✎ Edit {where} directly (no model)', { where })}</div>
          <CommentBox
            value=""
            mark="✎"
            draft={draftOf(`=${anchor}`)}
            onDraft={(next) => typeDraft(`=${anchor}`, next)}
            startOpen
            rows={Math.min(14, Math.max(3, blockSource(anchor).split('\n').length + 1))}
            placeholder={t('The original text of this block. Edit it directly.')}
            onApply={() => submitFromBox(submitAll)}
            applyWhenEmpty={markCount > 0}
            applyLabel={confirmLabel}
            applyTitle={confirmTitle}
            applyNote={applyNote[`=${anchor}`] || ''}
            onChange={() => {}}
            onDismiss={() => setEditAt(null)}
          />
        </div>
      );
  };

  /** 删掉这一页（标记）—— 写出字来、单独摆在页头（它删的是整页，和"对某样东西提意见"不是一类动作）。 */
  const dropPageBtn = (page: number) => {
    const gone = !!dropped[page];
    return (
      <button
        type="button"
        className={`rt-block-drop rv-drop-page${gone ? ' on' : ''} nopan nodrag`}
        title={gone ? t('Keep it') : t('Mark this page for deletion, slide and notes together (submitted together when you click "✓ Confirm")')}
        onClick={() => {
          setDropped((cur) => { const n = { ...cur }; if (gone) delete n[page]; else n[page] = true; return n; });
          if (!gone) bumpMark(`drop:${page}`);
        }}
      >{gone ? t('↩ Keep it') : t('✕ Delete this page')}</button>
    );
  };

  /** 版面那条通道：💬 + ＋ + 标记 + 正在写的那个框。页底下和大图里共用同一段。 */
  const pageToolRow = (page: number) => {
    if (!on) return null;
    const busy = jobs.filter((j) => j.line === page && j.kind !== 'note');
    if (busy.length) return <>{busy.map(jobRow)}</>;
    const open = openAt === page;
    const adding = insertAt === page;
    return (
      <>
        {!open && !adding && (
          <div className="rv-page-tools">
            <div className="rv-review-tools">
              <CommentOpener onClick={() => openBox('comment', page)} active={!!draftOf(String(page)).trim()} title={t('Comment on the layout of page {page}', { page })} />
              <button type="button" className={`rv-insert-btn${draftOf(`+${page}`).trim() ? ' has-note' : ''} nopan nodrag`}
                title={t('Add a page after page {page}', { page })}
                onClick={(e) => { e.stopPropagation(); openBox('insert', page); }}>＋</button>
            </div>
          </div>
        )}
        {!open && markChip(String(page), '💬', () => openBox('comment', page))}
        {!adding && markChip(`+${page}`, '＋', () => openBox('insert', page))}
        {submitHerePage(page, false) && submitRow}
        {open && markBox(String(page), t('💬 Revise the layout of page {page}', { page }), live ? t('How should the text / boxes on this page change?') : t('How should this page change? (sent to the session to do)'), '💬', () => setOpenAt(null))}
        {adding && markBox(`+${page}`, t('+ Add a page after page {page}', { page }), t('What should this page cover?'), '＋', () => setInsertAt(null))}
      </>
    );
  };

  /**
   * **讲稿**那条通道的 💬 + 框 —— 和版面那套是两套，不共用：共用的话就得判断"这条意见是说版面还是说讲稿"，
   * 而那个判断没有依据 —— 你写的时候知道，代码不知道。两个入口 = 你在点的时候就把这件事说清了。
   */
  const noteToolRow = (page: number) => {
    if (!on) return null;
    const busy = jobs.filter((j) => j.line === page && j.kind === 'note');
    if (busy.length) return <>{busy.map(jobRow)}</>;
    const key = `note:${page}`;
    const open = noteOpenAt === page;
    return (
      <div className="rv-page-tools rv-note-tools-row">
        {!open && (
          <div className="rv-review-tools rv-note-tools">
            <CommentOpener onClick={() => { closeBoxes(); setNoteOpenAt(page); }} active={!!draftOf(key).trim()} title={t('Comment on this page\'s speaker notes')} />
          </div>
        )}
        {!open && markChip(key, '🗒', () => { closeBoxes(); setNoteOpenAt(page); })}
        {submitHerePage(page, true) && submitRow}
        {open && markBox(key, t('🗒 Revise the speaker notes of page {page}', { page }), t('This changes the notes, not the text on the slide'), '🗒', () => setNoteOpenAt(null))}
      </div>
    );
  };

  /** 发给会话之后那一句确认 / 备份没成的警告。 */
  const statusLine = (justSent || backupWarn || writeWarn || handingOff) ? (
    <div className="rv-review-status">
      {handingOff && <p className="rv-review-sent">{t('Backing up this file before sending it to the session…')}</p>}
      {justSent && <p className="rv-review-sent">{t('Sent to this file\'s session. Check that session to see how it edits the file.')}</p>}
      {writeWarn && <p className="rv-review-warn">{t('Couldn\'t read this file, so nothing was submitted ({why}). Your marks are all still here; click "✓ Confirm" again once it\'s reachable.', { why: writeWarn })}</p>}
      {backupWarn && <p className="rv-review-warn">{t('Couldn\'t back up this file ({why}), so nothing was sent to the session. Your marks are still here; submit again once the backup works.', { why: backupWarn })}</p>}
    </div>
  ) : null;
  /**
   * 最下面：**对整篇的意见 + 提交** ——「最下面应该有一个额外的 comment 和提交按钮框是针对整篇文章提出修改建议的」。
   * 这里的「提交」和各个框里的「✓ 确认」是同一个动作：提交全部标记（整篇这一框也是一条标记）。
   */
  const wholeJobs = jobs.filter((j) => j.kind === 'whole');
  const summary = [
    marks.edit.length ? t('{n} direct edits', { n: marks.edit.length }) : '',
    marks.revise.length ? t('{n} revisions', { n: marks.revise.length }) : '',
    marks.note.length ? t('{n} notes edits', { n: marks.note.length }) : '',
    marks.insert.length ? t('{n} additions', { n: marks.insert.length }) : '',
    marks.drops.length ? t('{n} deletions', { n: marks.drops.length }) : '',
    marks.whole ? t('whole-document comment') : '',
  ].filter(Boolean).join(t(', '));
  const wholeBox = (
    <div className="rv-review-whole">
      <div className="rv-box-target">{isDeck ? t('Comments on the whole deck') : t('Comments on the whole document')}</div>
      <textarea
        className="rt-note rv-review-whole-input"
        rows={2}
        value={wholeDraft}
        onChange={(e) => setWholeDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitAll(); } }}
        placeholder={t('Things that don\'t belong to one passage: overall framing, structure, tone, what\'s missing')}
      />
      {applyNote.whole && <div className="rt-note-applied">{applyNote.whole}</div>}
      {wholeJobs.map(jobRow)}
      <div className="rt-note-actions rv-review-whole-actions">
        <span className="rv-review-count">{markCount ? t('Marked: {summary}', { summary }) : t('No marks yet')}</span>
        <button
          type="button"
          className="rt-note-apply nopan nodrag"
          disabled={markCount === 0}
          title={confirmTitle}
          onClick={() => submitAll()}
        >{markCount > 1 ? t('Submit ({n})', { n: markCount }) : t('Submit')}</button>
      </div>
    </div>
  );
  /**
   * **提交按钮在最新改的那一段下面** ——「comment 和删除的提交按钮还是在最新修改那一段落的下方就行，
   * 不要在底部单独设置按钮」。只标了删除的时候一个框都没开，所以不能只靠框里那个「✓ 确认」。
   *
   * "最新"按 `markOrder`：还在的那些标记里最后被动的那一条。它在哪一段（标题就是整节末尾）/ 哪一页，
   * 这一行就摆在哪儿；有框开着时不摆 —— 那个框里的「✓ 确认」就是它。
   */
  const latestMark = (() => {
    let best: { key: string; seq: number } | null = null;
    for (const [k, seq] of Object.entries(markOrder)) {
      const alive = k.startsWith('drop:') ? !!dropped[Number(k.slice(5))] : !!String(draftLive[k] || '').trim();
      if (alive && (!best || seq > best.seq)) best = { key: k, seq };
    }
    if (!best) return null;
    const m = /^(\+|=|drop:|note:)?(\d+)$/.exec(best.key);
    return m ? { line: Number(m[2]), note: m[1] === 'note:' } : null;
  })();
  const anyBoxOpen = openAt !== null || insertAt !== null || editAt !== null || noteOpenAt !== null;
  const submitRow = (
    <div className="rv-mark-submit">
      <span className="rv-review-count">{t('Marked: {summary}', { summary })}</span>
      <button type="button" className="rt-note-apply nopan nodrag" title={confirmTitle} onClick={() => submitAll()}>
        {confirmLabel}
      </button>
    </div>
  );
  /** 这一段（文本：它那一节的末行）下面要不要摆提交那一行。 */
  const submitHereText = (line: number) => {
    if (!latestMark || anyBoxOpen || markCount === 0) return false;
    return hostOf(latestMark.line) === line;
  };
  /** deck：这一页的版面那一行 / 讲稿那一行下面要不要摆。 */
  const submitHerePage = (page: number, note: boolean) =>
    !!latestMark && !anyBoxOpen && markCount > 0 && latestMark.line === page && latestMark.note === note;
  /** 没有主人会话：明说只能看（入口都不给，见 `on`）。 */
  const ownerless = !sessionId && (isDeck || commenting)
    ? <p className="rv-review-hint">{t('This tab doesn\'t belong to a session (it wasn\'t opened from one), so it\'s read-only. Open the file link from a session to edit it passage by passage.')}</p>
    : null;

  /* ── deck 的早返回：**必须在所有 hook 之后**（转换失败那支不走后面的 hook 会让 React 报 hooks 数量不一致） ── */
  if (isDeck && why) {
    return (
      <div className="rv-review rv-review-blocked" ref={rootRef}>
        {/* 转不出来时也不给"用系统应用打开"按钮 —— 顶栏那个 `↗ 打开文件` 就在正上方 */}
        <p className="rv-review-why">{why}</p>
        {install && (
          <div className="rv-review-install">
            <code>{install}</code>
            <button
              type="button"
              className="text-btn"
              onClick={() => {
                void navigator.clipboard?.writeText(install).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }).catch(() => {});
              }}
            >{copied ? t('Copied') : t('Copy command')}</button>
          </div>
        )}
      </div>
    );
  }
  if (isDeck && !bytes) {
    return (
      <div className="rv-review rv-review-loading" ref={rootRef}>
        {/\.pdf$/i.test(path) ? t('Reading PDF…') : t('Converting to PDF… (slower the first time, cached after that)')}
      </div>
    );
  }

  if (isDeck) {
    return (
      <div className="rv-review" ref={rootRef}>
        {ownerless}
        {/* 讲稿为什么没有 —— 多半是没装 python-pptx。预览和逐页意见不受影响 */}
        {notesWhy && <p className="rv-review-hint">{notesWhy}</p>}
        {on && pageCount !== null && !hasNotes && (
          /* 没有讲稿时这一排只放页码和「删掉这一页」；评论入口在每页底下 */
          <ol className="rv-review-pagerow">
            {blocks.map((block) => (
              <li key={block.index} className={`rv-review-pagecell${dropped[block.index] ? ' dropped' : ''}`}>
                <span className="rv-review-anchor">{t('Page {n}', { n: block.index })}</span>
                {dropPageBtn(block.index)}
              </li>
            ))}
          </ol>
        )}
        <div className="rv-review-pdf">
          <PdfView
            bytes={bytes!}
            onPages={setPageCount}
            /* 放大到哪一页按**这份文件**记着 —— 刷新/重挂载之后回到同一页 */
            zoomKey={path}
            noteFor={(page) => notes?.[page - 1] || ''}
            /* **版面那条通道的入口在页底下** ——「ppt comment 的在 ppt 下面，note comment 的在 note 下面」 */
            belowFor={(page) => pageToolRow(page)}
            zoomToolsFor={(page) => pageToolRow(page)}
            zoomNoteToolsFor={(page) => (hasNotes ? noteToolRow(page) : null)}
            sideFor={hasNotes ? (page) => {
              const note = notes?.[page - 1] || '';
              return (
                <>
                  <div className={`rv-review-pagecell${dropped[page] ? ' dropped' : ''}`}>
                    <div className="rv-page-head">
                      <span className="rv-review-anchor">{t('Page {n}', { n: page })}</span>
                      {on && !jobs.some((j) => j.line === page) && dropPageBtn(page)}
                    </div>
                    {note
                      ? <div className="rv-review-note">{note}</div>
                      : <div className="rv-review-note empty">{t('(No notes on this page)')}</div>}
                  </div>
                  {/* 讲稿的入口在那个带边框的格子**外面**（「不要让 comment 按钮在 note 框内」） */}
                  {noteToolRow(page)}
                </>
              );
            } : undefined}
            /* **在图上**留个痕迹 —— 有标记的页在图上角挂一个标记，点它直接展开那条 */
            overlayFor={(page) => {
              const said = draftOf(String(page)).trim();
              const saidNote = draftOf(`note:${page}`).trim();
              const adding = draftOf(`+${page}`).trim();
              const gone = !!dropped[page];
              if (!said && !saidNote && !adding && !gone) return null;
              return (
                <div className="rv-pdf-mark" onClick={(e) => e.stopPropagation()}>
                  {gone && <span className="rv-pdf-mark-drop" title={t('Page {page} is marked for deletion', { page })}>{t('✕ Marked for deletion')}</span>}
                  {said && (
                    <button type="button" className="rv-pdf-mark-note nopan nodrag"
                      title={t('Layout comment on page {page}: {text}\n(click to edit)', { page, text: said })}
                      onClick={() => openBox('comment', page)}>{t('💬 Layout')}</button>
                  )}
                  {saidNote && (
                    <button type="button" className="rv-pdf-mark-note note nopan nodrag"
                      title={t('Speaker-notes comment on page {page}: {text}\n(click to edit)', { page, text: saidNote })}
                      onClick={() => { closeBoxes(); setNoteOpenAt(page); }}>{t('🗒 Notes')}</button>
                  )}
                  {adding && (
                    <button type="button" className="rv-pdf-mark-note nopan nodrag"
                      title={t('New page to add after page {page}: {text}\n(click to edit)', { page, text: adding })}
                      onClick={() => openBox('insert', page)}>{t('+ Add page')}</button>
                  )}
                </div>
              );
            }}
          />
        </div>
        {on && wholeBox}
        {statusLine}
      </div>
    );
  }


  return (
    <div className="rv-review" ref={rootRef}>
      {ownerless}
      <ol className="rv-review-blocks" ref={listRef}>
        {groups.map((g) => {
          /*
            ✎ 那一块（标题连整节）：开着框时框顶替它，改过（还没提交）时显示**改过的那份** —— 盖住的那几行不再单独显示。
          */
          const editHost = (() => {
            if (!on) return null;
            if (editAt !== null && covers(editAt, g.anchor)) return editAt;
            for (const [l] of marks.edit) if (covers(l, g.anchor)) return l;
            return null;
          })();
          if (editHost !== null && editHost !== g.anchor) return null;
          const editingHere = editHost === g.anchor && editAt === g.anchor;
          const editedHere = editHost === g.anchor && !editingHere;
          const owner = coveredBy.get(g.anchor);
          /*
            预览：hover 那个"带整段"的锚点时整段亮 —— ✕ 删的、💬 改的、＋ 接在后面的都是那一整段。
            **框开着时一定亮，单独一行也亮** —— 鼠标一进框里 hover 就没了，而你得一直看得见自己评的是哪一段
            （实测：评的是上面那段，结果以为动了下面那段）。
          */
          const target = openAt ?? insertAt ?? editAt;
          const targeted = target !== null && covers(target, g.anchor);
          const previewing = target === null && covers(hoverAt, g.anchor)
            && (hoverAt === g.anchor || (spans[hoverAt!]?.length || 0) > 1);
          const ownsSection = (spans[g.anchor]?.length || 0) > 1;
          const goneBy = droppedBy(g.anchor);
          const locked = lockedLines.has(g.anchor);
          const aiHere = (aiLayout.rowAt.get(g.anchor) || []).map((i) => aiMarks[i]).filter(Boolean);
          return (
            <li
              key={g.anchor}
              onMouseEnter={() => setHoverAt(g.anchor)}
              onMouseLeave={() => setHoverAt((cur) => (cur === g.anchor ? null : cur))}
              className={'rv-review-block'
                + `${goneBy !== null ? ' dropped' : ''}${goneBy !== null && goneBy !== g.anchor ? ' section-dropped' : ''}`
                + `${on && targeted ? ' section-preview targeted' : ''}`
                + `${on && previewing && (ownsSection || owner !== undefined) ? ' section-preview' : ''}`
                + `${ownsSection ? ' section-head' : ''}`
                + `${locked ? ' locked' : ''}`
                + `${aiLayout.lit.has(g.anchor) ? ' ai-changed' : ''}`
                + `${aiHere.length ? ' ai-host' : ''}`}
              /* 右边那一栏：第一行 ✎ ✕ ＋ 💬，下面每处 AI 改动一行 —— 这一段至少撑到放得下它们，不压到下一段 */
              style={aiHere.length ? { minHeight: `calc(${aiHere.length + 1} * var(--rv-tool-row))` } : undefined}
            >
              {/*
                **comment 模式左边显示行号** ——「我希望 md 的 comment 模式左侧能显示行号」（早先「不要显示什么段落号」
                说的是纯读的时候；纯读不走这里）。号就是文件里的行号，和框顶上、排队那一行、会话里说的「第 N 行」
                是同一个数；代码围栏那一组写起止。
                Markdown 逐行渲染时**先摘掉缩进**（`mdLine`）：单独看一行，`    - 三级` 会被 CommonMark 当成
                代码块。缩进用 padding 还原。围栏组不摘：它本来就该是代码。
              */}
              {on && (
                <span className="rv-line-no" aria-hidden="true">
                  {/* 代码块写起始行就够了（起止在框顶上写着）—— 写成「10–13」在这一栏里放不下 */}
                  {g.anchor}
                </span>
              )}
              {editingHere ? editBox(g.anchor) : editedHere ? (
                <div className={markdown ? 'rv-review-md rv-edited' : 'rv-review-text rv-edited'}>
                  {markdown ? <MarkdownView content={draftOf(`=${g.anchor}`)} /> : <pre className="rv-review-text">{draftOf(`=${g.anchor}`)}</pre>}
                </div>
              ) : markdown
                ? (() => {
                  const { md, indent } = g.fenced ? { md: g.text, indent: 0 } : mdLine(g.text);
                  return (
                    <div className="rv-review-md" style={indent ? { paddingLeft: indent * 4 } : undefined}>
                      <MdBlock md={md} />
                    </div>
                  );
                })()
                : <pre className="rv-review-text">{g.text}</pre>}
              {/* 在一个标了删的整节里的那几行不给按钮 —— 它们跟着整节走，单独处置会和那条打架 */}
              {on && !locked && (goneBy === null || goneBy === g.anchor)
                && tools({ kind: 'line', index: g.anchor, text: g.text, ...(g.fenced ? { fenced: true as const } : null) })}
              {/* 收起的标记摆在那一段下面：点它接着改，✕ 去掉；没做成的原因也在这里 */}
              {on && !locked && openAt !== g.anchor && markChip(String(g.anchor), '💬', () => openBox('comment', g.anchor))}
              {on && !locked && insertAt !== g.anchor && markChip(`+${g.anchor}`, '＋', () => openBox('insert', g.anchor))}
              {/* 直接改过的那一块：只在真的改了（和原文不一样）时挂一行 */}
              {on && !locked && editedHere && (
                <div className="rt-brief-row rv-edited-row">
                  <span className="rt-hist-one">
                    <span className="rv-edited-tag">{t('✎ Edited directly (not submitted)')}</span>
                    <button type="button" className="rt-hist-btn nopan nodrag" title={t('Keep editing')} onClick={() => openBox('edit', g.anchor)}>✎</button>
                    <button type="button" className="rt-hist-btn rt-hist-del nopan nodrag" title={t('Undo this direct edit and restore the original')}
                      onClick={() => clearDraft(`=${g.anchor}`)}>✕</button>
                  </span>
                  {applyNote[`=${g.anchor}`] && <div className="rt-note-applied">{applyNote[`=${g.anchor}`]}</div>}
                </div>
              )}
              {on && applyNote[`drop:${g.anchor}`] && <div className="rt-note-applied">{applyNote[`drop:${g.anchor}`]}</div>}
              {/*
                AI 刚改过的那一处：「AI 刚改过」+ 撤销 摆在**右边那一栏、✎ ✕ ＋ 💬 正下面那一行**，靠右对齐 ——
                不另起一行占正文下面的位置。这一段的 min-height 把两行都包住（见上面 li 的 style），不会压到下一段。
                撤销没成的原因（一句话，放不进那一栏）还是跟在正文下面。
              */}
              {aiHere.length > 0 && (
                <div className="rv-ai-side">
                  {aiHere.map((m) => (
                    <span key={`ai:${m.id}`} className="rv-ai-one">
                      <span className="rv-ai-tag" title={m.original ? t('It used to be:\n{text}', { text: m.original }) : t('This passage wasn\'t here before')}>
                        {m.to < m.from ? t('AI deleted a passage') : t('AI just changed this')}
                      </span>
                      {sessionId && !locked && (
                        <button type="button" className="rt-hist-btn rv-ai-undo nopan nodrag"
                          title={t('Restore just this passage to its original text (backed up before writing)')}
                          onClick={() => { void undoAi(m.id); }}>{t('Undo')}</button>
                      )}
                    </span>
                  ))}
                </div>
              )}
              {/* 这次整节改写删掉了字段 —— 醒目地说出来，撤销就在右边那一栏 */}
              {aiHere.map((m) => (m.warn ? <div key={`ai-warn:${m.id}`} className="rt-note-applied rv-ai-warn">{m.warn}</div> : null))}
              {aiHere.map((m) => ((m.note || applyNote[`ai:${m.id}`])
                ? <div key={`ai-note:${m.id}`} className="rt-note-applied">{m.note || applyNote[`ai:${m.id}`]}</div>
                : null))}
              {/* 提交那一行在**最新标的那一段**下面（见 `latestMark`） */}
              {on && !locked && submitHereText(g.anchor) && submitRow}
              {/* 排着的改动挂在那一节末尾 —— 见 `statusAt` */}
              {(statusAt.get(g.anchor) || []).map(jobRow)}
              {on && !locked && boxFor(g.anchor)}
            </li>
          );
        })}
      </ol>
      {on && wholeBox}
      {statusLine}
    </div>
  );
};
