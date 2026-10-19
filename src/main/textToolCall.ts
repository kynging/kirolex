/**
 * **模型把工具调用写成了正文** ——「一直给我输出一些代码不干活」。
 *
 * 实测那条 CDE 会话（kiro-cli + claude-opus-5.5，远程）：9 条回复的末尾是一段
 * `<invoke name="use_aws"><parameter name="operation_name">send-command</parameter>…</invoke>`，
 * `toolCalls` 为 0、`stopReason=end_turn`，几秒就结束 —— 工具根本没执行，用户看到的是一段代码。
 * 追问「所以呢」它又照样写一遍；之后历史里这类「文字版调用」越攒越多，模型越学越像。
 *
 * 这里是纯逻辑（主进程和渲染端共用，不 import electron）：
 *   · `detectTextToolCall`：正文**末尾**有没有一段调用标记（代码块里的示例、行内提到的标签、后面还有正文的都不算）；
 *   · `textToolCallVerdict`：一轮结束时怎么处置 —— 补发一次纠正 / 纠正那一轮还这样就停下；
 *   · `foldTextToolCall`：重建历史 / 拼上下文时折叠成一句说明，不把整段标记原样喂回模型；
 *   · `splitTextToolCall`：界面上把标记块折叠起来、标「未执行」。
 */

/** 自动纠正那一条（发给模型，也作为 KiroLex 提示显示在会话里）。 */
export const TEXT_TOOL_NUDGE_PROMPT = '上一条把工具调用写成了文字，没有执行。请直接调用工具继续，不要在回复里写 invoke 标记。';

/** 纠正那一轮的用户消息 id 前缀 —— 一轮结束时据此认出「这是纠正那一轮」，它再犯就停下而不是再纠正。 */
export const TEXT_TOOL_NUDGE_ID_PREFIX = 'nudge_texttool_';

export function isTextToolNudgeId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(TEXT_TOOL_NUDGE_ID_PREFIX);
}

export interface TextToolCall {
  /** 标记块在传入文字里的起止（含前面那行孤零零的 `code` / 围栏行）。 */
  start: number;
  end: number;
  /** 想调用的工具（`invoke name=…`），按出现顺序去重；只写了 parameter 时为空。 */
  tools: string[];
}

/** 标记块后面最多还能跟多少字的收尾（「稍等。」之类）—— 再多就是正文（中文一句解释也就二三十字），标记在中间，不算。 */
const TRAIL_MAX = 24;

/** 调用标记：`<invoke` / `<function_calls` / `<parameter`，开或闭，可带一个命名空间前缀。 */
const TAG_RE = /<(\/?)(?:[a-z][\w-]*:)?(function_calls|invoke|parameter)(?=[\s>/])[^<>]*>?/gi;
/** 内容一开头就是调用标记（判「末尾那个代码块只装着标记」用）。 */
const STARTS_WITH_TAG_RE = /^<\/?(?:[a-z][\w-]*:)?(?:function_calls|invoke|parameter)(?=[\s>/])/i;
/** 标记块前面那一行：模型常在前面多吐一行 `code` / `xml`，或者是围栏的开头。 */
const LEAD_LINE_RE = /^[ \t]*(?:`{3,}[\w-]*|~{3,}[\w-]*|code|xml|html|tool_code|tool_use)[ \t]*$/i;
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;

/** 等长替换成空格（保住下标）。 */
const blank = (s: string) => s.replace(/[^\n]/g, ' ');

/**
 * 把「不算数」的地方涂掉：行内代码、代码块。只有一种代码块保留内容 ——
 * 它是整段回复的**最后一样东西**、而且里面一开头就是调用标记（模型把调用包进了围栏，不是在展示示例）。
 */
function maskExamples(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  let offset = 0;
  while (i < lines.length) {
    const m = FENCE_RE.exec(lines[i]);
    if (!m) { out.push(lines[i]); offset += lines[i].length + 1; i++; continue; }
    const fence = m[1];
    let j = i + 1;
    while (j < lines.length && !new RegExp(`^[ \\t]*${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*\\r?$`).test(lines[j])) j++;
    const closed = j < lines.length;
    const body = lines.slice(i + 1, closed ? j : lines.length);
    const blockLen = lines.slice(i, closed ? j + 1 : lines.length).join('\n').length;
    const after = text.slice(Math.min(text.length, offset + blockLen + 1));
    const terminal = !closed || after.trim().length <= TRAIL_MAX;
    const keep = terminal && STARTS_WITH_TAG_RE.test(body.join('\n').trim());
    out.push(blank(lines[i]));
    for (const b of body) out.push(keep ? b : blank(b));
    if (closed) out.push(blank(lines[j]));
    offset += blockLen + 1;
    i = closed ? j + 1 : lines.length;
  }
  return out.join('\n').replace(/`[^`\n]+`/g, (s) => blank(s));
}

/**
 * 标记块前后写明了是在**展示示例 / 格式**（「下面是工具调用格式的示例，仅供说明」「例如：」「仅供参考」）：那是讲解，不是没执行的调用。
 * 只看紧挨着的上下文（块前最后两行、块后那一小句），不看整段 —— 前文很早提过一次「格式」不能让真的伪调用漏掉。
 */
const EXAMPLE_RE = /示例|样例|范例|例子|举例|比如|例如|格式|长这样|如下所示|仅供|演示|示意|for example|e\.g\.|for instance|\bexamples?\b|\bsamples?\b|\bformat\b|looks like|illustrat/i;
function looksLikeExample(before: string, after: string): boolean {
  const lead = before.split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join('\n');
  return EXAMPLE_RE.test(lead) || EXAMPLE_RE.test(after);
}

/**
 * 正文**末尾**那段调用标记；没有就是 null。下标相对传入的 `text`。
 *
 * `from`：这一轮最后一次**真实**工具调用开始时正文的长度（主进程落盘时记在消息的 `toolTailFrom` 上）——
 * 只在它之后找。标记写在真实调用之前、之后没再写字的，那一轮其实干了活，不算（一轮结束时的判定、界面、历史折叠都用同一个口径）。
 */
export function detectTextToolCall(text: string, from = 0): TextToolCall | null {
  const full = String(text || '');
  const f = Math.min(full.length, Math.max(0, Number(from) || 0));
  const hit = detectInTail(full.slice(f));
  if (!hit) return null;
  const start = hit.start + f;
  const end = hit.end + f;
  if (looksLikeExample(full.slice(0, start), full.slice(end))) return null;
  return { start, end, tools: hit.tools };
}

function detectInTail(text: string): TextToolCall | null {
  const src = String(text || '');
  if (!src || !/<\/?(?:[a-z][\w-]*:)?(?:function_calls|invoke|parameter)\b/i.test(src)) return null;
  const masked = maskExamples(src);
  /* 顶层的标记块：从深度 0 的第一个开标签到回到深度 0 的那个闭标签；没闭合就到结尾 */
  const blocks: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let cur: { start: number; end: number } | null = null;
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(masked); m; m = TAG_RE.exec(masked)) {
    const closing = m[1] === '/';
    const tagEnd = m.index + m[0].length;
    if (!closing) {
      if (depth === 0) {
        /* 和上一块之间只有空白：同一串，接上 */
        const prev = blocks[blocks.length - 1];
        if (prev && !masked.slice(prev.end, m.index).trim()) { cur = prev; blocks.pop(); } else cur = { start: m.index, end: tagEnd };
      }
      if (/\/>$/.test(m[0])) { if (cur) cur.end = tagEnd; if (depth === 0 && cur) { blocks.push(cur); cur = null; } continue; }
      depth += 1;
      if (cur) cur.end = tagEnd;
    } else if (depth > 0) {
      depth -= 1;
      if (cur) cur.end = tagEnd;
      if (depth === 0 && cur) { blocks.push(cur); cur = null; }
    } else if (blocks.length) {
      /* 多出来的闭标签：并进上一块 */
      blocks[blocks.length - 1].end = tagEnd;
    }
  }
  if (cur) { cur.end = src.length; blocks.push(cur); }
  const last = blocks[blocks.length - 1];
  if (!last) return null;
  /* 末尾判据：块后面只剩一小句（围栏的收尾行已经被涂成空白） */
  if (masked.slice(last.end).trim().length > TRAIL_MAX) return null;
  /* 块里得真有一个开标签带 name=（`<parameter>` 这种裸词不算） */
  const inner = src.slice(last.start, last.end);
  if (!/<(?:[a-z][\w-]*:)?(?:invoke|parameter)\s+name\s*=/i.test(inner) && !/<(?:[a-z][\w-]*:)?function_calls\s*>/i.test(inner)) return null;
  const tools: string[] = [];
  for (const m of inner.matchAll(/<(?:[a-z][\w-]*:)?invoke\s+name\s*=\s*["']([^"']+)["']/gi)) {
    if (!tools.includes(m[1])) tools.push(m[1]);
  }
  /* 往前吃掉紧挨着的「code」/ 围栏开头那一两行 */
  let start = last.start;
  for (let k = 0; k < 2; k++) {
    const lineStart = src.lastIndexOf('\n', start - 1);
    if (lineStart < 0 || src.slice(lineStart + 1, start).trim()) {
      /* 标记前同一行还有字：不吃 */
      break;
    }
    const prevStart = src.lastIndexOf('\n', lineStart - 1) + 1;
    const prevLine = src.slice(prevStart, lineStart).replace(/\r$/, '');
    if (!LEAD_LINE_RE.test(prevLine)) break;
    start = prevStart;
  }
  /* 块后面紧跟的围栏收尾行也算块的一部分 */
  let end = last.end;
  const closeFence = /^[ \t]*\r?\n?[ \t]*(?:`{3,}|~{3,})[ \t]*(?=\r?\n|$)/.exec(src.slice(end));
  if (closeFence) end += closeFence[0].length;
  return { start, end, tools };
}

/** 折叠成的那句说明（喂给模型的历史里用）。 */
export function textToolCallNote(tools: string[]): string {
  return tools.length
    ? `（此处原本应调用工具 ${tools.join('、')}，但被写成了文字，未执行）`
    : '（此处原本应调用工具，但被写成了文字，未执行）';
}

/** 界面用：拆成前面的正文 / 标记块 / 后面那一小句。没有就是 null。 */
export function splitTextToolCall(text: string, from = 0): { before: string; markup: string; after: string; tools: string[] } | null {
  const hit = detectTextToolCall(text, from);
  if (!hit) return null;
  return {
    before: text.slice(0, hit.start).trimEnd(),
    markup: text.slice(hit.start, hit.end).trim(),
    after: text.slice(hit.end).trim(),
    tools: hit.tools,
  };
}

/** 历史用：把末尾那段文字版调用换成一句说明；没有就原样返回。 */
export function foldTextToolCall(text: string, from = 0): string {
  const s = splitTextToolCall(String(text ?? ''), from);
  if (!s) return text;
  return [s.before, textToolCallNote(s.tools), s.after].filter(Boolean).join('\n\n');
}

/**
 * 会话记忆用：把文字里**每一段**文字版调用块都去掉（不只末尾那段）。
 *
 * 会话记忆是压缩完永久留着、每一轮都注入的 —— 早先压进去的一段 `<invoke …>` 会一轮一轮喂回模型。
 * 记忆里不会有该保留的调用示例，所以这里不看代码块 / 「示例」上下文，凡是带 `name=` 的调用块都清；
 * 紧挨在前面那行孤零零的 `code` / 围栏行一起清，清完只剩列表符号的空行也去掉。
 */
export function stripTextToolCalls(text: string): string {
  const src = String(text ?? '');
  if (!/<\/?(?:[a-z][\w-]*:)?(?:function_calls|invoke|parameter)\b/i.test(src)) return src;
  const blocks: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let cur: { start: number; end: number } | null = null;
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(src); m; m = TAG_RE.exec(src)) {
    const tagEnd = m.index + m[0].length;
    if (m[1] !== '/') {
      if (depth === 0) cur = { start: m.index, end: tagEnd };
      if (/\/>$/.test(m[0])) { if (cur) cur.end = tagEnd; if (depth === 0 && cur) { blocks.push(cur); cur = null; } continue; }
      depth += 1;
      if (cur) cur.end = tagEnd;
    } else if (depth > 0) {
      depth -= 1;
      if (cur) cur.end = tagEnd;
      if (depth === 0 && cur) { blocks.push(cur); cur = null; }
    } else if (blocks.length) {
      blocks[blocks.length - 1].end = tagEnd;
    }
  }
  if (cur) { cur.end = src.length; blocks.push(cur); }
  /* 紧挨着块的前一行 `code` / 围栏开头、后一行围栏收尾（可带列表符号）一起清；离块远的围栏不碰 */
  const LEAD = /^[ \t]*(?:[-*•][ \t]*)?(?:`{3,}[\w-]*|~{3,}[\w-]*|code|xml|html|tool_code|tool_use)[ \t]*\r?$/i;
  const CLOSE = /^[ \t]*(?:[-*•][ \t]*)?(?:`{3,}|~{3,})[ \t]*\r?$/;
  let out = src;
  let removed = false;
  for (const b of blocks.reverse()) {
    const inner = src.slice(b.start, b.end);
    if (!/<(?:[a-z][\w-]*:)?(?:invoke|parameter)\s+name\s*=/i.test(inner) && !/<(?:[a-z][\w-]*:)?function_calls\s*>/i.test(inner)) continue;
    let start = b.start;
    const lineStart = src.lastIndexOf('\n', start - 1) + 1;
    /* 块前面这一行只有列表符号：整行算块的 */
    if (/^[ \t]*(?:[-*•][ \t]*)?$/.test(src.slice(lineStart, start))) {
      start = lineStart;
      if (lineStart > 0) {
        const prevStart = src.lastIndexOf('\n', lineStart - 2) + 1;
        if (LEAD.test(src.slice(prevStart, lineStart - 1))) start = prevStart;
      }
    }
    let end = b.end;
    const lineEnd = src.indexOf('\n', end);
    if (lineEnd >= 0 && !src.slice(end, lineEnd).trim()) {
      const nextEnd = src.indexOf('\n', lineEnd + 1);
      const nextLine = src.slice(lineEnd + 1, nextEnd < 0 ? src.length : nextEnd);
      end = CLOSE.test(nextLine) ? (nextEnd < 0 ? src.length : nextEnd) : lineEnd;
    }
    /* 块占满了整行：连换行一起去掉，不留空行 */
    if (start <= lineStart) {
      if (src[end] === '\n') end += 1;
      else if (start > 0 && end >= src.length) start -= 1;
    }
    out = out.slice(0, start) + out.slice(end);
    removed = true;
  }
  if (!removed) return src;
  return out
    .split('\n')
    .filter((line) => !(line.trim() && /^[ \t]*[-*•][ \t]*\r?$/.test(line)))   // 只剩列表符号的行
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type TextToolAction = 'none' | 'nudge' | 'stop';

/**
 * 一轮结束时怎么处置：
 *   · 只看 `end_turn`（被停止 / 出错 / 截断的不管 —— 那些有各自的提示）；
 *   · 只看**这一轮最后一次真实工具调用之后**的正文（`tailFrom` = 那一刻正文的长度）—— 标记之后又真调了工具，就不算没干活；
 *   · 普通一轮 → `nudge`（补发一次纠正）；纠正那一轮还这样 → `stop`（连续两轮，停下来在会话里说）。
 *     纠正那一轮永远不再纠正，所以不会自己跟自己循环。
 */
export function textToolCallVerdict(o: {
  stopReason: string;
  text: string;
  tailFrom?: number;
  correctionTurn: boolean;
  skip?: boolean;
}): { action: TextToolAction; hit?: TextToolCall } {
  if (o.skip || o.stopReason !== 'end_turn') return { action: 'none' };
  const hit = detectTextToolCall(String(o.text || ''), o.tailFrom || 0);
  if (!hit) return { action: 'none' };
  return { action: o.correctionTurn ? 'stop' : 'nudge', hit };
}
