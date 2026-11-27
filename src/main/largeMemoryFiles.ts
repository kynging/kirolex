/**
 * 大份记忆整理（`largeMemory.ts`）用到的文件操作：同目录备份、撤销（用备份覆盖回去）、一天一次的账本。
 * 不 import electron；路径都由调用方传进来（测试用临时目录）。
 */
import fs from 'fs';
import path from 'path';
import { COMPACT_BACKUP_RE, compactBackupName } from './largeMemory.ts';

/** 每层留最近几份整理前的备份（一层一天最多自动整理一次，手动的另算）。 */
export const COMPACT_BACKUPS_KEPT = 7;

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * 把 `file`（某层的 memory.md）备份成同目录 `memory.md.bak-<YYYYMMDD-HHmm>`；同一分钟已有一份就加 `-2`、`-3`
 * （不能覆盖：那一份是更早那次整理的撤销点）。只留最近 `COMPACT_BACKUPS_KEPT` 份。返回备份路径，失败 / 没有可备份的返回 null。
 */
export function backupMemoryFile(file: string, now: Date, keep = COMPACT_BACKUPS_KEPT): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size === 0) return null;
    const dir = path.dirname(file);
    const base = compactBackupName(now);
    let dest = path.join(dir, base);
    for (let n = 2; fs.existsSync(dest); n += 1) dest = path.join(dir, `${base}-${n}`);
    fs.copyFileSync(file, dest);
    const all = fs.readdirSync(dir)
      .filter((n) => COMPACT_BACKUP_RE.test(n))
      .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => a.t - b.t || a.n.localeCompare(b.n));
    for (const { n } of all.slice(0, Math.max(0, all.length - keep))) {
      if (path.join(dir, n) === dest) continue;
      try { fs.rmSync(path.join(dir, n), { force: true }); } catch { /* best-effort */ }
    }
    return dest;
  } catch { return null; }
}

/**
 * 备份路径 → 它对应的那份 memory.md；不是我们写的备份（名字不对 / 不在 `<root>/sessions|projects/<id>/` 下）返回 null。
 * 全局层没有这种备份（全局不自动整理），所以 `<root>/` 顶层的一律不认。撤销 / 看差异只接受这里认得的路径。
 */
export function memoryFileForBackup(backupPath: string, memoryRoot: string): { file: string; scope: 'session' | 'project'; id: string } | null {
  const p = path.resolve(String(backupPath || ''));
  if (!COMPACT_BACKUP_RE.test(path.basename(p))) return null;
  const dir = path.dirname(p);
  const kindDir = path.dirname(dir);
  const root = path.resolve(memoryRoot);
  if (path.dirname(kindDir) !== root) return null;
  const kind = path.basename(kindDir);
  if (kind !== 'sessions' && kind !== 'projects') return null;
  return { file: path.join(dir, 'memory.md'), scope: kind === 'sessions' ? 'session' : 'project', id: path.basename(dir) };
}

/** 撤销：用备份覆盖回去（tmp + rename）。 */
export function restoreMemoryBackup(backupPath: string, memoryRoot: string): { ok: true; file: string } | { ok: false; error: string } {
  const target = memoryFileForBackup(backupPath, memoryRoot);
  if (!target) return { ok: false, error: 'not a memory compaction backup' };
  let text: string;
  try { text = fs.readFileSync(path.resolve(backupPath), 'utf-8'); } catch { return { ok: false, error: 'backup file is gone' }; }
  try { writeAtomic(target.file, text); } catch (err: any) { return { ok: false, error: String(err?.message || err) }; }
  return { ok: true, file: target.file };
}

export function readCompactLedger(file: string): Record<string, string> {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

/** 记下「这一层今天整理过了」—— 在开始整理**之前**记（先记账再做：失败 / 崩溃也不会同一天反复来）。 */
export function recordCompactDay(file: string, key: string, day: string): void {
  try {
    const ledger = readCompactLedger(file);
    ledger[key] = day;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, `${JSON.stringify(ledger, null, 2)}\n`);
  } catch { /* best-effort：记不上最多是今天再试一次 */ }
}
