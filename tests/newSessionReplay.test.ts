import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { isReplayOutsideTurn } from '../src/main/replayGuard.ts';
import { reconcileWithStore } from '../src/renderer/messageReconcile.ts';

/*
  「现在开新会话还有历史会话」「graviton 那个远程机器的」（10-20 18:40，`s_1792492836455_jmu79y`）。
  盘上 0 条、`tail` 0 条 —— store 是空的，脏的是界面。那次的顺序：
    10:40:30 删掉正看着的空 New Chat D（远程：删除要等执行器退出，最多 8 s，再挪目录）
    10:40:36 点「新对话」→ N（远程：preflight + ssh + session/new，好几秒才建好）
    之后     D 的删除返回
  **这是假设下的重放，不是现场复现**：下面的模型主动往 N 注入一段旧对话，证明的是「只要 N 的缓存里有
  外来内容」这三处缺口会把它画出来、修好后不会。外来内容是不是后端回放，见 acpReplayTiming.test.ts
  （真 AcpClient + 按实测 kiro-cli 2.13 帧序写的假 agent：session/new 不吐正文、session/load 的回放在响应
  之前、主进程 await 之后才接监听 → 都到不了界面；只有「响应之后才回放」会，那是 ① 防的形状）。
  三处缺口：
  ① 主进程把执行器发来的每条 session/update 都转给渲染层，一轮之外也一样 —— 如果后端在响应之后回放旧对话
     （user/agent_message_chunk），它会进 N 的消息缓存（渲染层对没在流式的会话一律写缓存）；
  ② deleteSession 用的是点删除那一刻的焦点（闭包里的 currentSessionId）：删除返回时焦点早就是 N 了，
     照样「自动切到最新那条」—— 最新那条就是 N 自己，于是 switchSession(N) 把那份缓存画了出来；
  ③ switchSession 对「正在建」的会话整段跳过对账（还拿那份缓存去查自动重发）。
  useAcp.ts 测试 import 不了（React hook），所以和 messageCacheReconcile.test.ts 一样：纯函数直接测 +
  照 hook 写的最小状态模型重放那次交错（旧 / 新各跑一遍）+ 源码扫描钉住接线。
*/

type M = { id: string; role: 'user' | 'assistant'; content: string; timestamp: number };
const u = (id: string, ts: number): M => ({ id, role: 'user', content: id, timestamp: ts });
const a = (id: string, ts: number): M => ({ id, role: 'assistant', content: id, timestamp: ts });

// ---------------------------------------------------------------------------
// 1. 主进程判据（纯函数）
// ---------------------------------------------------------------------------

test('回放判据：一轮之外的对话正文（用户 / 助手 / 思考块）是后端回放，丢', () => {
  for (const kind of ['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'agent_reasoning_chunk']) {
    assert.equal(isReplayOutsideTurn({ sessionUpdate: kind }, false), true, kind);
    assert.equal(isReplayOutsideTurn({ sessionUpdate: kind }, true), false, `${kind}：一轮之内照常`);
  }
});

test('回放判据：不是消息的更新（命令表、plan、工具、权限、无 sessionUpdate）一轮之外照常转发', () => {
  for (const update of [
    { method: '_kiro.dev/commands/available' },
    { sessionUpdate: 'plan' },
    { sessionUpdate: 'tool_call' },
    { sessionUpdate: 'permission_request' },
    {},
    null,
    undefined,
  ]) {
    assert.equal(isReplayOutsideTurn(update as any, false), false, JSON.stringify(update));
  }
});

// ---------------------------------------------------------------------------
// 2. 事件交错：照 hook + 主进程写的最小状态模型
// ---------------------------------------------------------------------------

/** 别的会话的历史（远端 kiro-cli 回放出来的那段） */
const OLD: M[] = Array.from({ length: 12 }, (_, i) => (i % 2 ? a(`old_a${i}`, -50 + i) : u(`old_u${i}`, -50 + i)));

function makeApp(opts: { fixed: boolean }) {
  const disk: Record<string, M[]> = { X: [u('x_u1', 1), a('x_a1', 2)], D: [], N: [] };
  const cache = new Map<string, M[]>();
  const sessions: { id: string; timestamp: number }[] = [{ id: 'X', timestamp: 10 }, { id: 'D', timestamp: 20 }];
  const creating = new Set<string>();
  const streaming = new Set<string>();
  const busy = new Set<string>();             // 主进程 entry.busy
  let focus: string | null = null;
  let messages: M[] = [];
  let owner: string | null = null;
  const recovered: string[] = [];
  const effect = () => { if (focus && owner === focus && messages.length > 0) cache.set(focus, messages); };
  const setMessages = (next: M[]) => { owner = focus; messages = next; effect(); };
  /* App：焦点指着一个已经不在列表里的会话 → unfocusSession() */
  const appEffect = () => { if (focus && !sessions.some((s) => s.id === focus)) { focus = null; setMessages([]); } };
  const switchSession = (sid: string) => {
    focus = sid;
    const cached = cache.get(sid);
    setMessages(cached || []);
    const isCreating = creating.has(sid);
    const reconcileFirst = !!cached && cached.length > 0 && !streaming.has(sid) && (opts.fixed || !isCreating);
    if (cached && cached.length > 0 && !reconcileFirst && (!opts.fixed || !isCreating)) recovered.push(sid);
    if (!cached || !cached.length) {
      if (disk[sid]?.length) { cache.set(sid, disk[sid].slice()); setMessages(disk[sid].slice()); }
    } else if (reconcileFirst) {
      const healed = reconcileWithStore(cached, disk[sid] || []);
      if (healed) { cache.set(sid, healed); if (focus === sid) setMessages(healed); }
    }
  };
  return {
    cache, creating, busy, recovered,
    get focus() { return focus; },
    shown: () => messages.map((m) => m.id),
    switchSession,
    /** 主进程 wireSession 收到一条 update → 渲染层 onUpdate（没在流式 → 写这条会话的缓存） */
    backendUpdate(sid: string, sessionUpdate: string, m: M) {
      if (opts.fixed && isReplayOutsideTurn({ sessionUpdate }, busy.has(sid))) return;
      if (sid === focus && streaming.has(sid)) setMessages([...messages, m]);
      else cache.set(sid, [...(cache.get(sid) || []), m]);
    },
    /** deleteSession 点下去那一刻（同步部分）；返回「删除 IPC 回来之后」那一段 */
    deleteSession(sid: string) {
      const closureFocus = focus;                  // useCallback 闭包里的 currentSessionId
      const idx = sessions.findIndex((s) => s.id === sid);
      sessions.splice(idx, 1);
      cache.delete(sid);
      appEffect();
      return () => {
        const focusNow = focus;                    // currentSessionRef.current
        const stillThere = opts.fixed
          ? closureFocus === sid && (focusNow === sid || focusNow === null)
          : closureFocus === sid;
        if (!stillThere) return;
        const next = sessions.slice().sort((x, y) => y.timestamp - x.timestamp)[0];
        if (next) switchSession(next.id); else { focus = null; setMessages([]); }
      };
    },
    newSession(id: string, ts: number) {
      sessions.unshift({ id, timestamp: ts });
      focus = id;
      setMessages([]);
      creating.add(id);
    },
  };
}

/** 那次的顺序：看着 D → 删 D → 建 N（远程，还在建）→ N 的后端在一轮之外吐出一段旧对话 → D 的删除返回 */
function incident(app: ReturnType<typeof makeApp>) {
  app.switchSession('D');
  const deleteReturns = app.deleteSession('D');
  assert.equal(app.focus, null, '被删的那条一摘掉，App 就把焦点清掉了');
  app.newSession('N', 30);
  assert.deepEqual(app.shown(), []);
  for (const m of OLD) app.backendUpdate('N', m.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', m);
  deleteReturns();
}

test('交错（复现）：旧写法 —— 删除返回后焦点被「自动切」到正在建的 N，回放进缓存的旧对话被画成 N 的消息', () => {
  const app = makeApp({ fixed: false });
  incident(app);
  assert.equal(app.focus, 'N');
  assert.ok(app.shown().includes('old_u0'), '新会话的界面出现了别的会话的历史 —— 用户看到的就是这个');
  assert.deepEqual(app.recovered, ['N'], '还拿这份没核对的缓存去查了自动重发');
});

test('交错：修好后 —— 回放不进缓存、删除不抢焦点，新会话只显示空白欢迎页', () => {
  const app = makeApp({ fixed: true });
  incident(app);
  assert.equal(app.focus, 'N');
  assert.deepEqual(app.shown(), []);
  assert.equal(app.cache.get('N'), undefined, '一轮之外的回放一块都没进缓存');
  assert.deepEqual(app.recovered, []);
  /* 切走切回也还是空的 */
  app.switchSession('X');
  app.switchSession('N');
  assert.deepEqual(app.shown(), []);
});

test('交错：就算缓存已经被别的途径污染，正在建的会话被切到时也和 store 对账（store 为空 → 清空），且不查自动重发', () => {
  const app = makeApp({ fixed: true });
  app.newSession('N', 30);
  app.cache.set('N', OLD.slice());
  app.switchSession('X');
  app.switchSession('N');
  assert.ok(app.creating.has('N'));
  assert.deepEqual(app.shown(), []);
  assert.deepEqual(app.cache.get('N'), []);
  assert.deepEqual(app.recovered, []);
});

test('交错：一轮之内的正文照常显示（不是回放）', () => {
  const app = makeApp({ fixed: true });
  app.newSession('N', 30);
  app.creating.delete('N');
  app.busy.add('N');
  app.backendUpdate('N', 'agent_message_chunk', a('n_a1', 31));
  assert.deepEqual(app.cache.get('N')!.map((m) => m.id), ['n_a1']);
});

test('交错：删除返回时你还停在原处（焦点已被清空）→ 照旧自动切到最新那条；你已经自己选了别的 → 不动', () => {
  const stay = makeApp({ fixed: true });
  stay.switchSession('D');
  stay.deleteSession('D')();
  assert.equal(stay.focus, 'X');
  const moved = makeApp({ fixed: true });
  moved.switchSession('D');
  const back = moved.deleteSession('D');
  moved.switchSession('X');
  moved.newSession('N', 30);
  back();
  assert.equal(moved.focus, 'N');
});

// ---------------------------------------------------------------------------
// 3. 接线
// ---------------------------------------------------------------------------

const MAIN = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
const H = fs.readFileSync(new URL('../src/renderer/hooks/useAcp.ts', import.meta.url), 'utf8');

test('接线：wireSession 在累加 assistantBuf、转发 acp:update 之前丢掉一轮之外的回放（按 entry.busy），并记日志', () => {
  const at = MAIN.indexOf('function wireSession(sessionId: string, entry: SessionEntry) {');
  assert.ok(at >= 0);
  const body = MAIN.slice(at, MAIN.indexOf("mainWindow?.webContents.send('acp:update'", at));
  const guard = body.indexOf('if (isReplayOutsideTurn(data?.update, !!entry.busy)) {');
  assert.ok(guard > 0, '没有回放守卫');
  assert.ok(guard > body.indexOf('if (entry.priming) return;'));
  assert.ok(guard < body.indexOf("entry.assistantBuf += u?.content?.text || '';"), '必须在累加回复之前');
  assert.match(body.slice(guard, guard + 600), /logger\.warn\('acp', `dropped replayed/);
  assert.match(body.slice(guard, guard + 600), /return;/);
});

test('接线：deleteSession 删完之后按此刻的焦点决定要不要自动切', () => {
  const del = H.slice(H.indexOf('const deleteSession = useCallback('), H.indexOf('const forgetSessions = useCallback('));
  assert.match(del, /const focusNow = currentSessionRef\.current;[\s\S]{0,300}?if \(currentSessionId === sessionId && \(focusNow === sessionId \|\| focusNow === null\)\) \{/);
  /* 焦点在删除期间换了 → 不切，记一行 */
  assert.match(del, /diagSessionView\?\.\('delete: focus moved during the delete, not auto-switching'/);
});

test('接线：缓存被对账重载时把丢掉的 id 和它们在哪条会话的缓存里写进主进程日志（下次出现能直接看到来源）', () => {
  const helper = H.slice(H.indexOf('const reconcileCacheFromStore = async'), H.indexOf('const recoveryTargetIsOwn = async'));
  assert.match(helper, /window\.kiroApi\.diagSessionView\?\.\('cache reloaded from store', \{[\s\S]*droppedOwners: owners/);
  const P = fs.readFileSync(new URL('../src/main/preload.ts', import.meta.url), 'utf8');
  assert.match(P, /diagSessionView: \(event: string, detail: Record<string, unknown>\) => ipcRenderer\.send\('diag:session-view', event, detail\)/);
  assert.match(MAIN, /ipcMain\.on\('diag:session-view', \(_event, what: string, detail: Record<string, unknown>\) => \{[\s\S]{0,300}logger\.warn\('view'/);
});

test('接线：追问建议在**发起时**按会话记一行（完成那行要隔几秒到几十秒，单看它不能当「新会话 messages 非空」的证据）', () => {
  const C = fs.readFileSync(new URL('../src/renderer/components/ChatArea.tsx', import.meta.url), 'utf8');
  assert.match(C, /window\.kiroApi\.generateSuggestions\?\.\(recent, \{ sessionId: currentSessionId, messages: messages\.length, paneFocused \}\)/);
  const h = MAIN.slice(MAIN.indexOf("ipcMain.handle('app:generate-suggestions'"), MAIN.indexOf("ipcMain.handle('app:generate-suggestions'") + 1500);
  const req = h.indexOf("logger.info('suggestions', `requested sessionId=");
  assert.ok(req > 0, '没有发起时那一行');
  assert.ok(req < h.indexOf('await runLiteOneShot('), '必须在等 lite 之前记');
});

test('残留的每会话 agent（kirolex-local-<owner>-<会话>）不会出现在界面上：agent 下拉过滤掉，session/new 返回的 modes 渲染层不读', () => {
  assert.match(MAIN, /parseAgentList\(out\)\.filter\(\(a\) => !a\.name\.startsWith\(SESSION_AGENT_PREFIX\)\)/);
  const R = ['hooks/useAcp.ts', 'App.tsx', 'components/ChatArea.tsx']
    .map((f) => fs.readFileSync(new URL(`../src/renderer/${f}`, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(R, /availableModes|currentModeId/);
});
