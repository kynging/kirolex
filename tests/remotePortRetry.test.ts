import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AcpClient, setSpawnForTests } from '../src/main/acp-client.ts';
import {
  RemotePortRetry, isRemotePortsBusy, remotePortBusyOf, REMOTE_PORT_TRIES,
} from '../src/main/remotePortRetry.ts';
import { remotePortBusyFromStderr } from '../src/main/transientError.ts';

/*
  **远端反向端口被占：换端口重试同一个模型，不换模型候选** ——
  2026-11-07 实测：一次 attach 里 gpt-5.6-sol / gpt-5.6-terra / deepseek-3.2 三个候选都撞 39100
  （ssh exit 255 + `remote port forwarding failed for listen port 39100`），白等 ~30 秒后整体失败；
  下一次 attach 才换到 39101、成功。端口被占和模型无关。
*/

type LT = { remotePort: number; localPort: number; agentOverride: string };

const MAIN = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');

/** 和 `connectWithModelFallback` 的候选循环同一个形状（下面那条源码核对保证 index.ts 里真是这样写的） */
async function candidateLoop(
  candidates: string[],
  portRetry: RemotePortRetry<LT>,
  connect: (model: string, lt: LT | undefined) => Promise<string>,
  failed: string[],
): Promise<{ model: string; value: string }> {
  let localTools = portRetry.localTools;
  let lastError: any = null;
  for (let i = 0; i < candidates.length; i += 1) {
    const model = candidates[i];
    try {
      return { model, value: await connect(model, localTools) };
    } catch (err: any) {
      lastError = err;
      try {
        if (await portRetry.retryOnNewPort(err)) { localTools = portRetry.localTools; i -= 1; continue; }
      } catch (busy) {
        lastError = busy;
        break;
      }
      failed.push(model);
    }
  }
  throw lastError || new Error('No usable model: every candidate failed to start.');
}

/** 假执行器：端口在 `busy` 里就像 ssh 那样以 255 + 端口转发失败退出（错误上挂着 remotePortBusy） */
function fakeConnect(busy: Set<number>, attempts: Array<{ model: string; port: number }>) {
  return async (model: string, lt: LT | undefined) => {
    attempts.push({ model, port: lt!.remotePort });
    if (busy.has(lt!.remotePort)) {
      throw Object.assign(new Error(`SSH connection closed (ssh exit 255): remote port ${lt!.remotePort} is in use`), { remotePortBusy: lt!.remotePort });
    }
    return `${model}@${lt!.remotePort}`;
  };
}

/** 假 rearm：避开 avoid 从 39100 起分，跟 `allocateRemotePort` 一样 */
function fakeRearm(base: LT, avoided: number[][]) {
  return async (avoid: number[]): Promise<LT> => {
    avoided.push([...avoid]);
    let p = 39100;
    while (avoid.includes(p)) p += 1;
    return { ...base, remotePort: p };
  };
}

test('39100 被占 → 同一次 attach 里改用 39101 成功，只试了一个模型候选', async () => {
  const attempts: Array<{ model: string; port: number }> = [];
  const avoided: number[][] = [];
  const base = { remotePort: 39100, localPort: 5000, agentOverride: 'kirolex-local-x' };
  const portRetry = new RemotePortRetry<LT>({ localTools: base, rearm: fakeRearm(base, avoided) });
  const failed: string[] = [];
  const r = await candidateLoop(['gpt-5.6-sol', 'gpt-5.6-terra', 'deepseek-3.2'], portRetry, fakeConnect(new Set([39100]), attempts), failed);
  assert.deepEqual(r, { model: 'gpt-5.6-sol', value: 'gpt-5.6-sol@39101' });
  assert.deepEqual(attempts, [{ model: 'gpt-5.6-sol', port: 39100 }, { model: 'gpt-5.6-sol', port: 39101 }]);
  assert.deepEqual(new Set(attempts.map((a) => a.model)).size, 1, '只尝试了一个模型候选');
  assert.deepEqual(failed, [], '没有任何模型候选被判失败');
  assert.deepEqual(avoided, [[39100]], '换端口时把被占的那个排除掉');
  assert.equal(portRetry.localTools!.remotePort, 39101, '调用方拿到的是新端口那份本地工具');
});

test('一直被占：最多换 REMOTE_PORT_TRIES 个端口，报端口问题并列出试过的端口，不去试别的模型', async () => {
  const attempts: Array<{ model: string; port: number }> = [];
  const base = { remotePort: 39100, localPort: 5000, agentOverride: 'a' };
  const portRetry = new RemotePortRetry<LT>({ localTools: base, rearm: fakeRearm(base, []) });
  const busy = new Set(Array.from({ length: 20 }, (_, i) => 39100 + i));
  const failed: string[] = [];
  await assert.rejects(candidateLoop(['m1', 'm2', 'm3'], portRetry, fakeConnect(busy, attempts), failed), (err: any) => {
    assert.ok(isRemotePortsBusy(err));
    assert.deepEqual(err.ports, [39100, 39101, 39102, 39103, 39104]);
    assert.match(err.message, /39100, 39101, 39102, 39103, 39104/);
    assert.match(err.message, /端口|port/i);
    assert.doesNotMatch(err.message, /model|模型/i, '不能说成模型启动失败');
    return true;
  });
  assert.equal(REMOTE_PORT_TRIES, 5);
  assert.equal(attempts.length, 5);
  assert.ok(attempts.every((a) => a.model === 'm1'), '端口问题不换模型');
  assert.deepEqual(failed, []);
});

test('不是端口问题的失败照旧换下一个模型候选', async () => {
  const tried: string[] = [];
  const failed: string[] = [];
  const base = { remotePort: 39100, localPort: 5000, agentOverride: 'a' };
  const portRetry = new RemotePortRetry<LT>({ localTools: base, rearm: async () => { throw new Error('不该换端口'); } });
  const r = await candidateLoop(['bad', 'good'], portRetry, async (m) => {
    tried.push(m);
    if (m === 'bad') throw new Error('initialize timed out');
    return m;
  }, failed);
  assert.equal(r.model, 'good');
  assert.deepEqual(tried, ['bad', 'good']);
  assert.deepEqual(failed, ['bad']);
});

test('没有换端口的办法（复用连接 / 本地会话）：不重试，照旧当作这个候选失败', async () => {
  const busyErr = Object.assign(new Error('busy'), { remotePortBusy: 39100 });
  assert.equal(await new RemotePortRetry<LT>({ localTools: { remotePort: 39100, localPort: 1, agentOverride: '' } }).retryOnNewPort(busyErr), false);
  assert.equal(await new RemotePortRetry<LT>({ localTools: undefined, rearm: async () => undefined }).retryOnNewPort(busyErr), false);
});

test('换端口那一步没备好本地工具 / 给回同一个端口：报端口问题，不悄悄不带工具起', async () => {
  const busyErr = Object.assign(new Error('busy'), { remotePortBusy: 39100 });
  const lt = { remotePort: 39100, localPort: 1, agentOverride: '' };
  await assert.rejects(new RemotePortRetry<LT>({ localTools: lt, rearm: async () => undefined }).retryOnNewPort(busyErr),
    (err: any) => isRemotePortsBusy(err) && err.ports.join() === '39100');
  await assert.rejects(new RemotePortRetry<LT>({ localTools: lt, rearm: async () => lt }).retryOnNewPort(busyErr),
    (err: any) => isRemotePortsBusy(err));
});

test('从 ssh 的 stderr 认出被占的远端端口', () => {
  assert.equal(remotePortBusyFromStderr('Warning: remote port forwarding failed for listen port 39100\n'), 39100);
  assert.equal(remotePortBusyFromStderr('Connection closed by 1.2.3.4'), null);
  assert.equal(remotePortBusyOf(Object.assign(new Error('x'), { remotePortBusy: 39102 })), 39102);
  assert.equal(remotePortBusyOf(new Error('x')), null);
});

/*
  **真 AcpClient + 假 ssh：initialize 还没发出去（500ms）ssh 就退了** —— 审查复现的那个时序：
  端口被占时 ssh 10ms 就以 255 退出，那时没有在飞的请求；原来带端口的错误就丢了，
  500ms 后拿到的是不带端口的"没连着"，换端口那一步认不出来，又去换模型撞同一个端口。
*/
type Spawned = { model: string; port: number };

/** 假 ssh：`-R 127.0.0.1:<port>:…` 的端口在 busy 里就 10ms 后说那句 warning、以 255 退出；否则正常回 initialize */
function fakeSsh(busy: Set<number>, spawned: Spawned[]) {
  return ((_cmd: string, args: string[]) => {
    const p: any = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.exitCode = null; p.signalCode = null; p.pid = 4242;
    const fwd = args[args.indexOf('-R') + 1] || '';
    const port = Number(fwd.split(':')[1]);
    const model = ['gpt-5.6-sol', 'gpt-5.6-terra', 'deepseek-3.2'].find((m) => args.join(' ').includes(m)) || '?';
    spawned.push({ model, port });
    const exit = (code: number) => {
      if (p.exitCode !== null) return;
      p.exitCode = code; p.stdin.writable = false;
      p.emit('exit', code); p.emit('close', code);
    };
    p.stdin = {
      writable: true,
      write(line: string) {
        for (const l of String(line).split('\n').filter(Boolean)) {
          const msg = JSON.parse(l);
          if (msg.method === 'initialize') {
            setImmediate(() => p.stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })}\n`)));
          }
        }
        return true;
      },
      end() { setImmediate(() => exit(0)); },
      on() { return this; },
    };
    p.kill = () => exit(143);
    if (busy.has(port)) {
      setTimeout(() => {
        p.stderr.emit('data', Buffer.from(`Warning: remote port forwarding failed for listen port ${port}\n`));
        exit(255);
      }, 10);
    }
    return p;
  }) as any;
}

const REMOTE = { id: 'm1', sshHost: 'portbusy.test', bins: { kiro: 'kiro-cli' } } as any;

test('真 AcpClient：ssh 在 initialize 发出去之前就因端口被占退出，connect 拒绝时带着 remotePortBusy', async () => {
  const spawned: Spawned[] = [];
  setSpawnForTests(fakeSsh(new Set([39100]), spawned));
  try {
    const client = new AcpClient('gpt-5.6-sol', {}, undefined, 'ask', REMOTE, { remotePort: 39100, localPort: 5000, agentOverride: 'kirolex-local-x' }, 'kiro');
    const t0 = Date.now();
    await assert.rejects(client.connect(), (err: any) => {
      assert.equal(remotePortBusyOf(err), 39100);
      return true;
    });
    assert.ok(Date.now() - t0 < 450, '不等 initialize 那 500ms，ssh 一退就拒');
    assert.deepEqual(spawned, [{ model: 'gpt-5.6-sol', port: 39100 }]);
  } finally {
    setSpawnForTests();
  }
});

test('真 AcpClient + 候选循环：39100 被占（ssh 秒退）→ 同一次 attach 改用 39101 成功，不换模型', async () => {
  const spawned: Spawned[] = [];
  setSpawnForTests(fakeSsh(new Set([39100]), spawned));
  try {
    const base = { remotePort: 39100, localPort: 5000, agentOverride: 'kirolex-local-x' };
    const portRetry = new RemotePortRetry<LT>({ localTools: base, rearm: fakeRearm(base, []) });
    const clients: AcpClient[] = [];
    const failed: string[] = [];
    const t0 = Date.now();
    const r = await candidateLoop(['gpt-5.6-sol', 'gpt-5.6-terra', 'deepseek-3.2'], portRetry, async (model, lt) => {
      const client = new AcpClient(model, {}, undefined, 'ask', REMOTE, lt, 'kiro');
      clients.push(client);
      try {
        await client.connect();
      } catch (err) {
        /* 和 connectWithModelFallback 一样：起不来的先收掉再换端口 —— ssh 已经退了，不该白等 5 秒 */
        try { await client.disconnect(); } catch {}
        throw err;
      }
      return `${model}@${client.forwardedRemotePort}`;
    }, failed);
    assert.deepEqual(r, { model: 'gpt-5.6-sol', value: 'gpt-5.6-sol@39101' });
    assert.deepEqual(spawned, [{ model: 'gpt-5.6-sol', port: 39100 }, { model: 'gpt-5.6-sol', port: 39101 }]);
    assert.deepEqual(failed, [], '没有切换模型候选');
    /* 39100 秒退 + 收尾立即完成 + 39101 正常 initialize（500ms）：远小于 5 秒的收尾超时 */
    assert.ok(Date.now() - t0 < 2500, `换端口前的收尾不该等满 5 秒（实际 ${Date.now() - t0}ms）`);
    /* 活着的那个照旧走干净退出：关 stdin → 等它自己退（假 ssh 收到 end 就以 0 退出） */
    const t1 = Date.now();
    await clients[clients.length - 1].disconnect();
    assert.ok(Date.now() - t1 < 2500, '活进程收到 stdin 结束就退，不走 5 秒超时');
  } finally {
    setSpawnForTests();
  }
});

test('接线：acp-client 给端口转发失败的退出挂上 remotePortBusy', () => {
  const AC = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'acp-client.ts'), 'utf-8');
  assert.match(AC, /const busyPort = sshDrop \? remotePortBusyFromStderr\(this\.lastStderr\) : null;\s*\n\s*if \(busyPort !== null\) Object\.assign\(exitErr, \{ remotePortBusy: busyPort \}\);/);
});

test('接线：connectWithModelFallback 的候选循环就是上面那个形状；换端口前清理远端残留并避开撞过的端口', () => {
  const at = MAIN.indexOf('async function connectWithModelFallback(');
  const body = MAIN.slice(at, MAIN.indexOf("throw lastError || new Error('No usable model", at));
  assert.match(body, /for \(let i = 0; i < candidates\.length; i \+= 1\) \{\s*\n\s*const model = candidates\[i\];/);
  assert.match(body, /if \(await portRetry\.retryOnNewPort\(err\)\) \{ localTools = portRetry\.localTools; i -= 1; continue; \}\s*\n\s*\} catch \(busy\) \{\s*\n\s*lastError = busy;[\s\S]{0,120}break;/);
  const rearm = MAIN.slice(MAIN.indexOf('function remotePortRearm('), MAIN.indexOf('function remotePortRearm(') + 900);
  assert.match(rearm, /if \(!remote\?\.sshHost \|\| muxSupported\(\)\) return undefined;/);
  assert.match(rearm, /await sweepRemoteExecutors\(remote,/);
  assert.match(rearm, /return ensureLocalTools\(sessionId, profile, localDir, avoid\);/);
  assert.match(MAIN, /\.\.\.avoidPorts,\s*\n\s*\.\.\.remoteBusy,\s*\n\s*\];\s*\n\s*remotePort = allocateRemotePort\(used\);/);
});
