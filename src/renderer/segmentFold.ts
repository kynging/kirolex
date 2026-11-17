/**
 * 工具（🔧）/ 思考（💭）段的折叠状态 —— ChatArea 的 AssistantTurn 用。
 *
 * - 「live」= 这一段还处在运行期：自动折叠开时只算正在流式的那一段，关时整轮运行中都算（旧行为里这段一直展开）。
 * - 默认：自动折叠开 → 运行中也折叠（折叠条里带命令行 + 运行中指示，点开看实时输出）；
 *   自动折叠关 → 运行中展开；跑完一律折叠。
 * - 用户点击记成 override，连同点击时的 live：运行中的点击在这段跑完后作废（跑完即折，不残留一墙输出），
 *   跑完后的点击一直有效。
 */
export interface SegmentFoldInput {
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
  if (override && override.live === live) return { open: override.open, live };
  return { open: live && !s.fold, live };
}

/** 点一下折叠 / 展开：翻转当前显示状态，并记下点击时是否在运行期 */
export function toggleSegmentFold(cur: { open: boolean; live: boolean }): SegmentFoldOverride {
  return { open: !cur.open, live: cur.live };
}
