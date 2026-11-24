import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 「会话同步到别的电脑后，模型要知道现在在哪台电脑上跑」（2026-11-24）。
 *
 * 不能写进全局记忆：记忆跨电脑三方合并，写死「这台是 X」到另一台就错了。所以每轮由 KiroLex
 * 按**当前这台**动态生成一行 `[本机] …`，放在记忆块最前面。
 */
const ROOT = path.join(import.meta.dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8');
const remoteCtxSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'remoteContext.ts'), 'utf8');

const base = {
  hostname: 'kyn-workstation', platform: 'win32', osRelease: '10.0.26100', user: 'kyn06',
  kirolexHome: 'C:\\Users\\kyn06\\.kirolex', deviceId: 'abcd1234', advanced: false, version: '0.1.0', commit: 'abcdef1',
};

describe('localMachineInfo', () => {
  test('三种 platform 的显示名', async () => {
    const { localMachineInfo, platformDisplayName } = await import('../src/main/localMachine.ts');
    assert.equal(localMachineInfo({ ...base, platform: 'win32' }).platform, 'Windows');
    assert.equal(localMachineInfo({ ...base, platform: 'darwin' }).platform, 'macOS');
    assert.equal(localMachineInfo({ ...base, platform: 'linux' }).platform, 'Linux');
    /* 没见过的原样给，不编一个 */
    assert.equal(platformDisplayName('freebsd'), 'freebsd');
  });

  test('label 和同步里用的是同一个 machineTag', async () => {
    const { localMachineInfo } = await import('../src/main/localMachine.ts');
    const { machineTag } = await import('../src/main/s3Sync.ts');
    const info = localMachineInfo(base);
    assert.equal(info.label, machineTag('kyn-workstation'));
    assert.equal(info.deviceId, 'abcd1234');
    assert.equal(info.user, 'kyn06');
    assert.equal(info.kirolexHome, 'C:\\Users\\kyn06\\.kirolex');
    assert.equal(info.osRelease, '10.0.26100');
  });

  test('edition 判定：标准版 / advanced', async () => {
    const { localMachineInfo } = await import('../src/main/localMachine.ts');
    assert.equal(localMachineInfo({ ...base, advanced: false }).edition, '标准版');
    assert.equal(localMachineInfo({ ...base, advanced: true }).edition, 'advanced');
    assert.equal(localMachineInfo({ ...base, advanced: undefined }).edition, '标准版');
  });

  test('版本号 = version + 构建 commit；缺版本号 / commit 时不报错', async () => {
    const { localMachineInfo, machineInfoLine } = await import('../src/main/localMachine.ts');
    assert.equal(localMachineInfo(base).version, '0.1.0 (abcdef1)');
    assert.equal(localMachineInfo({ ...base, commit: '' }).version, '0.1.0');
    const none = localMachineInfo({ ...base, version: undefined, commit: undefined });
    assert.equal(none.version, '');
    const line = machineInfoLine(none);
    assert.match(line, /^\[本机\] kyn-workstation · Windows 10\.0\.26100 · 用户 kyn06 · KiroLex 标准版 · 数据目录 /);
    assert.doesNotMatch(line, /undefined|null/);
  });

  test('不给参数时取这台电脑的真实信息，也不抛', async () => {
    const { localMachineInfo } = await import('../src/main/localMachine.ts');
    const info = localMachineInfo();
    assert.equal(info.hostname, os.hostname());
    assert.ok(info.platform);
    assert.ok(info.kirolexHome.endsWith('.kirolex'));
  });

  test('那一行：例子里的样子，不超过 ~200 字符', async () => {
    const { localMachineInfo, machineInfoLine } = await import('../src/main/localMachine.ts');
    const line = machineInfoLine(localMachineInfo(base));
    assert.equal(line, '[本机] kyn-workstation · Windows 10.0.26100 · 用户 kyn06 · KiroLex 标准版 0.1.0 (abcdef1) · 数据目录 C:\\Users\\kyn06\\.kirolex');
    assert.ok(line.length <= 200, `${line.length}`);
    /* 很长的目录 / 主机名也截住，不让第一行膨胀 */
    const long = machineInfoLine(localMachineInfo({ ...base, kirolexHome: 'C:\\' + 'x'.repeat(400), hostname: 'h'.repeat(100) }));
    assert.ok(long.length <= 200, `${long.length}`);
    assert.ok(!long.includes('\n'));
  });

  test('远程会话：说清本机 = 用户的电脑、远端是哪台', async () => {
    const { localMachineInfo, machineInfoBlock } = await import('../src/main/localMachine.ts');
    const info = localMachineInfo(base);
    const local = machineInfoBlock(info);
    assert.equal(local.split('\n').length, 1);
    const remote = machineInfoBlock(info, { remoteLabel: 'tokyo-ec2' });
    const [first, second] = remote.split('\n');
    assert.match(first, /^\[本机\] /);
    assert.match(second, /本机 = 用户的电脑（上面这台），你所在的远端是 tokyo-ec2/);
  });

  test('会话上次在别的电脑上用过时附一句；同一台不说', async () => {
    const { localMachineInfo, machineInfoBlock } = await import('../src/main/localMachine.ts');
    const info = localMachineInfo(base);
    assert.match(machineInfoBlock(info, { lastUsedOn: 'f00baa-kyn-mbp' }), /这条会话上次在 f00baa-kyn-mbp 上用过/);
    assert.doesNotMatch(machineInfoBlock(info, { lastUsedOn: info.label }), /上次在/);
  });

  test('用户机器的称呼按 platform 生成', async () => {
    const { userMachineName } = await import('../src/main/localMachine.ts');
    assert.equal(userMachineName('win32'), '用户的 Windows 电脑');
    assert.equal(userMachineName('darwin'), '用户的 macOS 电脑');
    assert.equal(userMachineName('linux'), '用户的 Linux 电脑');
  });
});

describe('远程说明按真实系统描述用户机器', () => {
  test('源码里那段不再写死 Mac', () => {
    const start = remoteCtxSrc.indexOf('export function remoteContextBlock');
    const body = remoteCtxSrc.slice(start);
    /* 字符串字面量里不能把用户机器叫成 Mac（注释不算） */
    const literals = body.match(/'[^'\n]*'|`[^`]*`/g) || [];
    for (const s of literals) assert.doesNotMatch(s, /Mac/, s);
  });

  test('Windows / macOS / Linux 各自的称呼和命令语法', async () => {
    const { remoteContextBlock } = await import('../src/main/remoteContext.ts');
    const inp = { hostLabel: 'tokyo', remoteDir: '/r', localDir: '/l', hasLocalProject: false };
    const win = remoteContextBlock({ ...inp, localPlatform: 'win32' });
    assert.match(win, /不是用户的 Windows 电脑/);
    assert.match(win, /去搜用户的 Windows 电脑/);
    assert.match(win, /cmd\.exe/);
    assert.match(win, /PowerShell/);
    assert.doesNotMatch(win, /Mac/);
    const mac = remoteContextBlock({ ...inp, localPlatform: 'darwin' });
    assert.match(mac, /不是用户的 macOS 电脑/);
    assert.match(mac, /bash/);
    assert.doesNotMatch(mac, /cmd\.exe/);
    const linux = remoteContextBlock({ ...inp, localPlatform: 'linux' });
    assert.match(linux, /不是用户的 Linux 电脑/);
    assert.doesNotMatch(linux, /Mac/);
  });
});

describe('接线：每轮注入 [本机]，本地和远程会话都有', () => {
  /* 一直截到真正发出去的那一行：中间所有往 prompt 前面塞东西的地方都要算上（含历史快照 rideAlongBlock） */
  const start = main.indexOf('// Inject layered memory');
  const region = main.slice(start, main.indexOf('entry.client.sendPrompt(entry.cliSessionId, prompt)', start));

  test('本机那行在注入块最前面，不受 memoryInjection 开关和会话类型限制', () => {
    assert.match(region, /machineInfoBlock\(currentMachineInfo\(\)/);
    /* 本机块最后 prepend → 落在最前面（记忆块之前） */
    const iMachine = region.indexOf("if (mi) prompt = [{ type: 'text', text: mi }, ...prompt];");
    const iMemory = region.indexOf('buildMemoryInjection(');
    assert.ok(iMachine > 0, '本机块要 prepend 到 prompt');
    assert.ok(iMachine > iMemory, '本机块要在记忆块之后 prepend，才会排在它前面');
    /* 远程会话带上远端 label */
    assert.match(region, /remoteLabel:/);
  });

  test('带历史快照（rideAlongBlock 非空）的轮次，第一块仍是 [本机]', () => {
    const iRide = region.indexOf("if (rideAlongBlock) prompt = [{ type: 'text', text: rideAlongBlock }, ...prompt];");
    const iMachine = region.indexOf("if (mi) prompt = [{ type: 'text', text: mi }, ...prompt];");
    assert.ok(iRide > 0 && iMachine > iRide, '本机块要在历史快照之后 prepend');
    /* 本机块之后、发出去之前，不能再有别的块被塞到 prompt 前面 */
    const after = region.slice(iMachine + 10);
    assert.doesNotMatch(after, /prompt = \[\{ type: 'text'/);
    assert.doesNotMatch(after, /prompt\.unshift\(/);
    /* 仍在用户消息落盘之后（不进 transcript） */
    const iPersist = main.lastIndexOf('if (!handoff) persistUserMessage();', start);
    assert.ok(iPersist > 0 && start - iPersist < 400, '用户消息就在注入段前落盘');
  });

  test('取的是这台电脑的信息，不从会话记录里读机器', () => {
    const fn = main.slice(main.indexOf('function currentMachineInfo'), main.indexOf('function currentMachineInfo') + 1200);
    assert.match(fn, /localMachineInfo\(/);
    assert.match(fn, /thisDeviceId\(\)/);
    assert.doesNotMatch(fn, /readRecord/);
  });

  test('不写进 memory.md、不进同步', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'localMachine.ts'), 'utf8');
    assert.doesNotMatch(src, /writeFileSync|writeMemory|s3Sync'|putObject/);
  });
});
