/**
 * local_browser 在界面上的纯逻辑：设置页的状态文案、回合面板里挑出浏览器操作。
 * 主进程那边是 `src/main/localBrowserHost.ts`（形状和它的 `LocalBrowserStatus` 对齐）。
 */

export type BrowserRowState = 'off' | 'not-enabled' | 'waiting' | 'connected' | 'error' | 'idle';

export interface BrowserStatusRowView {
  kind: string;
  label: string;
  installed: boolean;
  state: BrowserRowState;
  error?: string;
  endpoint?: string;
  assumed?: boolean;
}

export interface LocalBrowserStatusView {
  enabled: boolean;
  browser: string;
  firefoxPort: number;
  browsers: BrowserStatusRowView[];
  effective?: string;
}

export interface BrowserDomainAsk { id: string; sessionId: string; host: string; url: string }

/** 状态 → 英文原文（界面上过 `t()`）。 */
export function browserStateLabel(row: Pick<BrowserStatusRowView, 'state' | 'kind' | 'assumed'>): string {
  switch (row.state) {
    case 'off': return 'Off';
    case 'connected': return 'Connected';
    case 'waiting': return 'Waiting for the browser to allow the connection';
    case 'idle': return 'Debugging enabled (connects on first use)';
    case 'error': return 'Connection failed';
    default:
      return row.kind === 'firefox' ? 'Not started in debug mode' : 'Remote debugging not enabled';
  }
}

/** 没开调试时告诉用户怎么开（Chromium：inspect 页；Firefox：按钮）。 */
export function browserEnableHint(kind: string): string | null {
  if (kind === 'firefox') return null;
  const scheme = kind === 'edge' ? 'edge' : kind === 'brave' ? 'brave' : 'chrome';
  return `${scheme}://inspect/#remote-debugging`;
}

/** 回合面板：这一轮里 local_browser 的操作（主进程以 `kind: 'browser'` 记下的那些）。 */
export function browserActionsOf<T extends { kind?: string; toolCallId: string }>(calls: T[]): T[] {
  const byId = new Map<string, T>();
  for (const c of calls) if ((c.kind || '').toLowerCase() === 'browser') byId.set(c.toolCallId, c);
  return [...byId.values()];
}
