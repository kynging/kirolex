import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

/**
 * 「为什么我把会话移出项目，它又自己跑回去了」。
 *
 * "从来没归过项目"和"我刚把它移出来"在盘上长得一模一样（`projectId` 都是 undefined），
 * 而 attach 对没有 projectId 的会话会按目录（老记录的 `localDir`）反推一个。对前者这是对的，
 * 对后者就是把你的操作撤销掉 —— "移出项目"还会 `detachExecutor`，下一次 attach 立刻到来。
 */
describe('移出项目要留得住', () => {
  const MAIN = read('src/main/index.ts');
  const CFG = read('src/main/config.ts');
  const handler = (name: string, len = 1800) => {
    const at = MAIN.indexOf(`ipcMain.handle('${name}'`);
    assert.ok(at > 0, `找不到 ${name}`);
    return MAIN.slice(at, at + len);
  };

  test('profile 上多一个字段区分"我移出来的"和"从来没归过"', () => {
    assert.match(CFG, /unassigned\?: true;/);
  });

  test('attach 不再无条件反推', () => {
    assert.match(MAIN, /existing\?\.profile\.projectId \?\? \(existing\?\.profile\.unassigned \? undefined : derived\)/);
    /* 会话创建时照旧反推：在项目目录里开的新对话本来就属于那个项目 */
    assert.ok(MAIN.includes('projectId: projectId ?? derived,'), '创建那处保持原样');
  });

  test('attach 的 profile 白名单带上这个标记 —— 否则下一次把 entry.profile 写回记录就丢了', () => {
    assert.match(MAIN, /existing\?\.profile\.unassigned \? \{ unassigned: true as const \} : \{\}/);
  });

  test('两条"移出去"的路都记这一笔', () => {
    for (const h of ['acp:set-project', 'acp:move-session']) {
      assert.match(handler(h), /if \(projectId\) delete rec\.profile\.unassigned; else rec\.profile\.unassigned = true;/, h);
    }
  });

  test('活着的执行器在 set-project 时也跟着改', () => {
    assert.match(handler('acp:set-project'), /if \(projectId\) delete entry\.profile\.unassigned; else entry\.profile\.unassigned = true;/);
  });

  /*
    回复跑到一半移出项目：move-session 只改盘（这一轮继续用旧的 memory scope，活着的 entry 还是旧项目）。
    这一轮里若撞上「模型不可用」自动换模型，swapSessionModel 会把 entry.profile 整份写回记录 ——
    不挡的话旧 projectId 回到盘上、unassigned 被抹掉，随后的重置 + attach 又把它归回旧项目。
  */
  test('运行中移出 → 自动换模型写回记录 → 重新挂载：仍然是未分组', async () => {
    const { keepRecordPlacement } = await import('../src/main/config.ts');
    const live = { model: 'claude-opus-5', permissionMode: 'auto-approve', projectId: 'Dev' } as any;
    const onDisk = { model: 'claude-opus-5', permissionMode: 'auto-approve', unassigned: true } as any;
    const written = keepRecordPlacement({ ...live, model: 'gpt-5.6-sol' }, onDisk);
    assert.equal(written.model, 'gpt-5.6-sol', '换模型本身照常写');
    assert.equal(written.projectId, undefined, '旧项目不能写回去');
    assert.equal(written.unassigned, true, '移出标记不能被抹掉');
    assert.ok(!('projectId' in written), '不留 projectId: undefined 这种空键');
    /* 重新挂载时 attach 的那一行：有 unassigned 就不按目录反推 */
    const attachProject = (existing: any, derived: string | undefined) =>
      existing?.profile.projectId ?? (existing?.profile.unassigned ? undefined : derived);
    assert.equal(attachProject({ profile: written }, 'Dev'), undefined);
    /* 反过来：运行中指派进项目，盘上的新项目也要保住，不能被旧的 unassigned 盖回去 */
    const moved = keepRecordPlacement({ ...onDisk, model: 'x' }, { projectId: 'Research' } as any);
    assert.equal(moved.projectId, 'Research');
    assert.ok(!('unassigned' in moved));
    /* 记录不存在（新建）时原样写 */
    assert.deepEqual(keepRecordPlacement(live, undefined), live);
  });

  test('自动换模型写回记录时用的是盘上的项目归属，活着的执行器仍沿用这一轮的旧 scope', () => {
    const at = MAIN.indexOf('async function swapSessionModel(');
    assert.ok(at > 0);
    const body = MAIN.slice(at, MAIN.indexOf('\n}\n', at));
    assert.match(body, /rec\.profile = keepRecordPlacement\(profile, rec\.profile\);/);
    /* 内存里的 entry 不跟着改 —— 这一轮剩下的部分按 move-session 的设计仍用旧范围 */
    assert.match(body, /\.\.\.entry, client, profile, lastUsedAt/);
  });

  test('指派给项目就清掉，活着的执行器也清', () => {
    const body = handler('acp:assign-project', 1000);
    assert.match(body, /delete rec\.profile\.unassigned;/);
    assert.match(body, /delete entry\.profile\.unassigned;/);
  });
});
