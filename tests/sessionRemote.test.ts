import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseRemoteTargets, readRemoteTargets, resolveSessionRemote, refreshedSnapshot, saveRemoteTarget } from '../src/main/remoteTargets.ts';

/*
 * 「会话记录里的远程机器快照过期」：aws-tokyo-4 从直连 99.83.165.184 改成 SSM 之后，
 * 老会话（record 里还是 ec2-user@99.83.165.184、没有 connectVia）preflight 仍连 99.83.165.184:22。
 */
const OLD_SNAPSHOT = { id: 'aws-tokyo-4', label: 'aws-tokyo', sshHost: 'ec2-user@99.83.165.184', sshPort: 22, identityFile: '/k/tokyo.pem', bins: { kiro: '/old/kiro' } };
const NOW = parseRemoteTargets({
  remotes: [{
    id: 'aws-tokyo-4', label: 'aws-tokyo', sshHost: 'ec2-user@i-03b396ce3b8546b90',
    connectVia: 'ssm', ssmInstanceId: 'i-03b396ce3b8546b90', ssmRegion: 'ap-northeast-1', bins: { kiro: '/new/kiro' },
  }],
}, '/home/me');

describe('会话按 id 解析到设置里现在的那台机器', () => {
  test('改了 sshHost / connectVia 之后，老会话解析到新配置（连接字段一个不留快照的）', () => {
    const r = resolveSessionRemote(OLD_SNAPSHOT, NOW);
    assert.equal(r.source, 'config');
    assert.equal(r.deleted, undefined);
    assert.equal(r.remote?.sshHost, 'ec2-user@i-03b396ce3b8546b90');
    assert.equal(r.remote?.connectVia, 'ssm');
    assert.equal(r.remote?.ssmInstanceId, 'i-03b396ce3b8546b90');
    assert.equal(r.remote?.ssmRegion, 'ap-northeast-1');
    assert.equal(r.remote?.bins?.kiro, '/new/kiro');
    assert.equal(r.remote?.identityFile, undefined, '快照里的旧私钥不能混进来');
  });

  test('id 在设置里找不到：标成已删除，remote 是快照（兜底），调用方据此明说', () => {
    const r = resolveSessionRemote({ ...OLD_SNAPSHOT, id: 'gone-1' }, NOW);
    assert.equal(r.deleted, true);
    assert.equal(r.source, 'snapshot');
    assert.equal(r.remote?.sshHost, 'ec2-user@99.83.165.184');
  });

  test('id 被 host:port 去重成另一条：认到留下来的那条', () => {
    const r = resolveSessionRemote({ ...OLD_SNAPSHOT, id: 'aws-tokyo-2' }, NOW, (id) => (id === 'aws-tokyo-2' ? NOW[0] : undefined));
    assert.equal(r.source, 'config');
    assert.equal(r.remote?.id, 'aws-tokyo-4');
  });

  test('配置读不了：只能用快照，不当成删了', () => {
    const r = resolveSessionRemote(OLD_SNAPSHOT, null);
    assert.equal(r.source, 'snapshot');
    assert.equal(r.deleted, undefined);
    assert.equal(r.remote?.sshHost, 'ec2-user@99.83.165.184');
  });

  test('没 id 的老记录按 sshHost + 端口兜底匹配', () => {
    const targets = parseRemoteTargets({ remotes: [{ id: 'box', sshHost: 'u@1.2.3.4', sshPort: 2222, bins: { kiro: '/live/kiro' } }] }, '/home/me');
    const hit = resolveSessionRemote({ sshHost: 'u@1.2.3.4', sshPort: 2222 }, targets);
    assert.equal(hit.source, 'config');
    assert.equal(hit.remote?.id, 'box');
    assert.equal(hit.remote?.bins?.kiro, '/live/kiro');
    const otherPort = resolveSessionRemote({ sshHost: 'u@1.2.3.4' }, targets);
    assert.equal(otherPort.source, 'snapshot', '端口不同就不是同一台');
    assert.equal(otherPort.deleted, undefined, '没 id 判断不了删没删：照旧用快照');
  });

  test('本地会话什么都不解析', () => {
    assert.deepEqual(resolveSessionRemote(undefined, NOW), {});
    assert.deepEqual(resolveSessionRemote({ sshHost: '' } as any, NOW), {});
  });

  test('readRemoteTargets：读不了返回 null，读到空列表返回 []', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-sr-'));
    assert.equal(readRemoteTargets(path.join(dir, 'nope.json')), null);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{');
    assert.equal(readRemoteTargets(path.join(dir, 'bad.json')), null);
    fs.writeFileSync(path.join(dir, 'ok.json'), '{}');
    assert.deepEqual(readRemoteTargets(path.join(dir, 'ok.json')), []);
  });
});

describe('设置里存机器时刷新会话快照', () => {
  test('按 id 认：返回新快照；别的机器的会话返回 null', () => {
    const next = refreshedSnapshot(OLD_SNAPSHOT, NOW[0]);
    assert.equal(next?.sshHost, 'ec2-user@i-03b396ce3b8546b90');
    assert.equal(next?.connectVia, 'ssm');
    assert.equal(refreshedSnapshot({ ...OLD_SNAPSHOT, id: 'other' }, NOW[0]), null);
    assert.equal(refreshedSnapshot(undefined, NOW[0]), null);
  });

  test('没 id 的老记录按改之前的地址认；SSH→SSM 顺手删掉的老 agents[].remote 的 id 也认', () => {
    const before = { sshHost: 'ec2-user@99.83.165.184', sshPort: 22 };
    assert.equal(refreshedSnapshot({ sshHost: 'ec2-user@99.83.165.184' }, NOW[0], before)?.id, 'aws-tokyo-4');
    assert.equal(refreshedSnapshot({ sshHost: 'ec2-user@5.5.5.5' }, NOW[0], before), null);
    const saved = { ...NOW[0], droppedLegacy: ['agent_1'] };
    const fromLegacy = refreshedSnapshot({ id: 'agent_1', sshHost: 'ec2-user@99.83.165.184' }, saved, before);
    assert.equal(fromLegacy?.id, 'aws-tokyo-4');
    assert.equal((fromLegacy as any)?.droppedLegacy, undefined, '返回值上的簿记字段不进快照');
  });

  test('和 saveRemoteTarget 串起来：改成 SSM 后老快照刷新成新配置', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-sr-'));
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ remotes: [{ id: 'aws-tokyo-4', label: 'aws-tokyo', sshHost: 'ec2-user@99.83.165.184', sshPort: 22 }] }));
    const saved = saveRemoteTarget(cfg, {
      id: 'aws-tokyo-4', sshHost: 'ec2-user@i-03b396ce3b8546b90',
      connectVia: 'ssm', ssmInstanceId: 'i-03b396ce3b8546b90', ssmRegion: 'ap-northeast-1',
    }, dir);
    const next = refreshedSnapshot(OLD_SNAPSHOT, saved);
    assert.equal(next?.sshHost, 'ec2-user@i-03b396ce3b8546b90');
    assert.equal(next?.connectVia, 'ssm');
    assert.equal(resolveSessionRemote(OLD_SNAPSHOT, readRemoteTargets(cfg, dir)).remote?.connectVia, 'ssm');
  });
});

/*
 * 接线（index.ts 太大、起不了 electron，按源码核对）：没连着的会话打开配置面板 / AI 登录、连着的会话换模型 / Agent /
 * 引擎 / 组合 —— 这些另起 ssh 的入口都先按 id 解析到设置里现在的那台，机器被删了就在 ssh 之前明说。
 */
describe('接线：另起 ssh 的入口都走同一个解析', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf-8');
  const slice = (anchor: string, n = 3000) => { const at = M.indexOf(anchor); assert.ok(at > 0, anchor); return M.slice(at, at + n); };

  test('kiroConfigTargetFor（配置面板 / AI 登录 / 远端文件）：活着的和记录里的都按 liveSessionRemote 解析，删了就抛', () => {
    const body = slice('const kiroConfigTargetFor', 500);
    assert.match(body, /liveSessionRemote\(sessionClients\.get\(sessionId\)\?\.profile\.remote \|\| store\.readRecord\(sessionId\)\?\.profile\?\.remote\)/);
    /* 调用方把那句删除提示原样交回界面，不往下 ssh */
    for (const anchor of ["ipcMain.handle('kiro:config-list'", "ipcMain.handle('kiro:config-read'", "ipcMain.handle('kiro:config-write'"]) {
      assert.match(slice(anchor, 1500), /\{ const gone = sessionMachineGone\(sessionId\); if \(gone\) return \{ ok: false, error: gone \}; \}\n    const target = kiroConfigTargetFor\(sessionId\);/, anchor);
    }
    assert.match(slice("ipcMain.handle('kiro:open-agent-config'"), /\{ const gone = sessionMachineGone\(sessionId\); if \(gone\) return \{ opened: false, error: gone \}; \}\n    const remoteT = kiroConfigTargetFor\(sessionId\);/);
    assert.match(slice("ipcMain.handle('kiro:save-agent-config'"), /\{ const gone = sessionMachineGone\(sessionId\); if \(gone\) return \{ saved: false, error: gone \}; \}\n    const remoteT = kiroConfigTargetFor\(sessionId\);/);
    assert.match(slice('function remoteFileFor', 400), /if \(sessionMachineGone\(sessionId\)\) return null;\n    const target = kiroConfigTargetFor\(sessionId\);/);
    assert.match(slice('const sessionMachineGone', 300), /try \{ kiroConfigTargetFor\(sessionId\); return null; \} catch/);
  });

  test('换模型：新执行器和回滚的那个都按现在的配置连，解析在动旧执行器之前', () => {
    const body = slice('const switchModelImpl', 7000);
    const live = body.indexOf('const live = liveRemountTarget(sessionId, oldEntry);');
    assert.ok(live > 0);
    assert.ok(live < body.indexOf('await awaitAttachIdle(sessionId);'), '删了的机器要在释放旧执行器之前报');
    assert.ok(live < body.indexOf('sessionClients.delete(sessionId)'));
    assert.match(body, /remote: live\.remote,\n    \};\n    profile\.modelEarnedOn = machineKeyOf\(profile\);/);
    assert.match(body, /const cliSessionId = oldEntry\.cliSessionId;\n    const cwd = live\.cwd;/);
    assert.match(body, /oldEntry\.profile\.permissionMode, live\.remote, undefined, engineOf\(oldEntry\.profile\),/);
  });

  test('换 Agent / 换引擎 / 重挂组合 / 自动换模型：同样先解析，cwd 按新配置', () => {
    const agent = slice('const switchKiroAgentImpl', 4000);
    assert.ok(agent.indexOf('const live = liveRemountTarget(sessionId, oldEntry);') < agent.indexOf('await awaitAttachIdle(sessionId);'));
    assert.match(agent, /kiroAgent: normalizedAgent, remote: live\.remote/);
    assert.match(agent, /client\.newSession\(live\.cwd\)/);
    const engine = slice('const switchEngineImpl', 6000);
    assert.match(engine, /const live = liveRemountTarget\(sessionId, oldEntry\);\n    await awaitAttachIdle\(sessionId\);/);
    assert.match(engine, /reshape\(\{ \.\.\.oldEntry\.profile, remote: live\.remote \}\)/);
    const remount = slice('async function remountWithProfile', 1500);
    assert.ok(remount.indexOf('liveRemountTarget(') < remount.indexOf('toolsSwapped = !!'), '删了的机器要在换掉工具通道之前报');
    assert.match(remount, /client\.newSession\(live\.cwd\)/);
    const swap = slice('async function swapSessionModel', 2500);
    const at = swap.indexOf('const live = liveRemountTarget(sessionId, entry);');
    assert.ok(at > 0 && at < swap.indexOf('sessionClients.delete(sessionId)'), '删了的机器要在拿掉旧执行器之前报');
    assert.match(swap, /entry\.profile = \{ \.\.\.entry\.profile, remote: live\.remote \};\n    entry\.cwd = live\.cwd;/);
  });

  test('liveRemountTarget：删了就抛；地址变了 cwd 按新配置重算', () => {
    const body = slice('function liveRemountTarget', 600);
    assert.match(body, /const remote = liveSessionRemote\(entry\.profile\.remote\);/);
    assert.match(body, /remote\.sshHost !== before\n    \? sessionCwd\(\{ \.\.\.entry\.profile, remote \}/);
  });
});
