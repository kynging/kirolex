import { createPortal } from 'react-dom';
import { useReviewQueue } from '../reviewQueue';
import { uiGet, uiSet, uiRemove } from '../uiStore';
import React, { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo, memo } from 'react';
import { KiroConfigPanel, type KiroConfigCategory } from './KiroConfigPanel';
import { EngineLoginPane } from './LoginSettings.tsx';
import { McpCombosPane } from './McpCombosPane.tsx';
import ReactMarkdown from 'react-markdown';
import { mdText } from '../mdText';
// 「这段文字是不是路径」的判据 —— 抽出来是为了能被 node:test 测到（.tsx 跑不了测试）
import { FILE_TOKEN_RE, PATH_RE } from '../filePaths';
// 清空上下文那条分界线：默认视图收到它之后，并在原位画出来（判据见那个模块）
import { sinceLastClear, isClearCommand, clearNoteText } from '../clearBoundary';
// 这一格自己的会话内搜索：命中算术（纯，可测）+ 高亮（Range/CSS.highlights，不动 DOM）
import { findDebounceDelay, findLabel, matchOffsets, shouldExpandForFind, shouldSearch, stepIndex } from '../paneFind';
import { clearPane, rangesIn, setActive, setPaneRanges, textOf } from '../findHighlight';
import { useLang, useT } from '../hooks/useLang';
import { displayTitle, shownIn } from '../i18n';
import { pickVariant } from '../../main/uiText.ts';
// 往输入框交接文本的语义：取走一次就清（见那个模块开头那段）
import { shouldApplyHandoff } from '../handoffDraft';
import { formatMemoryBytes, type MemoryScope, type MemoryWarning } from '../../main/memoryPolicy';
import { activeSubagents, type SubagentRow } from '../../main/subagents';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import hljs from 'highlight.js';
import { isFeatureOn, useFeatureFlags } from '../hooks/useFeatureFlags';
import { isKirolexNote } from '../../main/kirolexNote.ts';

import { useSessionNotice } from '../hooks/useSessionNotice';
import 'highlight.js/styles/github-dark.css';
import type { Message, AttachedFile, QueuedMessage, ToolCall, PlanEntry, FileDiff } from '../App';
import type { SlashCommand, PermissionRequest } from '../hooks/useAcp';
// Scheduling replaced loop mode. `schedule.ts` lives under src/main because the DRIVER
// runs there (a schedule has to fire with no window open); it is pure, so the renderer
// imports the same module rather than keeping a second copy of the rules.
import { validateSchedule, describeSchedule, DEFAULT_MAX_RUNS, MIN_INTERVAL_SEC, type ScheduleSpec } from '../../main/schedule';
import type { ScheduleSummary } from '../scheduleView';
import { decidePaste } from '../pasteDecision';
import { IconAppendMessage, IconClaudeSpark, IconCodexPrompt, IconCopy, IconEdit, IconFork, IconPaperclip, IconQueue, IconRobot, IconSteer } from './Icons';
import { ConfirmDialog, ConfirmRequest } from './ConfirmDialog';
import { PermissionBar } from './PermissionBar';
import { extractChoiceChips, type ChoiceChip } from '../choiceChips.ts';
import { slashIntent, resolveChoice, type SlashIntent } from '../slashPicker.ts';
import { visit } from 'unist-util-visit';

// U+2318 has no glyph in the Windows/Linux font stack and renders as a tofu box,
// so name the modifier for the actual platform instead of showing both.
const MOD_KEY =
  typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC')
    ? '⌘'
    : 'Ctrl';

// Make links/paths in messages clickable: URLs open in the browser, file/dir
// paths open in the OS (via app:open-external). Applied to every markdown render.
// Format a model's context window token count for the selector: 1000000 -> "1M",
// 272000 -> "272k". Keeps one decimal only when it isn't a whole million.
/**
 * 价格乘数 —— 「在模型列表里面把价格乘数也加进去」/「模型的乘数怎么不见了」。
 *
 * 后端本来就给（`rate_multiplier`，实测 opus-5 = 2.2、sonnet-5 = 1.3、auto = 1.0），
 * 只是列表里没显示 —— 于是"换个模型"这件事的**代价**在做决定的地方看不见，
 * 而这是这一格里唯一会花钱的选择。
 *
 * `1.0` 也照样显示：不显示就分不出"一倍"和"这个模型没给数据"，而那正是你想知道的。
 * 拿不到（老后端、字段缺失）才留空。
 *
 * （这一段在 `standard` 上一度不见了 —— 是我那次手工 backport 漏掉的，不是被谁删了。）
 */
function fmtRate(multiplier: unknown): string {
  const n = Number(multiplier);
  if (!Number.isFinite(n) || n <= 0) return '';
  /* 2 → `2×`，1.3 → `1.3×`：整数不写小数点，省一个字符（那一行本来就窄） */
  return `${Number.isInteger(n) ? n : n.toFixed(1)}×`;
}

function fmtContextWindow(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}
const mdUrlTransform = (url: string) => (/^javascript:/i.test(url) ? '' : url);
// Inline code that looks like a file path (ends in a known extension) becomes a
// clickable link that opens the file — covers kiro's file references (usually in
// `backticks`) and diff paths mentioned in prose.
const URL_RE = /^(https?:|mailto:|tel:)/i;
// Open a file path inside KiroLex's own viewer (not the OS default app). App
// listens for this event and shows the in-app file modal. URLs still go external.
function openPathInApp(target: string, sessionId?: string) {
  window.dispatchEvent(new CustomEvent('kirolex:open-file', { detail: { path: target, sessionId } }));
}
/**
 * **这条消息属于哪条会话** ——「为啥这两个会话里的文件链接打不开」。相对路径（`files/blog-draft-v1.md`）
 * 要按那条会话自己的目录解析；以前查存在和打开都不带会话 id，主进程只能按家目录解析，于是全部打不开。
 * 用 context 而不是读全局"当前会话"：分屏时两个窗格是两条会话。
 */
const PathSessionContext = React.createContext<string>('');
// Existence cache so a file path is only stat'd once across the whole transcript.
// 'pending' while the async check is in flight; a path that doesn't exist is
// rendered as plain text (no dead link) instead of a clickable reference.
const pathExistsCache = new Map<string, boolean>();
const pathExistsInflight = new Map<string, Promise<boolean>>();
function usePathExists(path: string, sessionId = ''): 'pending' | 'yes' | 'no' {
  /* 缓存按"会话 + 路径"：同一个相对路径在两条会话里指的是两个文件 */
  const key = `${sessionId}|${path}`;
  const cached = pathExistsCache.get(key);
  const [state, setState] = useState<'pending' | 'yes' | 'no'>(
    cached === undefined ? 'pending' : cached ? 'yes' : 'no',
  );
  useEffect(() => {
    if (pathExistsCache.has(key)) {
      setState(pathExistsCache.get(key) ? 'yes' : 'no');
      return;
    }
    let live = true;
    let p = pathExistsInflight.get(key);
    if (!p) {
      p = Promise.resolve(window.kiroApi.pathExists?.(path, sessionId || undefined) ?? true).then((ok) => {
        pathExistsCache.set(key, !!ok);
        pathExistsInflight.delete(key);
        return !!ok;
      });
      pathExistsInflight.set(key, p);
    }
    p.then((ok) => { if (live) setState(ok ? 'yes' : 'no'); });
    return () => { live = false; };
  }, [key, path, sessionId]);
  return state;
}
// Renders a file/dir path as a clickable in-app reference ONLY when it exists on
// disk; otherwise (or while checking) it renders as plain text so broken links
// never appear. Used for both linkified prose paths (<a>) and inline file tokens.
const FileRef = ({ path, as, className, children }: {
  path: string; as: 'a' | 'code'; className?: string; children: React.ReactNode;
}) => {
  const t = useT();
  const sessionId = React.useContext(PathSessionContext);
  const exists = usePathExists(path, sessionId);
  if (exists !== 'yes') {
    // Not (yet) known to exist -> plain, non-clickable text. **不带链接的样式**：原来照样挂着
    // md-file-link，看起来能点、点了没反应 —— 那就是「文件链接打不开」的另一半。
    return as === 'code'
      ? <code className={className === 'md-file-link' ? undefined : className}>{children}</code>
      : <span>{children}</span>;
  }
  if (as === 'code') {
    return (
      <code className="md-file-link" title={t('Open the file inside KiroLex')} onClick={() => openPathInApp(path, sessionId)}>
        {children}
      </code>
    );
  }
  return (
    <a
      href="#"
      className="md-link"
      onClick={(e: React.MouseEvent) => { e.preventDefault(); openPathInApp(path, sessionId); }}
    >
      {children}
    </a>
  );
};
/**
 * 用户气泡和 KiroLex 自己的提示里的裸路径也变成可点的 —— 「修改里的文件位置没有链接」。
 *
 * 助手那侧一直有（`remarkLinkifyPaths` + `FileRef`），用户这侧是**纯文本**渲染，而且那是故意的：
 * 你打进去的字不该被 markdown 重排。所以这里只把命中 `PATH_RE` 的那几段换成 `FileRef`，其余原样。
 * 文件不在盘上时 `FileRef` 自己退回普通文本，所以不会出现一个点了没反应的链接。
 */
function withPathLinks(text: string, keyBase: string): React.ReactNode {
  PATH_RE.lastIndex = 0;
  if (!PATH_RE.test(text)) return text;
  PATH_RE.lastIndex = 0;
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<FileRef key={`${keyBase}:${m.index}`} path={m[0]} as="a">{m[0]}</FileRef>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
const MD_COMPONENTS = {
  a: ({ href, children }: any) => {
    // Real URLs always open externally. A linkified file/dir path only becomes a
    // clickable in-app link when it actually exists on disk (else plain text).
    if (href && URL_RE.test(href)) {
      return (
        <a
          href={href}
          className="md-link"
          onClick={(e: React.MouseEvent) => { e.preventDefault(); void window.kiroApi.openExternal?.(href); }}
        >
          {children}
        </a>
      );
    }
    if (!href) return <span>{children}</span>;
    return <FileRef path={href} as="a">{children}</FileRef>;
  },
  // A table gets a scrolling wrapper. `table-layout: fixed` divides the pane between
  // the columns, which keeps a table inside its box but cannot make 5 columns readable
  // in a 275px split pane -- so the wrapper gives it somewhere to scroll. Without it
  // the overflow was clipped by the transcript's `overflow-x: hidden` and the data was
  // simply gone (measured: a 791px table inside a 275px container).
  table: ({ children, ...props }: any) => (
    <div className="md-table-scroll">
      <table {...props}>{children}</table>
    </div>
  ),
  // Fenced code blocks had NO copy button -- only user-message blocks and pasted
  // blobs did. A one-line URL in a code fence was therefore unselectable in
  // practice: it overflows horizontally, so dragging to select it scrolls away.
  // react-markdown renders <pre><code>…</code></pre>, so the button belongs on the
  // <pre> wrapper, where it can read the block's exact source from the code child.
  pre: ({ children, ...props }: any) => {
    const codeEl: any = Array.isArray(children) ? children[0] : children;
    /*
      文本必须**递归**取（`mdText`），不能 `join('')` —— `rehypeHighlight` 把代码切成一堆
      `<span class="hljs-…">` 元素，join 出来是 `[object Object][object Object]…`，「复制」按钮
      复制的就是那一坨（用户当成会话报错贴了出来）。空白是普通字符串所以留着，于是缩进看着像真代码。
    */
    const text = mdText(codeEl?.props?.children);
    return <MdCodeBlock text={text} preProps={props}>{children}</MdCodeBlock>;
  },
  code: ({ className, children, ...props }: any) => {
    /* 同上：高亮过的行内代码 join 出来是 `[object Object]`，「这是不是文件路径」就判错了 */
    const raw = mdText(children);
    const isBlock = !!className || raw.includes('\n');
    const text = raw.trim();
    if (!isBlock && FILE_TOKEN_RE.test(text)) {
      // Only clickable when the file exists on disk (else plain inline code).
      return <FileRef path={text} as="code" className="md-file-link">{children}</FileRef>;
    }
    return <code className={className} {...props}>{children}</code>;
  },
};
/** Inline thumbnail for an image attachment.
 *
 *  Attachments used to render as `📁 Screenshot 1` -- an icon and a name, so a
 *  pasted screenshot gave no idea WHAT was sent. `preview` (a data URL) only exists
 *  for the paste that created it and is deliberately NOT persisted in the
 *  transcript, so after a reload there is nothing to show; the bytes are read back
 *  from disk on demand instead, cached per path so a re-render never re-reads. */
const thumbCache = new Map<string, string>();
const AttachmentThumb: React.FC<{ file: AttachedFile; sessionId: string | null; onOpen?: (path: string) => void }> = ({ file, sessionId, onOpen }) => {
  const t = useT();
  const [src, setSrc] = useState<string | null>(file.preview || thumbCache.get(file.path) || null);
  useEffect(() => {
    if (src || !file.isImage || !file.path) return;
    let cancelled = false;
    void (async () => {
      try {
        // Session-free read FIRST. This used to call workspaceRead(sessionId, path),
        // which throws "This chat is not connected." whenever the chat has no live
        // kiro-cli -- so a dormant chat (or any chat rendering before its executor
        // attached) showed 🖼️ + the file name instead of the picture, permanently,
        // because nothing retried. Reading bytes off disk needs no backend.
        const direct = await window.kiroApi.readImageDataUrl?.(file.path);
        if (!cancelled && direct?.dataUrl) { thumbCache.set(file.path, direct.dataUrl); setSrc(direct.dataUrl); return; }
        // Fallback for remote sessions, where the file lives on the other host and
        // only the session-scoped reader can fetch it.
        if (!sessionId) return;
        const res = await window.kiroApi.workspaceRead?.(sessionId, file.path);
        if (!cancelled && res?.image && res.dataUrl) { thumbCache.set(file.path, res.dataUrl); setSrc(res.dataUrl); }
      } catch { /* leave the icon fallback in place */ }
    })();
    return () => { cancelled = true; };
  }, [file.path, file.isImage, sessionId, src]);
  if (!file.isImage) return null;
  if (!src) return <span className="message-attachment-icon">🖼️</span>;
  return (
    <img
      className="message-attachment-thumb"
      src={src}
      alt={file.name}
      title={t('{name} — click to view full size', { name: file.name })}
      onClick={onOpen ? () => onOpen(file.path) : undefined}
    />
  );
};

/** A fenced code block with a hover Copy button. Copies the block's SOURCE, not
 *  the rendered/highlighted DOM, so a long single-line value comes back intact. */
const MdCodeBlock: React.FC<{ text: string; preProps?: any; children?: React.ReactNode }> = ({ text, preProps, children }) => {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  };
  /**
   * **围栏里只有一条路径时，那条路径可点** —— 「我在技术问题这个会话中发现 …md 无法直接超链接打开，为什么」。
   *
   * 那次的形状是模型很爱用的写法：
   *
   *     已写到：
   *     ```text
   *     /Users/keyinan/Downloads/devops-agent-rds-诊断配置指南.md
   *     ```
   *
   * 链接化原来只发生在两处 —— 行内代码（`code` 渲染器 + `FILE_TOKEN_RE`）和散文里的裸路径
   * （`remarkLinkifyPaths`）。围栏两处都不走，而且**大部分时候这是对的**：围栏里常常是一整段脚本，
   * 把里面每个路径都染蓝会把代码变成一片链接。
   *
   * 所以判据卡得很窄：**整个围栏 trim 之后只有一行，而且那一行整体就是一条路径**。
   * 一整段脚本不满足（多行），`cd /x && ls` 不满足（那一行不是"整体就是一条路径"）。
   * 存在性仍然由 `FileRef` 说话：文件不在盘上就是普通文本，绝不给一个点了没反应的链接。
   *
   * 「复制」按钮照旧留着 —— 它本来就是为这种情形存在的（长路径在围栏里横向溢出，拖选会把它滚走）。
   */
  const lines = text.replace(/\n+$/, '').split('\n');
  /**
   * 放宽到"不超过 3 行"是因为「路径 + 一行尺寸说明」同样常见（实测那条就是
   * `…/诊断配置指南.md` 换行 `529 行 / 19.8 KB`），而它和"只有一条路径"是同一个需求。
   *
   * 上限存在的理由是**存在性探测的成本**：判据放开到任意行数的话，一个 500 行的 `find` 输出
   * 就是 500 次 `pathExists`。3 行接住了实际的写法，又接不住任何"一段输出"。
   */
  const pathLines = lines.length <= 3
    ? lines.map((line) => (FILE_TOKEN_RE.test(line.trim()) ? line.trim() : null))
    : null;
  const anyPath = !!pathLines?.some(Boolean);
  return (
    <div className="md-code-wrap">
      <button type="button" className="md-code-copy" onClick={copy} title={t('Copy this code')}>
        {copied ? t('Copied') : t('Copy')}
      </button>
      <pre {...preProps}>
        {anyPath && pathLines
          /* 只换掉"整行就是路径"的那几行，其余行原样 —— 尺寸说明那种行不该变成链接 */
          ? lines.map((line, i) => (
            <React.Fragment key={i}>
              {pathLines[i]
                ? <FileRef path={pathLines[i] as string} as="code" className="md-file-link">{line}</FileRef>
                : line}
              {i < lines.length - 1 ? '\n' : null}
            </React.Fragment>
          ))
          : children}
      </pre>
    </div>
  );
};

// Linkify absolute file/dir paths in plain text. Tightened to avoid matching prose
// like "/update/delete": require a Windows path, a path under a known root, or a
// path ending in a file extension.
function remarkLinkifyPaths() {
  return (tree: any) => {
    // Cast: this visitor RETURNS a new index to skip the nodes it just spliced in,
    // which is valid unist-util-visit behaviour but does not fit the strict
    // BuildVisitor<'text'> overload (it types `index` as number, never null). The
    // cast is what removes a long-standing TS2769 here without changing behaviour.
    visit(tree, 'text', ((node: any, index: number | null, parent: any) => {
      if (!parent || index == null || parent.type === 'link') return;
      const value: string = node.value || '';
      PATH_RE.lastIndex = 0;
      if (!PATH_RE.test(value)) return;
      PATH_RE.lastIndex = 0;
      const kids: any[] = [];
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = PATH_RE.exec(value))) {
        if (m.index > last) kids.push({ type: 'text', value: value.slice(last, m.index) });
        kids.push({ type: 'link', url: m[0], children: [{ type: 'text', value: m[0] }] });
        last = m.index + m[0].length;
      }
      if (last < value.length) kids.push({ type: 'text', value: value.slice(last) });
      parent.children.splice(index, 1, ...kids);
      return index + kids.length;
    }) as any);
  };
}
const MD_REMARK = [remarkGfm, remarkLinkifyPaths];

/* 常量在模块作用域，拿不到 hook —— 所以这里存**英文 key**，翻译发生在渲染点（`t(suggestion)`）。 */
const PROMPT_SUGGESTIONS = [
  'Explain what this project does and how it is structured',
  'Find and fix bugs in the current directory',
  'Add unit tests for the main modules',
  'Summarise the recent git changes',
  'Review this code for security problems',
];

type KiroAgentSource = 'built-in' | 'global' | 'local';

interface KiroAgentOption {
  name: string;
  isDefault: boolean;
  source: KiroAgentSource;
}

interface AgentConfigEditorState {
  agentName: string;
  path: string;
  content: string;
  initialContent: string;
  error?: string;
}

interface JsonValidationIssue {
  message: string;
  line: number;
  column: number;
}

function validateAgentConfigJson(content: string, t: (key: string) => string = (key) => key): JsonValidationIssue | null {
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        message: t('Agent configuration must be a JSON object.'),
        line: 1,
        column: 1,
      };
    }
    return null;
  } catch (error: any) {
    const message = error?.message || String(error);
    const explicitLocation = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
    if (explicitLocation) {
      return {
        message,
        line: Number(explicitLocation[1]),
        column: Number(explicitLocation[2]),
      };
    }

    const positionMatch = message.match(/position\s+(\d+)/i);
    const position = positionMatch
      ? Math.min(Number(positionMatch[1]), content.length)
      : content.length;
    const before = content.slice(0, position);
    const line = before.split('\n').length;
    const lastNewline = before.lastIndexOf('\n');
    return {
      message,
      line,
      column: position - lastNewline,
    };
  }
}

// Throttled markdown renderer: only re-renders markdown every N ms during streaming
const ThrottledMarkdown: React.FC<{ content: string; interval?: number }> = ({ content, interval = 150 }) => {
  const [rendered, setRendered] = useState(content);
  const lastUpdateRef = useRef(Date.now());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const now = Date.now();
    const elapsed = now - lastUpdateRef.current;

    if (elapsed >= interval) {
      setRendered(content);
      lastUpdateRef.current = now;
    } else {
      // Schedule an update for when the interval expires
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setRendered(content);
        lastUpdateRef.current = Date.now();
      }, interval - elapsed);
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [content, interval]);

  // Final flush: when content stops changing, ensure we show the latest
  useEffect(() => {
    return () => {
      setRendered(content);
    };
  }, []);

  return (
    <ReactMarkdown remarkPlugins={MD_REMARK} rehypePlugins={[rehypeHighlight]} components={MD_COMPONENTS as any} urlTransform={mdUrlTransform}>
      {rendered}
    </ReactMarkdown>
  );
};

/** Static markdown with EXACTLY the chat renderers: external links open in the
 *  system browser via openExternal, and file paths become clickable FileRefs.
 *  Exported so the file/report viewer renders .md instead of dumping raw source
 *  (a plain <pre> showed no formatting and made every URL unclickable). */
export const MarkdownView: React.FC<{ content: string }> = ({ content }) => (
  <ReactMarkdown
    remarkPlugins={MD_REMARK}
    rehypePlugins={[rehypeHighlight]}
    components={MD_COMPONENTS as any}
    urlTransform={mdUrlTransform}
  >
    {content}
  </ReactMarkdown>
);

// ---- Pasted text blobs -------------------------------------------------------
// Folding is decided by PROVENANCE, not by content shape: a paste this size gets
// swapped for a placeholder and stored on disk (same model as a pasted image),
// while anything you TYPE is never folded no matter how it looks.
//
// Thresholds: folding must only trigger on genuinely BULKY pastes. The previous
// values (>=3 lines or >=200 chars) folded a SINGLE-LINE 777-char stack trace into
// a placeholder, which reads as "paste is broken" -- you pasted an error message
// and the composer showed you a marker instead. A single line is one visible,
// wrapping thing; hiding it helps nobody. So the char trigger now REQUIRES more
// than one line, and a lone line only folds when it is large enough to genuinely
// swamp the composer (minified JSON, a base64 blob).
const PASTE_MIN_LINES = 6;
const PASTE_MIN_CHARS = 1200;
/** A single line only folds past this — well beyond any readable error message. */
const PASTE_SINGLE_LINE_MIN_CHARS = 4000;
/** `[ 粘贴 #1 · 42 行 ]` — the only thing that lands in the message text. */
const PASTE_PLACEHOLDER_RE = /\[ 粘贴 #(\d+) · (\d+) 行 \]/g;

/**
 * Scroll ONE container to its bottom.
 *
 * Deliberately not `element.scrollIntoView()`: that scrolls EVERY scrollable ancestor,
 * and `overflow: hidden` does not opt an element out -- a hidden container is still
 * programmatically scrollable. In split view the chain above a transcript is
 * `.chat-main` -> `.chat-row` -> `.chat-grid`, all `overflow: hidden` and all shared
 * with the other panes, so a single sub-pixel overflow anywhere up there let a
 * scrollIntoView in one pane shift the whole grid -- visible as a flash, with no
 * scrollbar and no way for the user to put it back. Writing `scrollTop` cannot reach
 * past the element it is called on.
 *
 * The second write on the next frame covers content that settles late (markdown,
 * highlighting, images): without it the first write lands against a height that then
 * grows, leaving the view short of the bottom. `stillWanted` guards that second write
 * so a user who starts scrolling up within that one frame is not yanked back.
 */
function scrollContainerToBottom(el: HTMLElement | null, stillWanted: () => boolean = () => true): void {
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  requestAnimationFrame(() => { if (stillWanted()) el.scrollTop = el.scrollHeight; });
}

/**
 * Reveal `el` inside its own transcript if it is out of view, moving nothing else.
 *
 * `block: 'nearest'` semantics done by hand, for the same reason as above: even
 * 'nearest' walks the ancestor chain, so revealing a button in one pane could shift
 * every other pane. The container is resolved from the element, so this is always the
 * transcript the element actually lives in.
 */
function revealInContainer(el: HTMLElement | null): void {
  const container = el?.closest('.chat-messages') as HTMLElement | null;
  if (!el || !container) return;
  const box = el.getBoundingClientRect();
  const view = container.getBoundingClientRect();
  if (box.bottom > view.bottom) container.scrollTop += box.bottom - view.bottom;
  else if (box.top < view.top) container.scrollTop -= view.top - box.top;
}

function pastePlaceholder(seq: number, lines: number): string {
  return `[ 粘贴 #${seq} · ${lines} 行 ]`;
}
function shouldCapturePaste(text: string): boolean {
  if (!text) return false;
  const lines = text.split('\n').length;
  if (lines >= PASTE_MIN_LINES) return true;
  // One line is one visible thing: only fold it when it would swamp the composer.
  if (lines <= 1) return text.length >= PASTE_SINGLE_LINE_MIN_CHARS;
  return text.length >= PASTE_MIN_CHARS;
}
export type PastedBlock = { seq: number; lines: number; chars: number; path: string; content?: string };
/** Swap placeholders back to the real text — what the MODEL must receive. */
export function expandPastes(text: string, blocks: PastedBlock[]): string {
  if (!blocks.length) return text;
  return text.replace(PASTE_PLACEHOLDER_RE, (m, seqStr) => {
    const b = blocks.find((x) => x.seq === Number(seqStr));
    return b?.content ?? m;
  });
}
/** Which blocks the text still references. A block whose placeholder the user
 *  deleted by hand must not travel with the message: it would record a paste the
 *  bubble never shows and keep that blob alive forever. */
function pastesReferencedBy(text: string, blocks: PastedBlock[]): PastedBlock[] {
  if (!blocks.length) return blocks;
  const seen = new Set<number>();
  PASTE_PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PASTE_PLACEHOLDER_RE.exec(text))) seen.add(Number(m[1]));
  return blocks.filter((b) => seen.has(b.seq));
}
/** Fill in `content` for blocks that only have a path (a draft restored after a
 *  restart), so the model still receives the real text and not the placeholder. */
async function hydratePasteContents(blocks: PastedBlock[]): Promise<PastedBlock[]> {
  return Promise.all(blocks.map(async (b) => {
    if (typeof b.content === 'string') return b;
    try {
      const body = await window.kiroApi.readPaste?.(b.path);
      return typeof body === 'string' ? { ...b, content: body } : b;
    } catch { return b; }
  }));
}

// Draft paste blocks PER SESSION, mirrored to disk. One shared ref used to leak
// blocks between chats (the composer is a single instance for all sessions while
// drafts are per-session) and did not survive a restart, so a restored draft kept
// a placeholder that could no longer expand and the raw `[ 粘贴 #N · M 行 ]` string
// was sent to the model.
const draftPastes: Record<string, PastedBlock[]> = {};
let draftPastesLoaded = false;
async function loadDraftPastesOnce() {
  if (draftPastesLoaded) return;
  draftPastesLoaded = true;
  try {
    const map = await window.kiroApi.getDraftPastes?.();
    if (map && typeof map === 'object') {
      for (const [sid, blocks] of Object.entries(map)) {
        if (Array.isArray(blocks)) draftPastes[sid] = blocks as PastedBlock[];
      }
    }
  } catch { /* best-effort */ }
}
function persistDraftPastes(sessionId: string | null, blocks: PastedBlock[]) {
  if (!sessionId) return;
  if (blocks.length) draftPastes[sessionId] = blocks;
  else delete draftPastes[sessionId];
  // `content` is intentionally not persisted: the bytes are already in the file.
  void window.kiroApi.setDraftPastes?.(
    sessionId,
    blocks.map(({ seq, lines, chars, path }) => ({ seq, lines, chars, path })),
  );
}

/** A `[ 粘贴 #N · M 行 ]` placeholder rendered as an expandable block. The body is
 *  read from disk ON DEMAND, so a huge paste costs nothing until you open it. */
const PastedBlockView = memo<{ block: { seq: number; lines: number; chars: number; path: string } }>(({ block }) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!open || body !== null || missing) return;
    let live = true;
    window.kiroApi.readPaste?.(block.path)
      .then((text: string | null) => {
        if (!live) return;
        if (typeof text === 'string') setBody(text);
        else setMissing(true);
      })
      .catch(() => { if (live) setMissing(true); });
    return () => { live = false; };
  }, [open, body, missing, block.path]);
  const copy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = body ?? (await window.kiroApi.readPaste?.(block.path)) ?? '';
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [body, block.path]);
  return (
    <div className={`user-code-block ${open ? 'open' : ''}`}>
      <div
        className="user-code-head"
        onClick={() => setOpen((o) => !o)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((o) => !o); } }}
        title={open ? t('Click to collapse') : t('Click to expand the pasted content')}
      >
        <span className="user-code-caret">{open ? '▾' : '▸'}</span>
        <span className="user-code-kind">{t('Paste #{n}', { n: block.seq })}</span>
        <span className="user-code-meta">{t('{lines} lines · {chars} chars', { lines: block.lines, chars: block.chars })}</span>
        <button type="button" className="user-code-copy" onClick={copy} title={t('Copy')}>
          {copied ? t('✓ Copied') : t('Copy')}
        </button>
      </div>
      {open && (
        <pre className="user-code-body">
          <code>{missing ? t('(pasted content unavailable: the file was deleted)') : (body ?? t('Reading…'))}</code>
        </pre>
      )}
    </div>
  );
});

const formatMessageTime = (timestamp: number) => {
  const messageDate = new Date(timestamp);
  const today = new Date();
  const isToday = messageDate.getFullYear() === today.getFullYear()
    && messageDate.getMonth() === today.getMonth()
    && messageDate.getDate() === today.getDate();

  return new Intl.DateTimeFormat(undefined, isToday
    ? { hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
  ).format(messageDate);
};

/**
 * KiroLex 自己说的话（`isKirolexNote`：换了后端会话、退到了备用模型、排队了、写好了备注…）。
 * 它既不是你说的，也不是助手的回答，所以画成居中的一张小卡片，不画成用户气泡 ——
 * 气泡会让它看起来像你发出去的，还带着「编辑 / Rerun」。里面的路径照样可点。
 */
/**
 * 带 `variants` 的消息按某种语言显示的那一份。**同一条消息 + 同一种语言永远是同一个对象**（WeakMap 缓存）——
 * 否则每次消息列表一变，这几条都是新对象，下面那些 memo 的消息项会白白重渲染（见 `paneIndependence` 那组测试）。
 */
const variantViews = new WeakMap<Message, { zh?: Message; en?: Message }>();
function variantView(m: Message, lang: 'zh' | 'en'): Message {
  let views = variantViews.get(m);
  if (!views) { views = {}; variantViews.set(m, views); }
  return views[lang] ??= { ...m, content: pickVariant(lang, m.content, m.variants) };
}

const KirolexMessageItem = memo<{ message: Message }>(({ message }) => (
  <div className="kirolex-message" role="status">
    <div className="kirolex-message-card">
      <span className="kirolex-message-label">KiroLex</span>
      <span className="kirolex-message-body">{withPathLinks(message.content, message.id)}</span>
      <time
        className="kirolex-message-time"
        dateTime={new Date(message.timestamp).toISOString()}
        title={new Date(message.timestamp).toLocaleString()}
      >
        {formatMessageTime(message.timestamp)}
      </time>
    </div>
  </div>
));

// Kiro CLI does not expose exact per-turn token counts. Estimate the visible
// question + answer, treating CJK characters as roughly one token and the
// remaining text as roughly one token per four characters.
const estimateVisibleTokens = (text: string) => {
  const cjkCount = (text.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const nonCjkLength = text.replace(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g, '').length;
  return Math.max(1, cjkCount + Math.ceil(nonCjkLength / 4));
};

// Memoized message item: only re-renders when its own content/streaming state changes
const MessageItem = memo<{
  segments: Message[];
  questionContent?: string;
  isLastAssistant: boolean;
  isStreaming: boolean;
  onFork: (messageId: string) => void;
  foldThinking: boolean;
  foldTools: boolean;
  /**
   * **这一轮的工具跑在哪台机器上**（远程会话才有值）——「看起来工具调用是在本地？」
   *
   * 实测那条记录长这样：`Running: printf … > REMOTE-PROOF.txt`，相对路径、没有 locations ——
   * 和本地执行长得一模一样。而它其实跑在东京那台 EC2 上（那条命令自己的输出是
   * `ip-10-0-4-14.ap-northeast-1.compute.internal`）。一条 `rm` 在哪台机器上跑，
   * 必须一眼看得出来，不能靠推。
   */
  remoteHost?: string;
}>(({ segments, questionContent, isLastAssistant, isStreaming, onFork, foldThinking, foldTools, remoteHost }) => {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const actionLocked = isLastAssistant && isStreaming;
  // One assistant turn = the consecutive assistant/tool/subagent messages between
  // two user turns, rendered as ONE bubble. Each segment carries a migration
  // marker prefix (🤖 subagent / 🔧 tool) which is stripped for display and shown
  // as a labelled badge, so a tool-using turn reads as one reply with inner
  // segments instead of being split into many separate replies.
  const SUB_PREFIX = '🤖 ';
  const TOOL_PREFIX = '🔧 ';
  const THINK_PREFIX = '💭 ';
  const last = segments[segments.length - 1];
  const parts = useMemo(() => segments.map((seg) => {
    const variant: 'subagent' | 'tool' | 'thinking' | null =
      seg.content.startsWith(SUB_PREFIX) ? 'subagent'
      : seg.content.startsWith(TOOL_PREFIX) ? 'tool'
      : seg.content.startsWith(THINK_PREFIX) ? 'thinking' : null;
    const body = variant === 'subagent' ? seg.content.slice(SUB_PREFIX.length)
      : variant === 'tool' ? seg.content.slice(TOOL_PREFIX.length)
      : variant === 'thinking' ? seg.content.slice(THINK_PREFIX.length)
      : seg.content;
    return { id: seg.id, variant, body };
  }), [segments]);
  // Copy excludes tool + thinking segments — only the actual reply text.
  const combinedText = useMemo(
    () => parts.filter((p) => p.variant !== 'tool' && p.variant !== 'thinking').map((p) => p.body).join('\n\n'),
    [parts],
  );
  // Tool segments are collapsed by default (only a chip shows); the user expands
  // them on demand. The actively-streaming last turn stays expanded so live tool
  // output is visible as it happens.
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const toggleTool = useCallback((segId: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(segId)) next.delete(segId); else next.add(segId);
      return next;
    });
  }, []);
  const turnFileChanges = useMemo(() => {
    const byId = new Map<string, ToolCall>();
    for (const segment of segments) {
      for (const toolCall of segment.toolCalls || []) byId.set(toolCall.toolCallId, toolCall);
    }
    return Array.from(byId.values());
  }, [segments]);
  const estimatedTokens = !actionLocked
    ? estimateVisibleTokens(`${questionContent || ''}\n${combinedText}`)
    : null;

  const copyMessage = useCallback(async () => {
    await navigator.clipboard.writeText(combinedText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [combinedText]);

  return (
    <div className="message assistant">
      <div className="message-content">
        {parts.map((p, idx) => {
          const streamThis = isStreaming && isLastAssistant && idx === parts.length - 1;
          const isCollapsible = p.variant === 'tool' || p.variant === 'thinking';
          // When the matching auto-fold setting is ON, a thinking/tool segment
          // auto-expands ONLY while it is the actively-streaming segment; the
          // moment a later segment begins — or the turn ends — it folds and stays
          // folded unless the user clicks it. When OFF, the segment stays open for
          // the whole running turn (legacy behavior).
          const running = isStreaming && isLastAssistant;
          const fold = p.variant === 'thinking' ? foldThinking : p.variant === 'tool' ? foldTools : false;
          const autoExpand = isCollapsible ? (fold ? streamThis : running) : running;
          const open = !isCollapsible || autoExpand || expandedTools.has(p.id);
          const firstLine = isCollapsible ? (p.body.split('\n').find((l) => l.trim()) || '').trim() : '';
          const hasMore = isCollapsible && p.body.trim().length > firstLine.length;
          const chipLabel = p.variant === 'thinking' ? t('💭 Thinking') : t('🔧 Tools');
          return (
            <div key={p.id} className={`turn-segment${p.variant ? ` variant-${p.variant}` : ''}`}>
              {isCollapsible && !autoExpand ? (
                <div className="tool-toggle-row">
                  <button
                    className={`msg-variant-badge ${p.variant} as-toggle`}
                    onClick={() => toggleTool(p.id)}
                    title={open ? t('Fold') : t('Expand')}
                  >
                    {open ? '▾' : '▸'} {chipLabel}
                  </button>
                  {!open && (
                    <span className="tool-collapsed-preview" onClick={() => toggleTool(p.id)} title={t('Expand')}>
                      {firstLine}{hasMore ? ' …' : ''}
                    </span>
                  )}
                </div>
              ) : p.variant && (
                <span className={`msg-variant-badge ${p.variant}`}>
                  {p.variant === 'subagent' ? t('🤖 Subagents') : p.variant === 'thinking' ? t('💭 Thinking') : t('🔧 Tools')}
                </span>
              )}
              {open && (streamThis ? (
                p.body ? (
                  <div className="streaming-content">
                    <ThrottledMarkdown content={p.body} interval={150} />
                  </div>
                ) : null
              ) : (
                <ReactMarkdown remarkPlugins={MD_REMARK} rehypePlugins={[rehypeHighlight]} components={MD_COMPONENTS as any} urlTransform={mdUrlTransform}>
                  {p.body}
                </ReactMarkdown>
              ))}
            </div>
          );
        })}
        {turnFileChanges.length > 0 && (
          <div className="message-turn-panels">
            <FileChangesPanel fileChanges={turnFileChanges} remoteHost={remoteHost} />
            {/* `live` = this turn is the one still running. The panel is open while it
                runs and closes itself when it ends, so a finished turn does not leave a
                wall of shell text in the transcript. */}
            <CommandsPanel fileChanges={turnFileChanges} live={isStreaming && isLastAssistant} remoteHost={remoteHost} />
          </div>
        )}
      </div>
      <div className="message-actions">
        <time
          className="message-time"
          dateTime={new Date(last.timestamp).toISOString()}
          title={new Date(last.timestamp).toLocaleString()}
        >
          {formatMessageTime(last.timestamp)}
        </time>
        {estimatedTokens !== null && (
          <span
            className="message-token-count"
            title={t('Estimated from the visible question and answer; Kiro CLI does not expose exact per-turn token counts.')}
          >
            · ≈ {estimatedTokens.toLocaleString()} {t('tokens')}
          </span>
        )}
        <button
          className="message-action-btn"
          onClick={() => void copyMessage()}
          title={copied ? t('Copied!') : t('Copy')}
          aria-label={copied ? t('Copied!') : t('Copy message')}
        >
          {copied ? '✓' : <IconCopy size={14} />}
        </button>
        <button
          className="message-action-btn"
          onClick={() => onFork(last.id)}
          disabled={actionLocked}
          title={t('Fork conversation from here')}
          aria-label={t('Fork conversation from here')}
        >
          <IconFork size={14} />
        </button>
      </div>
    </div>
  );
});

// A pasted blob inside a user message (code / log / JSON / tabular data) is
// collapsed by default so it doesn't flood the bubble. The classification below is
// deliberately EVIDENCE-BASED: earlier versions treated any markdown bullet, any
// bracket, any URL or any trailing comma as a "code signal", so a 10-line bulleted
// INSTRUCTION got folded away and labelled 代码; and a single occurrence of the
// word ERROR anywhere labelled the whole thing 日志. Rule now: if we cannot
// confidently name what the block is, we neither fold it nor label it.

/** A real log line: leading timestamp, leading level token, or a stack frame. */
function isLogLine(ln: string): boolean {
  return /^\s*[[(]?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(ln)          // 2026-08-04T11:00
    || /^\s*[[(]?\d{2}:\d{2}:\d{2}([.,]\d+)?\b/.test(ln)               // 11:00:03.120
    || /^\s*[[(]?(ERROR|WARN|WARNING|INFO|DEBUG|TRACE|FATAL|CRITICAL)\b/i.test(ln)
    || /^\s*at\s+[\w$.<>]+\s*\(/.test(ln)                              // java/js stack frame
    || /^\s*File\s+".+",\s+line\s+\d+/.test(ln)                        // python traceback frame
    || /^\s*(npm|yarn|pnpm)?\s*(ERR!|WARN)\b/.test(ln);
}

/** A real code line: statement/declaration shapes, not merely "contains a paren".
 *  Markdown bullets are intentionally NOT a signal — that is prose formatting. */
function isCodeLine(ln: string): boolean {
  const t = ln.trim();
  if (!t) return false;
  return /[;{}]$/.test(t)                                              // ends a statement/block
    || /^(import|export|from|const|let|var|function|async|def|class|struct|enum|interface|type|public|private|protected|return|if|else|elif|for|while|switch|case|try|catch|finally|throw|package|using|#include|#define|@\w+)\b/.test(t)
    || /=>|::|->|\|\||&&|!==|===|\+=|-=/.test(t)
    || /^[\w"'\-.[\]]+\s*[:=]\s*\S+,?$/.test(t)                        // key: value / key = value
    || /^<\/?[a-zA-Z][\w:-]*(\s|>|\/>)/.test(t)                        // markup tag
    || /^\$\s|^>\s*\w+@|^\w+@[\w.-]+:.*[$#]\s/.test(t);                // shell prompt lines
}

/** Consistent delimiter count per line = tabular paste (CSV/TSV). */
function looksTabular(lines: string[]): boolean {
  if (lines.length < 4) return false;
  const counts = lines.map((l) => (l.match(/[,\t|]/g) || []).length);
  const first = counts[0];
  if (first < 2) return false;
  const consistent = counts.filter((c) => c === first).length;
  return consistent / counts.length >= 0.8;
}

/** What this block IS, or null when we genuinely cannot tell. */
function classifyBlock(text: string): 'JSON' | '日志' | '代码' | '表格数据' | null {
  const t = text.trim();
  if (!t) return null;
  if (/^[[{][\s\S]*[\]}]$/.test(t)) {
    try { JSON.parse(t); return 'JSON'; } catch { /* not valid JSON, keep checking */ }
  }
  const lines = t.split('\n').filter((l) => l.trim());
  if (!lines.length) return null;
  const logRatio = lines.filter(isLogLine).length / lines.length;
  const codeRatio = lines.filter(isCodeLine).length / lines.length;
  if (/Traceback \(most recent call last\)/.test(t) || logRatio >= 0.4) return '日志';
  if (codeRatio >= 0.4) return '代码';
  if (looksTabular(lines)) return '表格数据';
  return null;
}

function looksLikeCodeOrData(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Explicit fenced code is self-declared — always foldable.
  if (/```/.test(t)) return true;
  // Whole-blob JSON is foldable regardless of line count: minified JSON is ONE
  // long line, so the length/line thresholds below would let it flood the bubble.
  if (t.length > 80 && classifyBlock(t) === 'JSON') return true;
  const lines = t.split('\n');
  const longEnough = lines.length >= 10 || t.length >= 600;
  if (!longEnough) return false;
  // Only fold what we can actually name. Prose (including bulleted instructions
  // and CJK text) classifies as null and therefore stays fully visible.
  return classifyBlock(t) !== null;
}

/** 上面那几个类别是内部标识（也拿来比较），显示时换成界面语言 —— 英文 key 都在字典里。 */
const BLOCK_KIND_LABEL: Record<string, string> = { '日志': 'Log', '代码': 'Code', '表格数据': 'Tabular data', '粘贴内容': 'Pasted content' };

function blockKind(text: string): string {
  // Fenced content we didn't classify is still just "pasted content" — do not
  // assert 代码/日志 without evidence.
  return classifyBlock(text) ?? '粘贴内容';
}

// Split a qualifying paragraph into a leading prose head (kept visible) and the
// trailing code/log/JSON block (collapsed). This keeps the user's actual
// question/intro lines readable while folding the pasted blob. If the blob
// starts at line 0, head is '' and the whole paragraph is the block.
function splitProseAndBlock(text: string): { head: string; block: string } {
  const lines = text.split('\n');
  // Same evidence-based test as the classifier: a bullet, a bracket or a URL in a
  // sentence must NOT start a "code block" and swallow the rest of the message.
  const isCodey = (ln: string) => isCodeLine(ln) || isLogLine(ln);
  for (let i = 0; i < lines.length; i++) {
    if (!isCodey(lines[i])) continue;
    const rest = lines.slice(i);
    const codey = rest.filter(isCodey).length;
    if ((rest.length >= 6 || rest.join('\n').length >= 300) && codey / rest.length >= 0.5) {
      return { head: lines.slice(0, i).join('\n').trim(), block: rest.join('\n') };
    }
  }
  return { head: '', block: text };
}

// Collapsed-by-default block for long pasted content in a user message. Shows a
// one-line chip (kind + line/char count + Copy); click the chip to expand the
// raw content in a scrollable <pre>. Copy works whether collapsed or expanded.
const CollapsibleUserBlock = memo<{ content: string }>(({ content }) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const body = content.replace(/\n$/, '');
  const lineCount = body.split('\n').length;
  const kind = blockKind(body);
  // Highlight ONLY when we know what this is, and only when expanded. Blind
  // highlightAuto() used to run on logs and plain pasted text too, where it guesses
  // some random grammar and colours the output wrongly — worse than no colour.
  const highlighted = useMemo(() => {
    if (!open) return null;
    if (kind === 'JSON') {
      try { return hljs.highlight(body, { language: 'json', ignoreIllegals: true }).value; } catch { return null; }
    }
    if (kind !== '代码') return null; // 日志 / 表格数据 / 粘贴内容 stay plain
    try {
      return hljs.highlightAuto(body).value;
    } catch {
      return null;
    }
  }, [open, body, kind]);
  const copy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      await navigator.clipboard.writeText(body);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    },
    [body],
  );
  return (
    <div className={`user-code-block ${open ? 'open' : ''}`}>
      <div
        className="user-code-head"
        onClick={() => setOpen((o) => !o)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
        title={open ? t('Click to collapse') : t('Click to expand')}
      >
        <span className="user-code-caret">{open ? '▾' : '▸'}</span>
        <span className="user-code-kind">{BLOCK_KIND_LABEL[kind] ? t(BLOCK_KIND_LABEL[kind]) : kind}</span>
        <span className="user-code-meta">{t('{lines} lines · {chars} chars', { lines: lineCount, chars: body.length })}</span>
        <button type="button" className="user-code-copy" onClick={copy} title={t('Copy')}>
          {copied ? t('✓ Copied') : t('Copy')}
        </button>
      </div>
      {open && (
        <pre className="user-code-body">
          {highlighted !== null
            ? <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
            : <code>{body}</code>}
        </pre>
      )}
    </div>
  );
});
CollapsibleUserBlock.displayName = 'CollapsibleUserBlock';

// Renders a turn's original user message and every mid-turn steer as one
// continuous paragraph in one bubble. The underlying steer messages and ids
// remain separate for pending/rollback/consume/queue-fallback bookkeeping, but
// the UI exposes one timestamp, one Copy action, and one Fork action for the
// whole turn. Fork still targets the last steer id so its history is complete.
const UserGroupItem = memo<{
  base: Message;
  steers: Message[];
  isStreaming: boolean;
  onRerun: (messageId: string, editedText: string) => void;
  /** The turn was interrupted and awaits an overwrite from the composer -- per
   *  message Rerun is intentionally blocked in that state. */
  interrupted?: boolean;
  isLooping: boolean;
  onScheduleSetup: (text: string) => void;
  /** Needed to read an image attachment back from disk for its thumbnail. */
  attachmentSessionId?: string | null;
  onOpenAttachment?: (path: string) => void;
}>(({ base, steers, isStreaming, onRerun, isLooping, onScheduleSetup, interrupted, attachmentSessionId, onOpenAttachment }) => {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // Each entry keeps an isSteer flag so a mid-turn steer paragraph can carry a
  // small left marker in the bubble, while the original question does not. The
  // group shows a single timestamp + Copy/Edit (Fork lives on the reply).
  const paragraphs = useMemo(() => {
    const out: { text: string; isSteer: boolean }[] = [];
    const b = base.content.trim();
    if (b) out.push({ text: b, isSteer: false });
    for (const steer of steers) {
      const t = steer.content.trim();
      if (t) out.push({ text: t, isSteer: true });
    }
    return out;
  }, [base.content, steers]);
  const combinedText = useMemo(() => paragraphs.map((p) => p.text).join('\n\n'), [paragraphs]);
  // Editor draft joins paragraphs with a single newline so previously-steered
  // turns don't show the display-only blank-line spacing inside the textarea.
  const draftText = useMemo(() => paragraphs.map((p) => p.text).join('\n'), [paragraphs]);
  const attachments = useMemo(
    () => [
      ...(base.attachments || []),
      ...steers.flatMap((steer) => steer.attachments || []),
    ],
    [base.attachments, steers],
  );

  const copyMessage = useCallback(async () => {
    await navigator.clipboard.writeText(combinedText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [combinedText]);

  const beginEdit = useCallback(() => {
    setDraft(draftText);
    setEditing(true);
  }, [draftText]);

  const submitRerun = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    setEditing(false);
    onRerun(base.id, text);
  }, [base.id, draft, onRerun]);

  // When edit mode opens, scroll the Rerun/Cancel actions into view so the
  // button is never left hidden below the fold in a long conversation. Scrolls THIS
  // transcript only -- scrollIntoView would also scroll the shared grid above it and
  // drag the other panes along. See revealInContainer.
  const editActionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!editing) return;
    requestAnimationFrame(() => revealInContainer(editActionsRef.current));
  }, [editing]);

  return (
    <div className="message user">
      {/* Attachments belong ABOVE the text: they are the context the message
          refers to, so the reader sees the files/images first. */}
      {attachments.length > 0 && (
        <div className="message-attachments">
          {attachments.map((file) => (
            <div
              key={file.id}
              className={`message-attachment-item${file.isImage ? ' image' : ''}`}
              title={file.path}
            >
              {file.isImage ? (
                <AttachmentThumb file={file} sessionId={attachmentSessionId ?? null} onOpen={onOpenAttachment} />
              ) : (
                <span className="message-attachment-icon">
                  {file.path.endsWith('/') || file.path.endsWith('\\') || !file.name.includes('.') ? '📁' : '📄'}
                </span>
              )}
              <span className="message-attachment-name">{file.name}</span>
            </div>
          ))}
        </div>
      )}
      <div className={`message-content ${editing ? 'editing' : ''}`}>
        {editing ? (
          <textarea
            className="message-edit-textarea"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.preventDefault(); setEditing(false); return; }
              // Enter submits (Rerun); Shift+Enter inserts a newline. Guard IME
              // composition so committing a Chinese candidate with Enter doesn't
              // fire a rerun.
              if (event.key === 'Enter' && !event.shiftKey && !(event.nativeEvent as any).isComposing) {
                event.preventDefault();
                submitRerun();
              }
            }}
            autoFocus
            rows={Math.max(3, Math.min(12, draft.split('\n').length + 1))}
          />
        ) : paragraphs.map((paragraph, index) => {
          const key = `${base.id}:paragraph:${index}`;
          // A `[ 粘贴 #N · M 行 ]` placeholder is authoritative: this text WAS pasted,
          // so it folds by provenance and needs no content guessing at all.
          const pasteBlocks = base.pastes || [];
          if (pasteBlocks.length && PASTE_PLACEHOLDER_RE.test(paragraph.text)) {
            PASTE_PLACEHOLDER_RE.lastIndex = 0;
            const parts: React.ReactNode[] = [];
            let last = 0;
            let m: RegExpExecArray | null;
            while ((m = PASTE_PLACEHOLDER_RE.exec(paragraph.text))) {
              const lead = paragraph.text.slice(last, m.index);
              if (lead.trim()) parts.push(<p key={`${key}:t${last}`}>{withPathLinks(lead, `${key}:t${last}`)}</p>);
              const seq = Number(m[1]);
              const blk = pasteBlocks.find((b) => b.seq === seq)
                || { seq, lines: Number(m[2]) || 0, chars: 0, path: '' };
              parts.push(<PastedBlockView key={`${key}:p${seq}`} block={blk} />);
              last = m.index + m[0].length;
            }
            const tail = paragraph.text.slice(last);
            if (tail.trim()) parts.push(<p key={`${key}:tail`}>{withPathLinks(tail, `${key}:tail`)}</p>);
            return <React.Fragment key={key}>{parts}</React.Fragment>;
          }
          // Long pasted code/log/JSON collapses into a click-to-expand block;
          // any leading prose (the user's question/intro) stays visible, and
          // short text (incl. all steer prose) keeps its existing rendering.
          if (looksLikeCodeOrData(paragraph.text)) {
            const { head, block } = splitProseAndBlock(paragraph.text);
            const label = paragraph.isSteer ? (
              <span className="steer-side-label" title={t('Steered into the running turn')}>{t('Steer')}</span>
            ) : null;
            if (head) {
              return (
                <React.Fragment key={key}>
                  <p className={paragraph.isSteer ? 'steer-paragraph' : undefined}>
                    {label}
                    {withPathLinks(head, key)}
                  </p>
                  <CollapsibleUserBlock content={block} />
                </React.Fragment>
              );
            }
            return paragraph.isSteer ? (
              <div key={key} className="steer-paragraph steer-block-wrap">
                {label}
                <CollapsibleUserBlock content={block} />
              </div>
            ) : (
              <CollapsibleUserBlock key={key} content={block} />
            );
          }
          return paragraph.isSteer ? (
            <p key={key} className="steer-paragraph">
              <span className="steer-side-label" title={t('Steered into the running turn')}>{t('Steer')}</span>
              {withPathLinks(paragraph.text, key)}
            </p>
          ) : (
            <p key={key}>{withPathLinks(paragraph.text, key)}</p>
          );
        })}
      </div>
      {editing && (
        <div className="message-edit-actions" ref={editActionsRef}>
          <button type="button" className="message-edit-btn cancel" onClick={() => setEditing(false)}>{t('Cancel')}</button>
          <button type="button" className="message-edit-btn rerun" onClick={submitRerun} disabled={isLooping || !draft.trim()}>{t('Rerun')}</button>
        </div>
      )}
      <div className="message-actions">
        <time
          className="message-time"
          dateTime={new Date(base.timestamp).toISOString()}
          title={new Date(base.timestamp).toLocaleString()}
        >
          {formatMessageTime(base.timestamp)}
        </time>
        <button
          className="message-action-btn"
          onClick={() => void copyMessage()}
          title={copied ? t('Copied!') : t('Copy')}
          aria-label={copied ? t('Copied!') : t('Copy message')}
        >
          {copied ? '✓' : <IconCopy size={14} />}
        </button>
        <button
          className="message-action-btn schedule-message-action"
          onClick={() => onScheduleSetup(combinedText)}
          // NOT disabled during a turn. Inherited from the 🔁 loop button, where starting a loop
          // mid-turn genuinely conflicted (the renderer drove those sends). Creating a SCHEDULE
          // sends nothing now — it writes one record and main's ticker fires it later — so the
          // guard only enforced "wait for the reply before you may schedule anything".
          // Empty text still cannot be scheduled: there would be no prompt to send.
          disabled={!combinedText.trim()}
          title={t('Send this message again on a schedule')}
          aria-label={t('Make it a scheduled job')}
        >
          ⏰
        </button>
        <button
          className="message-action-btn"
          onClick={beginEdit}
          disabled={isLooping || interrupted}
          title={isLooping
            ? t('A loop is running — stop it first')
            : interrupted
            ? t('This turn was interrupted — resubmit below; the new message replaces it')
            : t('Edit and rerun')}
          aria-label={t('Edit and rerun')}
        >
          <IconEdit size={14} />
        </button>
      </div>
    </div>
  );
});

// Isolated input component: does NOT receive `messages` prop, so it never re-renders due to streaming chunks. This is the primary fix for input lag.
/**
 * **侧栏 comment 提交之后排着的改写** —— 摆在这条会话自己的排队消息旁边，每条一个取消。
 * 执行不走这里（见 `reviewQueue.ts`：那些改写的回复要由 KiroLex 接住拼回文件），这里只是看得见、取消得了。
 */
const ReviewQueueStack: React.FC<{ sessionId: string | null }> = ({ sessionId }) => {
  const items = useReviewQueue(sessionId);
  const t = useT();
  if (!items.length) return null;
  return (
    <div className="queue-row">
      <div className="queue-stack review-queue-stack">
        <div className="queue-stack-header">
          <span>{t('Sidebar comment rewrites')}</span>
          <span>{items.length}</span>
        </div>
        {items.map((item, index) => (
          <div key={item.id} className="queue-card">
            <span className="queue-card-order">{index + 1}</span>
            <div className="queue-card-body">
              <span className="queue-card-text" title={`${item.file} · ${item.label}`}>
                {item.state === 'running' ? '⏳ ' : ''}{item.file} · {item.label}{item.state === 'running' ? t(' (in progress)') : t(' (queued)')}
              </span>
            </div>
            <div className="queue-card-actions">
              <button type="button" onClick={() => item.cancel()} title={t('Cancel this rewrite (the sidebar mark goes back)')}>✕</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

/** Queued follow-ups panel. Rendered as its own in-flow row between the message
 *  list and the composer (NOT an absolute overlay) so it never covers the chat
 *  or the input box -- the message list shrinks to give the queue its own space. */
const QueueStack = memo<{
  queuedMessages: QueuedMessage[];
  onCancelQueuedMessage: (queueId: string) => void;
  onEditQueuedMessage: (queueId: string, content: string) => void;
  onMoveQueuedMessage: (queueId: string, direction: -1 | 1) => void;
  /** Whether the whole queue will be sent as ONE merged turn (Settings toggle). */
  mergeQueued: boolean;
}>(({ queuedMessages, onCancelQueuedMessage, onEditQueuedMessage, onMoveQueuedMessage, mergeQueued }) => {
  const t = useT();
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const [editingQueueText, setEditingQueueText] = useState('');
  if (queuedMessages.length === 0) return null;
  return (
    <div className="queue-row">
      <div className="queue-stack">
        <div className="queue-stack-header">
          <span>{t('Queued follow-ups')}</span>
          {/* The merge setting CHANGES the meaning of this queue (one turn vs N
              turns), so it has to be visible right here — not only in Settings. */}
          <span
            className={`queue-mode-badge ${mergeQueued ? 'merge' : ''}`}
            title={mergeQueued
              ? t('Merged: the whole queue goes out as one message (10 per batch at most)')
              : t('One by one: only the first is sent, the rest keep queueing')}
          >
            {mergeQueued
              ? (queuedMessages.length > 1 ? t('Send as one message') : t('Merged'))
              : t('One by one')}
          </span>
          <span>{queuedMessages.length}</span>
        </div>
        {queuedMessages.map((item, index) => (
          <div key={item.id} className="queue-card">
            <span className="queue-card-order">{index + 1}</span>
            <div className="queue-card-body">
              {editingQueueId === item.id ? (
                <input
                  className="queue-card-edit-input"
                  value={editingQueueText}
                  /* 说清怎么收尾 —— 这个框长得像一行普通输入，而它的两个出口都是键盘 */
                  placeholder={t('Press Enter to save, Esc to cancel')}
                  autoFocus
                  onChange={(event) => setEditingQueueText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && editingQueueText.trim()) {
                      onEditQueuedMessage(item.id, editingQueueText);
                      setEditingQueueId(null);
                    } else if (event.key === 'Escape') {
                      setEditingQueueId(null);
                    }
                  }}
                />
              ) : (
                <span className="queue-card-text" title={item.content}>{item.content}</span>
              )}
              {item.attachments.length > 0 && (
                <span className="queue-card-attachments">📎 {item.attachments.length}</span>
              )}
            </div>
            <div className="queue-card-actions">
              {editingQueueId === item.id ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      if (editingQueueText.trim()) onEditQueuedMessage(item.id, editingQueueText);
                      setEditingQueueId(null);
                    }}
                    title={t('Save this edit')}
                  >✓</button>
                  <button type="button" onClick={() => setEditingQueueId(null)} title={t('Discard this edit')}>↩</button>
                </>
              ) : (
                <>
                  {/* 都写 `type="button"`：`<button>` 默认是 submit，哪天被包进 `<form>` 点一下就成了提交 */}
                  <button
                    type="button"
                    onClick={() => onMoveQueuedMessage(item.id, -1)}
                    disabled={index === 0}
                    title={t('Move up one')}
                  >↑</button>
                  <button
                    type="button"
                    onClick={() => onMoveQueuedMessage(item.id, 1)}
                    disabled={index === queuedMessages.length - 1}
                    title={t('Move down one')}
                  >↓</button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingQueueId(item.id);
                      setEditingQueueText(item.content);
                    }}
                    title={t('Edit this queued message')}
                  >✎</button>
                  <button
                    type="button"
                    onClick={() => onCancelQueuedMessage(item.id)}
                    title={t('Withdraw this one (its text goes back to the input box)')}
                  >✕</button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});

/* Per-session composer drafts. A half-written prompt belongs to ITS chat -- it
   must not follow the user into another session.

   Lifetime is ONE RUN, and that needs both halves:
     - kept on DISK (ui-state.json), not just in this module, so a draft survives
       anything that happens within a run -- a layout change that remounts the
       composer, a renderer reload from HMR, a crashed window;
     - wiped by MAIN at boot (RUN_SCOPED_UI_STATE_KEYS), so it never survives a
       restart. Only main can tell a fresh launch from a reload of the same run; to
       the renderer both look like a new page, which is why this is not done here. */
const COMPOSER_DRAFTS_KEY = 'kirolex-composer-drafts';
const composerDrafts: Record<string, string> = (() => {
  try {
    // The shared store, NOT localStorage: that is origin-scoped and this app has two
    // renderer origins (file:// normally, http://localhost:5173 in dev), so an unsent
    // draft used to be lost on every switch between `npm start` and `npm run dev:hot`.
    const raw = uiGet(COMPOSER_DRAFTS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
})();
function stashComposerDraft(sessionId: string | null, text: string) {
  if (!sessionId) return;
  if (text.trim()) composerDrafts[sessionId] = text;
  else delete composerDrafts[sessionId];
  try { uiSet(COMPOSER_DRAFTS_KEY, JSON.stringify(composerDrafts)); } catch {}
}

const ChatInputBox = memo<{
  sessionId: string | null;
  isStreaming: boolean;
  isLooping: boolean;
  status: 'disconnected' | 'connecting' | 'connected';
  sessionConnected: boolean;
  busyReason?: string | null;
  permissionMode: 'auto-approve' | 'ask';
  onPermissionModeChange: (mode: 'auto-approve' | 'ask') => void;
  /**
   * Claude Code / Codex：那颗 Auto/Ask 按钮换成它们自己的权限模式 ——「claude code 那个就不应该叫 auto 了啊，
   * 默认是 bypass 就好」。给了就显示下拉，不给就是 kiro 的 Auto/Ask。
   */
  engineMode?: { current: string; options: Array<{ value: string; name: string }>; busy: boolean; onChange: (value: string) => void } | null;
  onSend: (text: string, pastes?: PastedBlock[]) => void;
  onSteer: (text: string, pastes?: PastedBlock[]) => void;
  onCancel: () => void;
  onStopLoop: () => void;
  onQueueCommand: (text: string, pastes?: PastedBlock[]) => void;
  queuedMessages: QueuedMessage[];
  restoredDraft: { id: number; text: string; sessionId?: string } | null;
  restoredInputDraft: { id: number; text: string; sessionId?: string } | null;
  /** 接完这份交接就调它 —— 交接是一次性的（见 `handoffDraft`），不清就会每次挂载重放一遍 */
  onConsumeRestoredDraft?: (id: number) => void;
  onConsumeRestoredInputDraft?: (id: number) => void;
  onCancelQueuedMessage: (queueId: string) => void;
  onEditQueuedMessage: (queueId: string, content: string) => void;
  onMoveQueuedMessage: (queueId: string, direction: -1 | 1) => void;
  commands: SlashCommand[];
  suggestions: string[];
  onDropFiles: (files: AttachedFile[]) => void;
  onRemoveFile: (id: string) => void;
  attachedFiles: AttachedFile[];
  /** `/model` / `/agent` 接下来自己处理（见 `slashPicker.ts`）。 */
  onSlashPicker: (intent: SlashIntent) => void;
  /**
   * 模型在最后那条回复里列出来的选项（`choiceChips.ts` 认的）。
   *
   * kiro-cli 没有"问用户一个带选项的问题"这种协议方法（翻过二进制里所有方法名，
   * 只有 `session/request_permission`），所以这些只能从回复文字里认。
   */
  choiceChips: ChoiceChip[];
}>(({ sessionId, isStreaming, isLooping, status, sessionConnected, permissionMode, onPermissionModeChange, engineMode, onSend, onSteer, onCancel, onStopLoop, onQueueCommand, queuedMessages, restoredDraft, restoredInputDraft, onConsumeRestoredDraft, onConsumeRestoredInputDraft, onCancelQueuedMessage, onEditQueuedMessage, onMoveQueuedMessage, commands, suggestions, onDropFiles, onRemoveFile, attachedFiles, choiceChips, onSlashPicker }) => {
  const t = useT();
  const [input, setInput] = useState(() => (sessionId ? composerDrafts[sessionId] || '' : ''));
  // Live switches; a Settings toggle re-renders this composer immediately.
  const featureFlags = useFeatureFlags();
  const [isComposing, setIsComposing] = useState(false);
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const [editingQueueText, setEditingQueueText] = useState('');
  const [cmdIndex, setCmdIndex] = useState(0);
  const [cmdEscaped, setCmdEscaped] = useState(false);
  const [queueModifierHeld, setQueueModifierHeld] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Paste blocks are keyed BY SESSION in `draftPastes` (disk-backed), not held
  // in a single ref shared by every chat.
  useEffect(() => { void loadDraftPastesOnce(); }, []);

  // --- Per-session draft: switching chats stashes the outgoing draft and loads
  // the incoming one, so each conversation keeps its own half-written prompt.
  const draftSessionRef = useRef<string | null>(sessionId);
  const inputRef = useRef(input);
  useEffect(() => { inputRef.current = input; }, [input]);
  // Layout effect so the swap (and its setInput) settles before the passive
  // persist effect below runs -- otherwise it would write the OLD text under the
  // NEW session id.
  useLayoutEffect(() => {
    const previous = draftSessionRef.current;
    if (previous === sessionId) return;
    stashComposerDraft(previous, inputRef.current);
    draftSessionRef.current = sessionId;
    const restored = sessionId ? composerDrafts[sessionId] || '' : '';
    inputRef.current = restored;
    setInput(restored);
  }, [sessionId]);
  useEffect(() => {
    if (draftSessionRef.current !== sessionId) return;
    const timer = setTimeout(() => stashComposerDraft(sessionId, input), 300);
    return () => clearTimeout(timer);
  }, [input, sessionId]);
  // Flush the draft on unmount/reload (e.g. window close) so nothing is lost.
  useEffect(() => () => stashComposerDraft(draftSessionRef.current, inputRef.current), []);

  const slashMatch = /^\/(\S*)$/.exec(input);
  const cmdMatches = (!cmdEscaped && status === 'connected' && slashMatch)
    ? commands.filter((command) => command.name.toLowerCase().startsWith(`/${slashMatch[1].toLowerCase()}`))
    : [];
  const acceptCommand = useCallback((command: SlashCommand) => {
    setInput(`${command.name} `);
    setCmdEscaped(false);
    setCmdIndex(0);
    textareaRef.current?.focus();
  }, []);

  /** Which chips are picked, DERIVED from the composer text rather than kept in its
   *  own state: a chip is selected exactly when its text sits on a line of its own in
   *  the composer. One source of truth, so deleting a line by hand un-highlights its
   *  chip and nothing can desync. */
  const selectedSuggestions = useMemo(
    () => new Set(input.split('\n').map((l) => l.trim()).filter(Boolean)),
    [input],
  );

  const toggleSuggestion = useCallback((suggestion: string) => {
    const pick = suggestion.trim();
    setInput((prev) => {
      const lines = prev.split('\n');
      const at = lines.findIndex((l) => l.trim() === pick);
      // Second click removes just that line, so picking is reversible.
      if (at >= 0) {
        lines.splice(at, 1);
        return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
      }
      // APPEND. The old version rebuilt the whole box from the selected set, which
      // silently threw away anything the user had typed themselves, and made the two
      // interactions mutually exclusive.
      const base = prev.replace(/\s+$/, '');
      return base ? `${base}\n${pick}` : pick;
    });
    textareaRef.current?.focus();
  }, []);

  /**
   * 交接过来的文本**取走一次就完** —— 「反复把之前的提示词填入输入框」。
   *
   * 两处交接（取消排队的消息 / 上一轮被打断）原来都是"设置一个状态、没人清"，
   * 于是这个 effect 每次**挂载**都重放一遍：切回这条会话、进出分屏、布局变化 ——
   * 早已处理完的中断还会一直回来。实测那条会话只被打断过一次，所以"反复"不是反复打断，
   * 是同一份状态被反复消费。而且它会**盖掉**输入框按会话保留的草稿（你刚打的字）。
   *
   * 所以接完就调 `onConsume` 让拥有它的一方清掉（按 id 认，见 `handoffDraft`）。
   * 归属判断也统一到那个模块：原来两处各写一遍，而其中一处的依赖里还漏了 `sessionId`。
   */
  useEffect(() => {
    if (!shouldApplyHandoff(restoredDraft, sessionId)) return;
    setInput(restoredDraft!.text);
    onConsumeRestoredDraft?.(restoredDraft!.id);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [restoredDraft, sessionId, onConsumeRestoredDraft]);

  useEffect(() => {
    if (!shouldApplyHandoff(restoredInputDraft, sessionId)) return;
    setInput(restoredInputDraft!.text);
    onConsumeRestoredInputDraft?.(restoredInputDraft!.id);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [restoredInputDraft, sessionId, onConsumeRestoredInputDraft]);

  // Attachments alone are a valid message: images/files carry the intent, so an
  // empty text box must NOT block sending when something is attached.
  const canSend = input.trim() !== '' || attachedFiles.length > 0;

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text && attachedFiles.length === 0) return;
    setInput('');   // clears the chip highlighting too: selection is derived from this
    if (text === '/stop') {
      onSend(text);
      return;
    }
    /*
      **`/model` 和 `/agent` 接下来自己处理** ——「cli 里面是会有选项的」。

      实测：终端里那两条是上下键选的 picker，但**ACP 不带 picker** —— 发过去回来的是
      一堆纯文本（`/agent` 还会把每个 agent 的整段 description 都刷出来），
      零个结构化选项。而 KiroLex 本来就有真正的模型/agent 下拉。
      所以发给 kiro-cli 只会得到最差的那个版本，还占掉一轮。

      带参数的也接（`/model gpt-5.6-sol`）：让 kiro-cli 内部换模型的话它**不告诉 KiroLex**,
      下拉里显示的还是旧的。KiroLex 换模型走的是"重起执行器 + 改 agent JSON"那条路,
      两边状态才对得上。判据和参数匹配在 `slashPicker.ts`。
    */
    const intent = slashIntent(text);
    if (intent) { onSlashPicker(intent); return; }
    const own = sessionId ? (draftPastes[sessionId] || []) : [];
    // Only blocks the text still references travel with the message; hydrate their
    // content so a draft restored after a restart still expands for the model.
    const referenced = pastesReferencedBy(text, own);
    persistDraftPastes(sessionId, []);
    if (!referenced.length) {
      if (isStreaming) onSteer(text); else onSend(text);
      return;
    }
    void hydratePasteContents(referenced).then((pastes) => {
      if (isStreaming) onSteer(text, pastes);
      else onSend(text, pastes);
    });
  }, [input, isStreaming, onSend, onSteer, attachedFiles, sessionId, onSlashPicker]);

  const handleQueue = useCallback(() => {
    const text = input.trim();
    if (!text && attachedFiles.length === 0) return;
    setInput('');   // clears the chip highlighting too: selection is derived from this
    // The queue card keeps the PLACEHOLDER text (a queued 500-line paste used to
    // render as a wall of text); the blocks ride along so the drain can expand it.
    const own = sessionId ? (draftPastes[sessionId] || []) : [];
    const referenced = pastesReferencedBy(text, own);
    persistDraftPastes(sessionId, []);
    if (!referenced.length) { onQueueCommand(text); return; }
    void hydratePasteContents(referenced).then((pastes) => onQueueCommand(text, pastes));
  }, [input, onQueueCommand, attachedFiles, sessionId]);

  useEffect(() => {
    const updateModifier = (event: KeyboardEvent) => {
      setQueueModifierHeld(event.metaKey || event.ctrlKey);
    };
    const clearModifier = () => setQueueModifierHeld(false);
    window.addEventListener('keydown', updateModifier);
    window.addEventListener('keyup', updateModifier);
    window.addEventListener('blur', clearModifier);
    return () => {
      window.removeEventListener('keydown', updateModifier);
      window.removeEventListener('keyup', updateModifier);
      window.removeEventListener('blur', clearModifier);
    };
  }, []);

  const handleActionClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (event.metaKey || event.ctrlKey || queueModifierHeld) {
      handleQueue();
    } else {
      handleSend();
    }
  }, [queueModifierHeld, handleQueue, handleSend]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (isComposing || e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleQueue();
      return;
    }
    if (cmdMatches.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCmdIndex((index) => (index + 1) % cmdMatches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCmdIndex((index) => (index - 1 + cmdMatches.length) % cmdMatches.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptCommand(cmdMatches[Math.min(cmdIndex, cmdMatches.length - 1)]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setCmdEscaped(true); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [isComposing, cmdMatches, cmdIndex, acceptCommand, handleQueue, handleSend]);

  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items || []);
    const hasImage = items.some((i) => i.kind === 'file' && i.type.startsWith('image/'));
    const plain = e.clipboardData?.getData('text/plain') || '';

    // REAL FILES FIRST. Only the screenshot case was ever implemented here, so
    // copying a PDF/xlsx in Finder and pasting did NOTHING AT ALL: its MIME is not
    // image/*, so it fell through to the text branch, where `text/plain` is empty
    // for a file copy -- silent no-op, no attachment, no message.
    //
    // A copied file carries its on-disk path, exactly like a dragged one, and
    // KiroLex attaches BY PATH. An in-memory screenshot also shows up in
    // `clipboardData.files`, but with an empty path -- which is precisely how the
    // two are told apart here. Having a path is also better for an image FILE:
    // saveClipboardImage() re-encodes the bitmap into a new PNG and loses the
    // original name, while this references the file itself.
    //
    // NOTE: `File.path` is an Electron extension (present in Electron 31, which
    // this app uses). Electron 32+ removed it in favour of
    // `webUtils.getPathForFile()`. handleDrop above relies on the same property,
    // so both must be migrated together on an upgrade.
    const clipFiles = Array.from(e.clipboardData?.files || []) as any[];
    const withPaths = clipFiles.filter((f) => f && typeof f.path === 'string' && f.path);
    // What this paste MEANS is decided in `pasteDecision.ts` (pure, tested). The condition used
    // to live here as `hasImage && !plain`, which silently dropped every image pasted from a
    // browser / Word / Excel / a chat app, because those put the image AND its alt text on the
    // clipboard together.
    const decision = decidePaste({ hasImage, plain, filesWithPaths: withPaths.length });
    if (decision.kind === 'files') {
      e.preventDefault();
      // Images are capped first: an oversized one poisons the whole conversation,
      // because Bedrock validates EVERY image in the replayed history and rejects
      // the request once any exceeds 2000px. Capping at attach time is the only
      // point where it can still be prevented.
      void (async () => {
        const attached = [] as any[];
        for (const f of withPaths) {
          const isImage = /^image\//.test(String(f.type || ''));
          let p = f.path as string;
          if (isImage) {
            try { p = (await window.kiroApi.prepareImageAttachment?.(p))?.path || p; } catch {}
          }
          attached.push({
            id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name: f.name,
            path: p,
            isImage,
          });
        }
        onDropFiles(attached);
      })();
      return;
    }
    // An image flavour does NOT mean there is no text: copying from Excel, Preview, a browser or
    // a chat app puts BOTH on the clipboard. Take the image either way — but when text came with
    // it, do NOT prevent the default: the text then lands the ordinary way, so a failed image
    // save cannot eat it (which is what the old either/or was protecting against).
    if (decision.attachImage) {
      if (decision.preventDefault) e.preventDefault();
      try {
        const res = await window.kiroApi.saveClipboardImage();
        if (!res) return;
        const n = attachedFiles.filter((f) => f.isImage).length + 1;
        onDropFiles([
          { id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name: `Screenshot ${n}`, path: res.path, isImage: true, preview: res.thumbnail },
        ]);
      } catch {}
      // Returning is safe in the mixed case too: the default was NOT prevented, so the text has
      // already been inserted by the browser.
      return;
    }
    // LARGE TEXT PASTE -> disk, exactly like a pasted image. Folding is decided by
    // PROVENANCE (you pasted this), never by guessing whether the text "looks like"
    // code or a log — which is what used to fold typed instructions by mistake.
    const text = plain;
    // Feature switch read at the CALL SITE: turning folding off applies to the
    // very next paste, with no restart.
    if (!text || !isFeatureOn('pasteFolding') || !shouldCapturePaste(text)) return;   // stays inline
    e.preventDefault();
    // Capture the element AND the caret BEFORE any await: React nulls
    // `currentTarget` once the synthetic event handler yields, so reading it after
    // `await savePasteText` threw — the blob was written to disk but the composer
    // never got its placeholder, so the paste silently vanished from the input.
    const el = (e.currentTarget || textareaRef.current) as HTMLTextAreaElement | null;
    const selStart = el?.selectionStart ?? input.length;
    const selEnd = el?.selectionEnd ?? selStart;
    /** preventDefault() already ran, so the browser will NOT insert anything: every
     *  path out of here must put SOMETHING in the composer or the paste is silently
     *  lost. Falls back to the raw text, unfolded. */
    const insert = (piece: string) => {
      const next = input.slice(0, selStart) + piece + input.slice(selEnd);
      setInput(next);
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        try { node?.setSelectionRange(selStart + piece.length, selStart + piece.length); } catch {}
      });
    };
    try {
      const saved = await window.kiroApi.savePasteText?.(text);
      if (!saved) { insert(text); return; }   // disk failed -> paste inline, never drop it
      const own = sessionId ? (draftPastes[sessionId] || []) : [];
      const seq = own.reduce((max, b) => Math.max(max, b.seq), 0) + 1;
      persistDraftPastes(sessionId, [...own, { seq, lines: saved.lines, chars: saved.chars, path: saved.path, content: text }]);
      insert(pastePlaceholder(seq, saved.lines));
    } catch {
      insert(text);
    }
  }, [attachedFiles, onDropFiles, input, sessionId]);

  const handleFilePick = useCallback(async () => {
    try {
      const files = await window.kiroApi.pickFiles();
      if (files.length > 0) {
        onDropFiles(files.map((file) => ({
          id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: file.name,
          path: file.path,
          isImage: file.isImage,
        })));
      }
    } catch {}
  }, [onDropFiles]);

  return (
    <>
      {/* Stays put while you pick. The gate used to include `input.trim() === ''`, so
          the strip unmounted the moment the first chip landed in the composer -- which
          made a multi-select control effectively single-select. The chips are already
          scoped to the right moment without it: `suggestions` is the static starter set
          for an empty chat and otherwise only the chips STAMPED for the current turn,
          so they clear themselves when a new turn begins. */}
      {/*
        **模型列出来的选项** ——「有一些问题会给用户提问并提供多个选项，这个怎么处理的」。

        kiro-cli 没有这种协议（只有工具授权那个 `session/request_permission`），所以模型
        只能把选项写进文字里。这一排就是把那几项变成可点的 —— 点一下**填进输入框，不发送**:
        这类回答最常见的形状是"2，但用 TypeScript"，自动发会把补一句的机会拿掉;
        而万一认错了，填进去还能删，发出去就收不回。

        判据在 `choiceChips.ts`（保守：要有问号或冒号、要 ≥2 项、每项要短、不在代码块里）。
      */}
      {!isStreaming && !isLooping && choiceChips.length > 0 && (
        <div className="prompt-suggestions" aria-label={t('Options in the reply')}>
          {choiceChips.map((chip) => (
            <button
              key={chip.value}
              className="prompt-chip choice-chip"
              onClick={() => setInput((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')} ${chip.value}` : chip.value))}
              title={t('Click to fill it into the input box (not sent yet), so you can still add to it')}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}

      {featureFlags.promptSuggestions !== false && !isStreaming && !isLooping && suggestions.length > 0 && (
        <div className="prompt-suggestions" aria-label={t('Starter prompts')}>
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              /* 提示词既是显示文案也是**真正插入输入框的文字** —— 所以整条走 `t()`：
                 中文界面插入中文提示。`key` 保留原始英文 key（稳定身份，不随语言变）。 */
              className={`prompt-chip ${selectedSuggestions.has(t(suggestion).trim()) ? 'selected' : ''}`}
              onClick={() => toggleSuggestion(t(suggestion))}
              title={t('Click to add this prompt (pick several); click again to remove. You can keep typing too.')}
            >
              {t(suggestion)}
            </button>
          ))}
        </div>
      )}

      <div className="composer">
        {cmdMatches.length > 0 && (
        <div className="slash-command-menu" role="listbox" aria-label={t('Kiro CLI commands')}>
          {cmdMatches.slice(0, 8).map((command, index) => (
            <button
              key={command.name}
              className={`slash-command-item ${index === cmdIndex ? 'active' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => acceptCommand(command)}
              role="option"
              aria-selected={index === cmdIndex}
            >
              <span className="slash-command-name">{command.name}</span>
              {command.hint && <span className="slash-command-hint">{command.hint}</span>}
              {command.description && <span className="slash-command-description">{command.description}</span>}
            </button>
          ))}
        </div>
      )}

      {attachedFiles.length > 0 && (
        <div className="composer-attachments">
          {attachedFiles.map((file) => (
            <div key={file.id} className={`attached-file-chip ${file.isImage ? 'is-image' : ''}`} title={file.path}>
              {file.isImage && file.preview ? (
                <img className="attached-file-thumb" src={file.preview} alt={file.name} />
              ) : (
                <span className="attached-file-icon">
                  {file.path.endsWith('/') || file.path.endsWith('\\') || !file.name.includes('.') ? '📁' : '📄'}
                </span>
              )}
              <span className="attached-file-name">{file.name}</span>
              <button className="attached-file-remove" onClick={() => onRemoveFile(file.id)} title={t('Remove attachment')}>✕</button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        className="composer-input"
        placeholder={
          isLooping
            ? t('Looping this message — click Stop to end it')
            : status !== 'connected'
            ? t('Connecting... (type /stop to force reconnect)')
            : isStreaming && queuedMessages.length > 0
            ? t('Agent is working — Enter appends to the last queued follow-up · {key}+Enter adds a new queue item', { key: MOD_KEY })
            : isStreaming
            ? t('Agent is working — Enter steers the running turn · {key}+Enter queues', { key: MOD_KEY })
            : t('Type a message...')
        }
        value={input}
        disabled={isLooping}
        onChange={(e) => {
          setInput(e.target.value);
          setCmdIndex(0);
          setCmdEscaped(false);
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => setIsComposing(false)}
        rows={2}
      />

      <div className="composer-toolbar">
        <div className="composer-controls">
          <button
            className="composer-icon-btn"
            onClick={handleFilePick}
            title={t('Attach files')}
            disabled={isLooping || status !== 'connected'}
          >
            <IconPaperclip />
          </button>
          {engineMode ? (
            <select
              className={`composer-mode composer-mode-select ${engineModeTone(engineMode.current)}`}
              value={engineMode.current}
              onChange={(e) => engineMode.onChange(e.target.value)}
              disabled={isLooping || isStreaming || status !== 'connected' || engineMode.busy || !engineMode.options.length}
              title={t("Permission mode (this engine's own): whether to ask you before acting")}
              aria-label={t('Permission mode')}
            >
              {engineMode.options.length
                ? engineMode.options.map((o) => <option key={o.value} value={o.value}>{o.name}</option>)
                : <option value="">…</option>}
            </select>
          ) : (
          <button
            type="button"
            className={`composer-mode ${permissionMode === 'auto-approve' ? 'yolo' : ''}`}
            onClick={() => onPermissionModeChange(
              permissionMode === 'auto-approve' ? 'ask' : 'auto-approve'
            )}
            disabled={isLooping || isStreaming || status !== 'connected'}
            aria-pressed={permissionMode === 'auto-approve'}
            title={permissionMode === 'auto-approve'
              ? t('Auto-approve all tools (click to require approval)')
              : t('Ask before each tool (click to auto-approve)')}
          >
            {permissionMode === 'auto-approve' ? (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <polygon points="13 2 4 14 11 14 10 22 20 9 13 9" />
                </svg>
                {t('Auto')}
              </>
            ) : (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />
                  <polyline points="9 12 11.5 14.5 15.5 10" />
                </svg>
                {t('Ask')}
              </>
            )}
          </button>
          )}
          {/* Deliberately NOT disabled on empty content, only on states the user can
              actually reason about (looping / not connected). A button greyed out
              purely because the composer is empty explains nothing, and it read as
              "queueing is broken" — while the keyboard path stayed silent, so the two
              disagreed. handleQueue already ignores a genuinely empty message
              (no text AND no attachments), which is the honest no-op. */}
          <button
            className="composer-icon-btn"
            onClick={handleQueue}
            title={t('Queue message ({key}+Enter)', { key: MOD_KEY })}
            disabled={isLooping || status !== 'connected'}
          >
            <IconQueue />
          </button>
          {/* Two variants, picked by a pane-width container query, rather than one
              string left to ellipsize: the queue shortcut sits at the TAIL, so
              truncation eats precisely the hint that matters here. */}
          <span className="composer-shortcut">
            <span className="composer-shortcut-full">
              {isLooping
                ? t('Loop running · Stop to end it')
                : isStreaming && queuedMessages.length > 0
                ? t('Enter append to queue tail · Shift+Enter newline · {key}+Enter new queue item', { key: MOD_KEY })
                : isStreaming
                ? t('Enter steer running turn · Shift+Enter newline · {key}+Enter queue', { key: MOD_KEY })
                : t('Enter send · Shift+Enter newline · {key}+Enter queue', { key: MOD_KEY })}
            </span>
            <span className="composer-shortcut-short">
              {isLooping
                ? t('Stop the loop')
                : isStreaming && queuedMessages.length > 0
                ? t('{key}+Enter new queue item', { key: MOD_KEY })
                : t('{key}+Enter queue', { key: MOD_KEY })}
            </span>
          </span>
        </div>

        {isLooping ? (
          <button className="composer-send stop" onClick={onStopLoop} title={t('Stop looping')}>
            <span className="stop-btn-square" />
          </button>
        ) : isStreaming && !canSend ? (
          <button className="composer-send stop" onClick={onCancel} title={t('Stop')}>
            <span className="stop-btn-square" />
          </button>
        ) : (
          <button
            className={`composer-send${
              queueModifierHeld || (isStreaming && queuedMessages.length > 0)
                ? ' queue'
                : isStreaming
                ? ' steer'
                : ''
            }`}
            onClick={handleActionClick}
            // Same reasoning as the queue button: empty content is a no-op, not a
            // reason to grey out. handleSend/handleQueue drop a truly empty message.
            disabled={status !== 'connected'}
            title={queueModifierHeld
              ? t('Add a new queued message ({key}+Enter)', { key: MOD_KEY })
              : isStreaming && queuedMessages.length > 0
              ? t('Append to the last queued message (Enter)')
              : isStreaming
              ? t('Steer the running turn (Enter)')
              : t('Send (Enter)')}
          >
            {queueModifierHeld ? (
              <IconQueue size={17} />
            ) : isStreaming && queuedMessages.length > 0 ? (
              <IconAppendMessage size={17} />
            ) : isStreaming ? (
              <IconSteer size={17} />
            ) : (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            )}
          </button>
        )}
      </div>
    </div>
    </>
  );
});

const PLAN_STATUS_ICON: Record<string, string> = {
  completed: '✓',
  in_progress: '▶',
  pending: '○',
};

// Agent execution plan / todo list (ACP `plan` update). Collapsible; shows
// per-entry status. Only rendered when the session has a plan.
const PlanPanel = memo<{ plan: PlanEntry[] }>(({ plan }) => {
  const t = useT();
  const [collapsed, setCollapsed] = useState(false);
  if (!plan.length) return null;
  const done = plan.filter((e) => e.status === 'completed').length;
  return (
    <div className="turn-panel plan-panel">
      <button className="turn-panel-head" onClick={() => setCollapsed((c) => !c)}>
        <span className="turn-panel-caret">{collapsed ? '▸' : '▾'}</span>
        {t('📋 Task list')} <span className="turn-panel-count">{done}/{plan.length}</span>
      </button>
      {!collapsed && (
        <ol className="plan-list" aria-label={t('Task list')}>
          {plan.map((entry, i) => {
            const current = entry.current === true || entry.status === 'in_progress';
            return (
            <li
              key={i}
              className={`plan-item status-${entry.status || 'pending'}${current ? ' current' : ''}`}
              data-task-status={entry.status || 'pending'}
              aria-current={current ? 'step' : undefined}
            >
              <span className="plan-item-icon">{PLAN_STATUS_ICON[entry.status || 'pending'] || '○'}</span>
              <span className="plan-item-text">{entry.content}</span>
              {current && <span className="plan-item-current">{t('current')}</span>}
              {entry.priority && entry.priority !== 'medium' && (
                <span className={`plan-item-pri pri-${entry.priority}`}>{entry.priority === 'high' ? t('high') : entry.priority === 'low' ? t('low') : entry.priority}</span>
              )}
            </li>
            );
          })}
        </ol>
      )}
    </div>
  );
});

function diffStats(diff: FileDiff): { added: number; removed: number } {
  const oldLines = (diff.oldText || '').split('\n');
  const newLines = diff.newText.split('\n');
  // Naive line-count delta — a cheap signal, not a real LCS diff.
  const added = Math.max(0, newLines.length - oldLines.length);
  const removed = Math.max(0, oldLines.length - newLines.length);
  return { added, removed };
}

// Files the agent touched this turn (ACP tool_call locations + diffs).
// Deduped by path; each row opens the file; rows with a diff expand a peek.
/** Tool kinds that RUN something. Mirrors RUN_KINDS in the main process. */
const RUN_KINDS = new Set(['execute', 'run', 'bash', 'shell', 'command', 'terminal']);

/** Drop the backend's live-sounding prefix from a RECORDED command.
 *
 *  kiro-cli's tool-call title is literally `Running: <cmd>`, and this panel keeps that
 *  title verbatim as a historical record -- so a command that finished in 0.2s still
 *  read as "Running". Next to a timeout notice saying 「没有工具在运行」 that looks like
 *  the notice is lying, when in fact both were right and only this label was stale. The
 *  panel heading already says these commands ran; their live state is the badge below. */
function commandLabel(title: string): string {
  return String(title || '').replace(/^\s*(?:running|executing|running command)\s*:\s*/i, '');
}
/** A tool call is still open unless the backend reported a terminal status. */
function commandStillRunning(status?: string): boolean {
  return !!status && status !== 'completed' && status !== 'failed';
}

/** 「运行的命令」 -- the commands executed this turn.
 *
 *  Separate from 「改动的文件」 on purpose: a command is not a changed file, and the
 *  files panel correctly refuses to list it (no diff, non-mutating kind). But it must
 *  appear SOMEWHERE, because it is often the step that produces the real artifact:
 *  the agent writes build_deck.py (a genuine `edit`, listed) and then runs it, and the
 *  .pptx is written by that subprocess. With the command invisible, the turn read as
 *  "created a script" and the .pptx appeared to come from nowhere -- the middle link
 *  of the causal chain was missing. This does NOT claim what the command wrote: KiroLex
 *  cannot know that, since a subprocess's writes carry no tool metadata at all. */
/** First line of a recorded command, and how many more it has.
 *
 *  Commands are frequently multi-line for real (heredocs, `&&` chains split across
 *  lines), and the panel rendered every line with `white-space: pre-wrap` -- one
 *  `cat > file <<'EOF'` could push the rest of the turn off screen. */
function commandFirstLine(title: string): { head: string; more: number } {
  const text = commandLabel(title);
  const nl = text.indexOf('\n');
  if (nl < 0) return { head: text, more: 0 };
  return { head: text.slice(0, nl), more: text.slice(nl + 1).split('\n').filter((l) => l.trim()).length };
}

const CommandsPanel = memo<{ fileChanges: ToolCall[]; live?: boolean; remoteHost?: string }>(({ fileChanges, live, remoteHost }) => {
  const t = useT();
  /** null = follow the turn; a click pins this panel's own choice.
   *
   *  Open while the turn is RUNNING (watching commands go by is the point of it) and
   *  closed once it has finished, which is also how an older turn's panel starts. No
   *  effect and no ref: the rule is a pure function of `live`, so it cannot get out of
   *  step with the turn the way a state-syncing effect can. */
  const [pinned, setPinned] = useState<boolean | null>(null);
  const collapsed = pinned ?? !live;
  /** Multi-line commands the user asked to see in full, by tool-call id. */
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const cmds = useMemo(() => {
    const byId = new Map<string, ToolCall>();
    for (const tc of fileChanges) {
      if (RUN_KINDS.has((tc.kind || '').toLowerCase())) byId.set(tc.toolCallId, tc);
    }
    return Array.from(byId.values());
  }, [fileChanges]);
  if (!cmds.length) return null;
  const preview = commandFirstLine(cmds[0].title);
  return (
    <div className="turn-panel commands-panel">
      <button className="turn-panel-head" onClick={() => setPinned(!collapsed)}>
        <span className="turn-panel-caret">{collapsed ? '▸' : '▾'}</span>
        {/* A span, not a bare text node: as an anonymous flex item it competes with the
            preview for width and wraps instead of letting the preview clip. */}
        <span className="turn-panel-label">{t('⚡ Commands run')}</span>
        <span className="turn-panel-count">{cmds.length}</span>
        {/* **这些命令是在哪台机器上跑的** —— 记录里只有 `Running: <cmd>`，相对路径，
            跟本地执行分不出来。一条 rm 落在哪台机器上不该靠猜。 */}
        {remoteHost && (
          <span className="turn-panel-remote" title={t('These commands run on {host} (not your Mac)', { host: remoteHost })}>
            🌐 {remoteHost}
          </span>
        )}
        {/* Collapsed is ONE line in total: the first line of the first command, clipped.
            Enough to recognise what ran without the panel taking over the turn. */}
        {collapsed && (
          <span className="commands-preview" title={cmds[0].title}>
            {preview.head}
            {cmds.length > 1 ? ` … +${cmds.length - 1}` : ''}
          </span>
        )}
      </button>
      {!collapsed && (
        <ul className="files-list">
          {cmds.map((c) => {
            const { head, more } = commandFirstLine(c.title);
            const open = expandedIds.has(c.toolCallId);
            return (
              <li key={c.toolCallId} className="files-item">
                <div className="files-item-row">
                  <span className="files-item-kind">{c.kind}</span>
                  {/* First line by default, whole thing on click -- never only a
                      tooltip: a command is the record of what actually ran, so it has
                      to stay readable and selectable. */}
                  <span
                    className={`commands-item-title${open ? ' full' : ''}`}
                    title={c.title}
                  >
                    {open ? commandLabel(c.title) : head}
                  </span>
                  {more > 0 && (
                    <button
                      type="button"
                      className="commands-more"
                      title={open ? t('Show the first line only') : t('Show the full command')}
                      onClick={() => setExpandedIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(c.toolCallId)) next.delete(c.toolCallId);
                        else next.add(c.toolCallId);
                        return next;
                      })}
                    >
                      {open ? t('Collapse') : t('+{n} lines', { n: more })}
                    </button>
                  )}
                  {c.status === 'failed' && <span className="stat-del">{t('Failed')}</span>}
                  {commandStillRunning(c.status) && <span className="stat-add">{t('Running')}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});

/** One file name in 「改动的文件」, clickable only if the file is still there.
 *
 *  The panel records the path as it was AT TOOL-CALL TIME, which can stop resolving
 *  before the turn even ends -- renaming a file mid-turn is enough (observed: an edit
 *  to `…逐项分析_v4.md` followed by a rename to `…逐项评估_v4.md`, leaving the row
 *  pointing at a path that no longer existed). Every row used to be unconditionally
 *  clickable and `openPathInApp` only dispatches an event, so clicking a stale row
 *  did NOTHING AT ALL: no viewer, no error, no hint -- indistinguishable from the
 *  app being broken. Prose file links already had this exact protection via
 *  usePathExists; the panel simply never used it.
 *
 *  The `diff` button is intentionally unaffected: the diff text lives in the
 *  transcript, so what changed stays readable even once the file is gone. */
const FileChangePath: React.FC<{ path: string; label: string }> = ({ path, label }) => {
  const t = useT();
  const sessionId = React.useContext(PathSessionContext);
  const exists = usePathExists(path, sessionId);
  if (exists === 'no') {
    return (
      <span
        className="files-item-path missing"
        title={t('The file no longer exists and cannot be opened: {path}\n(It may have been renamed or deleted after this turn; the diff below still shows what changed)', { path })}
      >
        {label}
      </span>
    );
  }
  return (
    <span
      className="files-item-path"
      title={t('Open {path} in KiroLex', { path })}
      onClick={() => openPathInApp(path, sessionId)}
    >
      {label}
    </span>
  );
};
/**
 * **「⇩ 复制到本机」** —— 远程会话把交付文件写在了远端时，状态行上每个文件一颗（`sessionNotice` 的 `copyRemote`）。
 * 经已有的 ssh 连接读出来写进这条会话的本机文件夹，然后打开本机那一份 —— 不让用户自己去 ssh。
 */
const RemoteCopyButtons: React.FC<{ sessionId: string; paths: string[] }> = ({ sessionId, paths }) => {
  const t = useT();
  /* 每个路径：'busy' 复制中、{ ok } 复制好了（本机路径）、{ error } 失败原因 */
  const [state, setState] = useState<Record<string, 'busy' | { ok: string } | { error: string }>>({});
  const copy = async (p: string) => {
    setState((s) => ({ ...s, [p]: 'busy' }));
    const res = await window.kiroApi.copyRemoteToLocal?.(sessionId, p)
      .catch((err: any) => ({ ok: false, path: undefined, error: String(err?.message || err) }));
    if (res?.ok && res.path) {
      setState((s) => ({ ...s, [p]: { ok: res.path! } }));
      openPathInApp(res.path, sessionId);
    } else {
      setState((s) => ({ ...s, [p]: { error: res?.error || t('Copy failed') } }));
    }
  };
  return (
    <span className="session-notice-actions">
      {paths.map((p) => {
        const st = state[p];
        const name = p.split(/[/\\]/).pop() || p;
        return (
          <span key={p} className="session-notice-action-wrap">
            <button className="session-notice-action" title={p} disabled={st === 'busy'} onClick={() => { void copy(p); }}>
              {t('⇩ Copy to this machine')} {name}
            </button>
            {st && st !== 'busy' && ('ok' in st
              ? <span className="session-notice-action-ok" title={st.ok}>{t('Copied to {path}', { path: st.ok })}</span>
              : <span className="session-notice-action-error">⚠️ {st.error}</span>)}
          </span>
        );
      })}
    </span>
  );
};
const FileChangesPanel = memo<{ fileChanges: ToolCall[]; remoteHost?: string }>(({ fileChanges, remoteHost }) => {
  const t = useT();
  const [collapsed, setCollapsed] = useState(false);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const files = useMemo(() => {
    // "改动的文件" = files actually MUTATED this turn. ACP tool kinds like
    // 'read'/'search'/'fetch' also carry locations (e.g. a read of the cwd),
    // but they are NOT changes — only entries that carry a real diff, or whose
    // tool kind is mutating (edit/create/write/delete/move), count here.
    const MUTATING = new Set(['edit', 'create', 'write', 'delete', 'move', 'rename']);
    const map = new Map<string, { path: string; kind?: string; diff?: FileDiff }>();
    // Same file, two spellings: on macOS /tmp and /var are symlinks into /private,
    // and a tool may report either. Keyed on the raw string, one edit to
    // /tmp/x.py showed up as TWO rows (/tmp/x.py and /private/tmp/x.py, same
    // inode) and inflated the count — 3 entries for 2 files. Fold them, keeping
    // the first spelling seen so the row still names a path that resolves.
    const dedupKey = (fp: string) => fp.replace(/^\/private(\/(?:tmp|var|etc)\/)/, '$1');
    const put = (fp: string, v: { kind?: string; diff?: FileDiff }) => {
      const k = dedupKey(fp);
      const prev = map.get(k);
      if (!prev) map.set(k, { path: fp, ...v });
      // A later entry may carry the diff the earlier bare location lacked.
      else if (!prev.diff && v.diff) map.set(k, { ...prev, diff: v.diff, kind: v.kind || prev.kind });
    };
    for (const tc of fileChanges) {
      // A carried diff is always a genuine change.
      for (const d of tc.diffs || []) put(d.path, { kind: tc.kind || 'edit', diff: d });
      // Bare locations only count when the tool call itself is mutating.
      if (MUTATING.has((tc.kind || '').toLowerCase())) {
        for (const p of tc.locations || []) put(p, { kind: tc.kind });
      }
    }
    return Array.from(map.values());
  }, [fileChanges]);
  if (!files.length) return null;
  const base = (p: string) => p.split(/[/\\]/).pop() || p;
  return (
    <div className="turn-panel files-panel">
      <button className="turn-panel-head" onClick={() => setCollapsed((c) => !c)}>
        <span className="turn-panel-caret">{collapsed ? '▸' : '▾'}</span>
        {t('📝 Changed files')} <span className="turn-panel-count">{files.length}</span>
        {/* 远程会话：改是在远端改的，但这里点开的是**本地**那一份（镜像已经同步回来了）。
            两件事都要说清，否则"远端改的"和"我打开的是哪一份"会被混成一件事。 */}
        {remoteHost && (
          <span className="turn-panel-remote" title={t('Changed on {host}; this opens the copy already synced back locally', { host: remoteHost })}>
            🌐 {remoteHost}
          </span>
        )}
      </button>
      {!collapsed && (
        <ul className="files-list">
          {files.map((f) => {
            const stats = f.diff ? diffStats(f.diff) : null;
            const expanded = openPath === f.path;
            return (
              <li key={f.path} className="files-item">
                <div className="files-item-row">
                  {f.kind && <span className="files-item-kind">{f.kind}</span>}
                  <FileChangePath path={f.path} label={base(f.path)} />
                  {stats && (stats.added > 0 || stats.removed > 0) && (
                    <span className="files-item-stat">
                      {stats.added > 0 && <span className="stat-add">+{stats.added}</span>}
                      {stats.removed > 0 && <span className="stat-del">-{stats.removed}</span>}
                    </span>
                  )}
                  {f.diff && (
                    <button className="files-item-peek" onClick={() => setOpenPath(expanded ? null : f.path)}>
                      {expanded ? t('Collapse') : 'diff'}
                    </button>
                  )}
                </div>
                {f.diff && expanded && (
                  <pre className="files-item-diff">
                    <code>{f.diff.newText}</code>
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});

interface ChatAreaProps {
  messages: Message[];
  isStreaming: boolean;
  status: 'disconnected' | 'connecting' | 'connected';
  sessionConnected: boolean;
  connectionError: string | null;
  onDismissError?: () => void;
  attachedFiles: AttachedFile[];
  models: any[];
  selectedModel: string;
  activeToolCall: string | null;
  activityStatus: string | null;
  /** A RUNNING turn that has stopped producing. Refreshed every 30s by main, so the
   *  elapsed time and the countdown to the timeout interrupt stay accurate. */
  stall: {
    quietSeconds: number;
    openTools: number;
    toolIdleSeconds: number;
    interruptInSeconds: number | null;
    boundBy: 'tool' | 'quiet';
    boundSeconds: number;
  } | null;
  permissionRequest: PermissionRequest | null;
  onRespondPermission: (optionId: string) => Promise<void>;
  /**
   * 这条会话当前还在跑的子代理（kiro 的 `use_subagent`）。
   *
   * 会话里原来只渲染子代理**说过的话**（`🤖 子代理` 那些折叠块），看不到"现在有几个在跑、各自在干
   * 什么" —— 而那正是它慢下来时你要的信息。侧栏那个 `🤖 N` 有同一份数据，但只在 tooltip 里。
   */
  subagents?: SubagentRow[];
  /** 需要报警的记忆层，已按 global → project → session 排好序（`memoryPolicy.memoryWarnings`）。
   *  空数组就是三层都在阈值以内，顶部什么都不显示。 */
  memoryWarnings: MemoryWarning[];
  /** 正在压缩的层，形如 `project:Dev`；null 表示空闲。压缩期间三条横幅的按钮都禁用 —— 它们最终都
   *  是往同一条会话发消息，同时发两条只会互相打断。 */
  compactingMemoryScope: string | null;
  onCompactMemory: (scope: MemoryScope) => void;
  /** 打开记忆编辑器；给了 scope 就直接落在那一层（记忆太大横幅的「编辑」） */
  onOpenMemory: (scope?: 'global' | 'project' | 'session') => void;
  usage: { contextPercent: number; credits: number; turnMs?: number } | null;
  plan: PlanEntry[];
  autoFoldThinking: boolean;
  autoFoldTools: boolean;
  onManageContext: () => void;
  onResetCredits: () => void;
  commands: SlashCommand[];
  onModelChange: (model: string) => void;
  /**
   * 这条会话跑在哪台机器上（`undefined` = 本地）。给人看的短名字，和侧栏那个徽标同一个值 ——
   * 命令/文件面板要标出机器，而这件事必须跟着**会话状态**走，不能跟着同步状态走。
   */
  remoteHost?: string;
  /** 哪个引擎跑这条会话；undefined = kiro。 */
  engine?: 'kiro' | 'claude' | 'codex';
  kiroAgent: string;
  kiroAgents: KiroAgentOption[];
  switchingAgent: boolean;
  switchingModel: boolean;
  permissionMode: 'auto-approve' | 'ask';
  onPermissionModeChange: (mode: 'auto-approve' | 'ask') => void;
  onKiroAgentChange: (agentName: string) => void;
  onForkMessage: (messageId: string) => void;
  onRerunMessage: (messageId: string, editedText: string) => void;
  turnInterrupted?: boolean;
  onSend: (text: string, pastes?: PastedBlock[]) => void;
  onSteerMessage: (text: string) => void;
  onCancel: () => void;
  onDropFiles: (files: AttachedFile[]) => void;
  onRemoveFile: (id: string) => void;
  currentSessionId: string | null;
  isArchived?: boolean;
  onUnarchive?: () => void;
  /** Settings: send the whole queue as one merged turn (vs one-by-one). */
  mergeQueuedMessages: boolean;
  /** History for this session is still being read from disk. */
  historyLoading: boolean;
  queuedMessages: QueuedMessage[];
  restoredQueueDraft: { id: number; text: string } | null;
  /** 搜索条开着吗 —— 开着就把整份记录挂上（`findInPage` 只搜已渲染的 DOM，见 App 那段注释）。 */
  searchOpen?: boolean;
  restoredInputDraft: { id: number; text: string; sessionId?: string } | null;
  /** 接完这份交接就调它 —— 交接是一次性的（见 `handoffDraft`），不清就会每次挂载重放一遍 */
  onConsumeRestoredDraft?: (id: number) => void;
  onConsumeRestoredInputDraft?: (id: number) => void;
  onQueueMessage: (text: string, pastes?: PastedBlock[]) => void;
  onCancelQueuedMessage: (queueId: string) => void;
  onEditQueuedMessage: (queueId: string, content: string) => void;
  onMoveQueuedMessage: (queueId: string, direction: -1 | 1) => void;
  importableSessions: { id: string; title: string }[];
  contextLinks: { sourceId: string; sourceTitle: string }[];
  onToggleContextSource: (sourceSessionId: string) => void;
  isLooping: boolean;
  /** Create a time-triggered task from this message's text. No goal and no verifier:
   *  these tasks fire on a clock, and the previous run's result does not change the next
   *  run's action -- which is the only thing that would make it a loop. */
  onStartSchedule: (spec: ScheduleSpec) => void;
  /** This chat's standing schedule, already reduced to one line by `sessionScheduleSummary`.
   *  Null when there is nothing pending — the banner is then absent, not empty, because an
   *  empty chip still reads as "scheduled". Liveness and wording are decided in that helper,
   *  so this component neither filters jobs nor formats a countdown. */
  scheduleSummary?: ScheduleSummary | null;

  /** The project this chat belongs to, or null when it is unassigned. The flow rail is offered
   *  ONLY when there is one: a flow is a property of a project, so a "流程" entry on an
   *  unassigned chat claims something that cannot exist (observed live — the rail appeared on a
   *  chat in the Unassigned bucket and drew SFDC's flow beside an unrelated conversation). */
  projectName?: string | null;
  /** Pause/resume and cancel THIS chat's job. Both relay to main, which owns the record —
   *  before these existed a job's only exits were its run budget and editing the store. */
  onPauseSchedule?: (id: string, paused: boolean) => void;
  onCancelSchedule?: (id: string) => void;
  /** Stop whatever automation currently owns this session. */
  onStopLoop: () => void;
  /** Split-pane monitor mode: transcript + live indicators + permission bar,
   *  but no composer/queue — you type in the focused pane. */
  readOnly?: boolean;
  /** False for split panes that are not focused: they must not react to global
   *  triggers such as "open Agent config". */
  paneFocused?: boolean;
  /** 焦点在右侧文件预览栏里时为 true：那时 Ctrl/Cmd+F 归预览栏自己的搜索（`previewFind.ts`），这一格不响应。 */
  findSuspended?: boolean;
}

/** Generated suggestions keyed `${sessionId}:${lastAssistantMessageId}`.
 *  Module level ON PURPOSE: they used to live in component state, so every
 *  layout change that remounts a ChatArea (entering/leaving split view, adding
 *  or removing a pane) made the chips vanish and paid for a fresh generation
 *  ~8s later. The key is per turn, so nothing leaks between chats. */
const suggestionCache = new Map<string, string[]>();
const SUGGESTION_CACHE_MAX = 60;
function suggestionKey(sessionId: string | null, messages: Message[]): string | null {
  if (!sessionId || messages.length === 0) return null;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return null;
  return `${sessionId}:${last.id}`;
}
function cacheSuggestions(key: string, list: string[]) {
  suggestionCache.set(key, list);
  if (suggestionCache.size > SUGGESTION_CACHE_MAX) {
    const oldest = suggestionCache.keys().next().value;
    if (oldest) suggestionCache.delete(oldest);
  }
}

/**
 * 权限模式的颜色 —— 按"放手的程度"分三档：全放（bypass / full access）用强调色，和 kiro 的 Auto 一样；
 * 半放（自动批编辑 / 自动审 / 能写工作区）用暖色；要问 / 只读 / 只做计划用默认的灰。
 */
function engineModeTone(mode: string): string {
  if (/^(bypassPermissions|agent-full-access)$/.test(mode)) return 'yolo';
  if (/^(acceptEdits|auto|agent|workspace-write)$/.test(mode)) return 'semi';
  return '';
}

export const ChatArea: React.FC<ChatAreaProps> = ({
  messages,
  isStreaming,
  status,
  sessionConnected,
  connectionError,
  onDismissError,
  attachedFiles,
  models,
  selectedModel,
  activeToolCall,
  activityStatus,
  stall,
  permissionRequest,
  onRespondPermission,
  subagents = [],
  memoryWarnings,
  compactingMemoryScope,
  onCompactMemory,
  onOpenMemory,
  usage,
  onManageContext,
  plan,
  onResetCredits,
  autoFoldThinking,
  autoFoldTools,
  commands,
  onModelChange,
  remoteHost,
  engine,
  kiroAgent,
  kiroAgents,
  switchingAgent,
  switchingModel,
  permissionMode,
  onPermissionModeChange,
  onKiroAgentChange,
  onForkMessage,
  onRerunMessage,
  turnInterrupted,
  onSend,
  onSteerMessage,
  onCancel,
  onDropFiles,
  onRemoveFile,
  currentSessionId,
  isArchived,
  onUnarchive,
  mergeQueuedMessages,
  historyLoading,
  queuedMessages,
  restoredQueueDraft,
  searchOpen,
  restoredInputDraft,
  onConsumeRestoredDraft,
  onConsumeRestoredInputDraft,
  onQueueMessage,
  onCancelQueuedMessage,
  onEditQueuedMessage,
  onMoveQueuedMessage,
  importableSessions,
  contextLinks,
  onToggleContextSource,
  isLooping,
  onStartSchedule,
  scheduleSummary,
  projectName,
  onPauseSchedule,
  onCancelSchedule,
  onStopLoop,
  readOnly = false,
  paneFocused = true,
  findSuspended = false,
}) => {
  // 放在最前面：下面的回调（如 handleSlashPicker）要用 `t`，并把它列进依赖。
  const t = useT();
  const findLang = useLang();
  /*
    **`/model` / `/agent` 打开自己的下拉** ——「cli 里面是会有选项的」（而 ACP 不带 picker,
    见 `slashPicker.ts`）。`showPicker()` 是浏览器给原生 `<select>` 的标准接口;
    它在少数情况下会抛（不是用户手势触发时），所以兜底成 focus —— 至少人知道该看哪儿。
  */
  /*
    **本地那一句**（`/model xyz` 对不上时说的话）。和主进程发过来的 `sessionNotice`
    共用同一个位置 —— 同一类东西（KiroLex 自己对你说的）不该有两个落点。
    自己不消失：它是对你刚才那次输入的回答，看完手动关掉。
  */
  const [localNotice, setLocalNotice] = React.useState<string | null>(null);
  /* 换会话就清掉 —— 那句话是对上一条会话里你那次输入的回答 */
  React.useEffect(() => { setLocalNotice(null); }, [currentSessionId]);

  const modelSelectRef = React.useRef<HTMLSelectElement | null>(null);
  const agentSelectRef = React.useRef<HTMLSelectElement | null>(null);
  const handleSlashPicker = React.useCallback((intent: SlashIntent) => {
    const isModel = intent.kind === 'model';
    const el = isModel ? modelSelectRef.current : agentSelectRef.current;
    const options = isModel
      ? models.map((m: any) => String(m?.model_id || m)).filter(Boolean)
      : kiroAgents.map((a) => a.name);

    /* 没给参数 → 直接把下拉弹开 */
    if (!intent.arg) {
      if (!el) return;
      try { (el as any).showPicker?.(); } catch { el.focus(); }
      el.focus();
      return;
    }
    /*
      给了参数 → 走 KiroLex 自己那条切换路径。**不猜**：前缀命中多个时把候选说出来 ——
      换错模型这件事要等到账单或者输出风格变了才会被发现。
    */
    const { exact, matches } = resolveChoice(intent.arg, options);
    if (exact) { if (isModel) onModelChange(exact); else onKiroAgentChange(exact); return; }
    const what = isModel ? t('model') : 'agent';
    setLocalNotice(matches.length
      ? t('"{arg}" matches {n} {what}s: {list}. Be more specific, or type /{cmd} and pick from the dropdown.', { arg: intent.arg, n: matches.length, what, list: matches.join(t(', ')), cmd: intent.kind })
      : t('There is no {what} called "{arg}". Type /{cmd} (with no argument) to open the dropdown.', { arg: intent.arg, what, cmd: intent.kind }));
  }, [models, kiroAgents, onModelChange, onKiroAgentChange, t]);

  /*
    **模型列出来的选项**（只认最后一条助手消息）——「有一些问题会给用户提问并提供多个选项」。

    只看最后一条、而且只在这一轮结束之后：流式过程中那份文字是半截的，
    编号列表会一项一项冒出来，片也就跟着闪 —— 那比没有更烦。
    判据在 `choiceChips.ts`。
  */
  const choiceChips = React.useMemo<ChoiceChip[]>(() => {
    if (isStreaming) return [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg.role === 'user') return [];        // 最后说话的是你 → 没有待答的问题
      if (msg.role !== 'assistant') continue;    // 工具/子代理那些跳过
      return extractChoiceChips(String(msg.content || ''));
    }
    return [];
  }, [messages, isStreaming]);

  /**
   * **这条会话跑在哪台机器上** ——「看起来工具调用是在本地？」。
   *
   * 工具调用的记录里只有 `Running: <cmd>`（相对路径、没有 locations），和本地执行分不出来，
   * 所以命令/文件面板上要标出机器。显示时去掉 `user@`：那一段不是用来区分机器的，而面板很窄。
   *
   * **身份取自会话状态（`session.remoteHost`）** ——「命令调用那里即使切成本地也有远程的 tag」。
   * 它原来读的是同步状态（"此刻在推/在拉"）里的 hostLabel，那份按 sessionId 缓存在渲染层，
   * 切回本地时没人清它，于是本地会话顶着 🌐 继续跑。侧栏那个徽标一直是对的，因为它看的就是
   * `session.remoteHost` —— 现在两处看同一份事实（那套同步状态已经随镜像一起删掉了）。
   */
  const { notice: sessionNotice, dismiss: dismissNotice } = useSessionNotice(currentSessionId || null);
  const remoteHostLabel = remoteHost ? remoteHost.replace(/^[^@]*@/, '') : undefined;
  const nonKiro = !!engine && engine !== 'kiro';
  const engineLabel = engine === 'claude' ? 'Claude Code' : engine === 'codex' ? 'Codex' : 'Kiro';
  const [isDragOver, setIsDragOver] = useState(false);
  // Conversation-aware prompt suggestions: regenerate a few contextual follow-up
  // prompts each time a turn finishes, so the chips reflect the current chat
  // instead of the static starter set. Empty chats keep the static starters.
  // Seed from the cache so a remount (layout change) shows the existing chips
  // immediately instead of blanking and regenerating.
  //
  // The chips are STAMPED with the turn they were generated for, and only render
  // when that stamp matches the current turn. Without the stamp the state was a bare
  // string[], so when a new turn finished the PREVIOUS turn's chips became visible
  // again the instant `isStreaming` went false — and stayed visible for the whole
  // 400ms debounce plus the suggestion model's latency, i.e. seconds of confidently
  // showing follow-ups to an answer that had already been superseded. Note the
  // request guard below (`suggestionsForRef`) cannot serve this purpose: it is set
  // OPTIMISTICALLY before the async call, so it says "asked", not "arrived".
  const [dynamicSuggestions, setDynamicSuggestions] = useState<{ key: string | null; items: string[] }>(() => {
    const k = suggestionKey(currentSessionId, messages);
    const cached = (k && suggestionCache.get(k)) || [];
    return { key: cached.length ? k : null, items: cached };
  });
  /** The turn the chips must match to be shown. Null while a turn is unanswered or
   *  in flight, which is exactly when nothing should be offered. */
  const currentTurnKey = suggestionKey(currentSessionId, messages);
  const suggestionsForRef = useRef<string | null>(suggestionKey(currentSessionId, messages));
  useEffect(() => {
    // Switching chats in-place (single view): show that chat's cached chips if we
    // have them, otherwise clear — never leak one chat's suggestions into another.
    const k = suggestionKey(currentSessionId, messages);
    const cached = (k && suggestionCache.get(k)) || [];
    setDynamicSuggestions({ key: cached.length ? k : null, items: cached });
    suggestionsForRef.current = cached.length ? k : null;
  }, [currentSessionId]);
  useEffect(() => {
    if (isStreaming || messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    const key = `${currentSessionId || ''}:${last.id}`;
    if (suggestionsForRef.current === key) return; // already generated for this turn
    const cachedForTurn = suggestionCache.get(key);
    if (cachedForTurn?.length) {
      // Already generated for this exact turn (e.g. before a layout change):
      // reuse it instead of paying for the same suggestions again.
      suggestionsForRef.current = key;
      setDynamicSuggestions({ key, items: cachedForTurn });
      return;
    }
    suggestionsForRef.current = key;
    const recent = messages
      .slice(-6)
      /* KiroLex 自己对你说的话不算对话内容（判据和主进程共用一处，见 `main/kirolexNote`）——
         漏掉的后果实测过：追问建议是照着「⚠️ 这条会话现在跑在 gpt-5.6-sol 上」生成的。 */
      .filter((m) => !isKirolexNote(m as any))
      .filter((m) => !m.content.startsWith('💭 ') && !m.content.startsWith('🔧 '))
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 800)}`)
      .join('\n\n');
    let cancelled = false;
    const timer = setTimeout(() => {
      window.kiroApi.generateSuggestions?.(recent)
        .then((r) => {
          if (cancelled) return;
          if (r?.suggestions?.length) {
            cacheSuggestions(key, r.suggestions);
            setDynamicSuggestions({ key, items: r.suggestions });
          }
          // Nothing came back (timeout / backend hiccup): release the per-turn
          // guard so the next turn tries again instead of staying empty forever.
          else suggestionsForRef.current = null;
        })
        .catch(() => { if (!cancelled) suggestionsForRef.current = null; });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [messages, isStreaming, currentSessionId]);
  /** SCHEDULING replaced loop mode. The loop declared a goal and a verifier command and
   *  iterated until the check passed -- a coding shape. The real scenarios here (weekly
   *  report, SFDC logging, oncall) are time-triggered: the previous run's result does not
   *  change the next run's action, which is the only test of whether something is a loop.
   *  So there is no goal and no verifier here, on purpose. */
  const [scheduleSetup, setScheduleSetup] = useState<{ text: string } | null>(null);
  const [schedKind, setSchedKind] = useState<'interval' | 'daily' | 'weekly' | 'once'>('daily');
  const [schedEvery, setSchedEvery] = useState('60');
  const [schedTime, setSchedTime] = useState('09:00');
  const [schedWeekday, setSchedWeekday] = useState('1');
  const [schedOnceAt, setSchedOnceAt] = useState('');
  /** A VISIBLE prefill, not a silent fallback: every run costs a model turn, so the
   *  ceiling is a number the user can see and change. */
  const [schedMaxRuns, setSchedMaxRuns] = useState(String(DEFAULT_MAX_RUNS));
  /** Cancelling a job deletes its prompt and trigger, so the banner's 🗑️ arms before it fires.
   *  The arm expires: a click left behind on a pane you walked away from must not still be
   *  waiting to delete tomorrow's run. */
  const [cancelArmed, setCancelArmed] = useState(false);
  const cancelArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (cancelArmTimer.current) clearTimeout(cancelArmTimer.current); }, []);

  const draftSchedule = useMemo<ScheduleSpec>(() => ({
    prompt: scheduleSetup?.text || '',
    kind: schedKind,
    everySec: schedKind === 'interval' ? (Number.parseInt(schedEvery, 10) || 0) * 60 : 0,
    atTime: schedKind === 'daily' || schedKind === 'weekly' ? schedTime : undefined,
    weekday: schedKind === 'weekly' ? Number.parseInt(schedWeekday, 10) : undefined,
    atEpoch: schedKind === 'once' ? Date.parse(schedOnceAt) : undefined,
    maxRuns: Number.parseInt(schedMaxRuns, 10) || 0,
  }), [scheduleSetup, schedKind, schedEvery, schedTime, schedWeekday, schedOnceAt, schedMaxRuns]);
  const scheduleProblems = useMemo(() => validateSchedule(draftSchedule, findLang), [draftSchedule, findLang]);
  /** Stable, because it is handed to a MEMOISED message item.
   *
   *  It was an inline arrow, so every render of this component gave all user groups a
   *  new prop identity and their `memo` bailed out -- meaning each of the (up to 120)
   *  rendered groups re-rendered on ANY app re-render, including one caused by a chunk
   *  arriving in a different pane or by clicking another pane. */
  const openScheduleSetup = useCallback((text: string) => {
    setScheduleSetup({ text });
  }, []);
  const [showImportPicker, setShowImportPicker] = useState(false);
  const [pickerPos, setPickerPos] = useState<{ left: number; bottom: number }>({ left: 0, bottom: 0 });
  const importBtnRef = useRef<HTMLButtonElement>(null);
  const agentConfigTextareaRef = useRef<HTMLTextAreaElement>(null);
  const agentConfigLineNumbersRef = useRef<HTMLDivElement>(null);

  const [agentConfigEditor, setAgentConfigEditor] = useState<AgentConfigEditorState | null>(null);
  /* 机器人面板的 tab：'agents' 是原来那个编辑器，其余的见 KiroConfigPanel */
  const [agentConfigTab, setAgentConfigTab] = useState<string>('agents');
  const [agentConfigFilter, setAgentConfigFilter] = useState('');
  const [kiroConfigCats, setKiroConfigCats] = useState<KiroConfigCategory[]>([]);
  /** Claude Code / Codex 会话的机器人面板（它们没有 kiro 的 agent，tab 是「🔑 登录」+ 它们自己的配置文件）。 */
  const [engineConfigOpen, setEngineConfigOpen] = useState(false);
  const [engineConfigTab, setEngineConfigTab] = useState<string>('login');
  const [engineConfigCats, setEngineConfigCats] = useState<KiroConfigCategory[]>([]);
  const [agentConfigDrafts, setAgentConfigDrafts] = useState<Record<string, AgentConfigEditorState>>({});
  const [agentConfigLoading, setAgentConfigLoading] = useState(false);
  const [agentConfigSaving, setAgentConfigSaving] = useState(false);
  const [agentConfigStatus, setAgentConfigStatus] = useState<string | null>(null);
  /** Pending destructive confirmation for this pane. In-app dialog, not
   *  `window.confirm` -- that one blocks the renderer's main thread. */
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const agentConfigAgents = useMemo<KiroAgentOption[]>(() => {
    if (kiroAgents.some((agent) => agent.name === kiroAgent)) return kiroAgents;
    return [
      ...kiroAgents,
      {
        name: kiroAgent,
        isDefault: false,
        source: kiroAgent === 'kiro_default' ? 'built-in' : 'global',
      },
    ];
  }, [kiroAgents, kiroAgent]);
  const agentConfigValidationError = useMemo(
    () => agentConfigEditor && !agentConfigEditor.error
      ? validateAgentConfigJson(agentConfigEditor.content, t)
      : null,
    [agentConfigEditor?.content, agentConfigEditor?.error, t],
  );
  const agentConfigLines = useMemo(
    () => agentConfigEditor?.content.split('\n') || [''],
    [agentConfigEditor?.content],
  );

  const updateAgentConfigContent = useCallback((content: string) => {
    if (!agentConfigEditor) return;
    const updatedDraft = { ...agentConfigEditor, content };
    setAgentConfigEditor(updatedDraft);
    setAgentConfigDrafts((current) => ({
      ...current,
      [updatedDraft.agentName]: updatedDraft,
    }));
    setAgentConfigStatus(null);
  }, [agentConfigEditor]);

  const formatAgentConfig = useCallback(() => {
    if (!agentConfigEditor || agentConfigValidationError) return;
    const formatted = `${JSON.stringify(JSON.parse(agentConfigEditor.content), null, 2)}\n`;
    updateAgentConfigContent(formatted);
  }, [agentConfigEditor, agentConfigValidationError, updateAgentConfigContent]);

  const focusAgentConfigError = useCallback(() => {
    if (!agentConfigEditor || !agentConfigValidationError) return;
    const textarea = agentConfigTextareaRef.current;
    if (!textarea) return;

    const linesBeforeError = agentConfigEditor.content
      .split('\n')
      .slice(0, Math.max(0, agentConfigValidationError.line - 1));
    const lineStart = linesBeforeError.reduce((total, line) => total + line.length + 1, 0);
    const offset = Math.min(
      agentConfigEditor.content.length,
      lineStart + Math.max(0, agentConfigValidationError.column - 1),
    );
    textarea.focus();
    textarea.setSelectionRange(offset, offset);

    const lineHeight = Number.parseFloat(window.getComputedStyle(textarea).lineHeight) || 18.6;
    const scrollTop = Math.max(
      0,
      (agentConfigValidationError.line - 1) * lineHeight - textarea.clientHeight / 2,
    );
    textarea.scrollTop = scrollTop;
    if (agentConfigLineNumbersRef.current) {
      agentConfigLineNumbersRef.current.scrollTop = scrollTop;
    }
  }, [agentConfigEditor, agentConfigValidationError]);

  const loadAgentConfig = useCallback(async (agentName: string) => {
    if (!currentSessionId || agentConfigLoading) return;

    // Switching Agents is non-destructive: retain the current editor state in
    // memory and restore an existing draft when this Agent is selected again.
    // Nothing is written to disk until the user explicitly clicks Save.
    const draftsWithCurrent = agentConfigEditor
      ? { ...agentConfigDrafts, [agentConfigEditor.agentName]: agentConfigEditor }
      : agentConfigDrafts;
    if (agentConfigEditor) setAgentConfigDrafts(draftsWithCurrent);

    const existingDraft = draftsWithCurrent[agentName];
    setAgentConfigStatus(null);
    if (existingDraft) {
      setAgentConfigEditor(existingDraft);
      return;
    }

    setAgentConfigLoading(true);
    setAgentConfigEditor({
      agentName,
      path: '',
      content: '',
      initialContent: '',
    });
    try {
      const agentSource = agentConfigAgents.find((agent) => agent.name === agentName)?.source;
      const result = await window.kiroApi.openKiroAgentConfig(
        currentSessionId,
        agentName,
        agentSource,
      );
      const loadedConfig: AgentConfigEditorState =
        !result.opened || !result.path || result.content === undefined
          ? {
              agentName,
              path: '',
              content: '',
              initialContent: '',
              error: result.error || t('Unable to open this Agent configuration.'),
            }
          : {
              agentName,
              path: result.path,
              content: result.content,
              initialContent: result.content,
            };
      setAgentConfigEditor(loadedConfig);
      setAgentConfigDrafts((current) => ({
        ...current,
        [agentName]: loadedConfig,
      }));
    } finally {
      setAgentConfigLoading(false);
    }
  }, [
    currentSessionId,
    agentConfigLoading,
    agentConfigEditor,
    agentConfigDrafts,
    agentConfigAgents,
    t,
  ]);

  const openAgentConfig = useCallback(() => {
    void loadAgentConfig(kiroAgent);
  }, [kiroAgent, loadAgentConfig]);

  // The trigger now lives in the sidebar (Agent config is global, not per chat).
  // Only the focused pane opens the editor, so a split view never opens N copies.
  useEffect(() => {
    if (readOnly || paneFocused === false) return;
    const handler = () => openAgentConfig();
    window.addEventListener('kirolex:open-agent-config', handler);
    return () => window.removeEventListener('kirolex:open-agent-config', handler);
  }, [openAgentConfig, paneFocused, readOnly]);

  /*
    **Claude Code / Codex 的模型下拉** ——「右侧的选模型为什么没有」。清单是适配器自己给的
    （session/new 的 configOptions 里那个 model），连上 / 换完之后 main 推一次 `session:engine-models`。
  */
  type EngineSelect = { current: string; options: Array<{ value: string; name: string }> };
  /** 模型清单（`current`/`options`）+ effort + 权限模式 —— 三样都来自适配器的 configOptions。 */
  const [engineModels, setEngineModels] = useState<(EngineSelect & { effort?: EngineSelect | null; mode?: EngineSelect | null }) | null>(null);
  const [engineModelBusy, setEngineModelBusy] = useState(false);
  const [engineModelErr, setEngineModelErr] = useState('');
  useEffect(() => {
    setEngineModels(null); setEngineModelErr('');
    if (!nonKiro || !currentSessionId) return;
    const api = (window as any).kiroApi;
    const off = api?.onEngineModels?.((d: any) => {
      if (d?.sessionId === currentSessionId) setEngineModels(d);
    });
    void api?.engineModels?.(currentSessionId).then((d: any) => { if (d) setEngineModels(d); }).catch(() => {});
    return () => { try { off?.(); } catch { /* 卸载 */ } };
  }, [nonKiro, currentSessionId, engine, status]);
  /*
    **「组合」下拉**（取代原来的 effort 下拉）——「不同对话挂不同的 MCP」。清单是本机全局的
    `~/.kirolex/mcp-combos.json`（面板里「🧩 组合」那页改），每条会话记自己选的那个；换了要重启执行器（main 做）。
  */
  type McpComboList = { combos: Array<{ id: string; name: string; effort?: string }>; current: string; missing?: string; error?: string };
  const [mcpCombos, setMcpCombos] = useState<McpComboList | null>(null);
  const [mcpComboBusy, setMcpComboBusy] = useState(false);
  useEffect(() => {
    setMcpCombos(null);
    if (!nonKiro || !currentSessionId) return;
    const api = (window as any).kiroApi;
    let alive = true;
    const load = () => {
      void api?.mcpCombos?.(currentSessionId).then((d: McpComboList) => { if (alive && d) setMcpCombos(d); }).catch(() => {});
    };
    load();
    const off = api?.onMcpCombosChanged?.(load);
    return () => { alive = false; try { off?.(); } catch { /* 卸载 */ } };
  }, [nonKiro, currentSessionId, engine, status]);
  const onMcpComboChange = async (comboId: string): Promise<void> => {
    if (!currentSessionId) return;
    setMcpComboBusy(true); setEngineModelErr('');
    try {
      const d = await (window as any).kiroApi.switchMcpCombo(currentSessionId, comboId);
      setMcpCombos((prev) => (prev ? { ...prev, current: d?.current || comboId, missing: undefined } : prev));
    } catch (err: any) {
      setEngineModelErr(String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setMcpComboBusy(false);
    }
  };
  const onEngineModelChange = (value: string): Promise<void> => onEngineOptionChange('model', value);
  const onEngineOptionChange = async (category: 'model' | 'thought_level' | 'mode', value: string): Promise<void> => {
    if (!currentSessionId) return;
    setEngineModelBusy(true); setEngineModelErr('');
    try {
      const api = (window as any).kiroApi;
      const d = category === 'model'
        ? await api.setEngineModel(currentSessionId, value)
        : await api.setEngineOption(currentSessionId, category, value);
      if (d) setEngineModels(d);
    } catch (err: any) {
      setEngineModelErr(String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setEngineModelBusy(false);
    }
  };

  /* Claude Code / Codex 面板的 tab：按这条会话的引擎从 main 拿（换了引擎就重新拿） */
  useEffect(() => {
    if (!engineConfigOpen || !nonKiro) return;
    void (window as any).kiroApi?.kiroConfigCategories?.(engine).then((c: KiroConfigCategory[]) => {
      if (Array.isArray(c)) setEngineConfigCats(c);
    }).catch(() => {});
  }, [engineConfigOpen, nonKiro, engine]);

  /* tab 清单从 main 拿（那边是唯一定义），面板第一次打开时拉一次 */
  useEffect(() => {
    if (!agentConfigEditor || kiroConfigCats.length) return;
    void (window as any).kiroApi?.kiroConfigCategories?.().then((c: KiroConfigCategory[]) => {
      if (Array.isArray(c)) setKiroConfigCats(c);
    }).catch(() => {});
  }, [agentConfigEditor, kiroConfigCats.length]);

  /** Drop the Agent-config editor and every draft in it. */
  const discardAgentConfig = useCallback(() => {
    setAgentConfigTab('agents');
    setAgentConfigEditor(null);
    setAgentConfigDrafts({});
    setAgentConfigStatus(null);
  }, []);

  /**
   * **关闭 = 丢弃所有未保存的草稿，直接关** ——「如果 unsaved 不能直接 close，应该抛弃所有变更然后 close」。
   *
   * 原来有未保存草稿时会弹一个确认框挡住关闭。但"关"这个动作本身就是在说"不要了"：
   * 想留就按保存，保存按钮就在旁边。多一道确认只是让最常见的那条路（改两下看看、不满意、关掉）
   * 每次都多点一下。草稿只在内存里、从没写过盘，所以丢掉它不会碰到任何已存的配置。
   */
  const closeAgentConfig = useCallback(() => {
    discardAgentConfig();
  }, [discardAgentConfig]);

  const saveAgentConfig = useCallback(async () => {
    if (
      !currentSessionId ||
      !agentConfigEditor ||
      agentConfigEditor.error ||
      agentConfigSaving
    ) return;
    const validationError = validateAgentConfigJson(agentConfigEditor.content, t);
    if (validationError) {
      setAgentConfigStatus(validationError.message);
      return;
    }

    setAgentConfigSaving(true);
    setAgentConfigStatus(null);
    try {
      const agentSource = agentConfigAgents.find(
        (agent) => agent.name === agentConfigEditor.agentName
      )?.source;
      const result = await window.kiroApi.saveKiroAgentConfig(
        currentSessionId,
        agentConfigEditor.agentName,
        agentSource,
        agentConfigEditor.content,
      );
      if (!result.saved) {
        setAgentConfigStatus(result.error || t('Unable to save this Agent configuration.'));
        return;
      }
      const savedConfig: AgentConfigEditorState = {
        ...agentConfigEditor,
        initialContent: agentConfigEditor.content,
        path: result.path || agentConfigEditor.path,
      };
      setAgentConfigEditor(savedConfig);
      setAgentConfigDrafts((current) => ({
        ...current,
        [savedConfig.agentName]: savedConfig,
      }));
      setAgentConfigStatus('Saved');
    } finally {
      setAgentConfigSaving(false);
    }
  }, [currentSessionId, agentConfigEditor, agentConfigSaving, agentConfigAgents, t]);

  const toggleImportPicker = useCallback(() => {
    const el = importBtnRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      // Anchor a fixed-position popup just above the button so it escapes the
      // overflow:hidden clipping of the chat input / main containers, and CLAMP
      // it to the viewport: in a right-hand split pane the raw button x pushed
      // the 300px panel off screen, so it looked like the feature was dead.
      const PICKER_W = 300;
      const PICKER_MAX_H = 320;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - PICKER_W - 8));
      const bottom = Math.max(8, Math.min(window.innerHeight - r.top + 8, window.innerHeight - PICKER_MAX_H - 8));
      setPickerPos({ left, bottom });
    }
    setShowImportPicker((v) => !v);
  }, []);
  const [inputHeight, setInputHeight] = useState(() => {
    try {
      const saved = uiGet('kirolex-input-height');
      if (saved) return parseInt(saved, 10);
    } catch {}
    return 140;
  });
  const [inputCollapsed, setInputCollapsed] = useState(false);
  const chatMessagesRef = useRef<HTMLDivElement>(null);

  /*
    ── 这一格自己的会话内搜索（Cmd+F）─────────────────────────────────────────────
    「哪个分屏的搜索应该显示在那个分屏中」。所以状态在 ChatArea 里,不在 App 里:
    每格一份,各算各的计数,互不打断。命中怎么算见 `paneFind.ts`,怎么画见 `findHighlight.ts`。
  */
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  /**
   * 防抖后的查询词 —— 整开、算命中、计数标签都用它。输入框绑的还是 `findQuery`(打字不能卡)。
   * 清空立刻生效,马上收回只挂最近一窗（`findDebounceDelay`）。
   */
  const [findSearchQuery, setFindSearchQuery] = useState('');
  useEffect(() => {
    const delay = findDebounceDelay(findQuery);
    if (delay <= 0) { setFindSearchQuery(findQuery); return; }
    const timer = setTimeout(() => setFindSearchQuery(findQuery), delay);
    return () => clearTimeout(timer);
  }, [findQuery]);
  /** 当前是第几个命中,1 起;0 = 还没定位（或者没有命中）。 */
  const [findActive, setFindActive] = useState(0);
  const [findTotal, setFindTotal] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);
  /** 这一次搜出来的 `Range`,和 `findActive` 一起用。放 ref 里:它不参与渲染。 */
  const findRangesRef = useRef<Range[]>([]);
  /**
   * 高亮注册表里这一格的 key。用**这一格渲染的那条会话**的 id —— 一个会话同时只在一格里显示,
   * 所以它天然是每格唯一的。名字叫 `currentSessionId` 但在后台格里它就是那一格的会话。
   */
  const findKey = currentSessionId || 'no-session';
  // Sticky-bottom autoscroll state: true only while the user is parked at the
  // bottom. Declared before any effect that reads it (dependency arrays are
  // evaluated during render -- a later declaration would hit TDZ).
  const stickToBottomRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const dragCounterRef = useRef(0);
  const inputResizingRef = useRef(false);
  const inputHeightRef = useRef(inputHeight);

  // Windowed transcript rendering: render only the most recent N message groups
  // and reveal older ones as the user scrolls up. Rendering the full transcript
  // (thousands of markdown+highlight nodes for large/migrated sessions) freezes
  // the renderer and makes every re-render (delete, switch, stream) janky.
  const INITIAL_RENDER = 120;
  const RENDER_CHUNK = 120;
  const [renderLimit, setRenderLimit] = useState(INITIAL_RENDER);
  const preExpandHeightRef = useRef<number | null>(null);
  // Reset the window when switching sessions so a newly-opened chat starts capped.
  useEffect(() => { setRenderLimit(INITIAL_RENDER); }, [currentSessionId]);
  const loadOlder = useCallback(() => {
    const el = chatMessagesRef.current;
    if (el) preExpandHeightRef.current = el.scrollHeight;
    setRenderLimit((l) => l + RENDER_CHUNK);
  }, []);
  // Preserve the scroll position when older groups are prepended (no viewport jump).
  useLayoutEffect(() => {
    const el = chatMessagesRef.current;
    if (el && preExpandHeightRef.current != null) {
      el.scrollTop += el.scrollHeight - preExpandHeightRef.current;
      preExpandHeightRef.current = null;
    }
  }, [renderLimit]);

  const handleInputResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    inputResizingRef.current = true;
    const startY = e.clientY;
    const startHeight = inputHeight;

    const onMouseMove = (ev: MouseEvent) => {
      if (!inputResizingRef.current) return;
      const maxHeight = Math.max(180, Math.floor(window.innerHeight * 0.7));
      const newHeight = Math.max(96, Math.min(maxHeight, startHeight - (ev.clientY - startY)));
      inputHeightRef.current = newHeight;
      setInputHeight(newHeight);
    };

    const onMouseUp = () => {
      inputResizingRef.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        uiSet('kirolex-input-height', String(inputHeightRef.current));
      } catch {}
    };

    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [inputHeight]);

  useEffect(() => {
    inputHeightRef.current = inputHeight;
    try {
      uiSet('kirolex-input-height', String(inputHeight));
    } catch {}
  }, [inputHeight]);

  useEffect(() => {
    // Sticky-bottom autoscroll: only follow new output when the user is already
    // parked at the bottom. If they scrolled up to read history, incoming
    // messages must NOT yank the view down.
    if (!stickToBottomRef.current) return;
    // This pane's container only. This ran on EVERY message update, so it was the
    // most frequent way a streaming turn in one pane could shift the whole grid.
    scrollContainerToBottom(chatMessagesRef.current, () => stickToBottomRef.current);
  }, [messages]);

  // Switching chats always starts at the bottom (freshest turn) and re-arms stick.
  useEffect(() => {
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
    requestAnimationFrame(() => scrollContainerToBottom(chatMessagesRef.current, () => stickToBottomRef.current));
  }, [currentSessionId]);

  const jumpToBottom = useCallback(() => {
    stickToBottomRef.current = true;
    setShowJumpToBottom(false);
    // Instant, and confined to this transcript. It used to be a SMOOTH
    // scrollIntoView, which failed in two ways at once:
    //   - it scrolled the shared ancestors too (.chat-main/.chat-row/.chat-grid are
    //     all overflow:hidden, which does NOT make them unscrollable), so the other
    //     panes moved and the grid was left displaced with no scrollbar to undo it;
    //   - starting from high up in the transcript, the animation's own scroll events
    //     hit the `scrollTop <= 80` branch below, which loads older groups; the
    //     layout effect that compensates for prepended content then writes scrollTop,
    //     and that write CANCELS the in-flight smooth scroll -- so the view stopped
    //     somewhere in the middle instead of at the latest message.
    scrollContainerToBottom(chatMessagesRef.current, () => stickToBottomRef.current);
  }, []);

  // Ctrl+A only selects chat messages content
  useEffect(() => {
    const handleSelectAll = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        // The file side panel (ReviewPane) already took it: last click / focus was there.
        if (e.defaultPrevented) return;
        // If focus is in any editable element (chat input, a rename field, etc.),
        // let the browser's default select-all work on that field instead.
        const el = document.activeElement as HTMLElement | null;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
          return;
        }

        e.preventDefault();
        const selection = window.getSelection();
        if (selection && chatMessagesRef.current) {
          const range = document.createRange();
          range.selectNodeContents(chatMessagesRef.current);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
    };
    document.addEventListener('keydown', handleSelectAll);
    return () => document.removeEventListener('keydown', handleSelectAll);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    if (!e.dataTransfer.types.includes('Files')) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    void (async () => {
      const attached: AttachedFile[] = [];
      for (const f of files) {
        // Was missing, so a dropped image was attached as a generic file and never
        // rendered as one. Same MIME test the paste path uses.
        const isImage = /^image\//.test(String(f.type || ''));
        let p = (f as any).path || f.name;
        // Same dimension cap as the paste path: see prepare-image-attachment.
        if (isImage) {
          try { p = (await window.kiroApi.prepareImageAttachment?.(p))?.path || p; } catch {}
        }
        attached.push({
          id: `file_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name: f.name,
          path: p,
          isImage,
        });
      }
      onDropFiles(attached);
    })();
  }, [onDropFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    // Only show drop overlay for external file drops, not text selection drags
    if (e.dataTransfer.types.includes('Files')) {
      dragCounterRef.current++;
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  // Group each turn's original user message with the mid-turn steers injected
  // into the SAME turn (consecutive user messages carrying a `steer` flag). The
  // group renders as one bubble; an assistant message carries the COMBINED text
  // (original + all steers) of its preceding user group so the token estimate
  // reflects the whole question, not just the last steer. Render-layer only —
  // message ordering/ids in state are untouched.
  type RenderGroup =
    | { kind: 'user'; base: Message; steers: Message[] }
    | { kind: 'kirolex'; message: Message }
    | { kind: 'assistant'; segments: Message[]; isLast: boolean; question: string };
  // Heal stranded steers before grouping: a steer that ended up AFTER this
  // turn's assistant/tool messages (ordering slip, or restored history) is moved
  // back next to its base user message, so it renders as a Steer paragraph in
  // the same bubble instead of a lone orphan bubble without the Steer label.
  const orderedMessages = useMemo<Message[]>(() => {
    /*
      KiroLex 自己写进会话的那几句（换模型、排队、改写落盘、循环结束…）存了中英两版（`variants`）——
      这里按**当前**界面语言挑一版来显示：切了语言、重新打开都跟着换。你和 agent 的消息没有 variants，原样。
    */
    const shown = messages.some((m) => m.variants)
      ? messages.map((m) => (m.variants ? variantView(m, findLang) : m))
      : messages;
    if (!shown.some((m) => m.role === 'user' && m.steer)) return shown;
    const out: Message[] = [];
    for (const m of shown) {
      if (m.role === 'user' && m.steer) {
        let baseIdx = -1;
        for (let i = out.length - 1; i >= 0; i--) {
          if (out[i].role === 'user' && !out[i].steer && !isKirolexNote(out[i])) { baseIdx = i; break; }
        }
        if (baseIdx >= 0) {
          let at = baseIdx + 1;
          while (at < out.length && out[at].role === 'user' && out[at].steer) at++;
          out.splice(at, 0, m);
          continue;
        }
      }
      out.push(m);
    }
    return out;
  }, [messages, findLang]);

  const renderGroups = useMemo<RenderGroup[]>(() => {
    const groups: RenderGroup[] = [];
    let lastQuestion = '';
    const messages = orderedMessages;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      /* KiroLex 自己的话单独成组：不是提问（不进 lastQuestion），也不收 steer */
      if (m.role === 'user' && isKirolexNote(m)) {
        groups.push({ kind: 'kirolex', message: m });
      } else if (m.role === 'user') {
        if (!m.steer) {
          const steers: Message[] = [];
          let j = i + 1;
          while (j < messages.length && messages[j].role === 'user' && messages[j].steer) {
            steers.push(messages[j]);
            j++;
          }
          lastQuestion = [m.content, ...steers.map((s) => s.content)].join('\n\n');
          groups.push({ kind: 'user', base: m, steers });
          i = j - 1;
        } else {
          // Orphan steer with no visible base (e.g. trimmed history) — show alone.
          lastQuestion = m.content;
          groups.push({ kind: 'user', base: m, steers: [] });
        }
      } else {
        // Coalesce this turn's consecutive assistant/tool/subagent messages
        // (everything until the next user turn) into one assistant group so a
        // tool-using turn renders as a single reply bubble, not many.
        const segments: Message[] = [m];
        let j = i + 1;
        while (j < messages.length && messages[j].role !== 'user') {
          segments.push(messages[j]);
          j++;
        }
        groups.push({
          kind: 'assistant',
          segments,
          isLast: j === messages.length,
          question: lastQuestion,
        });
        i = j - 1;
      }
    }
    return groups;
  }, [orderedMessages]);

  /**
   * 清空过上下文的会话，**默认只显示清空之后的部分** ——
   * 「技术问题 这个会话 clear 了之后再打开还有历史会话呢」。
   *
   * `/clear` 重置的是模型的活动上下文，transcript 刻意不动（那是审计链，也是重启后重建上下文的依据）。
   * 但重新打开时界面上摆着 183 条**模型已经不记得**的消息、而且一个字都不说 ——
   * 你看到的和模型知道的不是同一份，这比两个极端都糟。
   *
   * 所以默认窗口收到那条分界线上，更早的用**现成的**「加载更早的消息」按钮取回（记录一条没少）。
   * 判据在 `clearBoundary.sinceLastClear`：认用户自己那条 `/clear`，不认后端那句英文的
   * `Conversation cleared`（那是后端措辞，哪天改了这条判据就静默失效）。
   */
  const afterClear = sinceLastClear(orderedMessages as any);
  const clearedGroupIndex = afterClear === undefined
    ? -1
    : renderGroups.findIndex((g: any) => isClearCommand(g?.base));
  /** 清空之后有几组。找不到那一组（它被合并进了别人）就退回不干预。 */
  const groupsSinceClear = clearedGroupIndex >= 0 ? renderGroups.length - clearedGroupIndex : 0;
  /**
   * 搜索时**不设窗口**：我们只搜已经挂上的 DOM,窗口挡住的就是搜不到的（自绘高亮和
   * `findInPage` 在这一点上一样）。清空边界那条收窄也一起让开 —— 否则清空过的会话
   * 搜不到清空之前的内容。
   *
   * 判据是**这一格自己的** `findOpen`,不再是全局那一个:分屏时只有你真的在搜的那一格
   * 需要付「挂完整棵树」的代价,旁边那格照旧只挂最近 120 组。
   *
   * 而且要**真有(防抖后的)查询词**才整开:只按了 Ctrl+F 还没输入时就整开,长会话会卡很久。
   * 清空查询词或关掉搜索条,就回到平时那一窗。
   */
  const expandForFind = shouldExpandForFind({ findOpen, query: findSearchQuery }) || !!searchOpen;
  const windowSize = expandForFind
    ? renderGroups.length
    : (groupsSinceClear > 0 ? Math.min(renderLimit, groupsSinceClear) : renderLimit);
  // Only the last `windowSize` groups are mounted; older ones load on scroll-up.
  const visibleGroups = renderGroups.length > windowSize
    ? renderGroups.slice(renderGroups.length - windowSize)
    : renderGroups;
  const hiddenGroupCount = renderGroups.length - visibleGroups.length;

  /**
   * 重新算这一格的命中。
   *
   * 等**两帧**再算,和当年 `findInPage` 那版同一个理由:有了查询词让 `windowSize` 整开,
   * 而那棵树是下一帧才挂上来的 —— 同一帧里算,搜的还是旧的那 120 组,表现成「第一次搜没结果,
   * 再敲一个字才对」。
   *
   * 依赖里带 `visibleGroups.length`:挂上来多少组会变（展开、加载更早、新消息),变了就得重算,
   * 否则命中数停在旧的那份上。
   */
  useEffect(() => {
    const root = chatMessagesRef.current;
    if (!findOpen || !root || !shouldSearch(findSearchQuery)) {
      findRangesRef.current = [];
      clearPane(findKey);
      setFindTotal(0);
      setFindActive(0);
      return;
    }
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const el = chatMessagesRef.current;
        if (!el) return;
        const offsets = matchOffsets(textOf(el), findSearchQuery);
        const ranges = rangesIn(el, findSearchQuery, offsets);
        findRangesRef.current = ranges;
        setPaneRanges(findKey, ranges);
        setFindTotal(ranges.length);
        // 换了词就回到第 1 个;没有命中就没有「当前」
        const first = ranges.length ? 1 : 0;
        setFindActive(first);
        setActive(findKey, first ? ranges[0] : null);
      });
    });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [findOpen, findSearchQuery, findKey, visibleGroups.length]);

  /** 这一格没了(关掉、换会话)就把它的高亮撤掉 —— 留着会画在别的会话的字上。 */
  useEffect(() => () => { clearPane(findKey); }, [findKey]);

  /** ↑/↓ 跳到上一个/下一个命中。绕回去的算术在 `stepIndex` 里（可测)。 */
  const findStep = useCallback((direction: 'next' | 'prev') => {
    const ranges = findRangesRef.current;
    if (!ranges.length) return;
    setFindActive((current) => {
      const next = stepIndex(current, ranges.length, direction);
      setActive(findKey, ranges[next - 1] || null);
      return next;
    });
  }, [findKey]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery('');
    findRangesRef.current = [];
    clearPane(findKey);
    setFindTotal(0);
    setFindActive(0);
  }, [findKey]);

  /**
   * Cmd/Ctrl+F 打开**这一格**的搜索条 —— 只有聚焦的那一格响应,否则一次按键会把每格都打开。
   *
   * capture 阶段:composer 的 textarea 和队列卡片各有自己的 keydown,冒泡阶段会被它们先吃掉 ——
   * 而「在输入框里按 Cmd+F」正是最常用的时刻。
   */
  useEffect(() => {
    if (!paneFocused || findSuspended) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setFindOpen(true);
        // 已经开着时再按一次 = 选中现有查询词,方便直接改写（编辑器通行行为）
        setTimeout(() => findInputRef.current?.select(), 0);
        return;
      }
      if (event.key === 'Escape' && findOpen) {
        event.preventDefault();
        closeFind();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [paneFocused, findSuspended, findOpen, closeFind]);

  return (
    /* 消息里的文件链接按这条会话的目录解析（见 PathSessionContext） */
    <PathSessionContext.Provider value={currentSessionId || ''}>
    <div
      className={`chat-main ${isDragOver ? 'drag-over' : ''}${readOnly ? ' chat-main-pane' : ''}`}
      onDrop={readOnly ? undefined : handleDrop}
      onDragOver={readOnly ? undefined : handleDragOver}
      onDragEnter={readOnly ? undefined : handleDragEnter}
      onDragLeave={readOnly ? undefined : handleDragLeave}
    >
      {/*
        这一格自己的搜索条 —— 「哪个分屏的搜索应该显示在那个分屏中」。

        `position: absolute` 落在**这一格里**（`.chat-main` 是 `position: relative`),而不是像上一版
        那样 `position: fixed` 浮在整个窗口的右上角。上一版的两个毛病都出在那个 fixed 上:
          ① 它属于窗口,所以分屏时说不清它在搜哪一格（而 `findInPage` 也确实在搜全部);
          ② 实测它被 `.chat-grid`（z-index 1001）整个盖住,点下去落到 `.chat-messages` 上,
             输入框根本拿不到焦点 —— 看起来就是「搜索没反应」。
        长在格子里,这两件事都不存在:它跟着格子走,z-index 只需要压住格子内部的东西。
      */}
      {findOpen && (
        <div className="pane-find" role="search">
          <input
            ref={findInputRef}
            className="pane-find-input"
            autoFocus
            placeholder={t('Find in this chat…')}
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={(e) => {
              // stopPropagation 是必须的:否则这个 Enter 冒泡出去会被聊天区当成「发送」
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                findStep(e.shiftKey ? 'prev' : 'next');
              }
            }}
          />
          <span className="pane-find-count">
            {findLabel({ query: findSearchQuery, active: findActive, total: findTotal }, findLang)}
          </span>
          <button className="pane-find-btn" onClick={() => findStep('prev')} title={t('Previous (Shift+Enter)')}>↑</button>
          <button className="pane-find-btn" onClick={() => findStep('next')} title={t('Next (Enter)')}>↓</button>
          <button className="pane-find-btn" onClick={closeFind} title={t('Close (Esc)')}>✕</button>
        </div>
      )}
      {isDragOver && (
        <div className="drop-overlay">
          <div className="drop-overlay-content">
            {t('📎 Drop files to attach')}
          </div>
        </div>
      )}

      {connectionError && messages.length > 0 && (
        <div className="chat-error-banner" role="alert">
          <span className="chat-error-banner-text">❌ {shownIn(findLang, connectionError)}</span>
          {onDismissError && (
            <button
              className="chat-error-banner-close"
              onClick={onDismissError}
              title={t('Dismiss')}
              aria-label={t('Dismiss')}
            >✕</button>
          )}
        </div>
      )}

      {/*
        记忆过大的横幅 —— 三层各一条，**放在最上面**。

        为什么要有：注入块每一轮都发，而三层里只有会话层有上限（`MAX_CHARS = 1200`，且只约束自动
        压缩那条路）。这笔钱之前完全无声，看不见就永远不会去清理 —— 实测某个项目到过 74 KB。

        为什么在顶部而不是 composer 上方：底部那块地方是给「此刻这一轮」的东西的（权限请求、排队、
        提示词建议），而这是一条要一直挂到你去清理为止的常驻状态。放底部会跟着输入区一起挤压滚动
        高度，也更容易被当成和当前这轮有关。

        它自己会消失：体积来自每轮注入后的播报 + 切会话/关 MemoryDialog 时的按需重取，所以你压缩完
        或手动删完横幅就没了 —— 不需要一个「不再提醒」的开关。
      */}
      {/*
        正在跑的子代理 —— 实时，全部结束就自己消失（`activeSubagents` 只算没 terminated 的）。
        放在顶部这一层的理由和记忆横幅一样：它是"这条会话现在的状态"，不属于某一轮消息。
      */}
      {activeSubagents(subagents).length > 0 && (
        <div className="chat-crew-bar" role="status">
          <span className="chat-crew-count">🤖 {t('{n} subagents running', { n: activeSubagents(subagents).length })}</span>
          {activeSubagents(subagents).map((row) => (
            <span className="chat-crew-item" key={row.name} title={t('{name} ({agent})', { name: row.name, agent: row.agentName || t('unknown agent') })}>
              <b>{row.name}</b>
              {row.statusMessage ? <span>{row.statusMessage}</span> : null}
            </span>
          ))}
        </div>
      )}
      {memoryWarnings.map((warning) => {
        const busy = compactingMemoryScope !== null;
        return (
          <div className="memory-warn-bar" role="status" key={warning.scope}>
            <span className="memory-warn-text">
              ⚠ {warning.label} {formatMemoryBytes(warning.bytes)} — {t('sent in full with every turn')}
            </span>
            <button
              className="memory-warn-btn"
              onClick={() => onCompactMemory(warning.scope)}
              disabled={busy}
              title={t('Back it up, then have this chat merge and de-duplicate the memory file (merge only — facts that still hold are kept)')}
            >
              {compactingMemoryScope?.startsWith(`${warning.scope}:`) ? t('Compacting…') : t('Compact')}
            </button>
            {/* 「编辑」直接打开**这一层**（会话 / 项目 / 全局），而且是这个窗格的会话 —— 分屏时不一定是"当前"那条 */}
            <button className="memory-warn-btn edit" onClick={() => onOpenMemory(warning.scope as 'global' | 'project' | 'session')} title={t('Open {label} and edit it yourself', { label: warning.label })}>
              {t('Edit')}
            </button>
            <button className="memory-warn-btn ghost" onClick={() => onOpenMemory()} title={t('Open the memory editor and clean it up yourself')}>
              {t('View')}
            </button>
          </div>
        );
      })}

      {/* ABOVE the transcript, not in the composer (where the archive notice lives): a
          schedule is a standing property of the chat, and it has to be visible while you
          read history — including when the composer is collapsed. */}
      {scheduleSummary && (
        <div
          className={`schedule-banner${scheduleSummary.paused ? ' paused' : ''}${scheduleSummary.hasError ? ' failing' : ''}`}
          title={scheduleSummary.text}
        >
          <span className="schedule-banner-icon">{scheduleSummary.paused ? '⏸️' : '⏰'}</span>
          <span className="schedule-banner-text">{scheduleSummary.text}</span>
          {scheduleSummary.next && (
            <>
              {/* Pause is REVERSIBLE, so one click. It is also the honest way to stop a job you
                  might want back — cancelling loses the prompt and the remaining budget. */}
              <button
                className="schedule-banner-pause"
                onClick={() => onPauseSchedule?.(scheduleSummary.next!.id, !scheduleSummary.paused)}
                title={scheduleSummary.paused ? t('Resume: keep running on the original schedule') : t('Pause: keep the job, stop it firing')}
              >{scheduleSummary.paused ? t('▶️ Resume') : t('⏸️ Pause')}</button>
              {/* Cancel is NOT reversible (the prompt and trigger are deleted), so it arms
                  first. The armed state resets on its own so a forgotten click cannot sit
                  there waiting to delete a job days later. */}
              <button
                className={`schedule-banner-cancel${cancelArmed ? ' armed' : ''}`}
                onClick={() => {
                  if (!cancelArmed) {
                    setCancelArmed(true);
                    if (cancelArmTimer.current) clearTimeout(cancelArmTimer.current);
                    cancelArmTimer.current = setTimeout(() => setCancelArmed(false), 4000);
                    return;
                  }
                  if (cancelArmTimer.current) clearTimeout(cancelArmTimer.current);
                  setCancelArmed(false);
                  onCancelSchedule?.(scheduleSummary.next!.id);
                }}
                title={cancelArmed ? t('Click again to confirm cancellation (cannot be undone)') : t('Cancel this scheduled job')}
              >{cancelArmed ? t('Confirm cancel?') : t('🗑️ Cancel')}</button>
            </>
          )}
        </div>
      )}

      <div
        className="chat-messages"
        ref={chatMessagesRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          // Sticky-bottom detection: within 60px of the bottom counts as "at
          // bottom" (covers fractional scroll heights and in-flight layout).
          const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
          const atBottom = distanceFromBottom <= 60;
          stickToBottomRef.current = atBottom;
          setShowJumpToBottom((visible) => (visible === !atBottom ? visible : !atBottom));
          if (el.scrollTop <= 80 && hiddenGroupCount > 0 && preExpandHeightRef.current == null) {
            loadOlder();
          }
        }}
      >
        {messages.length === 0 && historyLoading && (
          <div style={{ textAlign: 'center', marginTop: '20vh', color: 'var(--text-muted)' }}>
            <div className="history-loading-spinner" />
            <div style={{ marginTop: 14, fontSize: 13 }}>{t('Loading history…')}</div>
          </div>
        )}
        {messages.length === 0 && !historyLoading && (
          <div style={{ textAlign: 'center', marginTop: '20vh', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>⚡</div>
            <h2 style={{ fontSize: 20, fontWeight: 500, marginBottom: 8, color: 'var(--text-secondary)' }}>
              KiroLex
            </h2>
            {connectionError ? (
              <div style={{ 
                maxWidth: 500, margin: '16px auto', padding: '12px 16px',
                background: 'rgba(239, 83, 80, 0.1)', border: '1px solid rgba(239, 83, 80, 0.3)',
                borderRadius: 8, textAlign: 'left', fontSize: 13, lineHeight: 1.6,
                color: 'var(--error)', whiteSpace: 'pre-wrap',
              }}>
                ❌ {shownIn(findLang, connectionError)}
              </div>
            ) : (
              <p style={{ fontSize: 14 }}>
                {status === 'connected'
                  ? t('Start a conversation or drag files here')
                  : t('Connecting...')}
              </p>
            )}
          </div>
        )}

        {hiddenGroupCount > 0 && (
          <button className="load-older-btn" onClick={loadOlder}>
            {t('⤴ Load earlier messages ({n} more groups)', { n: hiddenGroupCount })}
          </button>
        )}

        {visibleGroups.map((group) => (
          /*
            清空那条**画成分界线**，不画成用户气泡：一个写着 `/clear` 的气泡说不出
            「上面的模型不记得了」，而那正是这条消息在这一页上唯一的意义。
            两句话都要有：上面的不记得了（否则你以为它记得）、记录还在（否则你以为清空把历史弄丢了）。
          */
          group.kind === 'user' && isClearCommand((group as any).base) ? (
            <div className="chat-clear-line" key={`${currentSessionId ?? 'none'}:${group.base.id}`}>
              <span>{clearNoteText(hiddenGroupCount, findLang)}</span>
            </div>
          ) : group.kind === 'kirolex' ? (
            <KirolexMessageItem
              key={`${currentSessionId ?? 'none'}:${group.message.id}`}
              message={group.message}
            />
          ) : group.kind === 'user' ? (
            <UserGroupItem
              key={`${currentSessionId ?? 'none'}:${group.base.id}`}
              base={group.base}
              steers={group.steers}
              isStreaming={isStreaming}
              onRerun={onRerunMessage}
              attachmentSessionId={currentSessionId}
              onOpenAttachment={openPathInApp}
              interrupted={!!turnInterrupted}
              isLooping={isLooping}
              onScheduleSetup={openScheduleSetup}
            />
          ) : (
            <MessageItem
              remoteHost={remoteHostLabel}
              key={`${currentSessionId ?? 'none'}:${group.segments[group.segments.length - 1].id}`}
              segments={group.segments}
              questionContent={group.question}
              isLastAssistant={group.isLast}
              isStreaming={isStreaming}
              onFork={onForkMessage}
              foldThinking={autoFoldThinking}
              foldTools={autoFoldTools}
            />
          )
        ))}

        {plan.length > 0 && (
          <div className="turn-panels">
            <PlanPanel plan={plan} />
          </div>
        )}

        {/* Exactly ONE tail indicator: a live tool call is the most specific, so
            it wins; otherwise show the phase text / thinking dots. */}
        {isStreaming && activeToolCall ? (
          <div className="agent-activity" title={activeToolCall}>
            <span className="agent-activity-pulse" />
            <span className="agent-activity-text">
              {/*
                `Spawning agent crew` 是 kiro 实际发的 title（探针实测，见 scripts/acp-probe.mjs）——
                只匹配 subagent / delegate 这些词的话，真正的委派一次都命中不了。
              */}
              {/(subagent|sub-agent|子代理|delegate|agent crew|task\b)/i.test(activeToolCall)
                ? t('🤖 Subagent running · {tool}', { tool: activeToolCall })
                : t('⚙️ Running · {tool}', { tool: activeToolCall })}
            </span>
          </div>
        ) : (activityStatus || (isStreaming && messages.length > 0)) ? (
          <div className="message assistant">
            <div className="message-content">
              <div className="thinking-dots">
                <span /><span /><span />
              </div>
              {activityStatus && (
                <span className="activity-status-text">{shownIn(findLang, activityStatus)}</span>
              )}
            </div>
          </div>
        ) : null}

        {/* The tail indicator above is deliberately exclusive, and "⚙️ 运行中 · X"
            wins whenever a tool is open — which is exactly the state that hangs. A
            turn could therefore sit here for half an hour looking perfectly healthy
            and then get cut by the timeout with no warning at all. This sits BELOW
            the indicator so it shows in either branch, and main refreshes it every
            30s so the elapsed time never freezes. */}
        {isStreaming && stall && (() => {
          const dur = (s: number) => (s < 90 ? t('{n} sec', { n: Math.max(1, Math.round(s)) }) : t('{n} min', { n: Math.round(s / 60) }));
          // ONE line. The only fact the user cannot get from the spinner is WHETHER AND
          // WHEN this turn will be cut off, so that is the whole sentence. Everything
          // else the old three-sentence version said -- that long commands legitimately
          // report nothing, that partial output survives, which setting moves the bound
          // -- is background for the one time someone wants it, and lives in the tooltip.
          //
          // The countdown NAMES its threshold. With a tool call open it is measured
          // against 「工具无进度多久判定卡死」 (30 min), not the silence threshold shown
          // first in Settings (10 min) -- so "再 23 分钟" read as a contradiction of the
          // 600 on that page. Both bounds have to be passed and the later one wins.
          const bound = stall.boundBy === 'tool'
            ? t('Tool stall threshold {d}', { d: dur(stall.boundSeconds) })
            : t('Silence threshold {d}', { d: dur(stall.boundSeconds) });
          const line = stall.interruptInSeconds === null
            ? t('The timeout interrupt is off, so it will wait indefinitely.')
            : stall.interruptInSeconds > 0
              ? (stall.openTools > 0
                  ? t('{n} tools still running; it will be interrupted only after {d} more without progress (per "{bound}").', { n: stall.openTools, d: dur(stall.interruptInSeconds), bound })
                  : t('No tool is running; it will be interrupted in {d} (per "{bound}").', { d: dur(stall.interruptInSeconds), bound }))
              : t('About to interrupt this turn…');
          const tip = [
            stall.openTools > 0
              ? t('{n} tool calls have started but not reported finishing; the last progress update was {d} ago.', { n: stall.openTools, d: dur(stall.toolIdleSeconds) })
              : t('This turn has produced no output and no tool activity.'),
            t('Long commands (builds, tests, parsing big files) report nothing between start and finish, so silence alone does not mean it is stuck.'),
            t('Interrupting needs both conditions at once: silence beyond the silence threshold, and no tool reporting progress within the tool stall threshold.'),
            t('So while a tool is running, the real wait is the later of the two thresholds; the parentheses in the line above name the one in effect.'),
            t('If it does get interrupted, the output so far is kept, and the tool itself may keep running in the background. Press Stop to end it yourself at any time.'),
          ].join('\n');
          return (
            <div className="stall-notice" role="status" aria-live="polite" title={tip}>
              <span className="stall-notice-icon" aria-hidden="true">⏳</span>
              <div className="stall-notice-copy">
                <strong>{t('No output for {d}', { d: dur(stall.quietSeconds) })}</strong>
                <span>{line}</span>
              </div>
            </div>
          );
        })()}

        {/* No end-anchor element: scrolling to the latest message writes this
            container's scrollTop instead of calling scrollIntoView on an anchor, so
            nothing outside this pane can be scrolled. See scrollContainerToBottom. */}
      </div>

      <div className="jump-to-bottom-anchor">
        {showJumpToBottom && (
          <button
            className="jump-to-bottom-btn"
            onClick={jumpToBottom}
            title={t('Jump to the latest message')}
            aria-label={t('Jump to the latest message')}
          >
            {t('↓ Latest')}
          </button>
        )}
      </div>

      {!readOnly && <ReviewQueueStack sessionId={currentSessionId} />}
      {!readOnly && (
        <QueueStack
          queuedMessages={queuedMessages}
          onCancelQueuedMessage={onCancelQueuedMessage}
          onEditQueuedMessage={onEditQueuedMessage}
          onMoveQueuedMessage={onMoveQueuedMessage}
          mergeQueued={mergeQueuedMessages}
        />
      )}

      {/* Rendered from turnInterrupted — the SAME persistent state that disables the
          per-message Rerun buttons, so the notice and the restriction cannot
          disagree. It is deliberately NOT also reported through `connectionError`:
          that value is app-wide and written in ~20 places, so it outlived this state
          and left a second, red copy of this message on screen that nothing cleared.

          Hidden while a turn is streaming, because then it would be false: the
          composer steers the running turn (or queues) and does not overwrite
          anything -- exactly what the shortcut hint under the input says. The state
          itself is also retired when a new turn starts, so this only covers the brief
          window while a cancel is still settling.

          Kept to one line on purpose. The single fact the user cannot guess is that
          Enter OVERWRITES instead of appending, so that is what the sentence says;
          the disabled Rerun button explains itself in its own tooltip, and "this
          notice will disappear by itself" does not need saying -- it just does. */}
      {turnInterrupted && !isStreaming && (
        <div className="interrupted-bar" role="region" aria-live="polite">
          <span className="interrupted-bar-icon" aria-hidden="true">↩</span>
          <div className="interrupted-bar-copy">
            <strong>{t('The previous turn was interrupted')}</strong>
            <span>{t('The original text is back in the composer. Enter replaces and reruns this turn; it does not send a new message.')}</span>
          </div>
        </div>
      )}


      {/* Monitor pane: no composer, but permission requests MUST stay actionable
          here — a background session's approval prompt was previously invisible
          until you switched to it, which stalled that session indefinitely. */}
      {readOnly && permissionRequest && (
        <div className="chat-input-area pane-permission-only">
          <PermissionBar request={permissionRequest} onRespond={onRespondPermission} />
        </div>
      )}

      {!readOnly && (
      <div className="input-resize-area">
        {!inputCollapsed && (
          <div
            className="input-resize-handle"
            onMouseDown={handleInputResizeStart}
            onDoubleClick={() => setInputHeight(140)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
              event.preventDefault();
              const delta = event.key === 'ArrowUp' ? 16 : -16;
              const maxHeight = Math.max(180, Math.floor(window.innerHeight * 0.7));
              setInputHeight((height) => Math.max(96, Math.min(maxHeight, height + delta)));
            }}
            role="separator"
            aria-label={t('Resize message composer')}
            aria-orientation="horizontal"
            aria-valuemin={96}
            aria-valuemax={Math.max(180, Math.floor(window.innerHeight * 0.7))}
            aria-valuenow={inputHeight}
            tabIndex={0}
            title={t('Drag upward to enlarge · Double-click to reset')}
          >
            <span className="input-resize-grip" />
          </div>
        )}
        <button
          className="input-collapse-btn"
          onClick={() => setInputCollapsed(!inputCollapsed)}
          title={inputCollapsed ? t('Show input') : t('Hide input')}
        >
          {inputCollapsed ? '▲' : '▼'}
        </button>
      </div>
      )}

      {!readOnly && !inputCollapsed && (
        <div
          className="chat-input-area"
          // minHeight, NOT height: in a narrow pane the belowbar wraps to two
          // rows and a fixed height clipped it, so the agent/model/usage
          // controls vanished. The composer keeps its own resize behaviour.
          style={{ minHeight: inputHeight }}
        >
          {isArchived ? (
            <div className="archived-composer-banner">
              <span>{t('📥 This chat is archived — unarchive it to continue chatting.')}</span>
              {onUnarchive && (
                <button className="archived-unarchive-btn" onClick={onUnarchive}>{t('♻️ Unarchive')}</button>
              )}
            </div>
          ) : (
            <>
              {permissionRequest && (
                <PermissionBar
                  request={permissionRequest}
                  onRespond={onRespondPermission}
                />
              )}
              {/*
                **KiroLex 自己对你说的那一句**（⏳ 正在推/拉、⚠️ 本地不是最新的、🔀 换了机器）。
                在输入框**上方**、不进对话：它不是对话内容，写进 transcript 会打断读法、
                把 transcript 撑大（远程会话每轮都要推它），还得靠"别发给模型"那条过滤一直兜着。
                自己会消失（⚠️ 留久一点，它影响你接下来的判断）。
              */}
              {localNotice && (
                <div className="session-notice">
                  <span className="session-notice-text">{localNotice}</span>
                  <button className="session-notice-close" onClick={() => setLocalNotice(null)} title={t('Close notice')}>✕</button>
                </div>
              )}
              {sessionNotice && (
                <div className={`session-notice${/⚠️/.test(sessionNotice.text) ? ' warn' : ''}`}>
                  <span className="session-notice-text">
                    {sessionNotice.variants?.[findLang] ?? sessionNotice.text}
                    {/* 放在文字下面（同一列）：分屏时一格很窄，并排会把按钮挤出去 */}
                    {sessionNotice.copyRemote && currentSessionId && (
                      <RemoteCopyButtons sessionId={currentSessionId} paths={sessionNotice.copyRemote} />
                    )}
                  </span>
                  <button className="session-notice-close" onClick={dismissNotice} title={t('Close notice')}>✕</button>
                </div>
              )}
              <ChatInputBox
                choiceChips={choiceChips}
                onSlashPicker={handleSlashPicker}
                sessionId={currentSessionId}
                isStreaming={isStreaming}
                isLooping={isLooping}
                status={status}
                sessionConnected={sessionConnected}
                permissionMode={permissionMode}
                onPermissionModeChange={onPermissionModeChange}
                engineMode={nonKiro ? {
                  current: engineModels?.mode?.current || '',
                  options: engineModels?.mode?.options || [],
                  busy: engineModelBusy,
                  onChange: (v) => void onEngineOptionChange('mode', v),
                } : null}
                onSend={onSend}
                onSteer={onSteerMessage}
                onCancel={onCancel}
                onStopLoop={onStopLoop}
                onQueueCommand={onQueueMessage}
                queuedMessages={queuedMessages}
                restoredDraft={restoredQueueDraft}
                restoredInputDraft={restoredInputDraft}
                onConsumeRestoredDraft={onConsumeRestoredDraft}
                onConsumeRestoredInputDraft={onConsumeRestoredInputDraft}
                onCancelQueuedMessage={onCancelQueuedMessage}
                onEditQueuedMessage={onEditQueuedMessage}
                onMoveQueuedMessage={onMoveQueuedMessage}
                commands={commands}
                suggestions={messages.length === 0
                  ? PROMPT_SUGGESTIONS
                  // Stamp must match the current turn, else show nothing: stale chips
                  // read as current ones, and offering follow-ups to the PREVIOUS
                  // answer is worse than offering none for a moment.
                  : (dynamicSuggestions.key && dynamicSuggestions.key === currentTurnKey ? dynamicSuggestions.items : [])}
                onDropFiles={onDropFiles}
                onRemoveFile={onRemoveFile}
                attachedFiles={attachedFiles}
              />

              <div className="composer-belowbar">
                <div className="composer-belowbar-left">

                  {/* kiro 的 agent 只对 Kiro 会话有意义；Claude Code / Codex 会话在这儿显示引擎名 */}
                  {nonKiro ? (
                    <div className="composer-agent-selector">
                      {/*
                        **Claude Code / Codex 也有这个机器人** ——「claude code 和 codex 左下角也得有一个类似的图标啊，
                        要不然怎么打开登录」。点开是它自己的配置（~/.claude / ~/.codex，跟着会话的机器走）和「🔑 登录」。
                      */}
                      <button
                        className="composer-meta-btn composer-agent-config"
                        onClick={() => { setEngineConfigTab('login'); setEngineConfigOpen(true); }}
                        disabled={!currentSessionId}
                        title={t('{engine} config and login (on the machine this chat runs on)', { engine: engineLabel })}
                        aria-label={t('{engine} config', { engine: engineLabel })}
                      >
                        {/* 不用机器人 —— 那是 kiro 的（「左下角不应该再用那个机器人的图标了」） */}
                        {engine === 'claude' ? <IconClaudeSpark size={15} /> : <IconCodexPrompt size={15} />}
                      </button>
                      {/*
                        **组合** —— 取代原来的 effort 下拉：组合里带着 MCP 和 effort（「不同对话挂不同的 MCP」）。
                        换组合会重启这条会话的执行器，所以回复中不让换。
                      */}
                      <select
                        className="composer-select composer-combo-select"
                        value={mcpCombos?.current || 'default'}
                        onChange={(event) => void onMcpComboChange(event.target.value)}
                        disabled={!currentSessionId || !mcpCombos || isStreaming || isLooping || mcpComboBusy || engineModelBusy}
                        title={isStreaming
                          ? t('Wait for this reply to finish before switching combos')
                          : mcpCombos?.error
                            ? t('The combo file has an error: {error}', { error: mcpCombos.error })
                            : t("{engine} combo (MCP + effort). Switching restarts this chat's executor", { engine: engineLabel })}
                        aria-label={t('Combo')}
                      >
                        {(mcpCombos?.combos || [{ id: 'default', name: t('General purpose') }]).map((c) => (
                          /* 内置组合的名字在这里按当前语言取：清单是进会话时拉的，那一刻的语言不一定是现在的 */
                          <option key={c.id} value={c.id}>{t('Combo · {name}', { name: c.id === 'default' ? t('General purpose') : c.name })}</option>
                        ))}
                      </select>
                    </div>
                  ) : (
                  <div
                      className="composer-agent-selector"
                      title={t("Agent (switching restarts this chat's executor with the selected Kiro agent)")}
                    >
                      {/*
                        改这个 agent 的配置 —— 按钮就在选它的旁边。「把 kiro 的 agent 配置这个按钮放到会话界面」。
                        它原来在左侧栏底部那排图标里:选 agent 在这儿、改 agent 在那儿,而那排图标里它和
                        🧠、⚙️ 挤在一起,看不出改的是「当前这个 agent」。
                        **改的是全局配置**:agent 定义在 ~/.kiro 下,一份被所有会话共用 —— 所以 title 里明说,
                        免得看着它在会话里就以为只影响这一个会话。
                      */}
                      <button
                        className="composer-meta-btn composer-agent-config"
                        onClick={openAgentConfig}
                        disabled={!currentSessionId || agentConfigLoading}
                        title={t('Edit the config of {agent} (global: every chat shares this one definition)', { agent: kiroAgent || 'agent' })}
                        aria-label={t('Edit agent config (global)')}
                      >
                        {/* 还是那个机器人图标 —— 它在侧栏用了很久，认的是它，不是一个新的齿轮 */}
                        <IconRobot size={15} />
                      </button>
                      {agentConfigLoading && <span className="composer-agent-spinner">⏳</span>}
                      <select
                        ref={agentSelectRef}
                        className="composer-select composer-agent-select"
                        value={kiroAgent}
                        onChange={(event) => onKiroAgentChange(event.target.value)}
                        disabled={!currentSessionId || isStreaming || isLooping || switchingAgent || status !== 'connected'}
                        aria-label={t('Agent')}
                      >
                        {kiroAgent && !kiroAgents.some((agent) => agent.name === kiroAgent) && (
                          <option value={kiroAgent}>{kiroAgent}</option>
                        )}
                        {kiroAgents.map((agent) => (
                          <option key={agent.name} value={agent.name}>
                            {agent.name}{agent.isDefault ? t(' (default)') : ''}
                          </option>
                        ))}
                      </select>
                      {switchingAgent && <span className="composer-agent-spinner">⏳</span>}
                    </div>
                  )}

                  <div className="import-context-wrapper">
                    <button
                      ref={importBtnRef}
                      className={`composer-meta-btn ${contextLinks.length > 0 ? 'active' : ''}`}
                      onClick={toggleImportPicker}
                      title={t('Sync context from other sessions')}
                      disabled={importableSessions.length === 0}
                    >
                      🛠️ <span className="composer-meta-label">{t('Context Engineering')}</span>
                      {contextLinks.length > 0 && <span className="composer-meta-count">{contextLinks.length}</span>}
                    </button>
                    {/* Portal to <body>: `.chat-main` now sets container-type for the
                        composer's container queries, and container-type implies
                        contain:layout, which makes it the containing block for
                        position:fixed children. Without the portal this panel was
                        offset by the pane's own x (it flew off screen in a
                        right-hand split pane). */}
                    {showImportPicker && createPortal(
                      <>
                        <div className="import-picker-overlay" onClick={() => setShowImportPicker(false)} />
                        <div className="import-picker" style={{ left: pickerPos.left, bottom: pickerPos.bottom }}>
                          <div className="import-picker-header">
                            <span>{t('Select context to sync')}</span>
                          </div>
                          <div className="import-picker-list">
                            {importableSessions.length === 0 ? (
                              <div className="import-picker-empty">{t('No other sessions available')}</div>
                            ) : (
                              importableSessions.map((session) => {
                                const linked = contextLinks.some((link) => link.sourceId === session.id);
                                return (
                                  <button
                                    key={session.id}
                                    className={`import-picker-item ${linked ? 'active' : ''}`}
                                    title={displayTitle(findLang, session.title)}
                                    onClick={() => onToggleContextSource(session.id)}
                                  >
                                    <span className="import-picker-box">{linked ? '☑' : '☐'}</span>
                                    <span className="import-picker-title">{displayTitle(findLang, session.title) || t('Untitled')}</span>
                                  </button>
                                );
                              })
                            )}
                          </div>
                        </div>
                      </>,
                      document.body,
                    )}
                  </div>

                </div>

                <div className="composer-belowbar-right">
                  {isStreaming && activeToolCall ? (
                    <span className="composer-tool-status" title={activeToolCall}>⚙️ {activeToolCall}</span>
                  ) : usage ? (
                    <>
                      <button
                        type="button"
                        className={`composer-usage composer-usage-action ${usage.contextPercent >= 80 ? 'high' : usage.contextPercent >= 50 ? 'mid' : ''}`}
                        onClick={onManageContext}
                        disabled={!currentSessionId || isStreaming}
                        title={t('Manage context · currently {pct}% used', { pct: usage.contextPercent.toFixed(1) })}
                      >
                        <span className="composer-usage-bar">
                          <span className="composer-usage-fill" style={{ width: `${Math.min(100, Math.max(0, usage.contextPercent))}%` }} />
                        </span>
                        <span className="composer-usage-label">{usage.contextPercent.toFixed(0)}%</span>
                      </button>
                      <button
                        type="button"
                        className="composer-credits composer-usage-action"
                        onClick={onResetCredits}
                        disabled={!currentSessionId || isStreaming}
                        title={t("Reset this session's local Credits counter")}
                      >
                        {usage.credits.toFixed(2)} {t('credits')}
                      </button>
                    </>
                  ) : null}

                  {/* 模型清单是 kiro 的；另外两家用它们自己 CLI 配的模型 */}
                  {!nonKiro && (
                  <select
                      ref={modelSelectRef}
                      className="composer-select composer-model-select"
                      value={selectedModel}
                      onChange={(event) => onModelChange(event.target.value)}
                      disabled={!currentSessionId || isStreaming || isLooping || switchingModel || status !== 'connected'}
                      title={isStreaming
                        ? t('Wait for the current response to finish before switching models')
                        : switchingModel
                        ? t('Wait for the current model change to finish')
                        : t('Model')}
                    >
                      {models.length > 0 ? (
                        <>
                          {/* The executor binds --model at spawn, so a session can hold a
                              model this account cannot use (a retired id, or a stale
                              hardcoded default). A <select> whose value matches no option
                              silently shows the FIRST one, so the composer claimed
                              "gpt-5.6-sol" while the request actually ran
                              "claude-sonnet-4.6" and failed. Surfacing the real value as a
                              non-selectable option keeps the selector honest. */}
                          {selectedModel && !models.some((model) => model.model_id === selectedModel) ? (
                            <option value={selectedModel} disabled>
                              {selectedModel} {t('· unavailable')}
                            </option>
                          ) : null}
                          {models.map((model) => (
                            <option
                              key={model.model_id}
                              value={model.model_id}
                              /*
                                **数字是哪来的要能查** ——「为什么又看不到模型乘数了」那次的根因是
                                远端只给 id、而本机清单里没有那个模型（地域过滤），于是倍率补不上。
                                现在有缓存和内置快照兜底（`modelMeta.ts`），但快照可能过期 ——
                                所以非实时的那几条在 title 里说一句，而不是让 `2.2x` 看起来永远权威。
                              */
                              title={(model as any).metaFrom && (model as any).metaFrom !== 'live' && (model as any).metaFrom !== 'none'
                                ? ((model as any).metaFrom === 'cache'
                                  ? t('{model} (rate/window from the local cache, not reported by this machine right now)', { model: model.model_id })
                                  : t('{model} (rate/window from the built-in snapshot, not reported by this machine right now)', { model: model.model_id }))
                                : model.model_id}
                            >
                              {model.model_name}{model.context_window_tokens ? ` · ${fmtContextWindow(model.context_window_tokens)}` : ''}
                              {/* 价格乘数 —— 换模型是这一格里唯一会花钱的选择，代价该摆在做决定的地方 */}
                              {fmtRate((model as any).rate_multiplier) ? ` · ${fmtRate((model as any).rate_multiplier)}` : ''}
                            </option>
                          ))}
                        </>
                      ) : (
                        <option value={selectedModel || 'auto'}>{selectedModel || 'auto'}</option>
                      )}
                    </select>
                  )}
                  {nonKiro && (
                    <select
                      className="composer-select composer-model-select"
                      value={engineModels?.current || ''}
                      onChange={(event) => void onEngineModelChange(event.target.value)}
                      disabled={!currentSessionId || !engineModels?.options.length || isStreaming || isLooping || engineModelBusy || status !== 'connected'}
                      title={engineModelErr ? `✗ ${engineModelErr}` : isStreaming ? t('Wait for this reply to finish before switching models') : t('{engine} model', { engine: engineLabel })}
                    >
                      {engineModels?.options.length ? (
                        <>
                          {engineModels.current && !engineModels.options.some((o) => o.value === engineModels.current) ? (
                            <option value={engineModels.current} disabled>{engineModels.current}</option>
                          ) : null}
                          {engineModels.options.map((o) => <option key={o.value} value={o.value}>{o.name}</option>)}
                        </>
                      ) : (
                        <option value="">{status === 'connected' ? t('Default model') : t('Connecting…')}</option>
                      )}
                    </select>
                  )}
                  {(switchingModel || engineModelBusy) && <span className="composer-agent-spinner">⏳</span>}
                  {engineModelErr && <span className="composer-engine-err" title={engineModelErr}>✗</span>}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {scheduleSetup && createPortal(
        <>
          <div className="overlay" onClick={() => setScheduleSetup(null)} />
          <div
            className="loop-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="schedule-dialog-title"
            onKeyDown={(event) => {
              if (event.key === 'Escape') { setScheduleSetup(null); return; }
              if (event.key !== 'Enter' || event.shiftKey) return;
              if (scheduleProblems.length > 0) return;
              onStartSchedule(draftSchedule);
              setScheduleSetup(null);
            }}
          >
            <h3 id="schedule-dialog-title">{t('⏰ Scheduled job')}</h3>
            <div className="loop-dialog-preview">{scheduleSetup.text}</div>
            <div className="loop-dialog-level level-0">
              {describeSchedule(draftSchedule, findLang)} · {t('up to {n} times', { n: draftSchedule.maxRuns })}
              {/* 英文两句之间要断开；中文原样紧挨着 */}
              {findLang === 'en' ? '. ' : ''}
              <span className="schedule-note">
                {t("Each run is an independent send that doesn't carry the previous result into the next; otherwise a scheduled job would keep reporting the same thing.")}
              </span>
            </div>

            <div className="loop-dialog-grid">
              <label className="loop-dialog-field">
                <span>{t('Trigger')}</span>
                <select value={schedKind} onChange={(event) => setSchedKind(event.target.value as any)}>
                  <option value="daily">{t('Daily at a set time')}</option>
                  <option value="weekly">{t('Weekly at a set time')}</option>
                  <option value="interval">{t('Repeat on an interval')}</option>
                  <option value="once">{t('Once, at a given moment')}</option>
                </select>
              </label>

              {schedKind === 'interval' && (
                <label className="loop-dialog-field">
                  <span>{t('Interval (minutes, at least {n})', { n: MIN_INTERVAL_SEC / 60 })}</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={schedEvery}
                    onChange={(event) => setSchedEvery(event.target.value.replace(/[^0-9]/g, ''))}
                  />
                </label>
              )}

              {schedKind === 'weekly' && (
                <label className="loop-dialog-field">
                  <span>{t('Day of week')}</span>
                  <select value={schedWeekday} onChange={(event) => setSchedWeekday(event.target.value)}>
                    {[t('Sunday'), t('Monday'), t('Tuesday'), t('Wednesday'), t('Thursday'), t('Friday'), t('Saturday')].map((day, index) => (
                      <option key={index} value={String(index)}>{day}</option>
                    ))}
                  </select>
                </label>
              )}

              {(schedKind === 'daily' || schedKind === 'weekly') && (
                <label className="loop-dialog-field">
                  <span>{t('Time (HH:MM, 24-hour)')}</span>
                  <input type="text" value={schedTime} onChange={(event) => setSchedTime(event.target.value)} />
                </label>
              )}

              {schedKind === 'once' && (
                <label className="loop-dialog-field">
                  <span>{t('Trigger moment')}</span>
                  <input type="datetime-local" value={schedOnceAt} onChange={(event) => setSchedOnceAt(event.target.value)} />
                </label>
              )}

              <label className="loop-dialog-field">
                <span>{t('Maximum number of runs (required)')}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={schedMaxRuns}
                  onChange={(event) => setSchedMaxRuns(event.target.value.replace(/[^0-9]/g, ''))}
                />
              </label>
            </div>

            {scheduleProblems.length > 0 && (
              <div className="loop-dialog-problems">{scheduleProblems.join(t('; '))}</div>
            )}
            <div className="loop-dialog-actions">
              <button className="loop-dialog-cancel" onClick={() => setScheduleSetup(null)}>{t('Cancel')}</button>
              <button
                className="loop-dialog-start"
                disabled={scheduleProblems.length > 0}
                title={scheduleProblems.length > 0 ? scheduleProblems.join(t('; ')) : t('Create scheduled job')}
                onClick={() => {
                  onStartSchedule(draftSchedule);
                  setScheduleSetup(null);
                }}
              >
                {t('Create')}
              </button>
            </div>
          </div>
        </>,
        document.body,
      )}

      {agentConfigEditor && createPortal(
        <>
          <div className="overlay" onClick={closeAgentConfig} />
          <div
            className="agent-config-editor-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-config-editor-title"
          >
            <div className="settings-header">
              <div className="agent-config-editor-title">
                <IconRobot size={17} />
                <h3 id="agent-config-editor-title">{t('Kiro Agent configurations')}</h3>
              </div>
              <button className="settings-close" onClick={closeAgentConfig} aria-label={t('Close')}>✕</button>
            </div>
            <div className="kiro-config-tabs" role="tablist">
              {[{ id: 'agents', label: t('Agents') }, ...kiroConfigCats].map((c) => (
                <button
                  key={c.id}
                  role="tab"
                  aria-selected={agentConfigTab === c.id}
                  className={`kiro-config-tab ${agentConfigTab === c.id ? 'active' : ''}`}
                  onClick={() => setAgentConfigTab(c.id)}
                >
                  {c.label}
                </button>
              ))}
            </div>
            {agentConfigTab === 'agents' ? (<>
            <div className="agent-config-editor-workspace">
              <aside className="agent-config-agent-list" aria-label={t('Kiro Agents')}>
                <input
                  className="agent-config-filter"
                  placeholder={t('Filter {n} agents', { n: agentConfigAgents.length })}
                  value={agentConfigFilter}
                  onChange={(ev) => setAgentConfigFilter(ev.target.value)}
                />
                {/* 按来源分组：能改的（全局 / 本地）在前，内置的只能看，放最后 */}
                {(['global', 'local', 'built-in'] as const).map((src) => {
                  const q = agentConfigFilter.trim().toLowerCase();
                  const group = agentConfigAgents.filter((a) => (a.source || 'global') === src
                    && (!q || a.name.toLowerCase().includes(q)));
                  if (!group.length) return null;
                  return (
                    <div key={src} className="agent-config-group">
                      <div className="agent-config-group-head">
                        {src === 'built-in' ? t('Built-in (read-only)') : src === 'global' ? t('Global') : t('This project')}
                        <span>{group.length}</span>
                      </div>
                      {group.map((agent) => {
                        const draft = agentConfigDrafts[agent.name];
                        const hasUnsavedDraft = !!draft && !draft.error && draft.content !== draft.initialContent;
                        return (
                          <button
                            key={agent.name}
                            className={`agent-config-row ${agentConfigEditor.agentName === agent.name ? 'active' : ''} ${src === 'built-in' ? 'readonly' : ''}`}
                            onClick={() => void loadAgentConfig(agent.name)}
                            disabled={agentConfigLoading}
                            title={src === 'built-in' ? t('{name} is built in and cannot be changed', { name: agent.name }) : agent.name}
                          >
                            <span className="agent-config-row-name">{agent.name}</span>
                            {hasUnsavedDraft && <span className="agent-config-row-dirty" title={t('Unsaved changes')} />}
                            {agent.isDefault && <span className="agent-config-row-default">{t('Default')}</span>}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </aside>

              <div className="agent-config-editor-body">
                <div className="agent-config-editor-selection">
                  <strong>{agentConfigEditor.agentName}</strong>
                  {!agentConfigLoading && !agentConfigEditor.error && (
                    <span className="agent-config-editor-path" title={agentConfigEditor.path}>
                      {agentConfigEditor.path}
                    </span>
                  )}
                </div>

                {agentConfigLoading ? (
                  <div className="agent-config-editor-message">{t('Loading configuration…')}</div>
                ) : agentConfigEditor.error ? (
                  <div className="agent-config-readonly-note">
                    <strong>{t("This agent can't be edited here")}</strong>
                    <span>{agentConfigEditor.error}</span>
                  </div>
                ) : (
                  <>
                    <div className={`agent-config-editor-shell ${agentConfigValidationError ? 'invalid' : 'valid'}`}>
                      <div
                        ref={agentConfigLineNumbersRef}
                        className="agent-config-line-numbers"
                        aria-hidden="true"
                      >
                        {agentConfigLines.map((_, index) => {
                          const lineNumber = index + 1;
                          const isErrorLine = agentConfigValidationError?.line === lineNumber;
                          return (
                            <span
                              key={lineNumber}
                              className={isErrorLine ? 'error' : ''}
                              title={isErrorLine ? t('JSON error on this line') : undefined}
                            >
                              {lineNumber}
                            </span>
                          );
                        })}
                      </div>
                      <textarea
                        ref={agentConfigTextareaRef}
                        className="agent-config-editor-textarea"
                        value={agentConfigEditor.content}
                        onChange={(event) => updateAgentConfigContent(event.target.value)}
                        onScroll={(event) => {
                          if (agentConfigLineNumbersRef.current) {
                            agentConfigLineNumbersRef.current.scrollTop = event.currentTarget.scrollTop;
                          }
                        }}
                        onKeyDown={(event) => {
                          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                            event.preventDefault();
                            void saveAgentConfig();
                          } else if (event.key === 'Escape') {
                            event.preventDefault();
                            closeAgentConfig();
                          }
                        }}
                        aria-invalid={!!agentConfigValidationError}
                        spellCheck={false}
                        autoFocus
                      />
                    </div>
                    {agentConfigValidationError ? (
                      <button
                        type="button"
                        className="agent-config-validation invalid"
                        onClick={focusAgentConfigError}
                        title={t('Jump to the JSON error')}
                      >
                        <strong>
                          {t('Line {line}, column {column}', { line: agentConfigValidationError.line, column: agentConfigValidationError.column })}
                        </strong>
                        <span>{agentConfigValidationError.message}</span>
                      </button>
                    ) : (
                      <div className="agent-config-validation valid">
                        {t('✓ Valid JSON · {n} lines', { n: agentConfigLines.length })}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
            <div className="agent-config-editor-actions">
              {agentConfigStatus && (
                <span className={agentConfigStatus === 'Saved' ? 'saved' : 'error'}>
                  {agentConfigStatus === 'Saved' ? t('Saved') : agentConfigStatus}
                </span>
              )}
              <button
                className="btn deny"
                onClick={formatAgentConfig}
                disabled={
                  agentConfigLoading ||
                  !!agentConfigEditor.error ||
                  !!agentConfigValidationError ||
                  agentConfigSaving
                }
                title={t('Format with two-space indentation')}
              >
                {t('Format JSON')}
              </button>
              <button className="btn deny" onClick={closeAgentConfig}>{t('Close')}</button>
              <button
                className="btn allow"
                onClick={() => void saveAgentConfig()}
                disabled={
                  agentConfigLoading ||
                  !!agentConfigEditor.error ||
                  !!agentConfigValidationError ||
                  agentConfigSaving ||
                  agentConfigEditor.content === agentConfigEditor.initialContent
                }
              >
                {agentConfigSaving ? t('Saving…') : t('Save')}
              </button>
            </div>
            </>) : (() => {
              const cat = kiroConfigCats.find((c) => c.id === agentConfigTab);
              /* key = 类别：换 tab 就换一个实例，上一个 tab 的草稿随之丢掉（关闭即丢弃那条规则） */
              return cat
                ? <KiroConfigPanel key={cat.id} sessionId={currentSessionId || undefined} category={cat} onClose={closeAgentConfig} />
                : null;
            })()}
          </div>
        </>,
        document.body,
      )}
      {engineConfigOpen && nonKiro && currentSessionId && createPortal(
        <>
          <div className="overlay" onClick={() => setEngineConfigOpen(false)} />
          <div className="agent-config-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="engine-config-title">
            <div className="settings-header">
              <div className="agent-config-editor-title">
                {engine === 'claude' ? <IconClaudeSpark size={17} /> : <IconCodexPrompt size={17} />}
                <h3 id="engine-config-title">{t('{engine} config', { engine: engineLabel })}</h3>
              </div>
              <button className="settings-close" onClick={() => setEngineConfigOpen(false)} aria-label={t('Close')}>✕</button>
            </div>
            <div className="kiro-config-tabs" role="tablist">
              {[{ id: 'login', label: t('🔑 Login') }, { id: 'mcp-combos', label: t('🧩 Combos') }, ...engineConfigCats].map((c) => (
                <button
                  key={c.id}
                  role="tab"
                  aria-selected={engineConfigTab === c.id}
                  className={`kiro-config-tab ${engineConfigTab === c.id ? 'active' : ''}`}
                  onClick={() => setEngineConfigTab(c.id)}
                >
                  {c.label}
                </button>
              ))}
            </div>
            {engineConfigTab === 'login'
              ? <EngineLoginPane sessionId={currentSessionId} tool={engine as 'claude' | 'codex'} />
              : engineConfigTab === 'mcp-combos'
              ? <McpCombosPane onClose={() => setEngineConfigOpen(false)} />
              : (() => {
                const cat = engineConfigCats.find((c) => c.id === engineConfigTab);
                return cat
                  ? <KiroConfigPanel key={cat.id} sessionId={currentSessionId} category={cat} onClose={() => setEngineConfigOpen(false)} />
                  : null;
              })()}
          </div>
        </>,
        document.body,
      )}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
    </PathSessionContext.Provider>
  );
};
