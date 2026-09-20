import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseRemoteTargets, listRemoteTargets, findRemoteTarget, deriveLabel, expandHome } from '../src/main/remoteTargets.ts';
import { RemoteSyncManager, type SyncStatus, type MirrorLike } from '../src/main/remoteSync.ts';
import type { PullResult } from '../src/main/remoteMirror.ts';

/*
 * 「混用粒度按会话选」。所以配置给的是一个**列表**，而不是一个全局开关 ——
 * 老形状 `agents[].remote.enabled` 正是那个要换掉的开关（改一次影响所有会话）。
 */
describe('可选远端的解析', () => {
  test('新形状 remotes[]：缺省值补齐，`~` 展开', () => {
    const [t] = parseRemoteTargets({
      remotes: [{ id: 'tokyo', label: 'tokyo-ec2', sshHost: 'ec2-user@1.2.3.4', identityFile: '~/k.pem' }],
    }, '/home/me');
    assert.equal(t.id, 'tokyo');
    assert.equal(t.label, 'tokyo-ec2');
    assert.equal(t.sshPort, 22);
    assert.equal(t.identityFile, '/home/me/k.pem', '配置里写 ~ 的人不该因此连不上');
  });

  test('**兼容读**老的 agents[].remote —— 用户配置里现在就是这个形状', () => {
    /* 实测那份配置：agents[0].remote = { enabled: false, sshHost: 'ec2-user@99.83.165.184', … } */
    const list = parseRemoteTargets({
      agents: [{ id: 'agent_1', remote: { enabled: false, sshHost: 'ec2-user@9.9.9.9', sshPort: 22 } }],
    });
    assert.equal(list.length, 1, '不兼容读的话得手改配置才能用');
    assert.equal(list[0].id, 'agent_1');
    assert.equal(list[0].label, '9.9.9.9');
  });

  test('`enabled: false` 照样出现在列表里 —— 那个字段原来的意思是"全局开关关着"', () => {
    /* 现在选不选由会话决定，所以它不再能决定一台机器要不要能被选中 */
    const list = parseRemoteTargets({ agents: [{ id: 'a', remote: { enabled: false, sshHost: 'u@h' } }] });
    assert.equal(list.length, 1);
  });

  test('同一台机器不出现两遍 —— 出现两遍人只会怀疑自己选错了', () => {
    const list = parseRemoteTargets({
      remotes: [{ id: 'new', sshHost: 'u@h', sshPort: 22 }],
      agents: [{ id: 'old', remote: { sshHost: 'u@h', sshPort: 22 } }],
    });
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'new', '新形状优先');
  });

  test('没有 sshHost 的条目直接不要 —— 放进列表等于给一个选了必然失败的选项', () => {
    assert.deepEqual(parseRemoteTargets({ remotes: [{ id: 'x' }, { id: 'y', sshHost: '  ' }] }), []);
  });

  test('label 默认取 host（用户名不是用来区分机器的）', () => {
    assert.equal(deriveLabel('ec2-user@1.2.3.4'), '1.2.3.4');
    assert.equal(deriveLabel('devbox'), 'devbox');
    assert.equal(deriveLabel(''), 'remote');
  });

  test('~ 展开只动开头', () => {
    assert.equal(expandHome('~', '/h'), '/h');
    assert.equal(expandHome('~/a/b', '/h'), path.join('/h', 'a/b'));
    assert.equal(expandHome('/abs/~/x', '/h'), '/abs/~/x');
    assert.equal(expandHome(undefined), undefined);
  });

  test('配置坏了返回空 —— 不该让"新建会话"整个不能用', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rt-')), 'config.json');
    fs.writeFileSync(f, '{ not json');
    assert.deepEqual(listRemoteTargets(f), []);
    assert.equal(findRemoteTarget(f, 'tokyo'), undefined);
  });

  test('按 id 找不到就返回 undefined —— **不猜**一台机器', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt2-'));
    const f = path.join(dir, 'config.json');
    fs.writeFileSync(f, JSON.stringify({ remotes: [{ id: 'a', sshHost: 'u@h' }, { id: 'b', sshHost: 'u@h2' }] }));
    assert.equal(findRemoteTarget(f, 'a')?.sshHost, 'u@h');
    assert.equal(findRemoteTarget(f, 'zzz'), undefined);
    assert.equal(findRemoteTarget(f, undefined), undefined);
  });
});

/*
 * 状态要显出来，否则 `stale`（本地不是最新的）就只存在于日志里 —— 而那正是最不能沉默的一件事。
 */
describe('同步状态推给界面', () => {
  function mgr(pull: () => Promise<PullResult>) {
    const seen: SyncStatus[] = [];
    const m = new RemoteSyncManager({
      note: () => {}, log: () => {}, onStatus: (s) => seen.push(s), schedule: (fn) => fn(),
    });
    const project: MirrorLike = {
      localDir: '/l', remoteDir: '/r',
      push: async () => ({ ok: true, snapshot: {}, ms: 1 }),
      pull,
    };
    m.register({ sessionId: 's1', project, hostLabel: 'tokyo' });
    return { m, seen };
  }

  test('推/拉/空闲依次报出来', async () => {
    const { m, seen } = mgr(async () => ({ ok: true, changed: ['a'], conflicts: [], ms: 1 }));
    await m.beforeTurn('s1');
    await m.afterTurn('s1');
    assert.deepEqual(seen.map((s) => s.state), ['pushing', 'idle', 'pulling', 'idle']);
    assert.equal(seen[0].hostLabel, 'tokyo');
  });

  test('拉失败报 stale + 原因 —— 界面靠它显警告色', async () => {
    const { m, seen } = mgr(async () => ({ ok: false, error: 'ssh timeout', changed: [], conflicts: [], ms: 1 }));
    await m.afterTurn('s1');
    const last = seen[seen.length - 1];
    assert.equal(last.state, 'stale');
    assert.match(last.error!, /ssh timeout/);
    assert.equal(m.hasUnpulled('s1'), true);
  });

  test('冲突报 conflict + 文件清单', async () => {
    const { m, seen } = mgr(async () => ({ ok: true, changed: [], conflicts: ['src/a.ts'], ms: 1 }));
    await m.afterTurn('s1');
    const last = seen[seen.length - 1];
    assert.equal(last.state, 'conflict');
    assert.deepEqual(last.conflicts, ['src/a.ts']);
  });

  test('一轮里工具写十次文件只拉一次 —— 所以状态也只闪一次（防抖在 pullSoon 里）', async () => {
    const seen: SyncStatus[] = [];
    let pending: (() => void) | null = null;
    const m = new RemoteSyncManager({
      note: () => {}, log: () => {}, onStatus: (s) => seen.push(s), schedule: (fn) => { pending = fn; },
    });
    m.register({
      sessionId: 's1', hostLabel: 'tokyo',
      project: {
        localDir: '/l', remoteDir: '/r',
        push: async () => ({ ok: true, snapshot: {}, ms: 1 }),
        pull: async () => ({ ok: true, changed: [], conflicts: [], ms: 1 }),
      },
    });
    for (let i = 0; i < 10; i += 1) m.pullSoon('s1');
    (pending as any)?.();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen.map((s) => s.state), ['pulling', 'idle']);
  });

  test('再试一次又失败要**再报一次** —— 那不是重复，是"又试了一次还是不行"', async () => {
    const { m, seen } = mgr(async () => ({ ok: false, error: '一样的错', changed: [], conflicts: [], ms: 1 }));
    await m.afterTurn('s1');
    await m.afterTurn('s1');
    assert.deepEqual(seen.map((s) => s.state), ['pulling', 'stale', 'pulling', 'stale']);
  });

  test('statusOf 能被问到（界面重新挂载时只靠事件会丢状态）', async () => {
    const { m } = mgr(async () => ({ ok: false, error: 'x', changed: [], conflicts: [], ms: 1 }));
    assert.equal(m.statusOf('s1')?.state, 'idle', '还没同步过就是 idle');
    await m.afterTurn('s1');
    assert.equal(m.statusOf('s1')?.state, 'stale');
    assert.equal(m.statusOf('本地会话'), undefined);
  });

  test('注销之后不再报状态，也问不到', () => {
    const { m } = mgr(async () => ({ ok: true, changed: [], conflicts: [], ms: 1 }));
    m.forget('s1');
    assert.equal(m.statusOf('s1'), undefined);
  });
});

describe('接线：主进程', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const P = fs.readFileSync(path.join(process.cwd(), 'src/main/preload.ts'), 'utf8');

  test('目标按会话选：new-session 收 remoteId，不再读全局 active agent', () => {
    assert.match(M, /findRemoteTarget\(KIROLEX_CONFIG_PATH, remoteId\)/);
    assert.equal(/loadActiveRemoteTarget\(/.test(M), false, '全局开关那条路必须断掉，否则"共存"是假的');
  });

  test('flag 关着时列表是空的 —— 界面据此完全不显示目标选择', () => {
    const at = M.indexOf("ipcMain.handle('app:remote-targets'");
    assert.ok(at > 0);
    assert.match(M.slice(at, at + 400), /if \(!isFeatureEnabled\('remoteSessions'\)\) return \{ enabled: false, targets: \[\] \};/);
  });

  test('找不到那个 id 就不建会话（**不猜**一台机器）', () => {
    assert.match(M, /找不到远端目标/);
  });

  test('状态既能订阅也能查', () => {
    assert.match(M, /mainWindow\?\.webContents\.send\('remote:sync', status\)/);
    assert.match(M, /ipcMain\.handle\('remote:status'/);
    assert.match(P, /onRemoteSync:/);
    assert.match(P, /remoteStatus:/);
    assert.match(P, /remoteTargets:/);
  });

  test('侧栏要的 host 跟着会话列表一起发出去', () => {
    assert.match(M, /remoteHost: deriveRemoteLabel\(rec\.profile\.remote\.sshHost\)/);
  });
});

describe('接线：渲染进程', () => {
  const A = fs.readFileSync(path.join(process.cwd(), 'src/renderer/App.tsx'), 'utf8');
  const SB = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/Sidebar.tsx'), 'utf8');
  const MAIN = fs.readFileSync(path.join(process.cwd(), 'src/renderer/main.tsx'), 'utf8');

  test('新建对话框里有目标选择，且**默认本地**', () => {
    assert.match(A, /remoteTargets\.enabled && remoteTargets\.targets\.length > 0/);
    assert.match(A, /<option value="">本地（这台 Mac）<\/option>/);
    assert.match(A, /useState\(''\);\s*\n\s*const remoteTargets = useRemoteTargets\(\);/);
  });

  test('创建时把选中的目标传下去', () => {
    assert.match(A, /remoteId: target\?\.id, remoteLabel: target\?\.label,/);
  });

  test('侧栏每行常驻机器徽标，warn 状态另一个样式', () => {
    assert.match(SB, /session\.remoteHost && \(/);
    assert.match(SB, /session-remote-warn/);
    assert.match(SB, /syncBadgeTitle\(session\.remoteHost, remoteSync\)/);
  });

  test('状态走 context（会话行有多个渲染点，逐层传 prop 迟早漏一个）', () => {
    assert.match(MAIN, /<RemoteSyncProvider>/);
    assert.match(SB, /useRemoteSyncFor\(session\.id, !!session\.remoteHost\)/);
  });
});
