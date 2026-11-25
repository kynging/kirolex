/**
 * **连接中也能打字、能回车** ——「远程会话连接的前半段输入框没法输入」（2026-11-25，Windows + SSM）。
 *
 * 连接中（应用还在连后端 `status === 'connecting'`、这条会话还在挂执行器、新会话还在建）：
 *   - 输入框始终可编辑，附件 / 排队按钮也能用；
 *   - 按 Enter = 先进**这条会话**的发送队列，连上后排空队列那一段自动发出；输入框上方显示「已排队，连上后发送」，卡片上能取消；
 *   - 斜杠命令（`/stop` 等）不排：它们在本地处理，`/stop` 正是「连不上时强制重连」的出路。
 * 不改发送语义：这一轮在跑（`turn`）时照旧插话（steer），排队判定和 steer 判定都还在原处。
 *
 * 纯函数，测试直接 import。
 */

export type AppStatus = 'disconnected' | 'connecting' | 'connected';

export interface ConnectingFacts {
  /** 应用级连接状态（`useAcp` 的 `status`） */
  appStatus: AppStatus;
  /** 这条会话正在挂执行器（`connectingSessionIds`） */
  sessionConnecting: boolean;
  /** 新建的会话还没就绪（`startupBlocksSend(createStages[sid])`） */
  startupPending: boolean;
}

/** 这条会话此刻是不是「还在连」：是的话发的消息先排队，排着的也先不发 */
export function waitsForConnection(f: ConnectingFacts): boolean {
  return f.appStatus === 'connecting' || f.sessionConnecting || f.startupPending;
}

/**
 * 普通 Enter（空闲时那条路，`handleSendMessage`）要不要先进队列等连上。
 * `busy === 'turn'`：这一轮在跑 —— 交给原来的 steer 那条路，不在这里截。
 */
export function queueUntilConnected(f: ConnectingFacts & { text: string; busy?: string | null }): boolean {
  if (f.text.trim().startsWith('/')) return false;
  if (f.busy === 'turn') return false;
  return waitsForConnection(f);
}

/**
 * 输入框换了会话 id（切会话 / 新会话从「还没有 id」到有了 id）时输入框里该放什么。
 *
 * 原来 `previous` 为空时直接丢掉当前文本、换成新 id 的草稿 —— 新会话从创建到连上期间先打的字就没了。
 * 现在：从「没有 id」换到一个 id，当前文本带过去（新 id 自己也存着草稿的话两份都留，不丢任何一份）；
 * 其余情况照旧：旧的那份已经按旧 id 存好了，换成新 id 的草稿。
 */
export function draftAfterSessionSwap(previous: string | null, next: string | null, currentText: string, storedForNext: string | undefined): string {
  const stored = storedForNext || '';
  if (previous === null && next && currentText.trim()) {
    if (stored.trim() && stored !== currentText) return `${stored}\n\n${currentText}`;
    return currentText;
  }
  return next ? stored : '';
}

/**
 * 能不能进排队：有文字，或者（没文字但）带了附件 —— 只有附件也是一条消息（输入框和直接发送一直这么认）。
 * 原来排队那条只认文字，连接中只加了附件就按 Enter 的那条被静默丢掉（没有卡片、连上也不发）。
 */
export function queueableMessage(text: string, attachmentCount: number): boolean {
  return text.trim() !== '' || attachmentCount > 0;
}
