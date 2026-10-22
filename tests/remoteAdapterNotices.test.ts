/**
 * 远程适配器那几句提示 —— ab052098 验收时发现的三个老问题：
 *   1. 远程没装适配器 / 没 node 时，会话里的报错前面带一段英文 `Error invoking remote method 'acp:load-session': Error:`
 *      （新建会话时也一样）—— 只显示我们自己的那句；
 *   2. 「登录 shell 看不到…已直接用 fnm 的 node 起」几秒就自动消失 —— 这条会话没换掉之前一直挂着；
 *   3. 「还没登录、也没配 Bedrock / API key」每次重启都再记一条（×2、×3）；第一次启动有时要重新打开会话才看到。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { noteAlreadyInTranscript } from '../src/main/kirolexNote.ts';
import { connectFailureNotice } from '../src/renderer/connectFailure.ts';
import { cleanIpcError } from '../src/renderer/sessionRequestStatus.ts';
import { notesAfterReload } from '../src/renderer/noticeMerge.ts';
import { createNoticeHub } from '../src/renderer/sessionNoticeHub.ts';
import { createAdapterNotes } from '../src/main/adapterNotes.ts';

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf8');
const MISSING = 'graviton 上没有 Claude Code 的 ACP 适配器（claude-agent-acp）。设置 → 🖥 机器 → 选中这台机器 →「安装 AI 工具」会装上它。';

describe('1. 报错不带 Electron 包的英文前缀', () => {
  test('新建会话失败的「没连上」提示：只留我们自己的中文那句', () => {
    for (const ch of ['acp:new-session', 'acp:load-session']) {
      const n = connectFailureNotice(`Error invoking remote method '${ch}': Error: ${MISSING}`, 1, 'zh');
      assert.ok(!/Error invoking remote method/.test(n.content), n.content);
      assert.ok(!/Error invoking remote method/.test(n.variants!.zh) && !/Error invoking remote method/.test(n.variants!.en));
      assert.ok(n.content.endsWith(MISSING));
    }
  });

  test('cleanIpcError 认字符串和 Error 两种；没有前缀的原样', () => {
    assert.equal(cleanIpcError(`Error invoking remote method 'acp:load-session': Error: ${MISSING}`), MISSING);
    assert.equal(cleanIpcError(new Error(`Error invoking remote method 'acp:prompt': ${MISSING}`)), MISSING);
    assert.equal(cleanIpcError(MISSING), MISSING);
  });

  test('接线：错误横幅（noteError）和发消息失败的那条气泡都先去掉前缀', () => {
    const A = read('src', 'renderer', 'hooks', 'useAcp.ts');
    const ne = A.slice(A.indexOf('const noteError = useCallback('), A.indexOf('const noteError = useCallback(') + 600);
    assert.match(ne, /cleanIpcError\(raw\)/);
    assert.match(A, /content: `⚠️ \$\{\(retryErr\?\.message && cleanIpcError\(retryErr\)\) \|\| t\('Failed to send message\.'\)\}`/);
    assert.ok(!/content: `⚠️ \$\{retryErr\?\.message \|\|/.test(A), '原来那条照原文显示的写法不能留着');
  });
});

describe('2. 「已直接用 fnm 的 node 起」一直挂着', () => {
  test('适配器探测的状态行走 pinned（不自动消失，别的提示来了也不把它换掉）', () => {
    const M = read('src', 'main', 'index.ts');
    const at = M.indexOf('const adapterNotes = (() => {');
    const body = M.slice(at, at + 2500);
    assert.match(body, /how === 'status'\) \{ stickySessionNotice\(sid, text, group, \{ pinned: true \}\)/);
    const fn = M.slice(M.indexOf('function stickySessionNotice('), M.indexOf('function stickySessionNotice(') + 700);
    assert.match(fn, /pinned: true/);
  });

  test('hub：pinned 那句之后来了别的提示（实测 40ms 后就来了一句「自动起标题…」）→ 还记着；关掉才清', () => {
    let cb: ((d: any) => void) | null = null;
    const hub = createNoticeHub((fn) => { cb = fn; return () => { cb = null; }; });
    const seen: string[] = [];
    const off = hub.subscribe((_sid, n) => seen.push(n.text));
    const pinned = { sessionId: 'A', ts: 1, sticky: true, pinned: true, group: 'adapter-hidden:graviton:claude', text: 'graviton 的登录 shell 找不到 Claude Code 适配器，已直接用 fnm 的 node 起。' };
    cb!(pinned);
    cb!({ sessionId: 'A', ts: 2, text: '自动起标题…不用 Kiro' });
    cb!({ sessionId: 'A', ts: 3, text: '⏳ 正在推送' });
    assert.equal(hub.pinnedFor('A')?.text, pinned.text);
    assert.equal(hub.pinnedFor('A')?.pinned, true);
    assert.equal(hub.stickyFor('A'), undefined, 'sticky 照旧被下一句换掉');
    assert.equal(hub.pinnedFor('B'), undefined);
    assert.equal(seen.length, 3, '别的提示照常显示（盖在上面）');
    /* 同一条会话又来一句 pinned → 换成新的 */
    cb!({ ...pinned, ts: 4, text: '新的一句' });
    assert.equal(hub.pinnedFor('A')?.text, '新的一句');
    hub.clearPinned('A');
    assert.equal(hub.pinnedFor('A'), undefined);
    off();
  });

  test('接线：别的提示淡出后回到 pinned 那句；切回这条会话时也回来；关掉时一起清', () => {
    const U = read('src', 'renderer', 'hooks', 'useSessionNotice.ts');
    assert.match(U, /setTimeout\(\(\) => setNotice\(\(sessionId && hub\.pinnedFor\(sessionId\)\) \|\| null\)/);
    assert.match(U, /hub\.stickyFor\(sessionId\) \?\? hub\.pinnedFor\(sessionId\)/);
    assert.match(U, /hub\.clearPinned\(sessionId\)/);
  });
});

describe('3. 「还没登录」同一个原因只记一条', () => {
  const hint = '⚠️ graviton 上的 Claude Code 还没登录，也没配 Bedrock / API key，发消息会失败。';
  const hintEn = '⚠️ Claude Code on graviton is not signed in and has no Bedrock / API key configured, so messages will fail.';
  const group = 'remote-login:graviton:claude';

  test('记录里已经有这一句（同组、同话）→ 不再追加（重启后 said 是空的也一样）', () => {
    const tr = [
      { id: 'u1', role: 'user', content: '你好' },
      { id: 'n1', role: 'user', content: hint, kirolex: true, noteGroup: group, variants: { zh: hint, en: hintEn } },
      { id: 'a1', role: 'assistant', content: '好' },
    ];
    assert.equal(noteAlreadyInTranscript(tr, group, [hint]), true);
    /* 中间切过界面语言：落盘的是中文，这次说的是英文 —— 还是同一句 */
    assert.equal(noteAlreadyInTranscript(tr, group, [hintEn, hint]), true);
    assert.equal(noteAlreadyInTranscript([{ ...tr[1], content: hintEn, variants: undefined }], group, [hint, hintEn]), true);
  });

  test('没有 / 不同组 / 不是 KiroLex 说的 / 同组最新那条说的是别的 → 要说', () => {
    assert.equal(noteAlreadyInTranscript([], group, [hint]), false);
    assert.equal(noteAlreadyInTranscript([{ id: 'n', content: hint, kirolex: true, noteGroup: 'remote-login:other:claude' }], group, [hint]), false);
    assert.equal(noteAlreadyInTranscript([{ id: 'u', content: hint, noteGroup: group }], group, [hint]), false);
    assert.equal(noteAlreadyInTranscript([
      { id: 'n1', content: hint, kirolex: true, noteGroup: group },
      { id: 'n2', content: '别的话', kirolex: true, noteGroup: group },
    ], group, [hint]), false);
  });

  test('接线：adapterNotes 落盘前先看记录里有没有（说过就记成已说）', () => {
    const M = read('src', 'main', 'index.ts');
    const at = M.indexOf('const adapterNotes = (() => {');
    const body = M.slice(at, at + 2500);
    assert.match(body, /noteAlreadyInTranscript\(store\.readTranscript\(sid\), group,/);
  });

  test('第一次启动：提示到的时候这条会话的列表还是空的 → 读回盘上的历史（提示已经落盘，自然在里面）', () => {
    const note = { id: 'n1', content: hint };
    const stored = [{ id: 'u1', content: '你好' }, note];
    assert.deepEqual(notesAfterReload([], stored, [note]), stored);
    /* 读盘那会儿别处已经填好了列表 → 只把这条接上去（已经有了就不重复） */
    const cur = [{ id: 'u1', content: '你好' }];
    assert.deepEqual(notesAfterReload(cur, [], [note]), [...cur, note]);
    assert.equal(notesAfterReload([...cur, note], stored, [note]), null);
    /* 盘上读不到、列表也还是空 → 不动 */
    assert.equal(notesAfterReload([], [], [note]), null);
  });

  test('接线：插不进去的提示，当前会话就读盘补上', () => {
    const A = read('src', 'renderer', 'hooks', 'useAcp.ts');
    const at = A.indexOf('const showLiveNotes = (sid: string, notes: Message[]) => {');
    const body = A.slice(at, at + 2200);
    assert.match(body, /notesAfterReload\(/);
    assert.match(body, /readTranscript\(sid\)/);
  });
});

/**
 * 跟进 9432ab38：「已直接用 fnm 的 node 起」钉住以后，换到另一台不需要 fnm 回退的机器（或换了引擎）还挂着旧机器那句 ——
 * 把旧状态当成了现状。换位置 / 换引擎时清掉这条会话的 adapter-hidden 钉住提示，新机器要的话由新的探测重新钉上。
 */
describe('4. 换机器 / 换引擎清掉旧的钉住提示', () => {
  const GROUP_A = 'adapter-hidden:graviton:claude';
  const HIDDEN_A = 'graviton 的登录 shell 找不到 Claude Code 适配器，已直接用 fnm 的 node 起。';
  /* 主进程那半（adapterNotes 的记账）+ 渲染端那半（hub），中间就是 session:notice 那条 IPC */
  const wire = () => {
    let cb: ((d: any) => void) | null = null;
    const hub = createNoticeHub((fn) => { cb = fn; return () => { cb = null; }; });
    const shown: Array<string | null> = [];
    const off = hub.subscribe((_sid, n) => shown.push(n.text), (_sid) => shown.push(null));
    const notes = createAdapterNotes({
      hasRecord: () => true,
      emit: (sid, how, text, group) => { if (how === 'status') cb!({ sessionId: sid, text, ts: Date.now(), sticky: true, pinned: true, group }); return true; },
      unpin: (sid, prefix) => cb!({ sessionId: sid, text: '', ts: Date.now(), unpin: prefix }),
    });
    return { hub, notes, shown, off };
  };

  test('换到不需要 fnm 回退的机器 → 旧机器那句钉住提示消失', () => {
    const { hub, notes, shown, off } = wire();
    notes.say('S', 'status', HIDDEN_A, GROUP_A);
    assert.equal(hub.pinnedFor('S')?.text, HIDDEN_A);
    notes.forgetPinned('S');   // 换机器（新机器的探测判出来不用回退：什么都不说）
    assert.equal(hub.pinnedFor('S'), undefined);
    assert.equal(shown.at(-1), null, '正显示着的那句也要撤掉');
    assert.equal(hub.stickyFor('S'), undefined, '它也记在 sticky 里：切回这条会话时不能从那儿又冒出来');
    off();
  });

  test('同一台机器重连 → 提示还在（也不重复钉）', () => {
    const { hub, notes, shown, off } = wire();
    notes.say('S', 'status', HIDDEN_A, GROUP_A);
    notes.say('S', 'status', HIDDEN_A, GROUP_A);   // 重连又探测了一次
    assert.equal(hub.pinnedFor('S')?.text, HIDDEN_A);
    assert.deepEqual(shown, [HIDDEN_A]);
    off();
  });

  test('换走再换回来（或新机器也要回退）→ 新的探测重新钉上；别的会话不受影响', () => {
    const { hub, notes, off } = wire();
    notes.say('S', 'status', HIDDEN_A, GROUP_A);
    notes.say('T', 'status', HIDDEN_A, GROUP_A);
    notes.forgetPinned('S');
    assert.equal(hub.pinnedFor('T')?.text, HIDDEN_A, '别的会话的钉住提示不动');
    notes.say('S', 'status', HIDDEN_A, GROUP_A);
    assert.equal(hub.pinnedFor('S')?.text, HIDDEN_A, '回到原来那台：重新钉上（不是被「说过了」挡掉）');
    off();
  });

  test('只清 adapter-hidden 那类：「还没登录」那句的「说过了」不动；别的钉住提示也不动', () => {
    const said: string[] = [];
    const notes = createAdapterNotes({ hasRecord: () => true, emit: (_s, _h, text) => { said.push(text); return true; }, unpin: () => {} });
    notes.say('S', 'note', '还没登录', 'remote-login:graviton:claude');
    notes.forgetPinned('S');
    notes.say('S', 'note', '还没登录', 'remote-login:graviton:claude');
    assert.deepEqual(said, ['还没登录']);

    let cb: ((d: any) => void) | null = null;
    const hub = createNoticeHub((fn) => { cb = fn; });
    hub.subscribe(() => {});
    cb!({ sessionId: 'S', text: '别的钉住', ts: 1, pinned: true, group: 'other:x' });
    cb!({ sessionId: 'S', text: '', ts: 2, unpin: 'adapter-hidden:' });
    assert.equal(hub.pinnedFor('S')?.text, '别的钉住');
  });

  test('新建会话时攒着还没发的那句也作废（换了就不该再钉旧机器的）', () => {
    let has = false;
    const said: string[] = [];
    const notes = createAdapterNotes({ hasRecord: () => has, emit: (_s, _h, text) => { said.push(text); return true; }, unpin: () => {} });
    notes.say('S', 'status', HIDDEN_A, GROUP_A);
    notes.forgetPinned('S');
    has = true;
    notes.commit('S');
    assert.deepEqual(said, []);
  });

  test('接线：换机器、换引擎（连着的、没连着的）都先清掉', () => {
    const M = read('src', 'main', 'index.ts');
    const at = M.indexOf('const adapterNotes = (() => {');
    const body = M.slice(at, at + 2500);
    assert.match(body, /createAdapterNotes\(/);
    assert.match(body, /unpinSessionNotice\(/);
    const target = M.slice(M.indexOf('const hostLabelOf = (t?: RemoteTarget)'), M.indexOf("ipcMain.handle('acp:set-remote-target'"));
    assert.equal(target.match(/adapterNotes\.forgetPinned\(sessionId\)/g)?.length, 2, '换机器：没连着 / 连着 两条路');
    const eng = M.slice(M.indexOf("const before = engineOf(oldEntry?.profile || rec0?.profile);"), M.indexOf("const before = engineOf(oldEntry?.profile || rec0?.profile);") + 2500);
    assert.equal(eng.match(/adapterNotes\.forgetPinned\(sessionId\)/g)?.length, 2, '换引擎：没连着 / 连着 两条路');
    const U = read('src', 'renderer', 'hooks', 'useSessionNotice.ts');
    assert.match(U, /prev\?\.pinned/);
  });
});
