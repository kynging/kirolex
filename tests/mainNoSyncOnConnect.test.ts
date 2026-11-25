import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 「远程会话连接的前半段输入框没法输入」（2026-11-25，Windows + SSM）：Windows 上窗口的键盘输入要经过主进程，
 * 主进程被同步子进程卡住时整个窗口不响应输入。连接路径上的这几处同步调用改成了异步（调用方 await），
 * 这里读源码守住：它们不再用 execSync / execFileSync / spawnSync，延迟监控和阶段标记接上了。
 */
const read = (p: string) => fs.readFileSync(path.join(import.meta.dirname, '..', p), 'utf8');
const MAIN = read('src/main/index.ts');
const PROXY = read('src/main/sshProxy.ts');
const SYNC = /\b(execSync|execFileSync|spawnSync)\s*\(/;

/** 从 `anchor` 开始截到下一个顶格的 `}`（函数体） */
function body(src: string, anchor: string, end = '\n}\n'): string {
  const i = src.indexOf(anchor);
  assert.ok(i >= 0, `找不到 ${anchor}`);
  const rest = src.slice(i);
  return rest.slice(0, rest.indexOf(end) + end.length);
}

describe('连接路径上不再有同步子进程', () => {
  test('sweepStrayLocalSsh / sweepStrayLocalSshWindows：异步（PowerShell 冷启动常要几秒）', () => {
    for (const name of ['async function sweepStrayLocalSsh(', 'async function sweepStrayLocalSshWindows(']) {
      const b = body(MAIN, name);
      assert.doesNotMatch(b, SYNC, name);
      assert.match(b, /await execFileText\(/, name);
    }
    /* 宁可漏不可错杀：拿不到全量 pid 照旧什么都不杀 */
    assert.match(body(MAIN, 'async function sweepStrayLocalSshWindows('), /catch \{ return; \}/);
    /* 调用方 await 本机那一轮（远端那一轮要等它杀完才认得出孤儿），而整件事在窗口出来之后、不 await（不挡 attach） */
    assert.match(body(MAIN, 'async function sweepRemoteSessionAgents('), /lagPhases\.enter\('sweep local ssh'\)[\s\S]{0,80}try \{ await sweepStrayLocalSsh\(\); \} finally \{ endSweep\(\); \}/);
    const reveal = MAIN.slice(MAIN.indexOf("ipcMain.handle('acp:reveal'"));
    assert.match(reveal.slice(0, 600), /showMainWindow\(\);[\s\S]*void sweepRemoteSessionAgents\(\);/);
  });

  test('tightenKeyAcl / currentUserPrincipal：异步 execFile（超时照旧 15 秒），ACL 收紧照做', () => {
    for (const name of ['export async function tightenKeyAcl(', 'async function currentUserPrincipal(']) {
      const b = body(PROXY, name);
      assert.doesNotMatch(b, SYNC, name);
      assert.match(b, /await keyDeps\.execFile\(/, name);
    }
    assert.match(body(PROXY, 'export async function tightenKeyAcl('), /'\/inheritance:r'[\s\S]*'\/grant:r'[\s\S]*'\*S-1-5-18:F', '\*S-1-5-32-544:F'/);
    assert.doesNotMatch(PROXY, /import \{[^}]*execFileSync[^}]*\} from 'child_process'/);
    assert.match(PROXY, /execFile\(file, args, \{ encoding: 'utf8', windowsHide: true, timeout: 15_000 \}/);
    /* 同步取钥匙那条（buildSshArgs 用）不起子进程 */
    assert.doesNotMatch(body(PROXY, 'export function ensureSsmKey('), /execFile|tightenKeyAcl\(/);
    /* 起 ssh 之前先异步备好 */
    assert.match(body(PROXY, 'export function prepareSshFor('), /prepareSsmKey\(remote\)/);
    assert.match(body(MAIN, 'function prepareSsmTunnel('), /prepareSsmKey\(remote\)/);
  });

  test('pathProbe（找 LibreOffice）、本机 kiro-cli whoami：异步，超时不变', () => {
    const probe = body(MAIN, 'const findSoffice = async', '\n  };\n');
    assert.doesNotMatch(probe, SYNC);
    assert.match(probe, /await execShellText\(pathProbeCommand\(name, process\.platform\)/);
    assert.match(MAIN, /await findSoffice\(\)/);
    const i = MAIN.indexOf("execFileText(cli, ['whoami']");
    const around = MAIN.slice(i - 200, i + 60);
    assert.match(around, /await execFileText\(cli, \['whoami'\], \{ timeout: 20_000 \}\)/);
    assert.doesNotMatch(around, SYNC);
    assert.doesNotMatch(MAIN, /execFileSync\s*\(|import \{[^}]*execFileSync/, 'index.ts 里一处 execFileSync 调用都不剩');
  });
});

describe('延迟监控与阶段标记接上了', () => {
  test('主进程一启动就开监控，日志 scope 是 mainlag', () => {
    assert.match(MAIN, /createLagMonitor\(\{ log: \(line\) => logger\.warn\('mainlag', line\) \}\)\.start\(\);/);
  });

  test('attach / preflight / transcript 读取 / history 重建 / ensureSsmKey / sweep 处有阶段标记', () => {
    assert.match(MAIN, /lagPhases\.run\(`attach \$\{sessionId\}`, attachOnce\)/);
    assert.match(MAIN, /lagPhases\.run\(`preflight \$\{host\}`, \(\) => runPreflight\(remote, opts\)\)/);
    assert.match(MAIN, /lagPhases\.enter\(`ride-along \$\{sessionId\}`\)/);
    assert.match(MAIN, /lagPhases\.run\(`history rebuild \$\{sessionId\}`, async/);
    assert.match(read('src/main/sessionStore.ts'), /lagPhases\.run\(`transcript read \$\{id\}`/);
    assert.match(PROXY, /lagPhases\.run\(`ensureSsmKey /);
  });

  test('turn end 刷新 history.md：异步 + 排队（heavyLane），读到写之间 transcript 变了就重渲', () => {
    const b = body(MAIN, 'function refreshHistoryFile(');
    assert.match(b, /heavyLane\(\(\) => renderHistoryFileAsync\(sessionId\)\)/);
    assert.doesNotMatch(b, /renderHistoryFile\(sessionId\)/);
    const r = body(MAIN, 'async function renderHistoryFileAsync(');
    assert.match(r, /store\.readTranscriptAsync\(sessionId\)/);
    assert.match(r, /if \(stamp\(\) !== before\) continue;/);
    assert.match(r, /return await writeHistoryFromLines\(sessionId, lines\);/);
    assert.match(body(MAIN, 'async function writeHistoryFromLines('), /await store\.writeHistoryFileAsync\(/);
    assert.doesNotMatch(r, /readFileSync|writeFileSync|store\.readTranscript\(/);
  });
});

describe('启动后第 3 秒那一下：bg_run 辅助进程（winJob）不再用 -EncodedCommand 起', () => {
  /*
    延迟监控在沙箱里真跑出来的：`[mainlag] blocked=966 phase=attach …,preflight …`，CPU 剖析落在 winJob 的 `spawn` ——
    带一段新的 -EncodedCommand 起 powershell.exe，spawn 本身同步要 0.8–1.2 秒；-File 只要 ~10ms。
  */
  test('脚本写成文件、用 -File 起；写不了才退回 -EncodedCommand', () => {
    const W = read('src/main/winJob.ts');
    assert.match(W, /const scriptArgs = script \? \['-File', script\] : \['-EncodedCommand', /);
    assert.match(W, /\.\.\.scriptArgs\]/);
    assert.match(W, /const PS_NAME = `winjob-\$\{createHash\('sha256'\)\.update\(PS\)/);
  });
});

describe('历史恢复那几条路也不再同步整读（审查意见 1）', () => {
  /* 顶格函数体：截到下一个顶格的 function / async function */
  const fnAt = (name: string): string => {
    const at = MAIN.search(new RegExp(`\\n(async )?function ${name}\\(`));
    assert.ok(at >= 0, `找不到 ${name}`);
    const rest = MAIN.slice(at + 1);
    const next = rest.search(/\n(async )?function /);
    return rest.slice(0, next > 0 ? next : undefined);
  };
  const SYNC_READ = /store\.readTranscript\(|readFileSync|store\.writeHistoryFile\(|\brenderHistoryFile\(/;

  test('ride-along 快照：异步分片读、排进 heavyLane，history.md 异步写；手改的快照照旧优先', () => {
    const b = fnAt('buildHistoryRideAlong');
    assert.match(b, /^async function buildHistoryRideAlong\(sessionId: string\): Promise<string>/);
    assert.match(b, /await heavyLane\(\(\) => store\.readTranscriptAsync\(sessionId\)\)\)\s*\.filter\(modelFacing\)/);
    assert.match(b, /await historyLinesOf\(stored\)/);
    assert.match(b, /await buildSnapshot\(sessionId, stored, lines, \{ rideAlong: true \}\)/);
    assert.ok(b.indexOf('readContextOverride') < b.indexOf('readTranscriptAsync'), '手改的快照先于生成的');
    assert.doesNotMatch(b, SYNC_READ);
    const snap = fnAt('buildSnapshot');
    assert.match(snap, /^async function buildSnapshot\(/);
    assert.match(snap, /await heavyLane\(\(\) => writeHistoryFromLines\(sessionId, lines\)\)/);
    assert.doesNotMatch(snap, SYNC_READ);
  });

  test('发送时（sendPromptOnce）await 快照；等完再对一遍：执行器动过 → 整条重走；并发的另一次已经带上 / 开始重建 → 不带、不标记', () => {
    const i = MAIN.indexOf('const read = await prepOnExecutor(sessionId, entry, prepDeps, () => buildHistoryRideAlong(sessionId));');
    assert.ok(i > 0, '发送路径 await 异步快照（占住执行器读，见 sendPrep.test.ts）');
    const after = MAIN.slice(i, i + 1800);
    /* 执行器换了 / 正在换 / 没了：不往下（原来只是不带快照、仍发给旧执行器），先于标记 */
    const moved = after.indexOf("if (read.moved) return rerunOnCurrentExecutor('读历史快照', read.why);");
    const recheck = after.indexOf('if (rideAlongBlock && (contextEstablished(sessionId, entry)');
    assert.ok(moved > 0 && recheck > moved);
    const mark = after.indexOf('markContextEstablished(sessionId, entry);');
    assert.ok(recheck > 0 && mark > recheck, '先复查，再标记');
    assert.match(after, /entry\.priming \|\| entry\.needsHistoryPrime \|\| entry\.primeAbandoned\)\) \{[\s\S]{0,300}rideAlongBlock = '';/);
    /* 复查和标记之间没有 await：标记仍是原子的 */
    assert.doesNotMatch(after.slice(recheck, mark), /await /);
  });

  test('重建历史（primeHistoryNow）：在第一个 await 之前登记进行中（并发的 JOIN 同一次），读完再过一遍闸门', () => {
    const now = fnAt('primeHistoryNow');
    const reg = now.indexOf('entry.primePromise = planning;');
    assert.ok(reg > 0);
    assert.ok(now.indexOf('const planning = primeHistoryPlanned(sessionId, entry);') < reg);
    const code = now.slice(0, reg).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\bawait\b/, '登记之前不能有 await');
    assert.match(now, /if \(entry\.primePromise\) \{[\s\S]{0,120}return entry\.primePromise;/, 'JOIN 那道闸还在');
    assert.doesNotMatch(now, SYNC_READ);

    const planned = fnAt('primeHistoryPlanned');
    assert.match(planned, /await heavyLane\(\(\) => store\.readTranscriptAsync\(sessionId\)\)\)\s*\.filter\(modelFacing\)/);
    assert.match(planned, /lines = await historyLinesOf\(stored\);/);
    assert.match(planned, /splitHistory\(\[await buildSnapshot\(sessionId, stored, lines\)\], PRIME_CHUNK_CHARS\)/);
    assert.doesNotMatch(planned, SYNC_READ);
    /* 读完再过闸：执行器换了 / 点了停止 / 一轮开始了 */
    const reread = planned.indexOf('reason=executor-replaced while reading history');
    assert.ok(reread > 0 && reread < planned.indexOf('reason=empty-transcript'));
    assert.match(planned, /if \(entry\.primeAbandoned\) \{[\s\S]{0,200}return \{ ok: true, skipped: true \};/);
    assert.match(planned, /if \(entry\.busy\) \{[\s\S]{0,300}return \{ ok: true, queued: true \} as any;/);
    /* 重试语义不变：重试时用存下来的同一份分段（byte-identical） */
    assert.match(planned, /entry\.primeChunks && entry\.primeChunks\.length\s*\? entry\.primeChunks/);
    assert.match(planned, /entry\.primePromise = run;\s*return run;/);
  });

  test('同步的 renderHistoryFile 已经没有了，index.ts 里也不剩直接同步整读 transcript 的历史渲染', () => {
    assert.doesNotMatch(MAIN, /\nfunction renderHistoryFile\(/);
    assert.doesNotMatch(MAIN, /store\.writeHistoryFile\(/);
  });
});

describe('连接时那几句提示的去重也不再同步整读 transcript（审查意见：attach → remoteAdapterCheck → adapterNotes）', () => {
  test('adapterNotes：emit 返回 Promise 时，等它落定之前同一件事不说第二遍；说成了记成已说，没说成下次再说', async () => {
    const { createAdapterNotes } = await import('../src/main/adapterNotes.ts');
    const calls: string[] = [];
    let release!: (ok: boolean) => void;
    const notes = createAdapterNotes({
      hasRecord: () => true,
      emit: (_sid, _how, _text, group) => { calls.push(group); return new Promise<boolean>((r) => { release = r; }); },
      unpin: () => {},
    });
    notes.say('s1', 'note', '还没登录', 'remote-login:h:claude');
    notes.say('s1', 'note', '还没登录', 'remote-login:h:claude');   // 还在读记录：不再说
    assert.deepEqual(calls, ['remote-login:h:claude']);
    release(false);                                                   // 没说成
    await new Promise((r) => setImmediate(r));
    notes.say('s1', 'note', '还没登录', 'remote-login:h:claude');   // 下次再说
    assert.equal(calls.length, 2);
    release(true);
    await new Promise((r) => setImmediate(r));
    notes.say('s1', 'note', '还没登录', 'remote-login:h:claude');   // 说过了
    assert.equal(calls.length, 2);
    /* 同步返回 boolean 的老用法照旧 */
    const sync = createAdapterNotes({ hasRecord: () => true, emit: () => true, unpin: () => {} });
    let n = 0;
    const counted = createAdapterNotes({ hasRecord: () => true, emit: () => { n++; return true; }, unpin: () => {} });
    counted.say('s', 'status', 'x', 'g'); counted.say('s', 'status', 'x', 'g');
    assert.equal(n, 1);
    sync.say('s', 'status', 'x', 'g');
  });

  test('接线：adapterNotes / Codex 权限预检 / 窗口起来时的交棒恢复 都异步读 transcript', () => {
    const notes = MAIN.slice(MAIN.indexOf('const adapterNotes = (() => {'));
    const emit = notes.slice(0, notes.indexOf('createAdapterNotes('));
    assert.match(emit, /return heavyLane\(\(\) => store\.readTranscriptAsync\(sid\)\)\.then\(/);
    assert.doesNotMatch(emit, /store\.readTranscript\(/);

    const pre = body(MAIN, 'function precheckCodexBedrock(');
    assert.match(pre, /await heavyLane\(\(\) => store\.readTranscriptAsync\(sessionId\)\)/);
    assert.doesNotMatch(pre, /store\.readTranscript\(/);
    /* 并发的两次连接：查记录到记完之间占着这一句，不记两遍 */
    assert.match(pre, /if \(bedrockNoteChecking\.has\(checkKey\)\) return;/);
    assert.ok(pre.indexOf('noteInSession(') < pre.indexOf('bedrockNoteChecking.delete(checkKey)'), '记完才放开');
    /* 它确实在连接路径上被调到 */
    assert.match(MAIN, /if \(engine === 'codex' && sessionId\) precheckCodexBedrock\(sessionId, /);

    const h = MAIN.slice(MAIN.indexOf("ipcMain.handle('acp:take-pending-handoffs', async () => {"));
    const handler = h.slice(0, h.indexOf('\n  });'));
    assert.ok(handler.length > 100);
    assert.match(handler, /await store\.readTranscriptAsync\(id, \{ raw: true \}\)/);
    assert.doesNotMatch(handler, /store\.readTranscript\(/);
  });

  test('attach 那条链上的函数（挂载、预检、适配器检查、本地工具、起执行器、接线）里不再有同步整读 transcript', () => {
    const attach = MAIN.slice(MAIN.indexOf('  const loadSessionImpl = async ('), MAIN.indexOf("ipcMain.handle('acp:load-session'"));
    assert.doesNotMatch(attach, /store\.readTranscript\(|readFileSync\(.*transcript/);
    for (const name of ['async function remoteAdapterCheck(', 'function remotePreflight(', 'async function runPreflight(', 'function wireSession(']) {
      assert.doesNotMatch(body(MAIN, name), /store\.readTranscript\(/, name);
    }
  });
});
