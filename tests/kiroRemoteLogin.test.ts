/**
 * 「远端 kiro 会话没登录时没有任何登录入口」（2026-11-07，aws-tokyo 走 SSM、kiro-cli 2.27.1 Not logged in）。
 *
 * 守的几件事：
 *   · 预检报 not-logged-in 的那条「没连上」提示认得出来 → 会话里挂「登录 kiro」卡片（并且提示不再叫人「去那台机器跑一次」）；
 *   · 登录命令：本机开终端、经**同一条连接**（SSM 的 ProxyCommand / 临时公钥都在）`ssh -t` 过去跑
 *     `kiro-cli login … --use-device-flow`；free / pro + start URL / 区由卡片选；
 *   · 默认：这台机器上次的选择 → 本机 kiro-cli 的登录方式 → 都没有就让人选；
 *   · 登上之后自动重连那条会话；
 *   · 「🔑 登录」对 kiro 会话也有；设置 → 机器每台机器有「登录 kiro」。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeKiroLoginChoice, kiroLoginArgs, remoteKiroLoginCommand, withTty, kiroLoginDefaults, readKiroLoginChoices,
} from '../src/main/kiroLogin.ts';
import { setSsmKeyRoot, setProxyFlavorOverride } from '../src/main/sshProxy.ts';
import { buildSshArgs } from '../src/main/acp-client.ts';
import { judgePreflight } from '../src/main/remotePreflight.ts';
import { setUiLang } from '../src/main/uiText.ts';
import { kiroLoginOffer, createKiroLoginStore, choiceOf, draftFrom, keyOf } from '../src/renderer/kiroLoginView.ts';
import { connectFailureNotice } from '../src/renderer/connectFailure.ts';

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf8');
const noSleep = async () => {};

/* SSM 默认推临时公钥，会生成密钥 —— 放进临时目录，不碰真的 ~/.kirolex */
setSsmKeyRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'kx-kiro-login-keys-')));

const SSM = {
  sshHost: 'ec2-user@i-03b396ce3b8546b90',
  connectVia: 'ssm' as const,
  ssmInstanceId: 'i-03b396ce3b8546b90',
  ssmRegion: 'ap-northeast-1',
};

describe('登录参数', () => {
  test('free / pro；pro 带 start URL / 区；远端一定带 --use-device-flow', () => {
    assert.deepEqual(kiroLoginArgs({ license: 'free' }, { deviceFlow: true }), ['login', '--license', 'free', '--use-device-flow']);
    assert.deepEqual(
      kiroLoginArgs({ license: 'pro', identityProvider: 'https://d-1.awsapps.com/start', region: 'ap-northeast-1' }, { deviceFlow: true }),
      ['login', '--license', 'pro', '--identity-provider', 'https://d-1.awsapps.com/start', '--region', 'ap-northeast-1', '--use-device-flow'],
    );
    /* 本机有浏览器：不加 device flow */
    assert.deepEqual(kiroLoginArgs({ license: 'pro' }, { deviceFlow: false }), ['login', '--license', 'pro']);
  });

  test('渲染层传来的选择要校验：没选 free / pro、start URL 不是 https、区不像区 → 拒绝', () => {
    assert.equal(normalizeKiroLoginChoice({}), null);
    assert.equal(normalizeKiroLoginChoice({ license: 'pro', identityProvider: 'http://x/start' }), null);
    assert.equal(normalizeKiroLoginChoice({ license: 'pro', region: 'tokyo; rm -rf /' }), null);
    assert.deepEqual(normalizeKiroLoginChoice({ license: 'free', identityProvider: 'https://x/start' }), { license: 'free' });
    assert.deepEqual(normalizeKiroLoginChoice({ license: 'pro', identityProvider: ' https://d-1.awsapps.com/start ', region: '' }), { license: 'pro', identityProvider: 'https://d-1.awsapps.com/start' });
  });

  test('默认：上次的选择 → 本机 kiro-cli 的 Identity Center（区不跟，ARN 的区不一定对）→ 都没有就让人选', () => {
    assert.deepEqual(kiroLoginDefaults({ license: 'free' }, { identityProvider: 'https://d-1.awsapps.com/start' }), { choice: { license: 'free' }, source: 'remembered' });
    assert.deepEqual(kiroLoginDefaults(undefined, { identityProvider: 'https://d-1.awsapps.com/start', region: 'us-east-1' }), { choice: { license: 'pro', identityProvider: 'https://d-1.awsapps.com/start' }, source: 'local' });
    assert.deepEqual(kiroLoginDefaults(undefined, {}), { source: 'none' });
  });

  test('记住的选择：坏的项丢掉', () => {
    const file = '/x/kiro-login.json';
    const got = readKiroLoginChoices(file, () => JSON.stringify({ tokyo: { license: 'pro', identityProvider: 'https://d-1.awsapps.com/start' }, bad: { license: 'gold' } }));
    assert.deepEqual(got, { tokyo: { license: 'pro', identityProvider: 'https://d-1.awsapps.com/start' } });
    assert.deepEqual(readKiroLoginChoices(file, () => 'not json'), {});
  });
});

describe('远端登录的 ssh 命令：同一条连接（SSM ProxyCommand）+ -t + device flow', () => {
  for (const flavor of ['posix', 'win32'] as const) {
    test(`${flavor}：带 -t（在 host 前）、带 SSM ProxyCommand、远端跑 kiro-cli login --use-device-flow`, () => {
      setProxyFlavorOverride(flavor);
      try {
        const cmd = remoteKiroLoginCommand('kiro-cli', { license: 'pro', identityProvider: 'https://d-1.awsapps.com/start' });
        const args = withTty(buildSshArgs(SSM as any, cmd));
        const host = args.indexOf(SSM.sshHost);
        assert.equal(args[host - 1], '-t', '-t 紧挨在 host 前面');
        assert.equal(args[host + 1], cmd, '最后一项是远端命令');
        const proxy = args.find((a) => String(a).startsWith('ProxyCommand='));
        assert.ok(proxy, '带 SSM 的 ProxyCommand');
        assert.match(proxy!, /ssm start-session --target i-03b396ce3b8546b90 --document-name AWS-StartSSHSession/);
        /* posix 那一支每个参数单引号括起（'ec2-instance-connect' 'send-ssh-public-key'），win32 那一支不括 */
        assert.match(proxy!, /ec2-instance-connect'? '?send-ssh-public-key/, '临时公钥那一步也在（和会话同一条连接）');
        assert.ok(args.indexOf(proxy!) < host, 'ProxyCommand 在 host 前');
        assert.ok(args.includes('HostKeyAlias=i-03b396ce3b8546b90'));
        assert.match(cmd, /^bash -lc '/);
        assert.match(cmd, /--use-device-flow/);
        assert.match(cmd, /--license.*pro/);
        assert.match(cmd, /--identity-provider.*https:\/\/d-1\.awsapps\.com\/start/);
      } finally {
        setProxyFlavorOverride(undefined as any);
      }
    });
  }

  test('远端命令的引号：启动命令里有空格 / 单引号也不断', () => {
    const cmd = remoteKiroLoginCommand("/home/ec2 user/it's/kiro-cli", { license: 'free' });
    assert.equal(cmd, `bash -lc ''"'"'/home/ec2 user/it'"'"'\\'"'"''"'"'s/kiro-cli'"'"' '"'"'login'"'"' '"'"'--license'"'"' '"'"'free'"'"' '"'"'--use-device-flow'"'"''`.replace(/'"'"'/g, "'\\''"));
  });

  test('withTty 只插一个 -t，其余参数原样', () => {
    assert.deepEqual(withTty(['-o', 'BatchMode=yes', 'h', 'cmd']), ['-o', 'BatchMode=yes', '-t', 'h', 'cmd']);
    assert.throws(() => withTty(['h']));
  });
});

describe('会话里：not-logged-in 的 kiro 远端会话挂出「登录 kiro」', () => {
  for (const lang of ['en', 'zh'] as const) {
    test(`${lang}：预检真说的那句（包在「没连上」里）认得出来，而且不再叫人「去那台机器跑一次」`, () => {
      setUiLang(lang);
      try {
        const v = judgePreflight(0, 'HAVE kiro-cli\nAUTH no\n', '', { sshHost: 'ec2-user@i-03b396ce3b8546b90' } as any);
        assert.equal(v.code, 'not-logged-in');
        const notice = connectFailureNotice(`Error invoking remote method 'acp:load-session': Error: ${v.message}`, 1, lang);
        assert.equal(kiroLoginOffer(notice.content), true);
        assert.doesNotMatch(v.message, /on that machine once|去那台机器跑一次/);
        assert.match(v.message, lang === 'zh' ? /登录 kiro/ : /Log in to kiro/);
      } finally {
        setUiLang('en');
      }
    });
  }

  test('别的报错不挂', () => {
    assert.equal(kiroLoginOffer('⚠️ This chat couldn\'t connect: Cannot connect to h: timeout'), false);
    assert.equal(kiroLoginOffer('Claude Code is not logged in on the machine running this session.'), false);
  });

  test('AdapterInstallAction 对这条提示返回 KiroLoginCard（按会话）', () => {
    const C = read('src', 'renderer', 'components', 'ChatArea.tsx');
    const at = C.indexOf('function AdapterInstallAction(');
    const fn = C.slice(at, at + 1600);
    assert.match(fn, /if \(isNotice && !offer && sessionId && kiroLoginOffer\(message\.content\)\) return <KiroLoginCard target=\{\{ sessionId \}\} compact \/>;/);
  });
});

describe('卡片的流程：开终端 → 等到 kiro 可用 → 重连会话', () => {
  test('默认值来自主进程；没选 free / pro 不能点；选了 → 开终端（带选择）→ 轮询到可用 → 重连', async () => {
    const calls: any[] = [];
    let polls = 0;
    const store = createKiroLoginStore({
      info: async (t) => { calls.push(['info', t]); return { ok: true, machine: 'tokyo', remote: true, host: 'aws-tokyo', source: 'none' }; },
      login: async (t, c) => { calls.push(['login', t, c]); return { ok: true, opened: true, machine: 'tokyo' }; },
      kiroReady: async (m) => { polls += 1; assert.equal(m, 'tokyo'); return polls >= 3; },
      reconnect: async (sid) => { calls.push(['reconnect', sid]); return { ok: true }; },
      pollMs: 1, timeoutMs: 60_000, sleep: noSleep,
    });
    const target = { sessionId: 's1' };
    await store.init(target);
    const key = keyOf(target);
    assert.equal(store.get(key)!.phase, 'idle');
    assert.equal(choiceOf(store.get(key)!.draft), null, '没选 free / pro');
    assert.equal(await store.start(target), false, '没选不能登录');
    store.setDraft(target, { license: 'pro', identityProvider: 'https://d-1.awsapps.com/start' });
    assert.equal(await store.start(target), true);
    assert.deepEqual(calls.find((c) => c[0] === 'login'), ['login', target, { license: 'pro', identityProvider: 'https://d-1.awsapps.com/start' }]);
    assert.equal(polls, 3);
    assert.deepEqual(calls[calls.length - 1], ['reconnect', 's1']);
    assert.equal(store.get(key)!.phase, 'done');
  });

  test('默认按上次的方式预选；终端开不了 / 等不到登录：失败、带原因、不重连', async () => {
    let reconnects = 0;
    let t = 0;
    const store = createKiroLoginStore({
      info: async () => ({ ok: true, machine: 'tokyo', remote: true, choice: { license: 'free' }, source: 'remembered' }),
      login: async () => ({ ok: true, opened: true, machine: 'tokyo' }),
      kiroReady: async () => false,
      reconnect: async () => { reconnects += 1; return { ok: true }; },
      pollMs: 1000, timeoutMs: 5000, sleep: async (ms) => { t += ms; },
    });
    const target = { sessionId: 's2' };
    await store.init(target);
    assert.equal(store.get(keyOf(target))!.draft.license, 'free', '按上次的方式预选');
    const origNow = Date.now;
    Date.now = () => t;
    try { assert.equal(await store.start(target), false); } finally { Date.now = origNow; }
    assert.equal(store.get(keyOf(target))!.phase, 'failed');
    assert.equal(reconnects, 0);
    const bad = createKiroLoginStore({
      info: async () => ({ ok: true, machine: 'local', remote: false, source: 'none' }),
      login: async () => ({ ok: false, error: '先装 kiro-cli。' }),
      kiroReady: async () => true,
      sleep: noSleep,
    });
    const m = { machine: 'local' };
    await bad.init(m);
    bad.setDraft(m, { license: 'free' });
    assert.equal(await bad.start(m), false);
    assert.equal(bad.get(keyOf(m))!.error, '先装 kiro-cli。');
  });

  test('draftFrom / choiceOf 往返', () => {
    assert.deepEqual(choiceOf(draftFrom({ license: 'pro', region: 'us-east-1' })), { license: 'pro', region: 'us-east-1' });
    assert.deepEqual(choiceOf(draftFrom({ license: 'free' })), { license: 'free' });
  });
});

describe('接线', () => {
  const M = read('src', 'main', 'index.ts');
  const P = read('src', 'main', 'preload.ts');
  const C = read('src', 'renderer', 'components', 'ChatArea.tsx');
  const R = read('src', 'renderer', 'components', 'RemoteSettings.tsx');
  const E = read('src', 'renderer', 'components', 'EngineStatusPanel.tsx');

  test('主进程：kiro:login 远端走 withTty(buildSshArgs(…remoteKiroLoginCommand…))、本机走 kiro-cli login；开终端；记住选择', () => {
    const at = M.indexOf("ipcMain.handle('kiro:login'");
    assert.ok(at > 0);
    const h = M.slice(at, at + 3000);
    assert.match(h, /argv = \['ssh', \.\.\.withTty\(buildSshArgs\(r\.remote, remoteKiroLoginCommand\(remoteKiroBin\(r\.remote\) \|\| 'kiro-cli', choice\)\)\)\];/);
    assert.match(h, /kiroLoginArgs\(choice, \{ deviceFlow: false \}\)/);
    assert.match(h, /openLoginTerminal\(argv\)/);
    assert.match(h, /fs\.renameSync\(tmp, KIRO_LOGIN_FILE\)/);
    assert.match(M, /ipcMain\.handle\('kiro:login-info'/);
  });

  test('登上之后：状态（跳过缓存）看到 kiro 可用就清掉熔断里的「没登录」，紧接着的重连会重新预检', () => {
    const fn = M.slice(M.indexOf('async function remoteEngineStatusesFor('), M.indexOf('async function remoteEngineStatusesFor(') + 2000);
    assert.match(fn, /if \(statuses\.some\(\(s\) => s\.engine === 'kiro' && s\.state === 'ok'\)\) reachability\.ok\(host\);/);
  });

  test('preload 暴露 kiroLoginInfo / kiroLogin', () => {
    assert.match(P, /kiroLoginInfo: \(target/);
    assert.match(P, /kiroLogin: \(target/);
  });

  test('kiro 会话的配置面板也有「🔑 登录」tab', () => {
    assert.match(C, /\.\.\.kiroConfigCats, \{ id: 'kiro-login', label: t\('🔑 Login'\) \}\]/);
    assert.match(C, /agentConfigTab === 'kiro-login'[\s\S]{0,200}<KiroLoginCard target=\{\{ sessionId: currentSessionId \}\} \/>/);
  });

  test('设置 → 机器：本机页和每台远端机器都有「登录 kiro」', () => {
    assert.match(R, /<KiroLoginEntry machine="local" \/>/);
    assert.match(R, /\{draft\.id && <KiroLoginEntry key=\{draft\.id\} machine=\{draft\.id\} \/>\}/);
  });

  test('状态面板里 kiro 的 ⚠️「登录」展开同一张卡片（不再只回一句去哪登）', () => {
    assert.match(E, /if \(e === 'kiro'\) setKiroLoginOpen\(\(v\) => !v\); else void store\.login\(machine, e\);/);
    assert.match(E, /<KiroLoginCard target=\{\{ machine \}\} compact/);
  });
});
