/**
 * 审计 10b：分叉 / 复制会话不带源会话的机器 —— 远程会话分叉后首条消息落到「新会话默认机器」上。
 * 这里是纯函数那一半；源码接线见 tests/claudeFeatureAudit.test.ts 的 10b。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { durableRemoteId } from '../src/main/coldRecord.ts';
import { forkRemoteIntent, firstSendRemoteId, forkMachineMissingText, restoredForkIntents } from '../src/renderer/forkTarget.ts';

const targets = [
  { id: 'tokyo-arm', sshHost: 'ec2-user@tokyo', sshPort: 22 },
  { id: 'oregon', sshHost: 'ubuntu@oregon', sshPort: 2222 },
];

describe('durableRemoteId：listDurableSessions 给每条会话带出机器的 id', () => {
  test('本地会话：不带 id', () => {
    assert.deepEqual(durableRemoteId(undefined, targets), {});
    assert.deepEqual(durableRemoteId({ sshHost: '' }, targets), {});
  });
  test('记录里存的 id 还在设置里：原样带出', () => {
    assert.deepEqual(durableRemoteId({ id: 'tokyo-arm', sshHost: 'ec2-user@tokyo' }, targets), { remoteId: 'tokyo-arm' });
  });
  test('老记录没存 id：按 host + 端口认回设置里那台', () => {
    assert.deepEqual(durableRemoteId({ sshHost: 'ubuntu@oregon', sshPort: 2222 }, targets), { remoteId: 'oregon' });
    /* 端口不同不是同一台 */
    assert.equal(durableRemoteId({ sshHost: 'ubuntu@oregon' }, targets).remoteMissing, true);
  });
  test('机器在设置里已经删掉：带出原来的 id 并标 remoteMissing，不换成别的机器', () => {
    assert.deepEqual(durableRemoteId({ id: 'gone', sshHost: 'root@gone' }, targets), { remoteId: 'gone', remoteMissing: true });
    assert.deepEqual(durableRemoteId({ sshHost: 'root@gone' }, targets), { remoteId: 'root@gone', remoteMissing: true });
  });
  test('旧 id 已删除、但另一个目标地址相同：不换成那一个，标 remoteMissing（复审意见）', () => {
    const list = [...targets, { id: 'replacement', sshHost: 'root@same', sshPort: 22 }];
    assert.deepEqual(durableRemoteId({ id: 'deleted-source', sshHost: 'root@same' }, list), { remoteId: 'deleted-source', remoteMissing: true });
    /* 查得到的 resolver（findRemoteTarget）认不出它也一样 */
    assert.deepEqual(durableRemoteId({ id: 'deleted-source', sshHost: 'root@same' }, list, () => undefined), { remoteId: 'deleted-source', remoteMissing: true });
    /* 没存 id 的老记录才按地址认 */
    assert.deepEqual(durableRemoteId({ sshHost: 'root@same' }, list), { remoteId: 'replacement' });
  });
  test('同 host:port 去重掉的那条 id（机器没删）：按 resolver 认到留下来的那条', () => {
    const resolve = (id: string) => (id === 'tokyo-dup' ? { id: 'tokyo-arm' } : undefined);
    assert.deepEqual(durableRemoteId({ id: 'tokyo-dup', sshHost: 'ec2-user@tokyo' }, targets, resolve), { remoteId: 'tokyo-arm' });
  });
});

describe('forkRemoteIntent：分叉记进 intendedRemoteRef 的机器', () => {
  test('本地源会话：明确记成本机（空串），不是「没记」', () => {
    assert.deepEqual(forkRemoteIntent({}), { remoteId: '' });
  });
  test('远程源会话：记它的 remote id', () => {
    assert.deepEqual(forkRemoteIntent({ remoteId: 'tokyo-arm', remoteHost: 'tokyo-arm' }), { remoteId: 'tokyo-arm' });
  });
  test('源会话的机器已删：仍记原来的 id（建后端时会报找不到，不悄悄换），并给出要提示的机器名', () => {
    assert.deepEqual(forkRemoteIntent({ remoteId: 'gone', remoteHost: 'gone-box', remoteMissing: true }), { remoteId: 'gone', missingHost: 'gone-box' });
  });
  test('只有显示名、没有 id（认不出是哪台）：同样当找不回处理', () => {
    assert.deepEqual(forkRemoteIntent({ remoteHost: 'tokyo-arm' }), { remoteId: 'tokyo-arm', missingHost: 'tokyo-arm' });
  });
});

describe('firstSendRemoteId：首条消息建后端用哪台机器', () => {
  const fallback = () => 'default-box';
  test('记过的优先，哪怕记的是本机（空串）也不退回新会话默认机器', () => {
    const m = new Map([['pending_dup_1', ''], ['pending_dup_2', 'tokyo-arm']]);
    assert.equal(firstSendRemoteId(m, 'pending_dup_1', fallback), undefined);
    assert.equal(firstSendRemoteId(m, 'pending_dup_2', fallback), 'tokyo-arm');
  });
  test('没记过的（侧栏直接开出来的 pending 会话）照旧用新会话默认机器', () => {
    assert.equal(firstSendRemoteId(new Map(), 'pending_x', fallback), 'default-box');
    assert.equal(firstSendRemoteId(new Map(), null, fallback), 'default-box');
  });
});

test('机器已删的提示：复用 coldRecord 的说法（设置里已经没有这台机器），并让人右键改', () => {
  const zh = forkMachineMissingText('zh', 'gone-box');
  assert.match(zh, /gone-box/);
  assert.match(zh, /设置里已经没有这台机器/);
  assert.match(zh, /右键/);
  const en = forkMachineMissingText('en', 'gone-box');
  assert.match(en, /no longer in your settings/);
  assert.match(en, /right-click/);
});

test('kiro / Claude Code / Codex 三种引擎的源会话，分叉记的机器一样（机器和引擎各记各的）', () => {
  for (const engine of [undefined, 'kiro', 'claude', 'codex'] as const) {
    const src = { engine, remoteId: 'tokyo-arm', remoteHost: 'tokyo-arm' };
    assert.deepEqual(forkRemoteIntent(src), { remoteId: 'tokyo-arm' }, String(engine));
    assert.deepEqual(forkRemoteIntent({ engine }), { remoteId: '' }, String(engine));
  }
});

describe('分叉后没发消息就重启：首条消息仍用分叉记下的机器（复审意见）', () => {
  /* 模拟：分叉时写在行上的 → 行整份存进 kirolex-sessions → 重启后读回来 → 启动时灌回 intendedRemoteRef → 首条消息 */
  const restart = (rows: any[]) => {
    const persisted = JSON.parse(JSON.stringify(rows));
    const intended = new Map<string, string>();
    for (const r of restoredForkIntents(persisted)) intended.set(r.id, r.remoteId);
    return intended;
  };
  const defaultBox = () => 'default-box';
  const forkRow = (src: any, id: string) => {
    const f = forkRemoteIntent(src);
    return { id, title: 'fork', ...(src.remoteHost ? { remoteHost: src.remoteHost } : {}), ...(f.remoteId ? { remoteId: f.remoteId } : {}), ...(f.missingHost ? { remoteMissing: true } : {}), forkRemoteId: f.remoteId };
  };

  test('远程分叉：重启后还在源会话那台机器上', () => {
    const rows = [forkRow({ remoteId: 'tokyo-arm', remoteHost: 'tokyo-arm' }, 'pending_dup_r')];
    assert.equal(firstSendRemoteId(restart(rows), 'pending_dup_r', defaultBox), 'tokyo-arm');
  });
  test('本机分叉：重启后还是本机，不被默认机器顶掉', () => {
    const rows = [forkRow({}, 'pending_dup_l')];
    assert.equal(rows[0].forkRemoteId, '');
    assert.equal(firstSendRemoteId(restart(rows), 'pending_dup_l', defaultBox), undefined);
  });
  test('机器已删的分叉：重启后仍带原来的 id（主进程据此拒绝），并要求再提示一次', () => {
    const rows = [forkRow({ remoteId: 'gone', remoteHost: 'gone-box', remoteMissing: true }, 'pending_dup_g')];
    assert.equal(firstSendRemoteId(restart(rows), 'pending_dup_g', defaultBox), 'gone');
    assert.deepEqual(restoredForkIntents(rows), [{ id: 'pending_dup_g', remoteId: 'gone', missingHost: 'gone-box' }]);
  });
  test('右键改过机器（记成本机 / 别的机器）后重启：按改过的', () => {
    const rows = [{ id: 'pending_dup_x', title: 'fork', forkRemoteId: '' }, { id: 'pending_dup_y', title: 'fork', remoteHost: 'oregon', remoteId: 'oregon', forkRemoteId: 'oregon' }];
    const m = restart(rows);
    assert.equal(firstSendRemoteId(m, 'pending_dup_x', defaultBox), undefined);
    assert.equal(firstSendRemoteId(m, 'pending_dup_y', defaultBox), 'oregon');
    assert.deepEqual(restoredForkIntents(rows).map((r) => r.missingHost), [undefined, undefined]);
  });
  test('只认 pending 行、而且记过的：已建后端的会话和没记过的不动（后者照旧用默认机器）', () => {
    const rows = [{ id: 's_1_abc', title: 'x', forkRemoteId: 'tokyo-arm' }, { id: 'pending_dup_old', title: 'y' }];
    assert.deepEqual(restoredForkIntents(rows), []);
    assert.equal(firstSendRemoteId(restart(rows), 'pending_dup_old', defaultBox), 'default-box');
  });
});
