/**
 * **当前已连接的执行器**（`acp:list-attached`）—— 渲染层刷新（控制入口 /reload、⌘R）后它的 attached 集合是空的，
 * 主进程里还活着的执行器它不知道，侧栏就把这些会话画成灰点。水化时取这一份并进去。
 *
 * `ids` = `sessionClients` 的键（执行器断开时会从里面删掉，所以在里面的就是活的）。
 * 连接中的不算（那条 attach 结束时渲染层自己会知道）；advanced 专属会话不给（和 `loop:list-live` 一样）。
 */
export function listAttachedSessionIds(
  ids: Iterable<string>,
  opts: { connecting: (id: string) => boolean; isProtected: (id: string) => boolean },
): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (!id || opts.connecting(id) || opts.isProtected(id)) continue;
    out.push(id);
  }
  return out;
}
