/**
 * 主进程里**给人看的话**（对话框、托盘、系统通知、发给界面显示的错误、插进聊天里的提示）的中英文案。
 *
 * 和渲染层的 `src/renderer/i18n.ts` 是同一套约定：**key 就是英文原文**，`zh` 查这张表，查不到退回英文原文。
 * 渲染层的 `t()` 也会查这张表 —— 主进程发过去的英文原文，在界面上照样能翻。
 *
 * 主进程拿不到 React context，所以语言是模块级的一个值：`index.ts` 启动时从 ui-state 里的
 * `kirolex-settings` 读出来，设置一改（`app:ui-state-set`）就跟着更新。模块是纯的（不 import electron），
 * 测试可以直接 import；默认中文，和渲染层 `normalizeLang` 的默认一致。
 *
 * 不进这张表的：只写进日志文件的、发给模型的提示词、会话内容、路径、模型名、命令名。
 */

import { ZH_INDEX_A } from './uiTextZh/indexA.ts';
import { ZH_INDEX_B } from './uiTextZh/indexB.ts';
import { ZH_MODULES_A } from './uiTextZh/modulesA.ts';
import { ZH_MODULES_B } from './uiTextZh/modulesB.ts';
import { ZH_WAKE } from './uiTextZh/wake.ts';
import { ZH_SESSION_CALLS } from './uiTextZh/sessionCalls.ts';
import { ZH_LOOP } from './uiTextZh/loop.ts';

export type UiLang = 'zh' | 'en';

let current: UiLang = 'zh';

/** 坏值 / 旧值一律退回中文（和 `normalizeLang` 同一判据）。 */
export function setUiLang(raw: unknown): UiLang {
  current = raw === 'en' ? 'en' : 'zh';
  return current;
}

export function uiLang(): UiLang {
  return current;
}

/** 托盘等零散的几条；大头按来源文件分在 `uiTextZh/` 下。 */
const ZH_MISC: Record<string, string> = {
  // ── 托盘 ────────────────────────────────────────────────────────────────
  'Show KiroLex': '显示 KiroLex',
  'Quit': '退出',
};

/** 各分表（测试逐张核对：同一个 key 不许在两张表里给出两种中文）。 */
export const ZH_MAIN_PARTS: Record<string, Record<string, string>> = {
  misc: ZH_MISC,
  indexA: ZH_INDEX_A,
  indexB: ZH_INDEX_B,
  modulesA: ZH_MODULES_A,
  modulesB: ZH_MODULES_B,
  wake: ZH_WAKE,
  loop: ZH_LOOP,
  sessionCalls: ZH_SESSION_CALLS,
};

/** 主进程文案的中文表（各分表合起来）。key 是英文原文。 */
export const ZH_MAIN: Record<string, string> = Object.assign({}, ...Object.values(ZH_MAIN_PARTS));

/** `{name}` 命名占位符替换 —— 两种语言语序不同，不能按位置。没给值的占位符原样留着。 */
export function fillVars(raw: string, vars?: Record<string, string | number>): string {
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** 按指定语言取一条主进程文案。 */
export function trIn(lang: UiLang, key: string, vars?: Record<string, string | number>): string {
  return fillVars(lang === 'en' ? key : (ZH_MAIN[key] ?? key), vars);
}

/**
 * 最近 `tr()` 出去的句子 → 它的 key 和 vars（有上限，旧的先挤掉）。
 *
 * 状态行上的提示是主进程**生成那一刻**按当时的语言翻好发过去的；之后界面切了语言，那句话还挂在那儿。
 * 记下 key + vars，发提示时就能把两种语言的版本一起带过去（`bothLangs`），界面按当前语言挑。
 */
type Made =
  | { kind: 'tr'; key: string; vars?: Record<string, string | number> }
  /** 几段拼起来的一句（`trConcat`）—— 每一段各自再认 */
  | { kind: 'concat'; parts: string[] }
  /** 一个列表（`trList`）—— 分隔符按语言：中文「、」，英文 ", " */
  | { kind: 'list'; items: string[] };
const recent = new Map<string, Made>();
const RECENT_MAX = 300;

function remember(out: string, made: Made): string {
  recent.delete(out);
  recent.set(out, made);
  if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value as string);
  return out;
}

const LIST_SEP: Record<UiLang, string> = { zh: '、', en: ', ' };

/** 渲染层的 `t()` 也记一笔（同一套 `bothLangs`，换成渲染层自己的取文案函数）。返回 `out` 本身。 */
export function rememberTr(out: string, key: string, vars?: Record<string, string | number>): string {
  return remember(out, { kind: 'tr', key, vars });
}

type Translate = (lang: UiLang, key: string, vars?: Record<string, string | number>) => string;

/** 按当前界面语言取一条主进程文案。 */
export function tr(key: string, vars?: Record<string, string | number>): string {
  return remember(trIn(current, key, vars), { kind: 'tr', key, vars });
}

/**
 * 把几段（通常是几句 `tr()`）拼成一句 —— 和直接用 `+` 拼的结果一模一样，只是记下了「是哪几段拼的」，
 * 这样整句也能换成另一种语言（`bothLangs`）。不是 `tr()` 出来的那几段（路径、模型名）原样留着。
 */
export function trConcat(...parts: string[]): string {
  const kept = parts.map((x) => String(x ?? ''));
  return remember(kept.join(''), { kind: 'concat', parts: kept });
}

/** 一个列表按当前语言的分隔符连起来（中文「、」，英文 ", "）；换语言时分隔符跟着换。 */
export function trList(items: Array<string | number>): string {
  const kept = items.map((x) => String(x));
  return remember(kept.join(LIST_SEP[current]), { kind: 'list', items: kept });
}

/**
 * 一句 `tr()` / `trConcat()` / `trList()` 出去的话的中英两版。占位符的值、拼接的每一段本身也是这样出来的
 * （例如内置组合名「通用」），同样换成那种语言。认不出的（别处来的原文、已经被挤出记录的）返回 null ——
 * 不猜，调用方照原文显示。
 */
export function bothLangs(text: string, depth = 0, translate: Translate = trIn): { zh: string; en: string } | null {
  const hit = recent.get(text);
  if (!hit || depth > 5) return null;
  const sub = (v: string, lang: UiLang) => (v !== text ? (bothLangs(v, depth + 1, translate)?.[lang] ?? v) : v);
  const build = (lang: UiLang): string => {
    if (hit.kind === 'concat') return hit.parts.map((x) => sub(x, lang)).join('');
    if (hit.kind === 'list') return hit.items.map((x) => sub(x, lang)).join(LIST_SEP[lang]);
    const vars = hit.vars && Object.fromEntries(Object.entries(hit.vars).map(
      ([k, v]) => [k, typeof v === 'string' ? sub(v, lang) : v],
    ));
    return translate(lang, hit.key, vars);
  };
  return { zh: build('zh'), en: build('en') };
}

/** 一句提示的中英两版（落盘 / 发给界面时带上）。认不出就是 undefined —— 调用方只存原文。 */
export type TextVariants = { zh: string; en: string };
export function textVariants(text: string, translate: Translate = trIn): TextVariants | undefined {
  return bothLangs(text, 0, translate) ?? undefined;
}

/** 从磁盘 / IPC 读回来的 variants 先过一遍：形状不对就当没有（不能让坏数据把界面弄成空白）。 */
export function asVariants(raw: unknown): TextVariants | undefined {
  const v = raw as any;
  return v && typeof v === 'object' && typeof v.zh === 'string' && typeof v.en === 'string' && v.zh && v.en
    ? { zh: v.zh, en: v.en }
    : undefined;
}

/** 显示一条消息：有两版就按语言挑，没有（旧记录、你和 agent 说的话）就显示原文。 */
export function pickVariant(lang: UiLang, content: string, variants: unknown): string {
  return asVariants(variants)?.[lang] ?? content;
}
