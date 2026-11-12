/**
 * **共享隧道还活着、但推送已经过期（> 45 秒）时，别的 ssh 调用也要先刷新公钥、继续用原端口** ——
 * 审查：断开时清理远端进程、loop/flow 校验、诊断（hostOps）、runProbe 等调用直接 `buildSshArgs`，
 * 那时 `liveFor` 因推送过期返回 undefined，于是另起一条 AWS-StartSSHSession。
 *
 * 判据：每次 `buildSshArgs` 问隧道时（resolver 被调用的那一刻）`liveFor` 给出的是**原来那个端口**，
 * 而且在那之前推过一次公钥。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SsmTunnels, type TunnelTarget } from '../src/main/ssmTunnel.ts';
import { AcpClient, buildSshArgs, shellQuote, setSsmTunnelResolver, setMuxSocketResolver, prepareSshFor } from '../src/main/acp-client.ts';
import { runVerifier } from '../src/main/loopVerify.ts';
import { hostFor } from '../src/main/hostOps.ts';
import { setSsmKeyRoot } from '../src/main/sshProxy.ts';

setSsmKeyRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-keys-')));
setMuxSocketResolver(undefined);

const A: TunnelTarget & { remoteWorkdir: string } = { id: 'aws-tokyo-4', sshHost: 'ec2-user@i-03b396ce3b8546b90', connectVia: 'ssm', ssmInstanceId: 'i-03b396ce3b8546b90', ssmRegion: 'ap-northeast-1', ssmProfile: 'kyn', remoteWorkdir: '~/kirolex' };

function fakeProc(): any {
  const p: any = new EventEmitter();
  p.exitCode = null; p.killed = false;
  p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
  p.kill = () => { p.killed = true; p.exitCode = 1; };
  setTimeout(() => { p.listening = true; p.stdout.emit('data', 'Waiting for connections...\n'); }, 5);
  return p;
}

/** 一条已经就绪、推送已经过期的隧道；resolver 记下每次 buildSshArgs 问到的结果。 */
async function staleTunnel() {
  let clock = 1_000_000;
  const events: string[] = [];
  const procs: any[] = [];
  const tunnels = new SsmTunnels({
    spawnTunnel: () => { const p = fakeProc(); procs.push(p); return p; },
    freePort: async () => 50000 + procs.length,
    probe: async () => procs.some((p) => p.listening && p.exitCode === null),
    pushKey: async () => { events.push('push'); },
    needsPush: () => true,
    pushKeyId: () => 'k',
    log: () => {},
    now: () => clock,
    probeEveryMs: 60_000,
  });
  const first = await tunnels.ensure(A);
  clock += 46_000;
  assert.equal(tunnels.liveFor(A), undefined, '前提：推送过期了');
  events.length = 0;
  setSsmTunnelResolver(
    (r) => { const live = tunnels.liveFor(r as any); events.push(live ? `ssh→${live.port}` : 'ssh→ProxyCommand'); return live; },
    (r) => tunnels.ensure(r as any),
  );
  return { tunnels, first: first!, events, procs };
}

test.afterEach(() => setSsmTunnelResolver());

test('prepareSshFor：推送过期时刷新一次公钥，随后的 ssh 用原端口', async () => {
  const s = await staleTunnel();
  await prepareSshFor(A as any);
  const args = buildSshArgs(A as any, 'true');
  assert.deepEqual(s.events, ['push', `ssh→${s.first.port}`]);
  assert.equal(args[args.indexOf('-p') + 1], String(s.first.port));
  assert.equal(s.procs.length, 1, '没有另建隧道');
  s.tunnels.closeAll();
});

test('断开时清理远端进程：先刷新公钥，再用原端口（不另起 SSM ProxyCommand）', async () => {
  const s = await staleTunnel();
  const c = new AcpClient('m', process.env as any, undefined, 'auto' as any, A as any, undefined, 'kiro');
  (c as any).remotePid = 4242;
  await c.disconnect();
  for (let i = 0; i < 40 && !s.events.some((e) => e.startsWith('ssh→')); i++) await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(s.events, ['push', `ssh→${s.first.port}`]);
  s.tunnels.closeAll();
});

test('loop/flow 校验（runVerifier）：先刷新公钥，再用原端口', async () => {
  const s = await staleTunnel();
  let captured: string[] = [];
  /* 真的 buildSshArgs 拿参数，交给 ssh 的换成 `-V`（只打版本就退，不真去连） */
  /* 不传 prepare：用主进程注入的钩子（和 index.ts 里 { buildSshArgs, shellQuote } 的接法一样） */
  const ssh = { buildSshArgs: (r: any, cmd: string) => { captured = buildSshArgs(r, cmd); return ['-V']; }, shellQuote };
  await runVerifier({ command: 'npm test', cwd: '~/kirolex/x', timeoutSec: 20, remote: A as any } as any, process.env, ssh);
  assert.deepEqual(s.events, ['push', `ssh→${s.first.port}`]);
  assert.equal(captured[captured.indexOf('-p') + 1], String(s.first.port));
  assert.equal(captured.some((a) => /ProxyCommand/.test(a)), false);
  s.tunnels.closeAll();
});

test('诊断取证（hostOps SshHost）：先刷新公钥，再用原端口', async () => {
  const s = await staleTunnel();
  let captured: string[] = [];
  const host = hostFor(A as any, { buildSshArgs: (r, cmd) => { captured = buildSshArgs(r, cmd); return ['-V']; }, shellQuote });
  await host.readTail('/tmp/x.log', 100);
  assert.deepEqual(s.events, ['push', `ssh→${s.first.port}`]);
  assert.equal(captured[captured.indexOf('-p') + 1], String(s.first.port));
  s.tunnels.closeAll();
});

test('index.ts 里其余直接起 ssh 的地方都先等 prepareSsmTunnel（源码检查）', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  /* 每处 buildSshArgs：要么前面几行就有 prepareSsmTunnel，要么它所在的函数一开头就等了（runRemoteCapture），
     要么只在 ControlMaster 平台才走（spare 重试），要么是包了一层 prepare 的 sshStdinNow，要么是「测试连接」（checkSsmNoted 里等） */
  const lines = M.split('\n');
  const bad: string[] = [];
  lines.forEach((l, i) => {
    if (!/buildSshArgs\(/.test(l) || /^import|setMuxSocketResolver|\{ buildSshArgs, shellQuote/.test(l)) return;
    const before = lines.slice(Math.max(0, i - 6), i).join('\n');
    if (/prepareSsmTunnel/.test(before)) return;
    if (/sparedOnce = true/.test(before)) return;   // mux 平台的备用连接重试
    if (/const sshStdinNow = /.test(l + before)) return;
    if (/const child = execFile\('ssh', \[\.\.\.buildSshArgs\(remote, `bash -lc \$\{shellQuote\(script\)\}`\)\],/.test(l)) return;   // runRemoteCapture 的 once（函数开头已等）
    if (/testConnectionScript/.test(l) && /checkSsmNoted|「测试连接」/.test(lines.slice(Math.max(0, i - 8), i).join('\n'))) return;
    bad.push(`${i + 1}: ${l.trim()}`);
  });
  assert.deepEqual(bad, []);
  assert.match(M, /async function checkSsmNoted[\s\S]{0,300}prepareSsmTunnel/);
  assert.match(M, /function runRemoteCapture[^\n]*\n[^\n]*\n\s*return prepareSsmTunnel\(remote\)/);
  /* hostOps / loopVerify 不传 prepare 时用的是主进程注入的那个钩子（setSsmTunnelResolver 第二个参数） */
  assert.match(M, /setSsmTunnelResolver\(\s*\([^)]*\) => \(ssmTunnelApplies\(remote\) \? ssmTunnels\.liveFor\(remote\) : undefined\),\s*prepareSsmTunnel,\s*\)/);
  assert.match(fs.readFileSync(path.join(process.cwd(), 'src/main/hostOps.ts'), 'utf8'), /: prepareSshFor\(this\.remote\)/);
  assert.match(fs.readFileSync(path.join(process.cwd(), 'src/main/loopVerify.ts'), 'utf8'), /: prepareSshFor\(req\.remote\)/);
});
