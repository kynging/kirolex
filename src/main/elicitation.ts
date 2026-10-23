/**
 * **模型向用户提问**（ACP `elicitation/create`，form 模式）—— PURE，主进程和渲染端共用。
 *
 * 「会话里模型让用户选择或提问时，界面上要显示成图形化的选择」。三家引擎的情况（2026-10-23 实测）：
 *
 * - **Claude Code**（claude-agent-acp 0.88）：内置 `AskUserQuestion` 工具**只有**客户端在 initialize 里声明了
 *   `clientCapabilities.elicitation.form` 才可用，否则直接进 `disallowedTools`，模型根本问不了。声明之后它发
 *   `elicitation/create`：每题一个 `question_<n>`（单选 `oneOf` / 多选 `array` + `items.anyOf`），
 *   外加一个 `question_<n>_custom`（「其他」自由填写）。
 * - **Codex**（codex-acp 2.1.1）：`request_user_input`（只在 Plan 协作模式下可用）和 MCP elicitation 在声明了
 *   form 时走 `elicitation/create`；**没声明就回空答案** `{ answers: {} }`，模型拿到的是「用户什么都没选」。
 *   带「其他」的题有一个 `_meta.codex.role === 'user_note'` 的备注框；`_meta.codex.isSecret` 的题是密文。
 * - **kiro-cli** 2.13.0：见 `acp-client.ts` 里 `elicitation/create` 那一段的注释。
 *
 * 这里只做三件事：把 `requestedSchema` 认成一张卡片的控件（`parseRequestedSchema`）、把用户填的值变成回包
 * （`buildAcceptContent` / `elicitationResult`）、给卡片写只读摘要（`answerLines` / `questionTailText`）。
 * 什么时候问、怎么超时、落盘，都在 index.ts。
 */

/** initialize 里声明的客户端能力。只声明 form：url 模式是让我们替代理在浏览器里打开一个它给的链接（MCP OAuth 之类），
 *  这个功能用不到它，声明了反而会改变 Claude Code 启动时 MCP 登录的走法。 */
export const CLIENT_CAPABILITIES = { elicitation: { form: {} } } as const;

/** 没人回答的提问多久之后按「取消」回给代理（这一轮不能一直挂着）。 */
export const QUESTION_TIMEOUT_MS = 30 * 60_000;

export type QuestionStatus =
  | 'pending'
  /** 用户填了、提交了 */
  | 'answered'
  /** 用户点了「跳过」 */
  | 'declined'
  /** 这一轮被停止 / 执行器断开 */
  | 'cancelled'
  /** 超时没人回答（按 cancel 回给代理） */
  | 'timeout'
  /** 代理自己撤回 / 关掉了这次提问（`$/cancel_request`、`elicitation/complete`） */
  | 'withdrawn';

export type QuestionFieldKind = 'single' | 'multi' | 'text' | 'boolean' | 'number' | 'integer';

export interface QuestionOption { value: string; title: string; description?: string }

export interface QuestionField {
  key: string;
  kind: QuestionFieldKind;
  title?: string;
  description?: string;
  required: boolean;
  options?: QuestionOption[];
  default?: string | number | boolean | string[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  /** 密文（Codex 的 `isSecret`）：输入框用 password，落盘 / 摘要里不出现原文 */
  secret?: boolean;
  /** 这一项是另一题（key）的「其他 / 自定义答案」输入框 —— 画在那一题下面 */
  customFor?: string;
}

export type QuestionValue = string | number | boolean | string[];

/** 一张提问卡片：界面画它、transcript 里存它（`StoredMessage.question`）。 */
export interface QuestionCard {
  /** transcript 里那条消息的 id */
  id: string;
  sessionId: string;
  /** JSON-RPC 请求 id（只在挂着的时候有意义） */
  requestId: string | number;
  engine?: string;
  /** url 模式 / 代理带了的话：`elicitation/complete` 用它对上 */
  elicitationId?: string;
  message: string;
  title?: string;
  description?: string;
  fields: QuestionField[];
  askedAt: number;
  /** 到这个时刻还没人回答就按 cancel 回给代理 */
  expiresAt: number;
  status: QuestionStatus;
  /** 提交的答案（密文已经换成 `••••`） */
  answer?: Record<string, QuestionValue>;
  closedAt?: number;
  /** 取消的原因是你切到了别的会话（`cancelled` 时才有）—— 卡片上照实说，不说成「这一轮被停止了」 */
  cancelledBy?: 'switch';
}

const isRecord = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function enumOptions(list: unknown, names?: unknown): QuestionOption[] {
  if (!Array.isArray(list)) return [];
  const labels = Array.isArray(names) ? names : [];
  return list.flatMap((o, i): QuestionOption[] => {
    if (typeof o === 'string') return [{ value: o, title: typeof labels[i] === 'string' ? labels[i] : o }];
    if (!isRecord(o) || typeof o.const !== 'string') return [];
    const title = str(o.title) ?? o.const;
    /* Claude Code 常把 description 填成和标题一样的字：再写一遍是噪音 */
    const description = str(o.description) && o.description.trim() !== title.trim() ? o.description : undefined;
    return [{ value: o.const, title, ...(description ? { description } : {}) }];
  });
}

/** schema 里的一个属性 → 控件。认不出的类型当成文字输入（总比整张卡片打不开好）。 */
function fieldOf(key: string, s: Record<string, any>, required: boolean): QuestionField {
  const base: QuestionField = {
    key,
    kind: 'text',
    required,
    ...(str(s.title) ? { title: s.title } : {}),
    ...(str(s.description) ? { description: s.description } : {}),
    ...(s._meta?.codex?.isSecret === true ? { secret: true } : {}),
  };
  if (s.type === 'array') {
    const items = isRecord(s.items) ? s.items : {};
    const options = enumOptions(items.anyOf ?? items.oneOf ?? items.enum);
    return {
      ...base,
      kind: 'multi',
      options,
      ...(Array.isArray(s.default) ? { default: s.default.filter((x: unknown) => typeof x === 'string') } : {}),
      ...(num(s.minItems) !== undefined ? { minItems: s.minItems } : {}),
      ...(num(s.maxItems) !== undefined ? { maxItems: s.maxItems } : {}),
    };
  }
  if (s.type === 'boolean') {
    return { ...base, kind: 'boolean', ...(typeof s.default === 'boolean' ? { default: s.default } : {}) };
  }
  if (s.type === 'number' || s.type === 'integer') {
    return {
      ...base,
      kind: s.type,
      ...(num(s.default) !== undefined ? { default: s.default } : {}),
      ...(num(s.minimum) !== undefined ? { minimum: s.minimum } : {}),
      ...(num(s.maximum) !== undefined ? { maximum: s.maximum } : {}),
    };
  }
  const options = enumOptions(s.oneOf ?? s.enum, s.enumNames);
  if (options.length) {
    return { ...base, kind: 'single', options, ...(typeof s.default === 'string' ? { default: s.default } : {}) };
  }
  return {
    ...base,
    ...(typeof s.default === 'string' ? { default: s.default } : {}),
    ...(num(s.minLength) !== undefined ? { minLength: s.minLength } : {}),
    ...(num(s.maxLength) !== undefined ? { maxLength: s.maxLength } : {}),
  };
}

/**
 * `requestedSchema` → 卡片上的控件，按属性原来的顺序。
 *
 * 「其他 / 自定义答案」框认两种写法：Claude Code 的 `<题>_custom`、Codex 的 `_meta.codex.role === 'user_note'`
 * （`questionId` 指向那一题）。认出来的标上 `customFor`，画在那一题下面，而不是另起一题。
 */
export function parseRequestedSchema(schema: unknown): { title?: string; description?: string; fields: QuestionField[] } {
  const s = isRecord(schema) ? schema : {};
  const props = isRecord(s.properties) ? s.properties : {};
  const required = new Set(Array.isArray(s.required) ? s.required.filter((k: unknown) => typeof k === 'string') : []);
  const fields = Object.entries(props)
    .filter(([, p]) => isRecord(p))
    .map(([key, p]) => fieldOf(key, p as Record<string, any>, required.has(key)));
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const choice = (k: unknown) => {
    const f = typeof k === 'string' ? byKey.get(k) : undefined;
    return f && (f.kind === 'single' || f.kind === 'multi') ? f : undefined;
  };
  for (const f of fields) {
    if (f.kind !== 'text') continue;
    const meta = (props[f.key] as any)?._meta?.codex;
    const owner = meta?.role === 'user_note' ? choice(meta.questionId)
      : /_custom$/.test(f.key) ? choice(f.key.slice(0, -'_custom'.length))
      : undefined;
    if (owner) f.customFor = owner.key;
  }
  return {
    ...(str(s.title) ? { title: s.title } : {}),
    ...(str(s.description) ? { description: s.description } : {}),
    fields,
  };
}

/** 控件的初始值（schema 里给了 default 的用它）。 */
export function initialValues(fields: QuestionField[]): Record<string, QuestionValue> {
  const out: Record<string, QuestionValue> = {};
  for (const f of fields) {
    if (f.default !== undefined) out[f.key] = Array.isArray(f.default) ? [...f.default] : f.default;
    else if (f.kind === 'multi') out[f.key] = [];
    else if (f.kind === 'boolean') out[f.key] = false;
  }
  return out;
}

export type AcceptCheck =
  | { ok: true; content: Record<string, QuestionValue> }
  /** `missing`：必填却没填的；`invalid`：填了但不合要求的（数字不是数字、超出范围、选的不在选项里） */
  | { ok: false; missing: string[]; invalid: string[] };

/**
 * 用户填的值 → `accept` 的 `content`。只带填了的项（空字符串 / 空数组不带），数字按 schema 转成数字，
 * 选项只收 schema 里有的那几个。必填没填、或者值不合要求 → 不提交，告诉界面是哪几项。
 */
export function buildAcceptContent(fields: QuestionField[], values: Record<string, unknown>): AcceptCheck {
  const content: Record<string, QuestionValue> = {};
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const f of fields) {
    const raw = values?.[f.key];
    let value: QuestionValue | undefined;
    if (f.kind === 'multi') {
      const allowed = new Set((f.options || []).map((o) => o.value));
      const picks = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
      if (picks.some((x) => allowed.size && !allowed.has(x))) invalid.push(f.key);
      else if (picks.length) {
        if ((f.minItems !== undefined && picks.length < f.minItems) || (f.maxItems !== undefined && picks.length > f.maxItems)) invalid.push(f.key);
        value = picks;
      }
    } else if (f.kind === 'single') {
      if (typeof raw === 'string' && raw !== '') {
        if ((f.options || []).some((o) => o.value === raw)) value = raw;
        else invalid.push(f.key);
      }
    } else if (f.kind === 'boolean') {
      if (typeof raw === 'boolean') value = raw;
    } else if (f.kind === 'number' || f.kind === 'integer') {
      const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
      if (text !== '') {
        const n = Number(text);
        if (!Number.isFinite(n) || (f.kind === 'integer' && !Number.isInteger(n))
          || (f.minimum !== undefined && n < f.minimum) || (f.maximum !== undefined && n > f.maximum)) invalid.push(f.key);
        else value = n;
      }
    } else if (typeof raw === 'string' && raw.trim() !== '') {
      if ((f.minLength !== undefined && raw.length < f.minLength) || (f.maxLength !== undefined && raw.length > f.maxLength)) invalid.push(f.key);
      else value = raw;
    }
    if (value !== undefined) content[f.key] = value;
    else if (f.required && !invalid.includes(f.key)) missing.push(f.key);
  }
  return missing.length || invalid.length ? { ok: false, missing, invalid } : { ok: true, content };
}

export type ElicitationAction = 'accept' | 'decline' | 'cancel';

/** 回给代理的那个 result（ACP `CreateElicitationResponse`）。 */
export function elicitationResult(action: ElicitationAction, content?: Record<string, QuestionValue>):
  { action: 'accept'; content: Record<string, QuestionValue> } | { action: 'decline' } | { action: 'cancel' } {
  if (action === 'accept') return { action, content: content || {} };
  return { action };
}

/** 落盘 / 推给界面的答案：密文换成 `••••`。 */
export function redactAnswer(fields: QuestionField[], content: Record<string, QuestionValue>): Record<string, QuestionValue> {
  const secret = new Set(fields.filter((f) => f.secret).map((f) => f.key));
  const out: Record<string, QuestionValue> = {};
  for (const [k, v] of Object.entries(content)) out[k] = secret.has(k) ? '••••' : v;
  return out;
}

/** 一个 `elicitation/create` 的 params → 一张挂着的卡片。超时取 `QUESTION_TIMEOUT_MS` 和 Codex 自己的 `autoResolutionMs` 里短的那个。 */
export function newQuestionCard(input: {
  id: string; sessionId: string; requestId: string | number; params: unknown; now: number; engine?: string;
}): QuestionCard {
  const p = isRecord(input.params) ? input.params : {};
  const parsed = parseRequestedSchema(p.requestedSchema);
  const auto = num(p._meta?.codex?.autoResolutionMs);
  const timeout = auto !== undefined && auto > 0 ? Math.min(auto, QUESTION_TIMEOUT_MS) : QUESTION_TIMEOUT_MS;
  return {
    id: input.id,
    sessionId: input.sessionId,
    requestId: input.requestId,
    ...(input.engine ? { engine: input.engine } : {}),
    ...(str(p.elicitationId) ? { elicitationId: p.elicitationId } : {}),
    message: typeof p.message === 'string' ? p.message : '',
    ...(parsed.title ? { title: parsed.title } : {}),
    ...(parsed.description ? { description: parsed.description } : {}),
    fields: parsed.fields,
    askedAt: input.now,
    expiresAt: input.now + timeout,
    status: 'pending',
  };
}

/** 卡片关掉（答了 / 跳过 / 取消 / 超时 / 撤回）。已经关过的原样返回（只关一次）。 */
export function closeQuestionCard(card: QuestionCard, status: Exclude<QuestionStatus, 'pending'>, now: number, content?: Record<string, QuestionValue>, cancelledBy?: 'switch'): QuestionCard {
  if (card.status !== 'pending') return card;
  return {
    ...card,
    status,
    closedAt: now,
    ...(status === 'answered' && content ? { answer: redactAnswer(card.fields, content) } : {}),
    ...(status === 'cancelled' && cancelledBy ? { cancelledBy } : {}),
  };
}

/** 一题的标签：title → description → key */
export function fieldLabel(f: QuestionField): string {
  return f.title || f.description || f.key;
}

function valueText(f: QuestionField, v: QuestionValue): string {
  const titleOf = (x: string) => f.options?.find((o) => o.value === x)?.title ?? x;
  if (Array.isArray(v)) return v.map(titleOf).join(', ');
  if (typeof v === 'string') return titleOf(v);
  return String(v);
}

/**
 * 只读摘要：每题一行「标签 → 答案」。「其他」框里填的字并进它那一题那一行（`answerLines` 不单列它）。
 * 布尔值给 true / false，由界面翻译。没答的题不列。
 */
export function answerLines(card: Pick<QuestionCard, 'fields' | 'answer'>): Array<{ key: string; label: string; value: string; boolean?: boolean }> {
  const answer = card.answer || {};
  const out: Array<{ key: string; label: string; value: string; boolean?: boolean }> = [];
  for (const f of card.fields) {
    if (f.customFor) continue;
    const parts: string[] = [];
    if (answer[f.key] !== undefined) parts.push(valueText(f, answer[f.key]));
    for (const c of card.fields) {
      if (c.customFor === f.key && typeof answer[c.key] === 'string' && answer[c.key] !== '') parts.push(String(answer[c.key]));
    }
    if (!parts.length) continue;
    out.push({ key: f.key, label: fieldLabel(f), value: parts.join(' · '), ...(f.kind === 'boolean' ? { boolean: answer[f.key] === true } : {}) });
  }
  /* 「其他」框对应的那一题不存在（不该发生）—— 也别丢 */
  for (const c of card.fields) {
    if (c.customFor && !card.fields.some((f) => f.key === c.customFor) && typeof answer[c.key] === 'string') {
      out.push({ key: c.key, label: fieldLabel(c), value: String(answer[c.key]) });
    }
  }
  return out;
}

/** 控制入口 tail 里的一段（纯文字、英文、机器读）：问了什么、选项、现在的状态 / 答了什么。 */
export function questionTailText(card: QuestionCard): string {
  const lines = [`[question ${card.status}] ${card.message || card.title || ''}`.trim()];
  for (const f of card.fields) {
    if (f.customFor) continue;
    /* 选项给「值」（回答时要填的就是它），和标题不一样时括号里带上标题；字段 key 也给（POST /answer 按 key 填） */
    const opts = f.options?.length ? `: ${f.options.map((o) => (o.title === o.value ? o.value : `${o.value} (${o.title})`)).join(' / ')}` : '';
    lines.push(`- ${fieldLabel(f)} [${f.key}] (${f.kind}${f.required ? ', required' : ''})${opts}`);
    for (const c of card.fields) if (c.customFor === f.key) lines.push(`  + free text [${c.key}]`);
  }
  if (card.status === 'answered') {
    for (const l of answerLines(card)) lines.push(`→ ${l.label} = ${l.value}`);
  }
  return lines.join('\n');
}
