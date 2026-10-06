import React, { useCallback, useMemo, useRef, useState } from 'react';
import { CommentBox, CommentOpener } from './CommentBox';
import { lineBlocks, reviewPrompt, dropSpan, displayGroups, mdLine, spanRange, sliceLines, spliceLines, type ReviewBlock } from '../reviewBlocks';
import { rewritePatch } from '../rewritePatch';
import { MarkdownView } from './ChatArea';

/**
 * 看一个文本 / Markdown 文件，并**逐行（逐块）提意见** ——「像门一样增加一个评论然后提交修改」。
 *
 * 从 feature/flow 搬过来，**只搬了文本那一侧**：那边同一个 pane 还管 `.pptx` / `.pdf`（pdf.js 画页、
 * LibreOffice 转 PDF、按 run 地址改幻灯片文字、逐页改备注），那一半要新依赖（`pdfjs-dist`）和一整套
 * deck 的主进程管线，没有跟着搬。
 *
 * ## 两个出口
 *
 *   · **逐块「✓ 确认」** —— 这条意见当场发给**打开这份文件的那条会话**（文件往往是它刚做出来的，上下文
 *     全在它那儿），它只回改完的那一块（改不了单块时再要整份），KiroLex 拼回整份、写回文件
 *     （`reviewWriteFile`，写前备份）。见 `applyOne`。
 *   · **「提交给这份文件的会话」** —— 「记下」的那些意见 + ✕ 掉的块 + 其他意见，拼成**一条普通用户消息**
 *     （`reviewPrompt`）发过去，由那条会话自己去改文件。普通消息而不是隐藏指令：它进 transcript、模型有
 *     全部上下文、你也看得见发出去的是什么。
 */
export const ReviewPane: React.FC<{
  path: string;
  /** 文件正文。按**行**切块在 `lineBlocks` 里做。 */
  text: string;
  /** 文件名像不像 Markdown —— 是就逐行渲染成 Markdown，否则 `<pre>` 原文。 */
  markdown?: boolean;
  /**
   * 提交 —— 接到**打开这份文件那条会话**的 `sendMessage` 上（不是此刻选中的那条）。
   *
   * 「是不是应该给这个 tab 记录它是从哪个会话打开的，就从这个会话提交更改」：那条会话才见过这份文件。
   * 没有主人时不传，按钮会禁用并说明原因 —— 与其乱发，不如说清没地方发。
   */
  onSubmit?: (prompt: string) => void;
  /** 在不在 comment 模式。默认关 —— 大多数时候你只是想看一眼。 */
  commenting?: boolean;
  /**
   * 这个标签页的**主人会话** —— 「✓ 确认」就在它里面改，写回也以它的名义（路径按它解析、白名单按它查）。
   * 不传就没有「✓ 确认」这条出口，只剩「记下」+ 提交（而提交也会禁用）。
   */
  sessionId?: string;
  /**
   * 改完写回文件之后通知上层，把新正文交回去 —— 否则你看的还是旧那份（监听也会刷，但那要等一拍）。
   *
   * 落盘由 KiroLex 做（`reviewWriteFile`），不让那条会话自己动文件：两个写者对同一个文件
   * 要么改两遍要么互相覆盖。
   */
  onRewritten?: (text: string) => void;
}> = ({ path, text, markdown, onSubmit, commenting, sessionId, onRewritten }) => {
  const [comments, setComments] = useState<Record<number, string>>({});
  const [dropped, setDropped] = useState<Record<number, true>>({});
  /** 哪一块的框开着。 */
  const [openAt, setOpenAt] = useState<number | null>(null);
  /**
   * 正在写的那份草稿 —— **这一层拿着，不落盘**。
   *
   * 草稿原来是 `CommentBox` 自己的 `useState(value)`，而这个框挂在**别的行**下面（整节的框挂在整节末尾），
   * 上层任何一次让它重挂载的重渲染都会把那句 `useState` 重跑一遍 —— 正在写的字当场变回空
   * （「打断了之后之前写的东西没有保存」）。提上来之后重渲染、关掉再点开都还在。键是锚点行号。
   */
  const [draftLive, setDraftLive] = useState<Record<string, string>>({});
  const draftOf = (key: string, fallback: string) => draftLive[key] ?? fallback;
  const typeDraft = (key: string, next: string) => setDraftLive((cur) => ({ ...cur, [key]: next }));
  const clearDraft = (key: string) => setDraftLive((cur) => { const n = { ...cur }; delete n[key]; return n; });
  /**
   * 鼠标停在哪一块上 —— **给"标题带整段"做动手前的预览**：✕ 一个标题可能带走十几行，那不可逆，
   * 范围必须在点之前就看得见。纯 CSS 做不到：一行亮不亮取决于"盖住它的那个锚点是不是正被 hover"。
   */
  const [hoverAt, setHoverAt] = useState<number | null>(null);
  /** 刚提交过 —— 显示一句确认，而不是让界面**看起来毫无变化**（否则你会再点一次）。 */
  const [justSent, setJustSent] = useState(false);
  /** 提交前那次备份没成 —— 说出来，因为接下来是会话自己改文件，改坏了没有副本。 */
  const [backupWarn, setBackupWarn] = useState('');
  /**
   * **其他意见：一个框，边打边算，不用确认** ——「其他意见改成直接提交，不要再走确认了，没有必要」。
   * 一行一条（空行跳过）。这里的意见不挂任何东西，唯一的出口就是下面那个提交按钮。
   */
  const [extraText, setExtraText] = useState('');
  const extra = useMemo(
    () => extraText.split('\n').map((t) => t.trim()).filter(Boolean),
    [extraText],
  );

  const blocks: ReviewBlock[] = useMemo(() => lineBlocks(text), [text]);
  /**
   * 显示用的分组 —— **围栏里的行合成一块**。见 `displayGroups`：不合的话每一行都单独渲染成 Markdown，
   * 一个代码块被撕成 N 个，而 ``` 那两行渲染出来是空的 `<pre>` —— 那就是「黑色空行」。
   */
  const groups = useMemo(() => displayGroups(blocks), [blocks]);
  /**
   * 锚点 → 它实际覆盖的行号。**代码围栏**（那一整段代码）、**标题**（它下面整节）、**列表项**（它的子项）
   * 会超过一行 ——「comment 的是标题的话应该视为整段」，所以它们进这张表，提示词里写成范围。
   */
  const spans = useMemo(() => {
    const out: Record<number, number[]> = {};
    for (const g of groups) {
      const span = g.span.length > 1 ? g.span : dropSpan(blocks, g.anchor);
      if (span.length > 1) out[g.anchor] = span;
    }
    return out;
  }, [groups, blocks]);
  /** 行号 → 是**哪一行**把它盖住的（最内层那个）—— 被盖住的行跟着画出"属于这一节"。 */
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
  /** 正在改写哪一块（锚点）。那期间那一块（标题连整节）不接受任何处置。 */
  const [applyingAt, setApplyingAt] = useState<number | null>(null);
  /**
   * **同一份文件的改写一条一条来**。每次改写都是"读这份文件 → 问模型（几十秒）→ 写回去"；两条重叠的话
   * 后写的那次基于**它自己开始时读到的那一版**，先落盘的那次就被静默盖掉。主进程那道队列只管"问模型"，
   * 管不到这里的拼接和写盘，所以这里按这一份文件把整段 读→问→写 串起来。
   */
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  const serialize = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    /* 前一个不管成没成都接着跑 —— 一次失败不该把后面排着的都堵死 */
    const next = chainRef.current.then(job, job);
    chainRef.current = next.catch(() => {});
    return next;
  }, []);
  /**
   * **排队的那一条要读到前一条写完之后的正文**，而不是它被点下去那一刻的 —— 所以正文和块都走一个 ref，
   * 每次真正开跑时再取。拿闭包里那份的话，第二条会对着旧文拼接，把第一条的改动整个盖掉。
   */
  const textRef = useRef(text);
  textRef.current = text;
  /** 上一次改写**没改成的原因**，按锚点记。 */
  const [applyNote, setApplyNote] = useState<Record<string, string>>({});
  /** 有哪个**别的**锚点带着这一行、而且它被标了删 / 写了意见（多级标题下可能有好几层） */
  const outerState = useCallback((line: number) => {
    let anyDropped = false;
    let anyNoted = false;
    for (const key of Object.keys(spans)) {
      const anchor = Number(key);
      if (anchor === line || !(spans[anchor] || []).includes(line)) continue;
      if (dropped[anchor]) anyDropped = true;
      if (comments[anchor]) anyNoted = true;
    }
    return { anyDropped, anyNoted };
  }, [spans, dropped, comments]);
  const unit = '行';
  const on = !!commenting;
  const prompt = reviewPrompt({ path, blocks, comments, dropped, extra, spans });

  /**
   * **确认一条就当场改完并写回文件** ——「1 听起来更好？」。
   *
   * 攒起来一次提交那条路的问题是：你不知道它到底改了没有、改的是不是你说的那处，而两批意见落在同一份
   * 文件上时它也不知道该按哪一批。所以这里：这条意见连同"它指的那一处"发给打开这份文件的那条会话，
   * 先只要**这一块**（快），它回 `CANNOT-REVISE-LOCALLY` 才要整份（加段/删段/挪位置），落盘由 KiroLex
   * 统一做 —— 提示词里明确禁止它自己动文件，否则两个写者互相覆盖。
   *
   * 改完之后**剩下那些意见要跟着它们那一行走**（`rewritePatch(...).keep`：旧行号 → 新行号），
   * 对不上的（它评的那行被改掉/删掉了）就丢掉 —— 它说的东西已经不在了。
   */
  const applyOne = async (anchor: number, instruction: string): Promise<boolean> => {
    if (!sessionId) return false;
    setApplyingAt(anchor);
    setApplyNote((cur) => ({ ...cur, [String(anchor)]: '' }));
    /* 排到这份文件的队尾 —— 读→问→写 中间不许插进另一次改写（见 `serialize`） */
    return serialize(async () => {
      try {
        const base = textRef.current;
        const baseBlocks = lineBlocks(base);
        /*
          这一块在**此刻**的文件里占哪一段：前一条改写可能已经挪动了行号，所以按锚点那一行的原文去对 ——
          对不上（那一行已经被前一条改掉了）就不改，说清楚，而不是改错地方。
        */
        const anchorText = blocks.find((b) => b.index === anchor)?.text;
        const stillThere = baseBlocks.find((b) => b.index === anchor)?.text === anchorText;
        if (!stillThere) {
          setApplyNote((cur) => ({ ...cur, [String(anchor)]: '这一处在前一条改写里已经变了 —— 看一眼新的正文，再对它提一次' }));
          return false;
        }
        const span = (() => {
          const g = displayGroups(baseBlocks).find((x) => x.anchor === anchor);
          return g && g.span.length > 1 ? g.span : dropSpan(baseBlocks, anchor);
        })();
        /* 按闭区间取原文、按闭区间换回去 —— 段落之间的空行照带（见 `spanRange`） */
        const { from, to } = spanRange(span);
        const where = sliceLines(base, from, to);
        const about = path;
        /* 位置写进显示文本：整节写范围，单行写行号 —— 回头翻会话要看得出说的是哪儿 */
        const name = path.split(/[\\/]/).pop() || path;
        const label = from !== to ? `${name} 第 ${from}–${to} ${unit}` : `${name} 第 ${from} ${unit}`;
        let res: any = await window.kiroApi.reviseInSession?.({
          sessionId, where, note: instruction, about, label, scope: 'block',
        });
        let gotWhole = false;
        if (res?.cannot) {
          setApplyNote((cur) => ({ ...cur, [String(anchor)]: '这条改不了单独一块 —— 正在按整份重改…' }));
          res = await window.kiroApi.reviseInSession?.({
            sessionId, where, note: instruction, about, label: `${label}（整份）`, scope: 'whole',
            /* 整份重改以**盘上此刻**这一份为基准，不让它照自己记得的旧版重写 */
            full: base,
          });
          gotWhole = true;
        }
        if (!res?.ok || typeof res.text !== 'string') {
          setApplyNote((cur) => ({
            ...cur,
            [String(anchor)]: res?.cannot
              ? `改不了：${res.cannot} —— 换个说法再试，或者「记下」它，从下面「提交」交给会话自己动手`
              : `改写失败：${res?.error || '没有返回'}`,
          }));
          return false;
        }
        /* 只回了这一块（快的那一档）时，先把它拼回整份 —— 写盘要的是完整正文 */
        const fullText = gotWhole ? String(res.text) : spliceLines(base, from, to, String(res.text));
        const wrote: any = await window.kiroApi.reviewWriteFile?.(sessionId, path, fullText);
        if (!wrote?.ok) {
          setApplyNote((cur) => ({ ...cur, [String(anchor)]: `写不进这个文件：${wrote?.error || '未知原因'}` }));
          return false;
        }
        /* 剩下那些意见按 `keep` 重新对位；对不上的就丢掉 */
        const patch = rewritePatch(baseBlocks.map((b) => ({ index: b.index, text: b.text })), fullText);
        const remap = <V,>(map: Record<number, V>): Record<number, V> => {
          const out: Record<number, V> = {};
          for (const [k, v] of Object.entries(map)) {
            const fromLine = Number(k);
            if (fromLine === anchor) continue;                 // 这一条已经生效了
            const toLine = patch.keep[fromLine];
            if (toLine) out[toLine] = v;
          }
          return out;
        };
        setComments((cur) => remap(cur));
        setDropped((cur) => remap(cur));
        setDraftLive((cur) => {
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(cur)) {
            const toLine = Number(k) === anchor ? 0 : patch.keep[Number(k)];
            if (toLine) out[String(toLine)] = v;
          }
          return out;
        });
        setApplyNote({});
        /*
          在会话里报一句 ——「不然不知道修改成功了没有」。报的是**已经发生的事实**（写进了哪个文件、
          多少字），而不是让模型说一句它看不见的"已修改"。这句标成 KiroLex 自己说的话，不发给模型。
        */
        void window.kiroApi.sessionNote?.(
          sessionId,
          `✅ 已写回这份文件（${fullText.length} 字）\n文件：${path}\n`
          + 'KiroLex 落盘完成（写前已备份到 ~/.kirolex/backups/review-files/）。',
        );
        textRef.current = fullText;
        setOpenAt(null);
        onRewritten?.(fullText);
        return true;
      } finally {
        setApplyingAt(null);
      }
    });
  };

  /**
   * 一块的按钮 —— 和它的**输入框分开**。
   *
   * 「在填写 comment 的时候也应该在整段下面」：标题上的意见管的是整节，所以框要出现在**整节的末尾**，
   * 而不是紧贴标题那一行。按钮留在标题上（那是你点的地方），框由 `noteBoxFor` 渲染到整节最后一行下面。
   */
  const tools = (block: ReviewBlock, groupSpan?: number[]) => {
    const gone = !!dropped[block.index];
    const said = comments[block.index] || '';
    const open = openAt === block.index;
    /**
     * ✕ 这一块实际会删掉哪些 —— 标题连整节；**代码围栏连它自己那几行**。只删围栏开头那一行的话，
     * 剩下的代码会散在文档里，而模型拿到的是"删掉第 12 行"，照做之后文档就坏了。
     */
    const span = groupSpan && groupSpan.length > 1 ? groupSpan : dropSpan(blocks, block.index);
    return (
      <div className="rv-review-tools">
        {!gone && !open && (
          <CommentOpener
            onClick={() => setOpenAt(block.index)}
            active={!!said}
            title={(() => {
              const where = span.length > 1
                ? `第 ${span[0]}–${span[span.length - 1]} ${unit}（这一整节）`
                : `第 ${block.index} ${unit}`;
              return said ? `${where}的意见：${said}` : `对${where}提意见`;
            })()}
          />
        )}
        <button
          type="button"
          className={`rt-block-drop${gone ? ' on' : ''} nopan nodrag`}
          title={gone ? '不删了'
            : span.length > 1 ? `删掉这一块和它带着的整节（第 ${span[0]}–${span[span.length - 1]} ${unit}）—— 提交时一起发给会话`
            : `这一${unit}删掉 —— 提交时一起发给会话`}
          onClick={() => setDropped((cur) => {
            const next = { ...cur };
            for (const at of span) { if (gone) delete next[at]; else next[at] = true; }
            return next;
          })}
        >{gone ? '↩' : '✕'}</button>
      </div>
    );
  };

  /**
   * 该在**这一行下面**渲染输入框吗 —— 框渲染在打开的那个锚点**覆盖的最后一行**下面：
   * 普通行就是它自己，标题就是整节的末尾。于是你写的时候看得见自己在评的是哪一段。
   */
  const noteBoxFor = (line: number) => {
    if (openAt === null) return null;
    /* 改写中连框的壳一起收走 —— 那一行「改写中…」由 `lockRow` 摆 */
    if (applyingAt === openAt) return null;
    const anchor = openAt;
    const span = spans[anchor];
    const last = span && span.length > 1 ? span[span.length - 1] : anchor;
    if (last !== line) return null;
    const said = comments[anchor] || '';
    return (
      <div className="rv-note-slot">
        <CommentBox
          value={said}
          draft={draftOf(String(anchor), said)}
          onDraft={(next) => typeDraft(String(anchor), next)}
          startOpen
          /* 对着一行写的意见通常是一句话 —— 不要一个突然出现的大方块 */
          rows={2}
          placeholder={span && span.length > 1
            ? `对第 ${span[0]}–${span[span.length - 1]} ${unit}（这一整节）的意见`
            : `对第 ${anchor} ${unit}的意见`}
          /* 确认 = 当场改完并写回文件（`applyOne`）。没有归属会话时不给这个出口 */
          onApply={sessionId ? (instruction) => applyOne(anchor, instruction) : undefined}
          /* 「记下」= 先攒着，从最下面一起提交（那是一条真出口，所以和「✓ 确认」并排） */
          allowRecord
          applying={applyingAt === anchor}
          applyNote={applyNote[String(anchor)] || ''}
          onChange={(next) => {
            setComments((cur) => {
              const c = { ...cur };
              if (next) c[anchor] = next; else delete c[anchor];
              return c;
            });
            clearDraft(String(anchor));
            setOpenAt(null);
          }}
          /* 取消也要清掉 —— 不清的话上层以为框还开着，这一块再也点不开。草稿留着（下次点开还是那句话） */
          onDismiss={() => setOpenAt(null)}
        />
      </div>
    );
  };

  /**
   * 正在改写的那一块 —— 收走它自己的入口和输入框，只留一行「改写中…」。一次改写实测十几秒，
   * 这中间点得动却什么都不做的控件，比一个明说"正在忙"的界面更难懂。
   */
  const lockRow = () => <div className="rt-block-lock" aria-live="polite">改写中…（在那条会话里改，改完自动写回）</div>;
  /** 锁住的行 —— **整节一起锁**：标题那条意见改的是整节，节内任何一行都不能同时被处置。 */
  const lockedLines = new Set<number>(applyingAt === null ? [] : (spans[applyingAt] || [applyingAt]));
  /** 那行「改写中…」摆在锁住这一节的**末行** —— 和它的输入框原来在的位置同一处。 */
  const lockHost = applyingAt === null ? null
    : (spans[applyingAt] && spans[applyingAt].length > 1
      ? spans[applyingAt][spans[applyingAt].length - 1]
      : applyingAt);

  return (
    <div className="rv-review">
      <ol className="rv-review-blocks">
        {groups.map((g) => {
          /*
            这一行是被别人（标题/围栏/列表项）盖住的吗。**只有当那个锚点真的被动过**，这一行才"跟着整节走"——
            不是"在某个标题下面"就算（那样几乎每一行都会被判成 in-section，整份文档一个 💬 都没有）。
          */
          const owner = coveredBy.get(g.anchor);
          const { anyDropped: sectionDropped, anyNoted: sectionNoted } = outerState(g.anchor);
          const inSection = sectionDropped || sectionNoted;
          /*
            预览：hover 那个"带整段"的锚点时整段亮。**框开着时也算** —— 鼠标一进框里 hover 就没了，
            写的时候整段必须一直亮着，否则那个框看着像是在评最后那一行。
          */
          const highlightAnchor = openAt ?? hoverAt;
          const previewing = covers(highlightAnchor, g.anchor)
            && (highlightAnchor === g.anchor || (spans[highlightAnchor!]?.length || 0) > 1);
          const ownsSection = (spans[g.anchor]?.length || 0) > 1;
          return (
            <li
              key={g.anchor}
              onMouseEnter={() => setHoverAt(g.anchor)}
              onMouseLeave={() => setHoverAt((cur) => (cur === g.anchor ? null : cur))}
              className={`rv-review-block${dropped[g.anchor] || sectionDropped ? ' dropped' : ''}`
                /* 写过意见的块要一直看得出来 —— 竖线不占高度，「comment 不许增加行距」仍然成立 */
                + `${comments[g.anchor] ? ' noted' : ''}`
                + `${inSection ? ' in-section' : ''}${sectionNoted ? ' section-noted' : ''}`
                + `${sectionDropped ? ' section-dropped' : ''}`
                + `${on && previewing && (ownsSection || owner !== undefined) ? ' section-preview' : ''}`
                + `${ownsSection ? ' section-head' : ''}`
                + `${lockedLines.has(g.anchor) ? ' locked' : ''}`}
            >
              {/*
                **不显示行号** ——「不要显示什么段落号」。号只用来拼提示词，它对读没有帮助。
                Markdown 逐行渲染时**先摘掉缩进**（`mdLine`）：单独看一行，`    - 三级` 会被 CommonMark 当成
                代码块。缩进用 padding 还原。围栏组不摘：它本来就该是代码。
              */}
              {markdown
                ? (() => {
                  const { md, indent } = g.fenced ? { md: g.text, indent: 0 } : mdLine(g.text);
                  return (
                    <div className="rv-review-md" style={indent ? { paddingLeft: indent * 4 } : undefined}>
                      <MarkdownView content={md} />
                    </div>
                  );
                })()
                : <pre className="rv-review-text">{g.text}</pre>}
              {/* 这一节被**标了删**时才收掉这一行的按钮 —— 它要走了，对它单独提意见会和上面那条打架 */}
              {on && !sectionDropped && !lockedLines.has(g.anchor)
                && tools({ kind: 'line', index: g.anchor, text: g.text, ...(g.fenced ? { fenced: true as const } : null) }, g.span)}
              {/*
                **记下的那条意见摆出来，带修改和删除**。只有写过意见的行多这一行 —— 没写过的照旧一行一行贴着。
                点意见本身 = 改它；`✕` 直接删掉这条，不用先点开框。
              */}
              {on && !!comments[g.anchor] && !lockedLines.has(g.anchor) && openAt !== g.anchor && (
                <div className="rt-brief-row">
                  <span className="rt-hist-one">
                    <button type="button" className="rt-note-brief nopan nodrag"
                      title="修改这条意见"
                      onClick={() => setOpenAt(g.anchor)}>
                      <span className="rt-note-brief-mark">💬</span>
                      <span className="rt-note-brief-text">
                        {String(comments[g.anchor] || '').replace(/\s+/g, ' ').trim()}
                      </span>
                    </button>
                    <button type="button" className="rt-hist-btn nopan nodrag"
                      title="修改"
                      onClick={() => setOpenAt(g.anchor)}>✎</button>
                    <button type="button" className="rt-hist-btn rt-hist-del nopan nodrag"
                      title="删除这条意见"
                      onClick={() => {
                        setComments((cur) => { const c = { ...cur }; delete c[g.anchor]; return c; });
                        clearDraft(String(g.anchor));
                      }}>✕</button>
                  </span>
                </div>
              )}
              {/* 整节的意见写在整节末尾 —— 见 `noteBoxFor`。改写中那里换成一行「改写中…」 */}
              {lockedLines.has(g.anchor) && lockHost === g.anchor && lockRow()}
              {on && noteBoxFor(g.anchor)}
            </li>
          );
        })}
      </ol>
      {on && (
        <div className="rv-review-adds">
          {/* 一行一条，写完就算 —— 不用确认，也没有「＋」（换行就是加一条） */}
          <textarea
            className="rt-note rv-review-adds-input"
            rows={2}
            value={extraText}
            onChange={(e) => setExtraText(e.target.value)}
            placeholder={`其他意见 —— 落不到某一${unit}上的那些（整体口径、结构、缺了什么）；一行一条`}
          />
        </div>
      )}
      {on && (
        <div className="rv-review-submit">
          {justSent && !prompt && (
            <p className="rv-review-sent">已发给这份文件的会话 —— 去那条会话里看它怎么改。</p>
          )}
          {backupWarn && <p className="rv-review-warn">提交前没能备份这份文件（{backupWarn}）—— 会话改坏了没有副本可回滚。</p>}
          <button
            type="button"
            className="rv-gate-pass"
            disabled={!prompt || !onSubmit}
            title={!onSubmit ? '这个标签页没有归属会话（不是从某条会话里打开的）—— 没地方发'
              : !prompt
                ? '还没有攒下待提交的意见（「✓ 确认」的那些当场就改了，不进这里；「记下」的、✕ 掉的、其他意见才进）'
                : '把记下的意见、删掉的块和其他意见拼成一条消息，发给打开这份文件的那条会话，由它改这个文件'}
            onClick={() => {
              if (!prompt || !onSubmit) return;
              /*
                **先备份，再发** —— 这条路是**会话自己写这个文件**，走不到 `reviewWriteFile` 那道「写前拷一份」。
                备在发之前：文件在它落笔前一个字节都没变。备份失败照旧发（只是少一份保险），但要说出来。
              */
              void window.kiroApi.reviewBackupFile?.(sessionId, path).then((res: any) => {
                if (!res?.ok) setBackupWarn(String(res?.error || '没能备份'));
                else setBackupWarn('');
              });
              onSubmit(prompt);
              /* 提交完就清空 —— 那些意见已经发出去了，留着只会在下一批里再发一遍 */
              setComments({}); setDropped({}); setExtraText(''); setOpenAt(null); setDraftLive({});
              setJustSent(true);
              window.setTimeout(() => setJustSent(false), 4000);
            }}
          >提交给这份文件的会话</button>
        </div>
      )}
    </div>
  );
};
