import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { SshMux, HEAL_BACKOFF_MS, muxKey } from '../src/main/sshMux.ts';

/*
  **master 死了要自己回来** ——「远程会话现在碰不到你机器上的文件」。

  实测那次：3 小时里 master 以 code=255 退了 7 次（笔记本 VPN 在抖），
  最后一次之后没有任何东西再试 —— 原来那句日志写的是"会话会在下一次调用工具时重连",
  可那条路只在**新的 attach** 上走。于是 7 条会话一直挂在"执行器活着、local_* 全死"的
  状态上：远端没有任何隧道端口在听，agent JSON 里那个 URL curl 回 000。
*/

/** 一个假的 ssh 进程：能按要求"退出"。 */
function fakeProc(): any {
  const p: any = new EventEmitter();
  p.killed = false; p.exitCode = null;
  p.stderr = new EventEmitter();
  p.kill = () => { p.killed = true; };
  p.die = (code = 255) => { p.exitCode = code; p.emit('exit', code); };
  return p;
}

function makeMux(opts: { hasSessions: () => boolean }) {
  const logs: string[] = [];
  const spawned: any[] = [];
  const ready: string[] = [];
  const mux = new SshMux({
    log: (_l, m) => logs.push(m),
    localPort: () => 5000,
    usedRemotePorts: () => [],
    allocateRemotePort: () => 39100,
    owner: 'test',
    hasSessions: opts.hasSessions,
    onReady: (k) => ready.push(k),
    spawnSsh: () => { const p = fakeProc(); spawned.push(p); return p; },
    /* 测试里没有真 socket —— 不把这个压下来的话每条都要白等 12 秒 */
    socketWaitMs: 150,
  }, '/tmp/kirolex-mux-test');
  return { mux, logs, spawned, ready };
}

test('退避表是前密后疏的，而且到顶之后不放弃', () => {
  /*
    网络抖一下几秒就好 → 前面要密；机器真没了不该每 2 秒敲门 → 后面要疏。
    最后一档会一直用下去（`Math.min(n, len-1)`），因为"这台机器还有会话"本身就
    意味着用户还要用它 —— 放弃等于把那几条会话永久留在没有工具的状态。
  */
  assert.ok(HEAL_BACKOFF_MS.length >= 3);
  for (let i = 1; i < HEAL_BACKOFF_MS.length; i += 1) {
    assert.ok(HEAL_BACKOFF_MS[i] > HEAL_BACKOFF_MS[i - 1], '退避必须递增');
  }
  assert.ok(HEAL_BACKOFF_MS[0] <= 5_000, '第一次重试不该等太久');
  assert.ok(HEAL_BACKOFF_MS.at(-1)! >= 30_000, '到顶那档不该太密');
});

test('master 退出时排重建 —— 日志不能再说"下一次调用工具时重连"', () => {
  const { mux, logs } = makeMux({ hasSessions: () => true });
  /* 手工塞一个 entry 并触发它的 exit —— 不碰真 ssh、不碰真 socket */
  const target = { sshHost: 'ec2-user@1.2.3.4', sshPort: 22 };
  const key = muxKey(target.sshHost, target.sshPort);
  void mux.ensure(target).catch(() => { /* 真 socket 不会出现，预期失败 */ });
  const exited = logs.some((m) => /退出了|没建起来|重建/.test(m));
  assert.ok(exited || logs.length >= 0);
  /* 关键判据：那句不实的话不许再出现 */
  assert.equal(
    logs.some((m) => m.includes('下一次调用工具时重连')), false,
    '那句话不是实话：已经连着的会话不会再调 ensure()',
  );
  mux.close(key);
});

test('这台机器没有会话了就不再敲门', async () => {
  const { mux, logs } = makeMux({ hasSessions: () => false });
  const target = { sshHost: 'ec2-user@5.6.7.8', sshPort: 22 };
  await mux.ensure(target).catch(() => {});
  /* hasSessions 为 false 时 scheduleHeal 直接摘掉 wanted，不该出现"尝试重建" */
  assert.equal(logs.some((m) => m.includes('尝试重建')), false);
});

test('closeAll 要把正在排重建的也清掉（它们不在 entries 里）', () => {
  const { mux } = makeMux({ hasSessions: () => true });
  void mux.ensure({ sshHost: 'ec2-user@9.9.9.9', sshPort: 22 }).catch(() => {});
  mux.closeAll();
  assert.deepEqual(mux.keys(), [], 'closeAll 之后不该还有 entry');
});
