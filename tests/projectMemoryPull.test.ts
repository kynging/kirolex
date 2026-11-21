/**
 * ☁ 占位下载回本机、勾了「放回原项目」：按恢复后的项目把云端的项目记忆拉回来（pullProjectMemory）。
 *
 * 现场：「恢复 s_1795074130812_oh3mz4：…放进「Blog」」之后 Blog 建出来了，但占位那条只下载 sessions/<id>/，
 * memory/projects/Blog/** 没回来。守的是：
 *   · 本机没有 → 直接写；本机有的 .md → mergeMemoryText 合并（本机原样保留、备份多出来的补在后面），改之前备份进 trash；
 *   · 本机有的非 .md 不动；
 *   · 只拉这个项目自己的前缀，越界的 key 不落盘；用的是调用方给的（占位记下的）前缀；
 *   · 接线：offloadRestoreImpl 勾了 putBack 才拉，前缀来自占位的 cloudKey，返回 memoryFiles。
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pullProjectMemory } from '../src/main/projectMemoryPull.ts';
import { keyFor, mergeMemoryText } from '../src/main/s3Sync.ts';

const tmp: string[] = [];
afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-mempull-')); tmp.push(d); return d; };

/** 假桶：key → 内容 */
const bucket = (objs: Record<string, string>) => {
  const listed: string[] = [];
  return {
    listed,
    ops: {
      list: async (p: string) => { listed.push(p); return Object.keys(objs).filter((k) => k.startsWith(p)).map((key) => ({ key })); },
      get: async (k: string) => (k in objs ? Buffer.from(objs[k]) : null),
    },
  };
};

describe('pullProjectMemory', () => {
  const PREFIX = 'mac-backup';
  const k = (rel: string) => keyFor(PREFIX, rel);

  test('本机没有 Blog 的记忆 → 整份写下来；只按这个项目的前缀列', async () => {
    const home = mk();
    const b = bucket({
      [k('memory/projects/Blog/memory.md')]: '# Blog\n- 用 Hugo\n',
      [k('memory/projects/Dev/memory.md')]: '# Dev\n',
    });
    const n = await pullProjectMemory({ ops: b.ops, home, prefix: PREFIX, project: 'Blog', trashDir: path.join(home, 'trash') });
    assert.equal(n, 1);
    assert.equal(fs.readFileSync(path.join(home, 'memory', 'projects', 'Blog', 'memory.md'), 'utf-8'), '# Blog\n- 用 Hugo\n');
    assert.ok(!fs.existsSync(path.join(home, 'memory', 'projects', 'Dev')), '别的项目不碰');
    assert.deepEqual(b.listed, [`${k('memory/projects/Blog')}/`], '用的是给的（占位记下的）前缀');
  });

  test('本机已有 → mergeMemoryText 合并，本机那份先进 trash；非 .md 不动', async () => {
    const home = mk();
    const dir = path.join(home, 'memory', 'projects', 'Blog');
    fs.mkdirSync(dir, { recursive: true });
    const mine = '# Blog\n- 本机后来教的\n';
    fs.writeFileSync(path.join(dir, 'memory.md'), mine);
    fs.writeFileSync(path.join(dir, 'memory.md.bak'), 'local bak');
    const theirs = '# Blog\n- 用 Hugo\n';
    const b = bucket({
      [k('memory/projects/Blog/memory.md')]: theirs,
      [k('memory/projects/Blog/memory.md.bak')]: 'cloud bak',
    });
    const trash = path.join(home, 'trash');
    const n = await pullProjectMemory({ ops: b.ops, home, prefix: PREFIX, project: 'Blog', trashDir: trash });
    assert.equal(n, 1);
    assert.equal(fs.readFileSync(path.join(dir, 'memory.md'), 'utf-8'), mergeMemoryText(mine, theirs), '和 s3:restore 同一个合并规则');
    assert.ok(fs.readFileSync(path.join(dir, 'memory.md'), 'utf-8').includes('本机后来教的'), '本机的不丢');
    assert.equal(fs.readFileSync(path.join(dir, 'memory.md.bak'), 'utf-8'), 'local bak');
    const backed = fs.readdirSync(trash, { recursive: true }).map(String).find((f) => f.endsWith('memory.md'));
    assert.ok(backed, '改之前的本机那份备份进 trash');
  });

  test('合并后没变化 → 不写', async () => {
    const home = mk();
    const dir = path.join(home, 'memory', 'projects', 'Blog');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'memory.md'), '# Blog\n- a\n');
    const b = bucket({ [k('memory/projects/Blog/memory.md')]: '# Blog\n- a\n' });
    assert.equal(await pullProjectMemory({ ops: b.ops, home, prefix: PREFIX, project: 'Blog', trashDir: path.join(home, 't') }), 0);
  });

  test('项目名带路径 / ..：什么都不拉', async () => {
    const home = mk();
    const b = bucket({ [k('memory/projects/x/memory.md')]: 'x' });
    for (const bad of ['../x', 'a/b', 'a\\b', '..', '']) {
      assert.equal(await pullProjectMemory({ ops: b.ops, home, prefix: PREFIX, project: bad, trashDir: path.join(home, 't') }), 0, bad);
    }
    assert.deepEqual(b.listed, []);
  });
});

describe('接线：☁ 占位下载回本机（offloadRestoreImpl）', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const at = M.indexOf('async function offloadRestoreImpl(');
  const body = M.slice(at, M.indexOf('\n}\n', at));

  test('勾了 putBack 才按恢复后的项目拉记忆；前缀用占位的 cloudKey；返回 memoryFiles', () => {
    assert.ok(body.includes("const placedProject = String(placedNow?.profile?.projectId || '').trim();"));
    assert.ok(body.includes('if (opts?.putBack && placedProject && !store.isAdvancedOnlyProjectName(placedProject))'));
    assert.ok(body.includes('const memPrefix = prefixFromCloudKey(placeholder.cloudKey, id);'));
    assert.ok(body.includes('memoryFiles = await pullProjectMemory({'));
    assert.ok(body.includes('prefix: memPrefix, project: placedProject,'));
    assert.ok(body.includes('ok: true, restored: r.files, backedUp: null, memoryFiles, madeLocal'));
    assert.ok(!body.includes('memoryFiles: 0,'), '不再写死 0');
    /* 先建项目、写好位置，再按写好之后的记录拉 */
    assert.ok(body.indexOf('ensureLocalProject(origin,') < body.indexOf('memoryFiles = await pullProjectMemory({'));
  });
});
