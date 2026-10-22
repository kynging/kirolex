/**
 * 远程会话：**用户要的文件一律落在本机，远端只放缓存** ——
 * 「v1 是经本机工具写到本机的，v3 却落在了 EC2 —— 用户在本机找不到、comment 写不回去」。
 *
 * 守的是三件事：
 *   ① 远端 kiro-cli 自带的写文件工具（fs_write / write …）写到缓存目录以外 → 权限那一层拒掉；
 *   ② 本机工具（`@kirolex-local/local_write`）、跑命令、写缓存 / /tmp 都不拦；
 *   ③ 漏过去的（比如信任了全部工具）事后认得出来，并能算出复制回本机的落点（不覆盖本机已有的别的文件）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  remoteCacheRoot, isRemoteDisposablePath, writeTargets, isLocalToolCall,
  remoteWriteVerdict, strayRemoteDeliverables, blockedWriteNotice, strayWriteNotice, localCopyPath, ToolCallLedger, saveRemoteCopy,
} from '../src/main/remoteWriteGuard.ts';

const HOME = '/home/ec2-user';
const CWD = `${HOME}/.cache/kirolex/files-e4a2a483`;
const ctx = { cwd: CWD, home: HOME };

describe('远端缓存目录', () => {
  test('缓存根是 ~/.cache/kirolex；缓存、/tmp、/var/tmp 算用完即弃，别的都不算', () => {
    assert.equal(remoteCacheRoot(HOME), '/home/ec2-user/.cache/kirolex');
    assert.equal(isRemoteDisposablePath(`${CWD}/build/out.o`, HOME), true);
    assert.equal(isRemoteDisposablePath('/tmp/x.txt', HOME), true);
    assert.equal(isRemoteDisposablePath('/var/tmp/x.txt', HOME), true);
    assert.equal(isRemoteDisposablePath(`${HOME}/kirolex-mirror/scratch/files-e4a2a483/v3.md`, HOME), false);
    assert.equal(isRemoteDisposablePath(`${HOME}/report.md`, HOME), false);
    /* 前缀相同但不是子目录：.cache/kirolex-evil 不是缓存 */
    assert.equal(isRemoteDisposablePath(`${HOME}/.cache/kirolex-evil/a.md`, HOME), false);
    /* `..` 跳出去的不算 */
    assert.equal(isRemoteDisposablePath(`${CWD}/../../../report.md`, HOME), false);
    assert.equal(isRemoteDisposablePath('/tmpfoo/a.md', HOME), false);
  });
});

describe('拦截判据（权限请求那一层）', () => {
  /* 实测日志：`[tool] … kind=edit Editing promo-new-story-bairong-ai-coding-v3.md` */
  const kiroFsWrite = {
    toolCallId: 't1', title: 'Editing promo-new-story-bairong-ai-coding-v3.md', kind: 'edit',
    rawInput: { command: 'create', path: `${HOME}/kirolex-mirror/scratch/files-e4a2a483/promo-new-story-bairong-ai-coding-v3.md`, file_text: '# v3' },
    locations: [{ path: `${HOME}/kirolex-mirror/scratch/files-e4a2a483/promo-new-story-bairong-ai-coding-v3.md` }],
  };

  test('远端自带的 fs_write 写到缓存以外 → 拦，并报出路径', () => {
    const v = remoteWriteVerdict(kiroFsWrite, ctx);
    assert.equal(v.block, true);
    assert.deepEqual(v.paths, [`${HOME}/kirolex-mirror/scratch/files-e4a2a483/promo-new-story-bairong-ai-coding-v3.md`]);
  });

  test('相对路径按远端 cwd（缓存目录）拼 → 落在缓存里，不拦', () => {
    const v = remoteWriteVerdict({ kind: 'edit', title: 'Editing tmp.py', rawInput: { command: 'create', path: 'tmp.py' } }, ctx);
    assert.equal(v.block, false);
    assert.deepEqual(v.paths, [`${CWD}/tmp.py`]);
  });

  test('/tmp 里的中间文件不拦', () => {
    assert.equal(remoteWriteVerdict({ kind: 'edit', rawInput: { path: '/tmp/a.json' } }, ctx).block, false);
  });

  test('相对路径用 .. 跳出缓存 → 拦', () => {
    assert.equal(remoteWriteVerdict({ kind: 'edit', rawInput: { path: '../../../doc.md' } }, ctx).block, true);
  });

  test('~ 开头的路径按远端家目录展开', () => {
    const v = remoteWriteVerdict({ kind: 'edit', rawInput: { path: '~/doc.md' } }, ctx);
    assert.equal(v.block, true);
    assert.deepEqual(v.paths, [`${HOME}/doc.md`]);
  });

  test('多个路径里只要有一个不在缓存 → 拦', () => {
    const v = remoteWriteVerdict({
      kind: 'edit',
      locations: [{ path: `${CWD}/a.txt` }, { path: `${HOME}/b.md` }],
    }, ctx);
    assert.equal(v.block, true);
  });

  test('Claude Code 形状（file_path）也认得', () => {
    const v = remoteWriteVerdict({ kind: 'edit', title: 'Write /home/ec2-user/x.md', rawInput: { file_path: `${HOME}/x.md`, content: 'x' } }, ctx);
    assert.equal(v.block, true);
    assert.deepEqual(v.paths, [`${HOME}/x.md`]);
  });

  test('是写文件、但说不出写到哪 → 也拦（写的一定是远端）', () => {
    const v = remoteWriteVerdict({ kind: 'edit', title: 'Editing something' }, ctx);
    assert.equal(v.block, true);
    assert.deepEqual(v.paths, []);
  });

  test('本机工具 local_write 不拦 —— 那正是要它走的路', () => {
    for (const tc of [
      { kind: 'edit', title: 'Running local_write from kirolex-local', rawInput: { path: 'v3.md', content: 'x' } },
      { kind: 'other', title: '@kirolex-local/local_write', rawInput: { path: '/Users/k/doc.md' } },
      { kind: 'edit', title: 'mcp__kirolex-local__local_write', rawInput: { path: 'a.md' } },
    ]) {
      assert.equal(isLocalToolCall(tc), true, JSON.stringify(tc));
      assert.equal(remoteWriteVerdict(tc, ctx).block, false, JSON.stringify(tc));
    }
  });

  test('跑命令（execute）、读文件不拦 —— 远端照旧可以编译、跑脚本', () => {
    assert.equal(remoteWriteVerdict({ kind: 'execute', title: 'Running: ls -la', rawInput: { command: 'ls -la /home/ec2-user' } }, ctx).block, false);
    assert.equal(remoteWriteVerdict({ kind: 'read', title: 'Reading x', locations: [{ path: `${HOME}/x.md` }] }, ctx).block, false);
    assert.equal(remoteWriteVerdict(undefined, ctx).block, false);
  });

  test('writeTargets 收全各家的路径字段并去重', () => {
    assert.deepEqual(writeTargets({
      locations: [{ path: '/a/x' }, '/a/y'],
      rawInput: { path: '/a/x', file_path: '/a/z', notebook_path: '/a/n.ipynb', changes: { '/a/c': {} } },
    }, CWD, HOME), ['/a/x', '/a/y', '/a/z', '/a/n.ipynb', '/a/c']);
  });
});

describe('事后发现：已经落在远端的交付文件', () => {
  test('完成了的远端写、在缓存以外 → 报出来；缓存里的、本机工具的不报', () => {
    assert.deepEqual(
      strayRemoteDeliverables({ kind: 'edit', status: 'completed', locations: [`${HOME}/v3.md`, `${CWD}/tmp.txt`] }, ctx),
      [`${HOME}/v3.md`],
    );
    assert.deepEqual(strayRemoteDeliverables({ kind: 'edit', status: 'completed', title: 'local_write', locations: ['/Users/k/a.md'] }, ctx), []);
    assert.deepEqual(strayRemoteDeliverables({ kind: 'execute', status: 'completed', locations: [`${HOME}/v3.md`] }, ctx), []);
  });

  test('被拒 / 失败 / 还没跑完的不报 —— 文件并没有写出来', () => {
    for (const status of ['failed', 'pending', 'in_progress']) {
      assert.deepEqual(strayRemoteDeliverables({ kind: 'edit', status, locations: [`${HOME}/v3.md`] }, ctx), [], status);
    }
  });

  test('只带 diff 的也认得', () => {
    assert.deepEqual(
      strayRemoteDeliverables({ kind: 'edit', status: 'completed', diffs: [{ path: `${HOME}/a.md`, newText: 'x' }] }, ctx),
      [`${HOME}/a.md`],
    );
  });
});

describe('提示文案', () => {
  test('拦下时：说清在哪台机器、哪个路径，以及改用 local_write 写到本机的哪个目录', () => {
    const s = blockedWriteNotice('tokyo', [`${HOME}/v3.md`], '/Users/k/.kirolex/sessions/s_1/files');
    assert.match(s, /tokyo/);
    assert.match(s, /\/home\/ec2-user\/v3\.md/);
    assert.match(s, /local_write/);
    assert.match(s, /\/Users\/k\/\.kirolex\/sessions\/s_1\/files/);
  });

  test('事后发现时：说清文件在远端，并指向「复制到本机」', () => {
    const s = strayWriteNotice('tokyo', [`${HOME}/v3.md`]);
    assert.match(s, /⚠️/);
    assert.match(s, /tokyo/);
    assert.match(s, /v3\.md/);
    assert.match(s, /复制到本机/);
  });
});

describe('复制回本机的落点', () => {
  test('放进会话的 files 目录、用原来的文件名；本机已有同名的别的文件时不覆盖', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-copy-'));
    try {
      const first = localCopyPath(dir, `${HOME}/kirolex-mirror/scratch/files-1/v3.md`, () => false);
      assert.equal(first, path.join(dir, 'v3.md'));
      fs.writeFileSync(first, '本机自己的那份');
      const second = localCopyPath(dir, `${HOME}/v3.md`, () => false);
      assert.equal(second, path.join(dir, 'v3 (远端).md'));
      fs.writeFileSync(second, 'x');
      assert.equal(localCopyPath(dir, `${HOME}/v3.md`, () => false), path.join(dir, 'v3 (远端 2).md'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('本机那份和远端内容一样 → 直接用它（重复点不生出一堆副本）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-copy-'));
    try {
      fs.writeFileSync(path.join(dir, 'v3.md'), 'same');
      assert.equal(localCopyPath(dir, `${HOME}/v3.md`, (p) => fs.readFileSync(p, 'utf8') === 'same'), path.join(dir, 'v3.md'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('文件名里的怪字符不能把落点带出 files 目录', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-copy-'));
    try {
      for (const remote of [`${HOME}/..`, '/', `${HOME}/a:b?.md`]) {
        const p = localCopyPath(dir, remote, () => false);
        assert.equal(path.dirname(p), dir, remote);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('接线：AcpClient 在权限请求那一层拦', () => {
  /* 直接驱动私有的 handleAgentRequest（不起进程）—— 判据是行为：拒掉、说一声、不转给人 */
  const permission = (toolCall: any) => ({
    jsonrpc: '2.0', id: 9, method: 'session/request_permission',
    params: {
      sessionId: 'cli-1', toolCall,
      options: [{ optionId: 'ok', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }],
    },
  });
  const make = async (mode: 'auto-approve' | 'ask') => {
    const { AcpClient } = await import('../src/main/acp-client.ts');
    const c: any = new AcpClient('m', {}, undefined, mode);
    const sent: any[] = [];
    const events: any[] = [];
    c.send = (m: any) => sent.push(m);
    c.on('update', (e: any) => events.push(['update', e]));
    c.on('remote-write-blocked', (e: any) => events.push(['blocked', e]));
    c.remoteWriteGuard = (tc: any) => remoteWriteVerdict(tc, ctx);
    return { c, sent, events };
  };

  for (const mode of ['auto-approve', 'ask'] as const) {
    test(`${mode}：远端 fs_write 写到缓存以外 → 选 reject、发 remote-write-blocked、不转给界面`, async () => {
      const { c, sent, events } = await make(mode);
      c.handleAgentRequest(permission({ kind: 'edit', title: 'Editing v3.md', rawInput: { command: 'create', path: `${HOME}/v3.md` } }));
      assert.deepEqual(sent, [{ jsonrpc: '2.0', id: 9, result: { outcome: { outcome: 'selected', optionId: 'no' } } }]);
      assert.equal(events.length, 1);
      assert.equal(events[0][0], 'blocked');
      assert.deepEqual(events[0][1].paths, [`${HOME}/v3.md`]);
    });
  }

  test('写缓存 / 跑命令照旧按权限模式走（自动批准）', async () => {
    const { c, sent, events } = await make('auto-approve');
    c.handleAgentRequest(permission({ kind: 'edit', rawInput: { path: 'scratch.py' } }));
    c.handleAgentRequest(permission({ kind: 'execute', rawInput: { command: 'make' } }));
    assert.deepEqual(sent.map((m) => m.result.outcome.optionId), ['ok', 'ok']);
    assert.equal(events.length, 0);
  });

  test('本地会话（没接闸）不受影响', async () => {
    const { AcpClient } = await import('../src/main/acp-client.ts');
    const c: any = new AcpClient('m', {}, undefined, 'auto-approve');
    const sent: any[] = [];
    c.send = (m: any) => sent.push(m);
    c.handleAgentRequest(permission({ kind: 'edit', rawInput: { path: '/home/x/v3.md' } }));
    assert.equal(sent[0].result.outcome.optionId, 'ok');
  });
});

describe('接线：远端会话 agent 不预先信任自带的写文件工具', () => {
  test('合并程序把 allowedTools 里信任写文件的条目和 toolsSettings 里的写文件设置剔掉', async () => {
    const { remoteAgentScript } = await import('../src/main/remoteLocalTools.ts');
    const sc = remoteAgentScript('kirolex-local-s1', 'aws-agent', 'http://127.0.0.1:39100/mcp/tok');
    const prog = sc.slice(sc.indexOf("python3 -c '") + 12, sc.length - 1);
    assert.equal(prog.includes("'"), false, 'python 程序里不许出现单引号');
    assert.match(prog, /native_write = \["fs_write", "write", "@builtin\/fs_write", "@builtin\/write"\]/);
    assert.match(prog, /fnmatch\.fnmatchcase\(w, str\(t\)\)/);
    assert.match(prog, /if kept\(t\) and not trusts_write\(t\)/);
    assert.match(prog, /k not in native_write/);
  });

  test('真跑一遍（POSIX 且有 python3 时）：* / fs_write 被剔掉，fs_read 和本机工具留着', {
    skip: process.platform === 'win32' && '远端脚本（bash + python3 + HOME）只在 POSIX 上能本机冒烟',
  }, async () => {
    const { execFileSync } = await import('node:child_process');
    const { remoteAgentScript } = await import('../src/main/remoteLocalTools.ts');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthome-'));
    try {
      fs.mkdirSync(path.join(home, '.kiro', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(home, '.kiro', 'agents', 'a.json'), JSON.stringify({
        name: 'a', tools: ['*'], allowedTools: ['fs_read', 'fs_write', 'fs_*', '*', 'execute_bash'],
        toolsSettings: { fs_write: { allowedPaths: ['~/**'] }, execute_bash: { autoAllowReadonly: true } },
      }));
      execFileSync('bash', ['-lc', remoteAgentScript('out', 'a', 'http://127.0.0.1:1/mcp/t')], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
      const j = JSON.parse(fs.readFileSync(path.join(home, '.kiro', 'agents', 'out.json'), 'utf8'));
      assert.deepEqual(j.allowedTools, ['fs_read', 'execute_bash', '@kirolex-local']);
      assert.deepEqual(Object.keys(j.toolsSettings), ['execute_bash']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('提示词：交付文件写本机、远端 cwd 是缓存', () => {
  test('说清用 local_write 写到会话的本机文件夹、远端写文件工具会被拒、cwd 是随时会被清的缓存', async () => {
    const { remoteContextBlock } = await import('../src/main/remoteContext.ts');
    for (const hasLocalProject of [true, false]) {
      const b = remoteContextBlock({
        hostLabel: 'tokyo', remoteDir: CWD, localDir: '/Users/k/proj', hasLocalProject,
        filesDir: '/Users/k/.kirolex/sessions/s_1/files',
      });
      assert.match(b, /交付给用户的文件一律写在他机器上/);
      assert.match(b, /local_write`（默认放进 `\/Users\/k\/\.kirolex\/sessions\/s_1\/files`/);
      assert.match(b, /别用你这台机器上自带的写文件工具（fs_write \/ write 之类）写交付物/);
      assert.match(b, /是\*\*缓存\*\*，里面的东西随时会被清、不算交付/);
      assert.match(b, /会被 KiroLex 拒绝 —— 被拒了就改用 `local_write`/);
    }
  });

  test('远端 cwd 落在 ~/.cache/kirolex 下，而不是 kirolex-mirror/scratch（哪怕工作目录配的就是 kirolex-mirror）', async () => {
    const { sessionCwd } = await import('../src/main/config.ts');
    const cwd = sessionCwd({ model: 'm', remote: { enabled: true, sshHost: 'ec2-user@h', remoteWorkdir: '/home/ec2-user/kirolex-mirror' } } as any, '/Users/k/.kirolex/sessions/s_1/files');
    assert.match(cwd, /^\/home\/ec2-user\/\.cache\/kirolex\/files-[0-9a-f]{8}$/);
    assert.equal(isRemoteDisposablePath(cwd, HOME), true, 'cwd 本身就在用完即弃的地方');
  });
});

describe('接线（源码扫描）', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const P = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'preload.ts'), 'utf8');
  const wire = M.slice(M.indexOf('function wireSession('), M.indexOf('function wireSession(') + 12000);

  test('wireSession 给远程会话接上写文件闸，拦下时在状态行说一声', () => {
    assert.match(wire, /client\.remoteWriteGuard = \(toolCall\) => remoteWriteVerdict\(toolCall, \{ cwd: entry\.cwd, home: remoteHomeDir\(remoteHost\) \}\)/);
    assert.match(wire, /client\.on\('remote-write-blocked'[\s\S]{0,400}sessionNotice\(sessionId, blockedWriteNotice\(/);
  });

  test('漏过去的远端写：事后认出来，提示里带「复制到本机」的路径', () => {
    assert.match(wire, /strayRemoteDeliverables\(/);
    assert.match(wire, /sessionNotice\(sessionId, strayWriteNotice\([\s\S]{0,200}\{ copyRemote: stray \}\)/);
  });

  test('「复制到本机」走 IPC：经 ssh 读、写进会话的本机 files 目录（tmp + rename）', () => {
    const at = M.indexOf("ipcMain.handle('workspace:copy-remote-to-local'");
    assert.ok(at > 0, '没有注册 workspace:copy-remote-to-local');
    const body = M.slice(at, at + 2000);
    assert.match(body, /remoteFileFor\(sessionId/);
    assert.match(body, /remoteFileBytes\(/);
    assert.match(body, /saveRemoteCopy\(sessionFilesDir\(sessionId\), remote\.path, got\.buffer\)/);
    assert.match(P, /copyRemoteToLocal: \(sessionId: string, remotePath: string\) =>\s*ipcRenderer\.invoke\('workspace:copy-remote-to-local'/);
  });
});

describe('审查回归：真实 kiro 权限请求的形状', () => {
  /*
    `scripts/acp-probe.mjs` 实测：`session/request_permission` 只带 `{ toolCallId, title }`，
    kind / rawInput 在早 ~1ms 到的同一 toolCallId 的 `tool_call` 通知里。只看请求本身会判成"不是写文件"而放行。
  */
  const make = async (mode: 'auto-approve' | 'ask') => {
    const { AcpClient } = await import('../src/main/acp-client.ts');
    const c: any = new AcpClient('m', {}, undefined, mode);
    const sent: any[] = [];
    const events: any[] = [];
    c.send = (m: any) => sent.push(m);
    c.on('update', (e: any) => events.push(['update', e]));
    c.on('remote-write-blocked', (e: any) => events.push(['blocked', e]));
    c.remoteWriteGuard = (tc: any) => remoteWriteVerdict(tc, ctx);
    return { c, sent, events };
  };
  const notify = (c: any, update: any) => c.handleMessage({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'cli-1', update } });
  const ask = (c: any, toolCall: any) => c.handleMessage({
    jsonrpc: '2.0', id: 41, method: 'session/request_permission',
    params: { sessionId: 'cli-1', toolCall, options: [{ optionId: 'ok', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }], _meta: {} },
  });

  for (const mode of ['auto-approve', 'ask'] as const) {
    test(`${mode}：先到的 tool_call 通知带 kind/rawInput，权限请求只有 toolCallId/title → 照样拦`, async () => {
      const { c, sent, events } = await make(mode);
      notify(c, {
        sessionUpdate: 'tool_call', toolCallId: 'tooluse_v3', title: 'Editing promo-new-story-bairong-ai-coding-v3.md', kind: 'edit', status: 'pending',
        rawInput: { command: 'create', path: `${HOME}/kirolex-mirror/scratch/files-e4a2a483/promo-new-story-bairong-ai-coding-v3.md`, file_text: '# v3' },
      });
      ask(c, { toolCallId: 'tooluse_v3', title: 'Editing promo-new-story-bairong-ai-coding-v3.md' });
      assert.deepEqual(sent, [{ jsonrpc: '2.0', id: 41, result: { outcome: { outcome: 'selected', optionId: 'no' } } }]);
      const blocked = events.filter((e) => e[0] === 'blocked');
      assert.equal(blocked.length, 1);
      assert.deepEqual(blocked[0][1].paths, [`${HOME}/kirolex-mirror/scratch/files-e4a2a483/promo-new-story-bairong-ai-coding-v3.md`]);
      assert.equal(events.some((e) => e[0] === 'update' && e[1]?.update?.sessionUpdate === 'permission_request'), false, '拦下的不该再转给人');
    });
  }

  test('同样形状写进缓存 → 不拦，按自动批准放行', async () => {
    const { c, sent, events } = await make('auto-approve');
    notify(c, { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Editing tmp.py', kind: 'edit', rawInput: { command: 'create', path: 'tmp.py' } });
    ask(c, { toolCallId: 't2', title: 'Editing tmp.py' });
    assert.equal(sent[0].result.outcome.optionId, 'ok');
    assert.equal(events.some((e) => e[0] === 'blocked'), false);
  });

  test('ToolCallLedger：后来的 update 只补字段不抹掉；有上限', () => {
    const l = new ToolCallLedger(2);
    l.remember({ toolCallId: 'a', kind: 'edit', rawInput: { path: '/x' } });
    l.remember({ toolCallId: 'a', status: 'in_progress' });
    assert.deepEqual(l.join({ toolCallId: 'a', title: 'T' }), { toolCallId: 'a', kind: 'edit', rawInput: { path: '/x' }, status: 'in_progress', title: 'T' });
    l.remember({ toolCallId: 'b', kind: 'read' });
    l.remember({ toolCallId: 'c', kind: 'read' });
    assert.deepEqual(l.join({ toolCallId: 'a' }), { toolCallId: 'a' }, '最老的被挤掉');
  });
});

describe('审查回归：文件名里带 local_write / kirolex-local 不能被当成本机工具', () => {
  test('远端原生写文件写 local_write.md → 照样拦，事后也照样提示复制', () => {
    for (const p of [`${HOME}/local_write.md`, `${HOME}/kirolex-local/a.md`]) {
      const tc = { kind: 'edit', title: `Editing ${p}`, rawInput: { command: 'create', path: p } };
      assert.equal(isLocalToolCall(tc), false, p);
      assert.equal(remoteWriteVerdict(tc, ctx).block, true, p);
      assert.deepEqual(strayRemoteDeliverables({ ...tc, status: 'completed' }, ctx), [p]);
    }
    assert.equal(isLocalToolCall({ title: 'Editing local_write' }), false);
  });
});

describe('审查回归：复制到本机之后，预览 / comment 写回的是本机那一份', () => {
  test('saveRemoteCopy 真写盘（tmp + rename、不留临时文件）→ 按会话登记 → review 写回闸选中本机文件 → 写回本机', async () => {
    const { ReviewedPaths, pickReviewTarget, writeTextVia } = await import('../src/main/reviewAccess.ts');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-copy-'));
    try {
      const filesDir = path.join(root, 'sessions', 's_1', 'files');
      const remotePath = `${HOME}/kirolex-mirror/scratch/files-e4a2a483/promo-v3.md`;
      const original = '# v3\n\n第一段\n';
      const bytes = Buffer.from(original, 'utf8');
      const local = saveRemoteCopy(filesDir, remotePath, bytes);
      assert.equal(local, path.join(filesDir, 'promo-v3.md'));
      assert.equal(fs.readFileSync(local, 'utf8'), original);
      assert.deepEqual(fs.readdirSync(filesDir), ['promo-v3.md'], '不留 .kx-tmp');
      /* 再点一次：内容一样 → 复用，不生副本 */
      assert.equal(saveRemoteCopy(filesDir, remotePath, bytes), local);
      assert.deepEqual(fs.readdirSync(filesDir), ['promo-v3.md']);

      /* 渲染端接着用本机路径打开预览 → workspace:read 按会话登记（和 index.ts 的 markReviewed 同一个闸） */
      const reviewed = new ReviewedPaths();
      reviewed.mark('s_1', local);
      const target = pickReviewTarget<{ sshHost: string }>({
        raw: local,
        resolveLocal: (r) => r,
        localExists: (p) => fs.existsSync(p),
        /* 就算它也像远端路径，本机这份登记过就写本机 */
        remoteFor: () => ({ target: { sshHost: 'ec2-user@h' }, path: remotePath }),
        reviewed: (k) => reviewed.has('s_1', k),
      });
      assert.deepEqual(target, { ok: true, want: local }, '写回目标是本机文件，不是远端');
      /* 别的会话不能借道 */
      assert.equal(pickReviewTarget<{ sshHost: string }>({
        raw: local, resolveLocal: (r) => r, localExists: () => true, remoteFor: () => null,
        reviewed: (k) => reviewed.has('s_2', k),
      }).ok, false);

      /* comment「✓ 确认」后的写回（本机 io） */
      let backedUp = '';
      const edited = '# v3\n\n第一段（改过）\n';
      const res = await writeTextVia({
        max: 512 * 1024,
        read: async () => { const t = fs.readFileSync(local, 'utf8'); return { size: Buffer.byteLength(t), bytes: Buffer.byteLength(t), text: t }; },
        backup: (prev) => { backedUp = prev; return true; },
        write: async (text) => { fs.writeFileSync(local, text); },
      }, edited, original);
      assert.equal(res.ok, true);
      assert.equal(backedUp, original);
      assert.equal(fs.readFileSync(local, 'utf8'), edited);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('审查回归：复制稍大的文件（> 1 MB）不能撞上 execFile 默认的 1 MiB stdout 上限', () => {
  /*
    远端读回来是 `KXSIZE <n>\n` + base64（4/3 倍）。用一个真子进程打出同样形状的输出（不需要 ssh），
    走和 `runRemoteCapture` 同一个 `execFile` —— 默认上限会报 ERR_CHILD_PROCESS_STDIO_MAXBUFFER，
    按 `captureBufferFor` 放宽就完整拿到。
  */
  const capture = async (size: number, maxBuffer?: number) => {
    const { execFile } = await import('node:child_process');
    const script = `const b=Buffer.alloc(${size}, 7); process.stdout.write('KXSIZE ' + b.length + String.fromCharCode(10) + b.toString('base64'));`;
    return new Promise<{ err: any; out: string }>((resolve) => {
      execFile(process.execPath, ['-e', script], { encoding: 'utf8', ...(maxBuffer ? { maxBuffer } : {}) },
        (err, stdout) => resolve({ err, out: String(stdout || '') }));
    });
  };

  test('captureBufferFor 装得下 base64 之后的正文，且不低于 1 MiB', async () => {
    const { captureBufferFor } = await import('../src/main/remoteWriteGuard.ts');
    for (const n of [0, 512 * 1024, 900_000, 5 * 1024 * 1024, 64 * 1024 * 1024]) {
      const need = `KXSIZE ${n}\n`.length + Math.ceil(n / 3) * 4;
      assert.ok(captureBufferFor(n) >= need, String(n));
      assert.ok(captureBufferFor(n) >= 1024 * 1024);
    }
  });

  test('2 MB 文件：默认上限读不全；按 captureBufferFor 放宽后字节一个不少', async () => {
    const { captureBufferFor } = await import('../src/main/remoteWriteGuard.ts');
    const size = 2 * 1024 * 1024;
    const dflt = await capture(size);
    assert.equal(dflt.err?.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', '前提：默认 1 MiB 确实不够');
    const ok = await capture(size, captureBufferFor(64 * 1024 * 1024));
    assert.equal(ok.err, null);
    const nl = ok.out.indexOf('\n');
    assert.equal(Number(ok.out.slice(7, nl)), size);
    assert.equal(Buffer.from(ok.out.slice(nl + 1), 'base64').length, size);
  });

  test('接线：远端读按上限放宽 stdout，复制那条路给 64 MB 和更长的超时', () => {
    const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
    assert.match(M, /function runRemoteCapture\(remote: RemoteTarget, script: string, timeoutMs = 60_000, maxBuffer\?: number, stdin\?: string\)/);
    assert.match(M, /\.\.\.\(maxBuffer \? \{ maxBuffer \} : \{\}\)/);
    assert.match(M, /runRemoteCapture\(target, script, timeoutMs, captureBufferFor\(max\)\)/);
    const at = M.indexOf("ipcMain.handle('workspace:copy-remote-to-local'");
    assert.match(M.slice(at, at + 2000), /remoteFileBytes\(remote\.target, remote\.path, MAX, 5 \* 60_000\)/);
  });
});
