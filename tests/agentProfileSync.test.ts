/**
 * `~/.kirolex/agent-profiles/` 跟着 S3 同步（`src/main/agentProfileSync.ts`）+ 接线（index.ts 的 S3 同步那一轮真的调了它）。
 *
 * 守的是：和 mcp-combos.json 一样跨电脑同步；**两边都改过时不静默覆盖任何一边**（桶里那份存成冲突副本）；
 * 冲突副本 / 临时文件不上传；上传带条件，别的电脑抢先传了就这一轮不传。
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  planProfileFile, syncProfileFiles, syncableRel, listLocalProfileFiles, listConflictCopies, contentHash,
  readProfileMarks, writeProfileMarks, type ProfileMarks, type ProfileSyncIo,
} from '../src/main/agentProfileSync.ts';

const tmps: string[] = [];
afterEach(() => { while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true }); });

/** 内存里的假桶 + 假磁盘。 */
function world(local: Record<string, string>, bucket: Record<string, string>, marks: ProfileMarks = {}) {
  const disk = new Map(Object.entries(local).map(([k, v]) => [k, Buffer.from(v)]));
  const objs = new Map(Object.entries(bucket).map(([k, v]) => [k, { body: Buffer.from(v), etag: `"${contentHash(v)}"` }]));
  const conflictsWritten: Array<[string, string]> = [];
  let m = { ...marks };
  let race = '';
  const io: ProfileSyncIo = {
    listRemote: async () => [...objs.keys()],
    get: async (rel) => objs.get(rel) || null,
    put: async (rel, body, cond) => {
      if (rel === race) return 'conflict';
      const cur = objs.get(rel);
      if ('ifMatch' in cond ? cur?.etag !== cond.ifMatch : !!cur) return 'conflict';
      objs.set(rel, { body, etag: `"${contentHash(body)}"` });
      return 'ok';
    },
    listLocal: () => [...disk.keys()],
    readLocal: (rel) => disk.get(rel),
    writeLocal: (rel, body) => { disk.set(rel, body); },
    writeConflictCopy: (rel, body) => { conflictsWritten.push([rel, body.toString()]); return `.conflicts/x/${rel}`; },
    readMarks: () => m,
    writeMarks: (x) => { m = x; },
  };
  return {
    io, disk, objs, conflictsWritten,
    marks: () => m,
    setRace: (rel: string) => { race = rel; },
    text: (rel: string) => disk.get(rel)?.toString(),
    bucketText: (rel: string) => objs.get(rel)?.body.toString(),
  };
}

describe('判据', () => {
  test('只有一边有 / 只有一边动过 → 用那一边；两边都动过 → 冲突；本机第一次同步、两边不同 → 冲突', () => {
    assert.equal(planProfileFile('a', undefined, undefined), 'upload');
    assert.equal(planProfileFile(undefined, 'b', undefined), 'pull');
    assert.equal(planProfileFile('a', 'a', undefined), 'none');
    assert.equal(planProfileFile('a2', 'b', { localHash: 'a', remoteHash: 'b' }), 'upload');
    assert.equal(planProfileFile('a', 'b2', { localHash: 'a', remoteHash: 'b' }), 'pull');
    assert.equal(planProfileFile('a2', 'b2', { localHash: 'a', remoteHash: 'b' }), 'conflict');
    assert.equal(planProfileFile('a', 'b', undefined), 'conflict');
    assert.equal(planProfileFile('a', 'b', { localHash: 'a', remoteHash: 'b' }), 'none');
  });

  test('冲突副本、隐藏文件、临时文件、越界路径都不同步', () => {
    assert.ok(syncableRel('claude/profile.json'));
    assert.ok(syncableRel('claude/rules/生产安全.md'));
    for (const r of ['.conflicts/1/claude/profile.json', 'claude/.DS_Store', 'claude/profile.json.123.tmp', '../x', 'claude/../../x', '/abs', 'a\\b']) assert.ok(!syncableRel(r), r);
  });
});

describe('一轮同步', () => {
  test('新电脑：桶里有、本机没有 → 拉下来', async () => {
    const w = world({}, { 'claude/profile.json': '{"v":1}', 'claude/rules/a.md': 'A' });
    const r = await syncProfileFiles(w.io);
    assert.deepEqual(r.pulled, ['claude/profile.json', 'claude/rules/a.md']);
    assert.equal(w.text('claude/profile.json'), '{"v":1}');
  });

  test('本机改了、桶里没动 → 传上去（带条件）', async () => {
    const base = '{"v":1}';
    const w = world({ 'claude/profile.json': '{"v":2}' }, { 'claude/profile.json': base }, { 'claude/profile.json': { localHash: contentHash(base), remoteHash: contentHash(base) } });
    const r = await syncProfileFiles(w.io);
    assert.deepEqual(r.uploaded, ['claude/profile.json']);
    assert.equal(w.bucketText('claude/profile.json'), '{"v":2}');
  });

  test('两边都改过 → 不覆盖任何一边：本机原样，桶里原样，桶里那份存成冲突副本；下一轮不重复报', async () => {
    const base = '{"v":1}';
    const w = world({ 'claude/profile.json': '{"v":"mac"}' }, { 'claude/profile.json': '{"v":"desktop"}' }, { 'claude/profile.json': { localHash: contentHash(base), remoteHash: contentHash(base) } });
    const r = await syncProfileFiles(w.io);
    assert.deepEqual(r.conflicts.map((c) => c.rel), ['claude/profile.json']);
    assert.deepEqual(w.conflictsWritten, [['claude/profile.json', '{"v":"desktop"}']]);
    assert.equal(w.text('claude/profile.json'), '{"v":"mac"}');
    assert.equal(w.bucketText('claude/profile.json'), '{"v":"desktop"}');
    const again = await syncProfileFiles(w.io);
    assert.deepEqual(again, { uploaded: [], pulled: [], conflicts: [], raced: [] });
    /* 之后本机再改一次（人看过冲突、挑好了）→ 正常传上去 */
    w.disk.set('claude/profile.json', Buffer.from('{"v":"merged"}'));
    assert.deepEqual((await syncProfileFiles(w.io)).uploaded, ['claude/profile.json']);
  });

  test('下载途中本机刚保存了新内容 → 不拉、不覆盖：按两边都改过处理（本机留着，桶里那份存冲突副本）', async () => {
    const base = '{"v":"old"}';
    const w = world({ 'claude/profile.json': base }, { 'claude/profile.json': '{"v":"new remote"}' }, { 'claude/profile.json': { localHash: contentHash(base), remoteHash: contentHash(base) } });
    const get = w.io.get;
    w.io.get = async (rel) => { w.disk.set(rel, Buffer.from('{"v":"new local save"}')); return get(rel); };
    const r = await syncProfileFiles(w.io);
    assert.deepEqual(r.pulled, []);
    assert.deepEqual(r.conflicts.map((c) => c.rel), ['claude/profile.json']);
    assert.equal(w.text('claude/profile.json'), '{"v":"new local save"}');
    assert.equal(w.bucketText('claude/profile.json'), '{"v":"new remote"}');
  });

  test('下载途中本机新建了原本不存在的文件 → 不覆盖它', async () => {
    const w = world({}, { 'codex/profile.json': '{"from":"bucket"}' });
    const get = w.io.get;
    w.io.get = async (rel) => { w.disk.set(rel, Buffer.from('{"mine":1}')); return get(rel); };
    const r = await syncProfileFiles(w.io);
    assert.deepEqual(r.pulled, []);
    assert.equal(w.text('codex/profile.json'), '{"mine":1}');
    assert.deepEqual(r.conflicts.map((c) => c.rel), ['codex/profile.json']);
  });

  test('决定要拉之后、写盘之前本机又变了 → 这一轮不写（第二道核对）', async () => {
    const base = '{"v":"old"}';
    const w = world({ 'claude/profile.json': base }, { 'claude/profile.json': '{"v":"new remote"}' }, { 'claude/profile.json': { localHash: contentHash(base), remoteHash: contentHash(base) } });
    let reads = 0;
    const read = w.io.readLocal;
    w.io.readLocal = (rel) => { reads += 1; if (reads === 2) w.disk.set(rel, Buffer.from('{"v":"just saved"}')); return read(rel); };
    const r = await syncProfileFiles(w.io);
    assert.deepEqual(r.pulled, []);
    assert.deepEqual(r.raced, ['claude/profile.json']);
    assert.equal(w.text('claude/profile.json'), '{"v":"just saved"}');
    assert.deepEqual(w.marks()['claude/profile.json'], { localHash: contentHash(base), remoteHash: contentHash(base) });
  });

  test('上传前别的电脑抢先传了 → 这个文件这一轮不传，摘要不更新', async () => {
    const w = world({ 'codex/profile.json': '{}' }, {});
    w.setRace('codex/profile.json');
    const r = await syncProfileFiles(w.io);
    assert.deepEqual(r.raced, ['codex/profile.json']);
    assert.equal(w.marks()['codex/profile.json'], undefined);
  });
});

describe('磁盘', () => {
  test('列本机文件：跳过 .conflicts 和隐藏文件；冲突副本单独列', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-agentprofiles-'));
    tmps.push(root);
    fs.mkdirSync(path.join(root, 'claude', 'rules'), { recursive: true });
    fs.mkdirSync(path.join(root, '.conflicts', '20261022-1', 'claude'), { recursive: true });
    fs.writeFileSync(path.join(root, 'claude', 'profile.json'), '{}');
    fs.writeFileSync(path.join(root, 'claude', 'rules', 'a.md'), 'A');
    fs.writeFileSync(path.join(root, 'claude', '.hidden'), 'x');
    fs.writeFileSync(path.join(root, '.conflicts', '20261022-1', 'claude', 'profile.json'), '{}');
    assert.deepEqual(listLocalProfileFiles(root), ['claude/profile.json', 'claude/rules/a.md']);
    assert.deepEqual(listConflictCopies(root), ['agent-profiles/.conflicts/20261022-1/claude/profile.json']);
    const mf = path.join(root, 'marks.json');
    writeProfileMarks(mf, { a: { localHash: '1', remoteHash: '2' } });
    assert.deepEqual(readProfileMarks(mf), { a: { localHash: '1', remoteHash: '2' } });
    assert.deepEqual(readProfileMarks(path.join(root, 'nope.json')), {});
  });
});

describe('接线：S3 同步那一轮包含 agent-profiles', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  test('runS3Sync 在组合文件旁边调了 syncAgentProfilesWithBucket', () => {
    const at = M.indexOf('async function runS3Sync(');
    assert.ok(at > 0);
    const body = M.slice(at, at + 20000);
    assert.ok(body.includes('syncMcpCombosWithBucket(creds!, cfg.prefix)'));
    assert.ok(body.includes('syncAgentProfilesWithBucket(creds!, cfg.prefix)'));
  });
  test('syncAgentProfilesWithBucket 用 syncProfileFiles，拉之前旧的进 trash，key 在 agent-profiles 下', () => {
    const at = M.indexOf('async function syncAgentProfilesWithBucket(');
    assert.ok(at > 0);
    const body = M.slice(at, at + 4000);
    assert.ok(body.includes('syncProfileFiles('));
    assert.ok(body.includes("'trash'"));
    assert.ok(body.includes('AGENT_PROFILES_REL'));
  });
});
