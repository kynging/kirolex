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

export function useRemoteTargets(): { enabled: boolean; targets: RemoteTargetInfo[] } {
  const [state, setState] = useState<{ enabled: boolean; targets: RemoteTargetInfo[] }>({ enabled: false, targets: [] });
  useEffect(() => {
    let alive = true;
    /* 读一次就够：配置改了要重启 app 才生效（和其他 feature flag 一样的口径） */
    void (window as any).kiroApi?.remoteTargets?.().then((r: any) => {
      if (!alive || !r) return;
      setState({ enabled: !!r.enabled, targets: Array.isArray(r.targets) ? r.targets : [] });
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return state;
}
