/**
 * **把云端某个项目的记忆拉回本机** —— ☁ 占位下载回本机时用（`index.ts` 的 `offloadRestoreImpl`）。
 *
 * 「勾了放回 Blog，Blog 是建出来了，Blog 的项目记忆却没回来」：占位那条只下载 `sessions/<id>/`，
 * 项目记忆在 `memory/projects/<项目>/` 下。规则和 `s3:restore` 拉记忆那段一样：
 *   · 本机没有的文件：直接写；
 *   · 本机有的 `.md`：`mergeMemoryText`（本机原样保留，备份里多出来的行补在后面），没变化就不写；
 *   · 本机有的别的文件（`.bak` 等）：不动；
 *   · 改之前把本机那份复制进 `trashDir`（同一条会话的回收站目录）。
 * 云端前缀由调用方给（占位记下的那一个，不用现在设置里的）。不 import electron，测试直接调。
 */
import fs from 'fs';
import path from 'path';
import { keyFor, relFor, mergeMemoryText } from './s3Sync.ts';

export interface MemoryPullOps {
  list(prefix: string): Promise<Array<{ key: string }>>;
  /** 不存在返回 null */
  get(key: string): Promise<Buffer | null>;
}

export async function pullProjectMemory(o: {
  ops: MemoryPullOps;
  /** `~/.kirolex` */
  home: string;
  prefix: string | undefined;
  project: string;
  /** 本机那份被改之前复制到这里 */
  trashDir: string;
}): Promise<number> {
  const project = String(o.project || '').trim();
  if (!project || /[\\/]/.test(project) || project.includes('..')) return 0;
  const root = path.resolve(o.home, 'memory', 'projects', project);
  const pfx = `${keyFor(o.prefix, path.join('memory', 'projects', project))}/`;
  let files = 0;
  for (const obj of await o.ops.list(pfx)) {
    if (!obj.key.startsWith(pfx)) continue;
    const rel = relFor(o.prefix, obj.key);
    if (!rel) continue;
    const abs = path.resolve(o.home, rel);
    /* 只许落在这个项目自己的记忆目录下（key 是远端来的数据） */
    if (abs !== root && !abs.startsWith(root + path.sep)) continue;
    const body = await o.ops.get(obj.key);
    if (!body) continue;
    const local = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : null;
    let next: string | Buffer | null;
    if (local === null) next = body;
    else if (rel.endsWith('.md')) {
      const m = mergeMemoryText(local, body.toString('utf-8'));
      next = m === local ? null : m;
    } else next = null;
    if (next === null) continue;
    if (local !== null) {
      const dest = path.join(o.trashDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, dest);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, next);
    files += 1;
  }
  return files;
}
