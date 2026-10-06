import React, { useState } from 'react';

/**
 * 一块内容旁边那个「写点意见」的框 —— 侧栏文件预览（`ReviewPane`）用它。
 *
 * 从 feature/flow 搬过来：那边门上（`ResultTable`）和文件预览共用这一份；这边只有文件预览，
 * 但这几条约定照旧，下面那段"为什么要抽出来"是它在那边的来历。
 *
 * ## 为什么要抽出来
 *
 * 门上已经有过三份几乎一样的实现（`ResultTable` 里的 💬 意见、✎ 改正文、以及「＋ 加一段」）。
 * 分叉的代价是实测过的：加一段那份**忘了确认/取消**，只有一个浮在右上角压着文字的 ✕
 * —— 「按钮的位置不对也没有确认取消按钮」。同一个交互写第四遍，第四遍一定还会漏点什么。
 *
 * 所以这里定死四件事，任何用它的地方都一样：
 *   · **草稿态**：你打字不会立刻生效，`✓ 确认` 才提交 —— 半句话不该被当成意见
 *   · **有退路**：`取消` 回到上一次确认的内容；从来没确认过的取消就等于不写
 *   · **键位**：⌘/Ctrl+Enter 确认，Esc 取消（Enter 留给换行，这里常写整段）
 *   · **收起有摘要**：确认之后收成一行，点它重新打开 —— 只留一道竖线的话，你不点开就不知道自己写过什么
 */
export const CommentBox: React.FC<{
  /** 上一次确认的内容。空串 = 还没写过。 */
  value: string;
  onChange: (next: string) => void;
  /** 一进来就是打开的（刚点「＋」加出来的那种）。 */
  startOpen?: boolean;
  placeholder?: string;
  rows?: number;
  /** 摘要那一行前面那个小标记（`💬` / `＋` / `✎`）。 */
  mark?: string;
  /** 有这个就多一个「✕ 删掉」按钮 —— 加出来的块要能整块去掉。 */
  onRemove?: () => void;
  /** 折叠状态下显示的提示（没有内容时用不上）。 */
  title?: string;
  /**
   * 框关掉了（确认或取消都算）——**上层用它清掉"哪一块的框开着"**。
   *
   * 必须有：框现在可以由上层决定挂在**哪一行**（整节的意见挂在整节末尾），那时"开没开"是上层的状态，
   * 而取消只改这里面的 `open`。不通知上层的话，上层一直以为框开着 —— 于是 💬 和摘要都被挡住，
   * 那一块**再也点不开**（实测：「我取消了以后直接不能 comment 了」）。
   */
  onDismiss?: () => void;
  /**
   * **✓ 确认** —— 「提交一条直接让 AI 改这一句或这一段，改完更新」。
   *
   * 名字改成「✓ 确认」（「把直接改改为确认吧，不要叫什么直接改」）：现在这是**唯一**
   * 的出口，"直接改"是相对当年那条「攒起来整步重做」说的，而那条路已经没了 —— 没有对照的东西，
   * "直接"就只是个不说明任何事的形容词。你按的是"确认这条意见"，它当场生效。
   *
   * 和 `✓ 确认` 是两个出口，刻意都留着（用户定的）：
   *   `✓ 确认`   只把这条意见**记下来**（改不了单段的那种：要和别处合并、要新增段落、要查外部信息）
   *   `✓ 确认` 当场只改这一段：一次调用、用那一步自己的模型，别的段一个字节都不动
   *
   * 不给这个 prop 就只有 `✓ 确认`（文件预览那侧就是这样）。
   */
  onApply?: (text: string) => Promise<boolean> | void;
  /**
   * 正在改 —— **整个框收走**，由上层在那一块摆一行「改写中…」。
   *
   * 「改写提交了就显示改写中把其他的按钮和输入框都收走」。原来只是把确认按钮禁用改字，框和「取消」
   * 照旧摆着 —— 于是那十几秒里你还能接着往框里写字、还能按取消，而这两件事都没有意义：
   * 那条指令已经发出去了，取消撤不回来，接着写的字回来时会被 `setDraft('')` 清掉。
   * 一个点得动却什么都不做的界面，比一个明说"正在忙"的界面更难懂。
   */
  applying?: boolean;
  /**
   * 上一次「✓ 确认」**没成**的原因 —— 就地显示。
   *
   * 成功的那条不走这里：框会关掉（「直接改按钮不会关闭 comment 框，这个不对」），
   * 指令原话留在正文下面那行摘要上。这里只剩失败和"改不了这一段"——
   * 那两种情况框必须留着，否则你按了一下，正文没变而且没人告诉你为什么。
   */
  applyNote?: string;
  /**
   * 草稿由**上层拿着**（受控）—— 「其他句或段状态变化会打断正在修改的 comment，而且打断了之后
   * 之前写的东西没有保存」。
   *
   * 草稿原来是这个组件自己的 `useState`。这个框挂在别的块下面（整节的框挂在整节末尾），
   * 上层任何一次让它重挂载的重渲染都会把 `useState(value)` 重新跑一遍 —— 你正在写的字当场变回空，
   * 而且**没有任何地方留着它**。一次 comment 常常是一整句话，那不是"再打一遍"的量级。
   *
   * 提到上层之后：重挂载不影响它，关掉再点开还在，而且上层把它落进 run 的状态里（重启也在）。
   * 不传这两个就退回本地 state（文件预览那侧就是这样）。
   */
  draft?: string;
  onDraft?: (next: string) => void;
  /**
   * 有 `onApply` 时**也给「记下」** —— 侧栏 review 那侧要的。
   *
   * 门上把它删了（「那记一条有什么用啊」：那边记下的东西不会发给任何人）。侧栏不一样：记下的意见进
   * 底下那个「提交给这份文件的会话」，攒几条一起发 —— 那是一条真的出口，所以两个按钮都该在。
   * ⌘/Ctrl+Enter 一直是"记下"（不发模型）：一个快捷键不该悄悄花掉一次几十秒的改写。
   */
  allowRecord?: boolean;
}> = ({ value, onChange, startOpen = false, placeholder, rows = 5, mark = '💬', onRemove, title, onDismiss, onApply, applying, applyNote, draft: outerDraft, onDraft, allowRecord }) => {
  const [open, setOpen] = useState(startOpen);
  const [localDraft, setLocalDraft] = useState(value);
  const controlled = onDraft !== undefined;
  const draft = controlled ? String(outerDraft ?? '') : localDraft;
  const setDraft = (next: string) => { if (controlled) onDraft!(next); else setLocalDraft(next); };

  const commit = () => {
    const next = draft.trim();
    /*
      确认一个空框 = 不要这条。有 `onRemove` 的（加出来的块）整块去掉，否则退回"没写过"——
      留一个空意见会让"改了几处"这个数字虚高，而那个数字是你决定要不要提交的依据。
    */
    if (!next) {
      if (onRemove) { onRemove(); return; }
      onChange('');
      setOpen(false);
      onDismiss?.();
      return;
    }
    onChange(next);
    setOpen(false);
    onDismiss?.();
  };
  const cancel = () => {
    // 从来没确认过的（原值为空）取消就等于不写；确认过的退回上一次确认的内容
    if (!value.trim() && onRemove) { onRemove(); return; }
    setDraft(value);
    setOpen(false);
    /* 取消也要通知上层 —— 不通知的话上层以为还开着，那一块就再也点不开 */
    onDismiss?.();
  };

  /*
    改写中：这个框整个不渲染 —— 上层负责摆那行「改写中…」（门上是 `rt-block-lock`，
    侧栏是 `ReviewPane.lockRow`）。放在 `open` 判断之前，因为"正在改"比"框开着没开着"更要紧。
  */
  if (applying) return null;

  if (!open) {
    if (!value.trim()) return null;
    return (
      <button
        type="button"
        className="rt-note-brief nopan nodrag"
        title={title || value}
        onClick={(e) => { e.stopPropagation(); setDraft(value); setOpen(true); }}
      >
        <span className="rt-note-brief-mark">{mark}</span>
        <span className="rt-note-brief-text">{value.replace(/\s+/g, ' ').trim()}</span>
      </button>
    );
  }

  return (
    <div className="rt-note-box" onClick={(e) => e.stopPropagation()}>
      <textarea
        className="rt-note"
        rows={rows}
        autoFocus
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancel();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit();
        }}
      />
      {/* 没改成的原因 —— 那时框留着，所以必须就地说出来（改成了的话框已经关了） */}
      {applyNote && <div className="rt-note-applied">{applyNote}</div>}
      <div className="rt-note-actions">
        {/*
          **✓ 确认**排在最前面：它是这个框现在最常用的出口（「提交一条直接让 AI 改这一句或这一段」）。
          按下去之后这个框整个收走（见上面的 `applying`）—— 同一段不会被点两次，也不用禁用什么。
        */}
        {onApply && (
          <button
            type="button"
            className="rt-note-apply nopan nodrag"
            disabled={!draft.trim()}
            title="确认这条意见 —— 让打开这份文件的那条会话按它改这一块（改不了单块时自动按整份改），KiroLex 写回文件、当场更新"
            onClick={() => {
              const next = draft.trim();
              if (!next) return;
              /*
                **成功了清草稿**（框由上层关掉，见 `ResultTable` 的 `setNoteOpenAt(null)`）。
                清草稿是必须的：那条指令已经执行完了，留在框里下一次会被再发一遍
                （于是同一处改两遍，第二遍是对着已经改过的文本执行同一条指令）。
                失败/改不了时**保留草稿、框也留着** —— 那条话还没起作用，让你改措辞再试，
                而不是重新打一遍。
              */
              void Promise.resolve(onApply(next)).then((ok) => { if (ok) setDraft(''); });
            }}
          >✓ 确认</button>
        )}
        {/*
          **第二个按钮：记下（不改）**。

          门上把它删了（「那记一条有什么用啊」）—— 那边记下的东西不会发给任何人，只是一个让人以为提交了
          什么的按钮。侧栏 review 不一样：记下的意见进最底下的「提交给这份文件的会话」，攒几条一起发，
          所以那边传 `allowRecord`，两个按钮都在：「✓ 确认」当场改这一块，「记下」先攒着。

          两个都在时它叫「记下」而不是「✓ 确认」—— 同一个框里两个一样名字的按钮做的是两件事，没法选。
          没有 `onApply` 的那种（没有归属会话）照旧只有它，叫「✓ 确认」。
        */}
        {(!onApply || allowRecord) && (
          <button type="button" className="rt-note-ok nopan nodrag"
            title={onApply ? '只记下这条意见，不改文件 —— 和别的意见一起从最下面「提交」（⌘/Ctrl + Enter）' : '记下来并收起（⌘/Ctrl + Enter）'}
            onClick={commit}>{onApply ? '记下' : '✓ 确认'}</button>
        )}
        <button type="button" className="rt-note-cancel nopan nodrag"
          title="丢掉刚写的（Esc）" onClick={cancel}>取消</button>
        {onRemove && (
          <button type="button" className="rt-note-cancel nopan nodrag"
            title="整块去掉" onClick={onRemove}>✕ 删掉</button>
        )}
      </div>
    </div>
  );
};

/**
 * 展开这个框的入口按钮。
 *
 * `active` = 这一行**已经写过意见**。写过之后按钮变亮，意见原文进 `title` ——
 * 这样一行有没有意见看一眼就知道，而**行高一点没变**。
 *
 * 「不要让 comment 增加行距，这样看起来效果很差」：折叠态如果渲染成一行摘要（门上那种
 * `rt-note-brief`），每条意见都会把正文推开一行。门上那样是对的 —— 那儿一"块"是一整段，多一行摘要
 * 不显眼；而这里一块就是**一行**，多一行等于把行距翻倍，一份文档批注几处就散了。
 */
export const CommentOpener: React.FC<{
  onClick: () => void; title?: string; mark?: string; active?: boolean;
}> = ({ onClick, title, mark = '💬', active }) => (
  <button
    type="button"
    /* 和门上那个 💬 同一个类 —— 位置（absolute right:0）、淡到不抢眼、hover 才亮，全都一样 */
    className={`rt-note-btn nopan nodrag${active ? ' has-note' : ''}`}
    title={title || '写点意见'}
    onClick={(e) => { e.stopPropagation(); onClick(); }}
  >{mark}</button>
);
