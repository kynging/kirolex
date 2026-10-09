import { execFile } from 'child_process';

/**
 * Windows 上「连子进程一起收掉」。
 *
 * `proc.kill()` 在 Windows 上是 TerminateProcess，**只结束那一个进程**：kiro-cli 起的 shell / python
 * 等子进程会活下来，而它们的工作目录常常就在 `sessions/<id>/files` 里 —— 进程还在，Windows 就不让
 * 移动或删除那个目录（删除会话报 EBUSY 的原因之一）。
 *
 * 只认**从这一个根 pid 往下**的进程树，所以只会碰到本会话的 kiro-cli 和它自己起的进程，不会误杀别的会话。
 * Windows 的 pid 会被复用，所以每个进程都带上创建时间：子进程必须比父进程晚创建，事后再杀时 pid 和创建时间
 * 都对得上才动手。
 */
export type ProcRow = { pid: number; ppid: number; created: number };

/** 解析 PowerShell 打出来的 `pid<TAB>ppid<TAB>创建时间(FileTimeUtc)` 每行一条。坏行跳过。 */
export function parseProcRows(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    const parts = line.trim().split('\t');
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const created = Number(parts[2]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(created) || pid <= 0) continue;
    rows.push({ pid, ppid, created });
  }
  return rows;
}

/**
 * `rootPid` 的全部后代（不含它自己）。根必须在 `rows` 里（也就是还活着），否则返回空 —— 拿不准就什么都不杀。
 * 「ppid 等于某个 pid」不够：那个 pid 可能是早已退出的旧进程、后来被复用了，所以还要求子进程不早于父进程创建。
 */
export function descendantsOf(rows: ProcRow[], rootPid: number): ProcRow[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const root = byPid.get(rootPid);
  if (!root) return [];
  const out: ProcRow[] = [];
  const seen = new Set<number>([rootPid]);
  const queue: ProcRow[] = [root];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const r of rows) {
      if (seen.has(r.pid) || r.ppid !== parent.pid || r.created < parent.created) continue;
      seen.add(r.pid);
      out.push(r);
      queue.push(r);
    }
  }
  return out;
}

/** 快照里的进程现在还活着的那些 —— pid **和**创建时间都要对得上（pid 被复用的新进程不算）。 */
export function stillAlive(snapshot: ProcRow[], now: ProcRow[]): ProcRow[] {
  const created = new Map(now.map((r) => [r.pid, r.created]));
  return snapshot.filter((r) => created.get(r.pid) === r.created);
}

const PS_LIST = 'Get-CimInstance Win32_Process | ForEach-Object { '
  + '"$($_.ProcessId)`t$($_.ParentProcessId)`t$(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 })" }';

/** 列出本机全部进程（只在 Windows 上用）。失败返回 null —— 调用方据此什么都不杀。 */
export function listWindowsProcesses(timeoutMs = 4000): Promise<ProcRow[] | null> {
  return new Promise((resolve) => {
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_LIST], {
        encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: timeoutMs,
      }, (err, stdout) => {
        if (err) { resolve(null); return; }
        const rows = parseProcRows(String(stdout));
        resolve(rows.length ? rows : null);
      });
    } catch { resolve(null); }
  });
}

/** `taskkill /PID <pid> /T /F`：结束这个进程和它下面的整棵树。等它做完（或失败）再返回，不抛错。 */
export function taskkillTree(pid: number, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) { resolve(); return; }
    try {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: timeoutMs }, () => resolve());
    } catch { resolve(); }
  });
}

/** `taskkill /PID <pid> /F`：只结束这一个进程（不带 /T）。不抛错。 */
export function taskkillOne(pid: number, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) { resolve(); return; }
    try {
      execFile('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true, timeout: timeoutMs }, () => resolve());
    } catch { resolve(); }
  });
}

/** FileTimeUtc（100ns，从 1601 年起）→ Unix 毫秒。 */
export function fileTimeToMs(ft: number): number {
  return ft / 10_000 - 11_644_473_600_000;
}

/**
 * 这一行是不是**我们自己起的那个**执行器：pid 对上还不够（Windows 会复用 pid，旧执行器退出后同一个 pid
 * 可能已经是别的会话的 kiro-cli），创建时间还必须落在我们调用 spawn 的那一刻附近。
 */
export function isSpawnedProcess(row: ProcRow | undefined, spawnedAtMs: number | undefined): boolean {
  if (!row || !spawnedAtMs || !row.created) return false;
  const created = fileTimeToMs(row.created);
  return created >= spawnedAtMs - 2_000 && created <= spawnedAtMs + 15_000;
}

export type ExecutorHandle = { pid?: number; exitCode: number | null; signalCode: string | null };
export type TreeDeps = {
  list: () => Promise<ProcRow[] | null>;
  /** 结束这个 pid 和它下面的整棵树（`taskkill /T /F`）——只用在刚核对过身份的执行器本身 */
  kill: (pid: number) => Promise<void>;
  /** 只结束这一个 pid（`taskkill /F`，不带 /T） */
  killOne: (pid: number) => Promise<void>;
};
export type SessionTree = { root: ProcRow; children: ProcRow[] };

const hasExited = (p: ExecutorHandle) => p.exitCode !== null || p.signalCode !== null;

/**
 * 趁执行器还活着，拍下「它自己 + 它下面的进程」。
 * 执行器已经退出、拿不到进程列表、或者那个 pid 现在属于别的进程（创建时间对不上）→ 返回 null，什么都不认。
 */
export async function snapshotExecutorTree(proc: ExecutorHandle, spawnedAtMs: number | undefined, deps: TreeDeps): Promise<SessionTree | null> {
  if (!proc.pid || hasExited(proc)) return null;
  const rows = await deps.list();
  if (!rows || hasExited(proc)) return null;
  const root = rows.find((r) => r.pid === proc.pid);
  if (!isSpawnedProcess(root, spawnedAtMs)) return null;
  return { root: root!, children: descendantsOf(rows, root!.pid) };
}

/**
 * 执行器不肯退出、要强杀时：根还是**同一个进程**（pid + 创建时间都对得上）才 `taskkill /T` 整棵树；
 * 否则返回 false，调用方退回 `proc.kill()`（走的是 Node 自己的进程句柄，不会打到复用了 pid 的别人）。
 */
export async function forceKillExecutorTree(proc: ExecutorHandle, tree: SessionTree | null, deps: TreeDeps): Promise<boolean> {
  if (!tree || hasExited(proc)) return false;
  const now = await deps.list();
  if (!now || stillAlive([tree.root], now).length === 0) return false;
  await deps.kill(tree.root.pid);
  return true;
}

/**
 * 执行器退出之后，把快照里还活着的子进程收掉。
 *
 * **每结束一个之前都重新核对身份**：结束一个进程要花时间，这期间别的子进程可能已经随之退出、它的 pid
 * 又被别的会话拿去了 —— 只在循环前核对一次，后面就会照着旧 pid 杀到别人。所以每一轮都重新列一次进程，
 * 只挑 pid **和**创建时间都还对得上的那一个；已经没了的、pid 被复用的一律跳过。
 * 一次只结束一个（`killOne`，不带 `/T`）：`/T` 会让 taskkill 自己按 ppid 往下找，那一串没经过我们的核对。
 * 快照之后才起的孙进程也算：它是某个核对过的本会话进程的后代（`descendantsOf` 同样核对创建时间）。
 */
export async function sweepExecutorChildren(tree: SessionTree | null, deps: TreeDeps): Promise<number[]> {
  if (!tree || !tree.children.length) return [];
  const killed: number[] = [];
  const handled = new Set<string>();
  const key = (r: ProcRow) => `${r.pid}@${r.created}`;
  let known: ProcRow[] = tree.children;
  for (let round = 0; round < 64; round++) {
    const now = await deps.list();
    if (!now) break;
    const alive = stillAlive(known, now);
    // 核对过的本会话进程，加上它们现在的后代（快照之后才起的）
    const byKey = new Map<string, ProcRow>();
    for (const r of alive) {
      byKey.set(key(r), r);
      for (const d of descendantsOf(now, r.pid)) byKey.set(key(d), d);
    }
    known = [...byKey.values()];
    const target = known.find((r) => !handled.has(key(r)));
    if (!target) break;
    handled.add(key(target));
    await deps.killOne(target.pid);
    killed.push(target.pid);
  }
  return killed;
}
