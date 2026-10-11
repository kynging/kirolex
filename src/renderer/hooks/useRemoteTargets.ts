import { useEffect, useState } from 'react';

/**
 * **可以把这条会话跑在哪些机器上** —— 远程会话（`docs/DESIGN_remote_sessions.md`）。
 *
 * 粒度在会话这一层：新建会话时选一次，之后固定。所以这个列表只在"新建"的界面上用。
 *
 * 远程会话没有开关了：配了几台就给几台；一台没配就是空列表。
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
        setState({ enabled: !!r.enabled, targets: Array.isArray(r.targets) ? r.targets : [] });
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
