import { useEffect, useState } from 'react';

/**
 * **可以把这条会话跑在哪些机器上** —— 远程会话（`docs/DESIGN_remote_sessions.md`）。
 *
 * 粒度在会话这一层：新建会话时选一次，之后固定。所以这个列表只在"新建"的界面上用。
 *
 * `enabled: false`（feature flag 关着、或者配置里没有任何远端）时返回空列表，界面应当
 * **完全不显示**目标选择 —— 显示一个选了会报错的选项比不显示糟。
 */
export interface RemoteTargetInfo {
  id: string;
  label: string;
  sshHost: string;
  remoteWorkdir?: string;
}

/** 设置页存/删了一台机器之后发这个事件，新建会话那边就地刷新。 */
export const REMOTE_TARGETS_CHANGED = 'kirolex:remote-targets-changed';
export function notifyRemoteTargetsChanged(): void {
  try { window.dispatchEvent(new Event(REMOTE_TARGETS_CHANGED)); } catch { /* 没有 window 的环境 */ }
}

export function useRemoteTargets(): { enabled: boolean; targets: RemoteTargetInfo[] } {
  const [state, setState] = useState<{ enabled: boolean; targets: RemoteTargetInfo[] }>({ enabled: false, targets: [] });
  useEffect(() => {
    let alive = true;
    /*
      **不是"读一次就够"** ——「为什么加了远程机器还没有切换到远程会话的选项」。原来只在挂载时读一次，
      设置里刚加的机器要重启 app 才出现在新建对话里，而删掉的那几台一直留在下拉里。
      现在：设置页存/删时（REMOTE_TARGETS_CHANGED）、窗口重新拿到焦点时（手改了 config.json）都重读。
    */
    const load = (): void => {
      void (window as any).kiroApi?.remoteTargets?.().then((r: any) => {
        if (!alive || !r) return;
        /* 主进程开关关着也会发已配的机器（设置页要看），新建会话的选项只在开着时给 */
        setState({ enabled: !!r.enabled, targets: r.enabled && Array.isArray(r.targets) ? r.targets : [] });
      }).catch(() => {});
    };
    load();
    window.addEventListener(REMOTE_TARGETS_CHANGED, load);
    window.addEventListener('focus', load);
    return () => {
      alive = false;
      window.removeEventListener(REMOTE_TARGETS_CHANGED, load);
      window.removeEventListener('focus', load);
    };
  }, []);
  return state;
}
