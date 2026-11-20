/**
 * 工具（🔧）/ 思考（💭）段的折叠状态 —— ChatArea 的 AssistantTurn 用。
 *
 * 工具段：
 * - 「live」= 这一段还处在运行期：自动折叠开时只算正在流式的那一段，关时整轮运行中都算（旧行为里这段一直展开）。
 * - 默认：自动折叠开 → 运行中也折叠（折叠条里带命令行 + 运行中指示，点开看实时输出）；
 *   自动折叠关 → 运行中展开；跑完一律折叠。
 * - 用户点击记成 override，连同点击时的 live：运行中的点击在这段跑完后作废（跑完即折，不残留一墙输出），
 *   跑完后的点击一直有效。
 *
 * 思考段（2026-11-20 口径，不跟工具段走）：
 * - 不显示运行中指示；运行中一直展开。
 * - 自动折叠思考关（默认）→ 跑完也展开；开 → 跑完折叠。
 * - 用户的点击一直有效，不随跑完作废。
 */
export interface SegmentFoldInput {
  /** 段类型：工具段 / 思考段折叠规则不同 */
  kind: 'tool' | 'thinking';
  /** 工具 / 思考段才可折叠 */
  collapsible: boolean;
  /** 对应的 autoFoldTools / autoFoldThinking */
  fold: boolean;
  /** 这一段正在流式输出（最后一轮的最后一段） */
  streamThis: boolean;
  /** 这一轮还在跑 */
  running: boolean;
}

export interface SegmentFoldOverride {
  open: boolean;
  live: boolean;
}

export function segmentFoldState(
  s: SegmentFoldInput,
  override?: SegmentFoldOverride,
): { open: boolean; live: boolean } {
  const live = s.fold ? s.streamThis : s.running;
  if (!s.collapsible) return { open: true, live };
  if (s.kind === 'thinking') {
    if (override) return { open: override.open, live };
    return { open: !s.fold || live, live };
  }
  if (override && override.live === live) return { open: override.open, live };
  return { open: live && !s.fold, live };
}

/** 折叠条 / 头部要不要带「◌ 运行中」：只有正在流式的工具段才带，思考段不带 */
export function showsRunningIndicator(s: SegmentFoldInput): boolean {
  return s.collapsible && s.kind === 'tool' && s.streamThis;
}

/** 点一下折叠 / 展开：翻转当前显示状态，并记下点击时是否在运行期 */
export function toggleSegmentFold(cur: { open: boolean; live: boolean }): SegmentFoldOverride {
  return { open: !cur.open, live: cur.live };
}

/**
 * 回复下面的「⚡ 执行的命令」/「🔧 用过的工具」面板（2026-11-20 第 3 轮）：和工具段同一套规则 ——
 * autoFoldTools 开 → 运行中也折叠；关 → 运行中展开（旧行为）；这一轮结束一律折叠。
 * 用户的点击 pin 住，但运行中的点击在这一轮结束后作废（跑完即折）。
 */
export function panelFoldState(autoFold: boolean, live: boolean, pin?: SegmentFoldOverride): { open: boolean; live: boolean } {
  return segmentFoldState({ kind: 'tool', collapsible: true, fold: autoFold, streamThis: live, running: live }, pin);
}

/** 折叠态显示「正在运行的那一个」：最后一个仍在运行的，没有就最后一个；`done` = 不在运行的条数 */
export function pickCurrent<T>(items: T[], isRunning: (item: T) => boolean): { current: T | undefined; running: boolean; done: number } {
  let current: T | undefined;
  let done = 0;
  for (const item of items) {
    if (isRunning(item)) current = item; else done++;
  }
  if (current !== undefined) return { current, running: true, done };
  return { current: items[items.length - 1], running: false, done };
}

/** 折叠态预览的文本：去掉首尾空行，最多 `max` 行，`more` = 没显示的行数（界面上是「+N 行」） */
export function previewLines(text: string, max = 5): { lines: string[]; more: number } {
  const all = String(text || '').split(/\r?\n/);
  while (all.length && !all[0].trim()) all.shift();
  while (all.length && !all[all.length - 1].trim()) all.pop();
  return { lines: all.slice(0, max), more: Math.max(0, all.length - max) };
}
