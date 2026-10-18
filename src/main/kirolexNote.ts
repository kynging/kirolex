/**
 * **KiroLex 自己说的话，和你说的话，是两回事** ——「这他妈什么玩意，为什么按照会话发出去了」。
 *
 * KiroLex 会在会话里插一些对**你**说的话（换了后端会话、退到了备用模型、排队了…）。它们以
 * `role: 'user'` 落进 transcript，于是每一条喂给模型的东西都会把它们当成你的指令带过去 ——
 * 实测模型真的照着答过：「收到，知道了——这轮是 gpt-5.6-sol」。
 *
 * ## 为什么这个判据必须是**共享的一处**
 *
 * 第一次修的时候判据写在 `src/main/index.ts` 里，只接在当时想到的三条路上
 * （ride-along 快照、`history.md`、逐段重建）。结果今天的日志里它又出去了：
 *
 * ```
 * [suggestions] ... Based on the conversation below ...
 * User: ⚠️ 这条会话现在跑在 gpt-5.6-sol 上 —— 你选的 claude-opus-5 这次起不来…
 * ```
 *
 * 漏的是另外两条：**追问建议**（渲染进程自己攒的对话摘要）和**会话记忆压缩**。后者更糟 ——
 * 它把这句话压进 memory，然后每一轮都注入一次，一句临时通知就变成了永久上下文。
 *
 * 所以判据搬到这里：主进程和渲染进程 import 同一个函数（放在 `src/main` 下是因为 `tsconfig.main.json` 的
 * `rootDir` 就是它 —— 而这个模块是纯的，渲染进程照样能直接 import，项目里已经有几处这样的先例）。散在两处的"同一个判断"就是这次漏掉的原因。
 */

/**
 * 标记之前写下的那些通知按固定开头认出来。
 *
 * 判据要**窄**：不能写成"以 emoji 开头就算"—— 那会吃掉你自己写的「⚠️ 这个接口别动」。
 * 宁可漏掉一条旧噪音，不能吃掉你说的话。
 */
export const KIROLEX_NOTE_OPENINGS = [
  '♻️ 后端连着',
  '♻️ 这条会话的后端会话 id',
  '⚠️ 这条会话现在跑在',
  '⏳ 已排队：',
  '🔀 后端连着',
  "⚠️ Error invoking remote method 'acp:",
];

export interface MaybeNote {
  content?: string;
  /** 新写下的通知都带这个标记；老的只能靠开头认。 */
  kirolex?: true | boolean;
}

/** 这条消息是 KiroLex 对人说的话吗（不是你说的）。 */
export function isKirolexNote(m: MaybeNote | null | undefined): boolean {
  if (!m) return false;
  if (m.kirolex) return true;
  const t = String(m.content || '').trim();
  return KIROLEX_NOTE_OPENINGS.some((head) => t.startsWith(head));
}

/**
 * 能不能发给模型。
 *
 * 除了 KiroLex 自己的通知，还挡掉助手的 `💭 ` 思考行 —— 它本来也不是对话内容。
 * （这两条判据原来在 `src/main/index.ts` 里，语义一个字没改，只是搬到了共享的一处。）
 */
export function modelFacing(m: { role?: string; content?: string; kirolex?: true | boolean }): boolean {
  if (!m) return false;
  if (isKirolexNote(m)) return false;
  return !(m.role === 'assistant' && String(m.content || '').startsWith('💭 '));
}

/**
 * 从一段**已经拼好的**对话文本里把这些通知整段删掉（`User: …` / `Assistant: …` 分段）。
 *
 * 为什么还要这一个：追问建议那条路收到的是渲染进程拼好的字符串，主进程手里没有结构化的消息。
 * 在真正发出去的那一处再挡一次 —— 上游哪天又多一个调用点，这里照样拦得住。
 */
export function stripKirolexNotes(convo: string): string {
  const blocks = String(convo || '').split(/\n\n+/);
  return blocks
    .filter((b) => {
      const body = b.replace(/^(User|Assistant):\s*/, '').trim();
      return !isKirolexNote({ content: body });
    })
    .join('\n\n');
}

/**
 * **提示的「详情」** —— 主句只说"发生了什么 + 要不要你做什么"，pid / 后端会话 id / 日志原文这类诊断细节
 * 折叠起来（写法见 `docs/notices-glossary.md`）。
 *
 * 详情和主句拼在**同一段文字**里、用这个分隔符隔开，而不是另加一个字段：这样落盘、IPC、中英两版
 * （`trConcat` → `bothLangs`）都不用改形状；界面显示时 `splitNoteDetail` 拆开，详情放进可展开的「详情」。
 * 不认识它的地方（日志、history.md）看到的就是空一行再接详情，照样读得通。
 */
export const NOTE_DETAIL_SEP = '\n\n\u2063';

/** 主句 + 详情拼成一句（详情为空就只有主句）。主进程里要中英两版时用 `trConcat(main, NOTE_DETAIL_SEP, detail)`。 */
export function withNoteDetail(main: string, detail?: string): string {
  const d = String(detail || '').trim();
  return d ? `${main}${NOTE_DETAIL_SEP}${d}` : main;
}

/** 拆回主句和详情（没有分隔符就没有详情）。 */
export function splitNoteDetail(text: string): { main: string; detail: string } {
  const s = String(text || '');
  const at = s.indexOf(NOTE_DETAIL_SEP);
  if (at < 0) return { main: s, detail: '' };
  return { main: s.slice(0, at), detail: s.slice(at + NOTE_DETAIL_SEP.length).trim() };
}
