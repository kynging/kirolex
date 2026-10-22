/**
 * `remoteAdapterCheck` 要说的话的记账（发出去的那一下在 index.ts 的 `adapterNotes`）。
 * 同一条会话同一件事只说一次（每次重连 / 换组合都会走到）；新建会话时记录还没落盘，先攒着，写好记录后 `commit`。
 *
 * `forgetPinned`：换机器 / 换引擎时，状态行钉住的那句（`adapter-hidden:…`「已直接用 fnm 的 node 起」）说的是**旧**位置怎么起的 ——
 * 留着就把旧状态当成了现状。撤掉它、也忘了「说过了」，新位置要的话由新的探测重新钉上；同一台机器重连不走这里，提示照旧挂着。
 */
export const ADAPTER_HIDDEN_PREFIX = 'adapter-hidden:';

export type AdapterNoteHow = 'note' | 'status';

export function createAdapterNotes(deps: {
  /** 这条会话的记录落盘了没有 */
  hasRecord: (sid: string) => boolean;
  /** 真正说出去；返回 false = 没说成（下次再说） */
  emit: (sid: string, how: AdapterNoteHow, text: string, group: string) => boolean;
  /** 撤掉这条会话 group 以 `prefix` 开头的钉住提示 */
  unpin: (sid: string, prefix: string) => void;
}) {
  const said = new Set<string>();
  const staged = new Map<string, Array<{ how: AdapterNoteHow; text: string; group: string }>>();
  return {
    say(sid: string, how: AdapterNoteHow, text: string, group: string): void {
      const key = `${sid}|${group}`;
      if (said.has(key)) return;
      if (!deps.hasRecord(sid)) {
        const list = (staged.get(sid) || []).filter((x) => x.group !== group);
        staged.set(sid, [...list, { how, text, group }]);
        return;
      }
      if (deps.emit(sid, how, text, group)) said.add(key);
    },
    commit(sid: string): void {
      const list = staged.get(sid) || [];
      staged.delete(sid);
      for (const x of list) if (deps.emit(sid, x.how, x.text, x.group)) said.add(`${sid}|${x.group}`);
    },
    forgetPinned(sid: string): void {
      const mine = `${sid}|${ADAPTER_HIDDEN_PREFIX}`;
      for (const key of [...said]) if (key.startsWith(mine)) said.delete(key);
      const list = staged.get(sid);
      if (list) {
        const rest = list.filter((x) => !x.group.startsWith(ADAPTER_HIDDEN_PREFIX));
        if (rest.length) staged.set(sid, rest); else staged.delete(sid);
      }
      deps.unpin(sid, ADAPTER_HIDDEN_PREFIX);
    },
  };
}
