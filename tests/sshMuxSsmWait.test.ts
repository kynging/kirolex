/**
 * SSM 的主连接不能被 12 秒的外层等待提前杀掉 —— ssh 自己的 `ConnectTimeout` 在 SSM 下是 30 秒，
 * start-session 握手慢于 12 秒是常态。直连照旧 12 秒。
 *
 * 用假 ssh + node:test 的假时钟（setTimeout / Date）跑真的 `ensure()`，**不注入 socketWaitMs**，
 * 测的就是默认值本身。
 */
import assert from 'node:assert/strict';
import { test, mock, afterEach } from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SshMux, masterWaitMs, MASTER_WAIT_MS, SSM_MASTER_WAIT_MS } from '../src/main/sshMux.ts';
import { execTimeoutFor, setSsmKeyRoot } from '../src/main/sshProxy.ts';

/* SSM 默认推临时公钥，会生成密钥 —— 放进临时目录，不碰真的 ~/.kirolex */
setSsmKeyRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-keys-')));

/** 假 ssh：`allocAfterMs` 之后在 stderr 上报 `Allocated port`（不给就一直不报）。 */
function fakeProc(allocAfterMs?: number): any {
  const p: any = new EventEmitter();
  p.killed = false; p.exitCode = null;
  p.stderr = new EventEmitter();
  p.kill = () => { if (p.killed) return; p.killed = true; p.exitCode = 255; setImmediate(() => p.emit('exit', 255)); };
  if (allocAfterMs !== undefined) {
    setTimeout(() => { if (!p.killed) p.stderr.emit('data', Buffer.from('Allocated port 41235 for remote forward to 127.0.0.1:5000\n')); }, allocAfterMs);
  }
  return p;
}

function makeMux(allocAfterMs?: number) {
  const procs: any[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muxssm-'));
  const mux = new SshMux({
    log: () => {},
    localPort: () => 5000,
    owner: 'test',
    hasSessions: () => false,   // 失败后不排自愈，免得假时钟里再起一条
    spawnSsh: () => { const p = fakeProc(allocAfterMs); procs.push(p); return p; },
    probeSocket: async () => true,
    platform: 'linux',
    healBackoffMs: [10_000_000],
  }, dir);
  return { mux, procs };
}

const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };
/** 假时钟往前走 `ms`，每 150 ms（waitFor 的步长）让出一次事件循环。 */
async function advance(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 150) { mock.timers.tick(150); await flush(); }
}

const SSM = { sshHost: 'ec2-user@i-0123456789abcdef0', connectVia: 'ssm' as const, ssmInstanceId: 'i-0123456789abcdef0', ssmRegion: 'ap-northeast-1' };
const SSH = { sshHost: 'ec2-user@192.0.2.10' };

afterEach(() => mock.timers.reset());

test('默认等待期限：直连 12 秒，SSM 盖得住 30 秒握手 + 隧道', () => {
  assert.equal(masterWaitMs(SSH), 12_000);
  assert.equal(masterWaitMs({ connectVia: 'ssh' }), MASTER_WAIT_MS);
  assert.equal(masterWaitMs(SSM), SSM_MASTER_WAIT_MS);
  assert.ok(SSM_MASTER_WAIT_MS > 30_000);
  assert.equal(masterWaitMs(SSM, 150), 150, '测试注入的值优先');
  assert.equal(execTimeoutFor(SSH), 30_000);
  assert.ok(execTimeoutFor(SSM) > 30_000);
});

test('SSM：20 秒才就绪的主连接不会被提前杀掉', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { mux, procs } = makeMux(20_000);
  let result: any; let error: any;
  mux.ensure(SSM).then((r) => { result = r; }, (e) => { error = e; });
  await flush();
  await advance(21_000);
  assert.equal(error, undefined, `被提前终止了：${error?.message}`);
  assert.equal(procs.length, 1);
  assert.equal(procs[0].killed, false);
  assert.equal(result?.remotePort, 41235);
});

test('直连：同样 20 秒才就绪，照旧 12 秒放弃（默认值没变）', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { mux, procs } = makeMux(20_000);
  let error: any;
  mux.ensure(SSH).catch((e) => { error = e; });
  await flush();
  await advance(11_000);
  assert.equal(error, undefined, '12 秒之前不该放弃');
  await advance(2_000);
  assert.ok(error, '过了 12 秒应当放弃');
  assert.equal(procs[0].killed, true);
});

test('SSM：一直不就绪，到 45 秒才放弃（不是 12 秒）', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { mux, procs } = makeMux(undefined);
  let error: any;
  mux.ensure(SSM).catch((e) => { error = e; });
  await flush();
  await advance(44_000);
  assert.equal(error, undefined);
  assert.equal(procs[0].killed, false);
  await advance(2_000);
  assert.ok(error);
  assert.equal(procs[0].killed, true);
});
