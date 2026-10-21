import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { forgetRetryTicket, rememberRetryTicket, remapResumable, resumableFrom, resumableTicket, reusableAfterReload } from '../src/renderer/reviewResume.ts';
import { InFlightPrompts, completedReplyInText, decidePromptDedupe, messageIdStatus, reviseMessageId } from '../src/main/promptDedupe.ts';

/*
  守的是：窗口 reload 之后，你再提交一次"上次没做完"放回来的那条意见 —— 主进程那一次还在排 / 在跑 ——
  **不能**变成另一次改写、往会话里再发一遍。用回原来那张 ticket，主进程按 ticket 合并到原来那一次。
*/

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf-8');
const PANE = read('renderer', 'components', 'ReviewPane.tsx');
const M = read('main', 'index.ts');

describe('resumableFrom / resumableTicket', () => {
  /* loadMarks 放回来的样子：interruptedTickets（标记 → ticket）+ 标记里的意见 */
  const interruptedTickets = { '10': 'rv:a.md#3:1:x', '+12': 'rv:a.md#4:1:y', 'drop:20': 'rv:a.md#5:1:z', whole: 'rv:a.md#6:1:w' };
  const drafts: Record<string, string> = { '10': '210k一直都有', '+12': '加一句' };
  const textOf = (k: string) => (k.startsWith('drop:') ? '' : k === 'whole' ? '整篇改短' : drafts[k]);

  test('只留主进程那边还活着的', () => {
    const r = resumableFrom(interruptedTickets, new Set(['rv:a.md#3:1:x', 'rv:a.md#6:1:w']), textOf);
    assert.deepEqual(Object.keys(r).sort(), ['10', 'whole']);
  });
  test('同一个标记、意见没改 → 用回原来的 ticket；改过了 / 别的标记 → 新的一次', () => {
    const r = resumableFrom(interruptedTickets, new Set(Object.values(interruptedTickets)), textOf);
    assert.equal(resumableTicket(r, '10', '210k一直都有'), 'rv:a.md#3:1:x');
    assert.equal(resumableTicket(r, '10', '210k一直都有，再短点'), undefined);
    assert.equal(resumableTicket(r, '11', '210k一直都有'), undefined);
    assert.equal(resumableTicket(r, 'drop:20', ''), 'rv:a.md#5:1:z');
  });
});

describe('模拟 reload：原来那一次还在跑，再提交同一条 → 只发一次', () => {
  test('用回的 ticket 合并到主进程里原来那一次；会话里只有一条', async () => {
    /* 主进程按「ticket|档」合并（和 review:revise-in-session 的 revisesInFlight 同一个语义） */
    const byTicket = new InFlightPrompts<string>();
    const transcript: string[] = [];
    let sends = 0;
    let finish!: (v: string) => void;
    const revise = (ticket: string) => byTicket.run('s', `${ticket}|block`, () => {
      sends += 1;
      transcript.push(reviseMessageId(ticket, 'block')!);
      return new Promise<string>((r) => { finish = r; });
    });
    const original = 'rv:promo.md#3:1:abcd';
    const before = revise(original);                         // reload 之前的那个窗口提交的
    /* reload：标记放回来，主进程说这张 ticket 还活着 */
    const r = resumableFrom({ '10': original }, new Set([original]), () => '210k一直都有');
    const reused = resumableTicket(r, '10', '210k一直都有') ?? 'rv:promo.md#1:2:new';
    const after = revise(reused);                            // 你再按一次 ✓
    finish('ok');
    assert.deepEqual(await Promise.all([before, after]), ['ok', 'ok']);
    assert.equal(sends, 1);
    assert.equal(transcript.length, 1);
  });
});

describe('接线', () => {
  test('ReviewPane：打开时先把"上次没做完"的全都记成可沿用（跟着标记落盘），再问主进程把写完 / 答了却没做成的摘掉；enqueue 先看能不能用回原来的 ticket', () => {
    assert.match(PANE, /const carried = resumableFrom\(initialMarks\.interruptedTickets, new Set\(Object\.values\(initialMarks\.interruptedTickets\)\)/);
    assert.match(PANE, /const all = \{ \.\.\.initialMarks\.retryTickets, \.\.\.carried \};\s*\n\s*if \(Object\.keys\(all\)\.length\) retryTicketsByPath\.set\(path, all\);/);
    assert.match(PANE, /window\.kiroApi\.reviewTicketsStatus\?\.\(tickets\)\.then\(\(status\) => \{\s*\n\s*const drop = Object\.entries\(byTicket\)\.filter\(\(\[, t\]\) => !reusableAfterReload\(status\?\.\[t\]\)\)/);
    const at = PANE.indexOf('const enqueue = (kind:');
    const body = PANE.slice(at, at + 1200);
    assert.match(body, /const resumed = persist \? takeResumable\(persist\.key, persist\.text\) : undefined;/);
    assert.match(body, /const ticket = resumed \?\? `rv:/);
  });

  test('主进程：tickets-status 报还在跑 / 写完 / 怎么结束的；每次改写结束都记下结局；同一张 ticket 写完盘了就不再做一遍', () => {
    const st = M.slice(M.indexOf("ipcMain.handle('review:tickets-status'"), M.indexOf("ipcMain.handle('review:tickets-status'") + 700);
    assert.match(st, /revisesInFlight\.keys\(\)/);
    assert.match(st, /out\[t\] = live\.has\(t\) \? 'live' : doneTickets\.has\(t\) \? 'done' : reviseOutcomes\.get\(t\) \?\? 'unknown';/);
    assert.match(M, /job\.then\(\(res\) => recordReviseOutcome\(ticketIn, res\), \(\) => \{\}\);/);
    const rec = M.slice(M.indexOf('function recordReviseOutcome('), M.indexOf('function recordReviseOutcome(') + 400);
    assert.match(rec, /reviseOutcomes\.set\(ticket, res\.error && !res\.retrySame \? 'final' : 'retry'\);/);
    const h = M.slice(M.indexOf("ipcMain.handle('review:revise-in-session'"), M.indexOf("ipcMain.handle('review:revise-in-session'") + 4000);
    assert.ok(h.indexOf('revisesInFlight.get(dupKey)') < h.indexOf('doneTickets.has(ticketIn)'));
    assert.ok(h.indexOf('doneTickets.has(ticketIn)') < h.indexOf('const tk = openTicket('));
    assert.match(h, /return \{ ok: false, cancelled: true, alreadyDone: true \};/);
  });

  test('preload 接上了', () => {
    assert.match(read('main', 'preload.ts'), /reviewTicketsStatus: \(tickets: string\[\]\): Promise<Record<string, string>> => ipcRenderer\.invoke\('review:tickets-status', tickets\)/);
  });
});

describe('失败后再点 ✓（含 reload 之后）：还是同一次提交', () => {
  const ticket = 'rv:promo.md#3:1:abcd';
  const prompt = '把第 10 行改成：210k一直都有';

  /** 最小的"主进程"：落盘 + 发给模型；第一次网络失败；答过的那一问用盘上的回复（storedReplyFor） */
  function fakeMain(failFirst: number) {
    const transcript: { id: string; role: string; replyTo?: string; replyComplete?: boolean; content?: string }[] = [];
    let sends = 0;
    let left = failFirst;
    const ask = (id: string) => {
      const stored = completedReplyInText(transcript.map((m) => JSON.stringify(m)).join('\n'), id);
      if (stored !== null) return stored;
      const d = decidePromptDedupe({ explicitId: true, attempt: 0, status: messageIdStatus(transcript, id) });
      if (d.action === 'reject') throw new Error('already sent and answered');
      if (d.persist) transcript.push({ id, role: 'user' });
      sends += 1;
      if (left > 0) { left -= 1; throw new Error('dispatch failure'); }
      transcript.push({ id: `a${sends}`, role: 'assistant', replyTo: id, replyComplete: true, content: 'ok' });
      return 'ok';
    };
    return { transcript, ask, get sends() { return sends; } };
  }

  test('网络失败 → 意见放回（记下 ticket）→ 一字不改再点 ✓ → 同一张 ticket、同一个 id：会话里只有一条', () => {
    const main = fakeMain(1);
    assert.throws(() => main.ask(reviseMessageId(ticket, 'block', prompt)!));
    /* 主进程回了 retrySame：ReviewPane 的 rememberRetry 记下 */
    let retry = rememberRetryTicket({}, '10', '210k一直都有', ticket);
    const reused = resumableTicket(retry, '10', '210k一直都有');
    assert.equal(reused, ticket);
    assert.equal(main.ask(reviseMessageId(reused, 'block', prompt)!), 'ok');
    assert.equal(main.transcript.filter((m) => m.role === 'user').length, 1);
    retry = {};
    assert.equal(resumableTicket(retry, '10', '210k一直都有'), undefined, '用过一次就摘掉');
  });

  test('reload 之后再点 ✓：记下的 ticket 跟着标记落盘（JSON 来回一趟）还在', () => {
    const saved = JSON.parse(JSON.stringify({ retryTickets: rememberRetryTicket({}, '10', '210k一直都有', ticket) }));
    assert.equal(resumableTicket(saved.retryTickets, '10', '210k一直都有'), ticket);
    assert.equal(resumableTicket(saved.retryTickets, '10', '改了意见'), undefined, '意见改过了是新的一次');
  });

  test('block 那一问答过了（改不了）、升级 patch 那一步断网 → 重试时 block 用盘上那份回复，不再问第二遍', () => {
    const main = fakeMain(0);
    const blockId = reviseMessageId(ticket, 'block', prompt)!;
    main.ask(blockId);                                         // 答了「改不了」
    assert.equal(main.sends, 1);
    assert.equal(main.ask(blockId), 'ok');                     // 重试：用盘上的
    assert.equal(main.sends, 1);
    assert.equal(main.transcript.filter((m) => m.role === 'user').length, 1);
  });
});

describe('接线：失败路径记下 ticket，enqueue 用得上，跟着标记落盘', () => {
  test('所有改写都走 reviseVia；三处失败放回意见时都 rememberRetry', () => {
    assert.equal((PANE.match(/window\.kiroApi\.reviseInSession\?\.\(/g) || []).length, 1, '只剩 reviseVia 里那一处');
    /* 文本那侧（reviseVia）和 deck 一页版面文字（slideVia）都经 trackRetry 记下结局 */
    assert.match(PANE, /return trackRetry\(input\.ticket, await window\.kiroApi\.reviseInSession\?\.\(input\)\);/);
    assert.match(PANE, /return trackRetry\(input\.ticket, await window\.kiroApi\.deckReviseSlideText\?\.\(input\)\);/);
    assert.match(PANE, /if \(res\?\.retrySame && ticket\) retrySameTickets\.add\(ticket\);/);
    assert.match(PANE, /const fail = \(why: string\) => \{\s*\n\s*rememberRetry\(path, failKey, instruction, ticket\);/);
    assert.match(PANE, /rememberRetry\(path, 'whole', note, ticket\);/);
    assert.match(PANE, /const fail = \(why: string\) => \{ rememberRetry\(path, key, instruction, ticket\);/);
  });
  test('takeResumable 只看不摘；做成了 / 答了却没做成才摘（enqueue 跑完时）；落盘 / 读回都带 retryTickets', () => {
    const at = PANE.indexOf('const takeResumable = (key: string, text: string)');
    const body = PANE.slice(at, at + 400);
    assert.match(body, /return resumableTicket\(retryTicketsByPath\.get\(path\) \|\| \{\}, key, text\);/);
    assert.doesNotMatch(body, /delete /, '取走时不能摘：这次重试又没做成时下次还得是这张');
    assert.match(PANE, /if \(ok \|\| finalTickets\.delete\(ticket\)\) \{\s*\n\s*const cur = retryTicketsByPath\.get\(path\);\s*\n\s*if \(cur\) retryTicketsByPath\.set\(path, forgetRetryTicket\(cur, ticket\)\);/);
    assert.match(PANE, /else if \(ticket && res && !res\.ok && !res\.cancelled && res\.error\) finalTickets\.add\(ticket\);/);
    assert.match(PANE, /\{ retryTickets: retryTicketsByPath\.get\(path\) \}/);
    assert.match(PANE, /return \{ drafts, dropped, whole: String\(saved\.whole \|\| ''\), order, interrupted, interruptedTickets, retryTickets \};/);
  });
});

describe('发送已落盘 → 重载窗口 → 请求网络失败 → 重新打开侧栏 → 再次提交：还是同一次', () => {
  const ticket = 'rv:promo.md#3:1:abcd';
  const prompt = '把第 10 行改成：210k一直都有';
  const text = '210k一直都有';
  /** 重新打开侧栏时 ReviewPane 做的那两步：先全记成可沿用，再按主进程报的结局摘掉 */
  const reopen = (interruptedTickets: Record<string, string>, status: Record<string, string>) => {
    let retry = resumableFrom(interruptedTickets, new Set(Object.values(interruptedTickets)), () => text);
    for (const [k, t] of Object.entries(interruptedTickets)) if (!reusableAfterReload(status[t]) && retry[k]?.ticket === t) { const { [k]: _d, ...rest } = retry; retry = rest; }
    return retry;
  };

  test('落盘一次、失败（主进程记 retry）、窗口回来再提交 → 同一张 ticket、同一个 messageId：不再追加，只是重发', () => {
    const transcript: { id: string; role: string }[] = [];
    const id = reviseMessageId(ticket, 'block', prompt)!;
    /* 旧窗口提交：主进程落盘这条用户消息，开始发 */
    let d = decidePromptDedupe({ explicitId: true, attempt: 0, status: messageIdStatus(transcript, id) });
    assert.deepEqual(d, { action: 'send', persist: true });
    transcript.push({ id, role: 'user' });
    /* 窗口重载：标记带着 interruptedTickets 落盘；请求接着因为网络失败结束 —— 没有窗口收 retrySame，主进程自己记 'retry' */
    const saved = JSON.parse(JSON.stringify({ interruptedTickets: { '10': ticket } }));
    const status = { [ticket]: 'retry' };
    /* 重新打开侧栏、意见没改再点 ✓ */
    const retry = reopen(saved.interruptedTickets, status);
    const reused = resumableTicket(retry, '10', text);
    assert.equal(reused, ticket);
    d = decidePromptDedupe({ explicitId: true, attempt: 0, status: messageIdStatus(transcript, reviseMessageId(reused, 'block', prompt)!) });
    assert.deepEqual(d, { action: 'send', persist: false }, '盘上已经有那一条：不再追加');
    assert.equal(transcript.filter((m) => m.role === 'user').length, 1);
  });

  test('主进程重启过、不记得这张 ticket（unknown）→ 照样沿用（去重兜底）；还在跑（live）→ 沿用，合并到那一次', () => {
    for (const s of ['unknown', 'live', undefined]) {
      assert.equal(resumableTicket(reopen({ '10': ticket }, s ? { [ticket]: s } : {}), '10', text), ticket, String(s));
    }
  });

  test('已经写完（done）、模型答了却没做成（final）→ 不沿用：再提交是新的一次', () => {
    for (const s of ['done', 'final']) {
      assert.equal(resumableTicket(reopen({ '10': ticket }, { [ticket]: s }), '10', text), undefined, s);
    }
  });
});

describe('连续断网：首次已落盘后网络失败 → 沿用 ticket 重试但预检仍失败 → 恢复连接后再提交', () => {
  const ticket = 'rv:promo.md#3:1:abcd';
  const prompt = '把第 10 行改成：210k一直都有';
  const text = '210k一直都有';

  test('三次提交始终是同一张 ticket、同一个 messageId；用户消息只落盘一次、最后只发出去一次完整的', () => {
    const transcript: { id: string; role: string; replyTo?: string; replyComplete?: boolean }[] = [];
    let modelCalls = 0;
    let retry: Record<string, { ticket: string; text: string }> = {};
    const finals = new Set<string>();
    /** 一次提交：渲染层取 ticket（只看不摘）→ 主进程（连得上才问）→ 渲染层按结局记 / 摘 —— 照 ReviewPane + index.ts 的规则 */
    const submit = (net: 'down-after-persist' | 'cannot-attach' | 'up') => {
      const t = resumableTicket(retry, '10', text) ?? `rv:promo.md#9:${Math.random()}`;
      const id = reviseMessageId(t, 'block', prompt)!;
      let res: { ok: boolean; error?: string; retrySame?: boolean };
      if (net === 'cannot-attach') {
        res = { ok: false, error: 'Cannot connect to this session', retrySame: true };   // ensureAttached 之后的提前返回
      } else {
        const d = decidePromptDedupe({ explicitId: true, attempt: 0, status: messageIdStatus(transcript, id) });
        assert.equal(d.action, 'send');
        if (d.action === 'send' && d.persist) transcript.push({ id, role: 'user' });
        modelCalls += 1;
        if (net === 'down-after-persist') res = { ok: false, error: 'dispatch failure', retrySame: true };
        else { transcript.push({ id: `a${modelCalls}`, role: 'assistant', replyTo: id, replyComplete: true }); res = { ok: true }; }
      }
      /* reviseVia + fail() + enqueue 收尾 */
      if (!res.ok && res.retrySame) retry = rememberRetryTicket(retry, '10', text, t);
      else if (!res.ok && res.error) finals.add(t);
      if (res.ok || finals.delete(t)) retry = forgetRetryTicket(retry, t);
      return { t, id, res };
    };

    const first = submit('down-after-persist');
    const second = submit('cannot-attach');
    assert.equal(second.t, first.t, '第二次沿用原 ticket');
    assert.equal(second.id, first.id);
    assert.equal(resumableTicket(retry, '10', text), first.t, '预检还失败：原 ticket 还留着');
    const third = submit('up');
    assert.equal(third.t, first.t, '恢复连接后第三次还是原 ticket');
    assert.equal(third.id, first.id);
    assert.equal(third.res.ok, true);
    assert.equal(transcript.filter((m) => m.role === 'user').length, 1, '用户消息只落盘一次');
    assert.equal(transcript.filter((m) => m.role === 'assistant' && m.replyComplete).length, 1);
    assert.equal(resumableTicket(retry, '10', text), undefined, '做成了才摘');
  });

  test('forgetRetryTicket 只摘指向这张 ticket 的', () => {
    const m = { '10': { ticket: 'a', text: 'x' }, '12': { ticket: 'b', text: 'y' }, '+10': { ticket: 'a', text: 'x' } };
    assert.deepEqual(forgetRetryTicket(m, 'a'), { '12': { ticket: 'b', text: 'y' } });
  });

  test('接线：还没问到模型就停下的那几处提前返回都带 retrySame（挂不上 / 等空闲超时 / 别的改写在等 / 闸没过）', () => {
    const at = M.indexOf('async function reviseOnce()');
    const body = M.slice(at, at + 4500);
    assert.match(body, /if \(!sessionClients\.get\(sessionId\)\) return \{ ok: false, error: tr\('Cannot connect to this session[^']*'\), retrySame: true \};/);
    assert.match(body, /if \(stillBusy\) return \{ ok: false, error: tr\('This session is still busy after waiting 20 minutes \(\{busy\}\)', \{ busy: stillBusy \}\), retrySame: true \};/);
    assert.match(body, /if \(askWaiters\.has\(sessionId\)\) return \{ ok: false, error: tr\('A revision is already waiting for a reply in this session'\), retrySame: true \};/);
    assert.match(body, /if \(gate && !gate\.ok\) return \{ ok: false, error: gate\.error, retrySame: true \};/);
    const fu = M.slice(M.indexOf('async function followUpPatch('), M.indexOf('async function followUpPatch(') + 1500);
    assert.equal((fu.match(/retrySame: true \}/g) || []).length >= 2, true);
  });
});

describe('没做成的意见挪了行号之后再提交：还是原来那张 ticket / messageId', () => {
  const ticket = 'rv:promo.md#3:1:abcd';
  const prompt = '把这一段改成：210k一直都有';
  const text = '210k一直都有';

  test('第 10 行失败放回 → 前面插了两行、意见挪到第 12 行 → 在第 12 行再提交：沿用原 ticket，会话里只有一条', () => {
    const transcript: { id: string; role: string }[] = [];
    const id = reviseMessageId(ticket, 'block', prompt)!;
    transcript.push({ id, role: 'user' });                                     // 第一次已落盘，然后网络失败
    let retry = rememberRetryTicket({}, '10', text, ticket);
    /* 在它前面成功插入了两行：writeBack 按 patch.keep 挪标记，可沿用的那些跟着挪 */
    const keep: Record<number, number> = { 1: 1, 2: 2, 3: 3, 4: 6, 5: 7, 6: 8, 7: 9, 8: 10, 9: 11, 10: 12 };
    retry = remapResumable(retry, keep);
    assert.equal(resumableTicket(retry, '10', text), undefined, '老行号那儿已经不是它了');
    const reused = resumableTicket(retry, '12', text);
    assert.equal(reused, ticket);
    assert.equal(reviseMessageId(reused, 'block', prompt), id, '同一个 messageId');
    const d = decidePromptDedupe({ explicitId: true, attempt: 0, status: messageIdStatus(transcript, id) });
    assert.deepEqual(d, { action: 'send', persist: false }, '不再追加');
  });

  test('挪完之后重载：落盘的那份（键已经是第 12 行）读回来还能沿用', () => {
    const moved = remapResumable(rememberRetryTicket({}, '+10', text, ticket), { 10: 12 });
    const saved = JSON.parse(JSON.stringify({ retryTickets: moved }));
    assert.equal(resumableTicket(saved.retryTickets, '+12', text), ticket);
  });

  test('remapResumable：讲稿 / 整篇的键不挪；那一行没了就丢掉；删除标记、✎ 标记照样挪', () => {
    const m = { 'note:3': { ticket: 'n', text: 'a' }, whole: { ticket: 'w', text: 'b' }, '5': { ticket: 'x', text: 'c' }, 'drop:7': { ticket: 'd', text: '' }, '=8': { ticket: 'e', text: 'f' } };
    assert.deepEqual(remapResumable(m, { 7: 9, 8: 10 }), { 'note:3': { ticket: 'n', text: 'a' }, whole: { ticket: 'w', text: 'b' }, 'drop:9': { ticket: 'd', text: '' }, '=10': { ticket: 'e', text: 'f' } });
  });

  test('接线：writeBack 挪标记时也挪 retryTicketsByPath；loadMarks 读回来时按原文重新对行号', () => {
    const at = PANE.indexOf('remapReviewLines(path, patch.keep);');
    assert.match(PANE.slice(at, at + 400), /const r = retryTicketsByPath\.get\(path\); if \(r\) retryTicketsByPath\.set\(path, remapResumable\(r, patch\.keep\)\);/);
    const lm = PANE.slice(PANE.indexOf('export function loadMarks('), PANE.indexOf('export function loadMarks(') + 3500);
    assert.match(lm, /for \(const \[k, v\] of Object\.entries\(saved\.retryTickets \|\| \{\}\)\) \{\s*\n\s*const nk = rekey\(k\);/);
  });
});

describe('deck 一页版面文字的改写（deck:revise-slide-text）：失败重试、重载后重试都还是同一次', () => {
  const ticket = 'rv:deck.pptx#4:1:abcd';
  /* 提示词里有这一页此刻的文字（run 地址 + 原文）—— 页面没变 → 同一问 */
  const prompt = 'slide 3 runs: s1.p0.r0\t旧标题\nnote: 标题改短';
  const text = '标题改短';

  test('网络失败（retrySame）→ 意见放回第 3 页 → 不改再点 ✓ → 同一张 ticket、同一个 messageId；重载后也一样', () => {
    const transcript: { id: string; role: string }[] = [];
    const id = reviseMessageId(ticket, 'slide', prompt)!;
    transcript.push({ id, role: 'user' });                            // 第一次已落盘，网络失败
    const retry = rememberRetryTicket({}, '3', text, ticket);        // queueSlide 的失败路径 rememberRetry
    const reused = resumableTicket(retry, '3', text);
    assert.equal(reused, ticket);
    assert.equal(reviseMessageId(reused, 'slide', prompt), id);
    assert.deepEqual(decidePromptDedupe({ explicitId: true, attempt: 0, status: messageIdStatus(transcript, id) }), { action: 'send', persist: false });
    /* 重载：retryTickets 跟着标记落盘；deck 的页号键不随正文挪 */
    const saved = JSON.parse(JSON.stringify({ retryTickets: retry }));
    assert.equal(resumableTicket(saved.retryTickets, '3', text), ticket);
    /* 重载时主进程那一次还在跑 / 结束了没拿到完整回复 / 不记得 → 沿用；写完了 → 不沿用 */
    for (const st of ['live', 'retry', 'unknown']) assert.equal(reusableAfterReload(st), true, st);
    assert.equal(reusableAfterReload('done'), false);
  });

  test('这一页在这期间被改过（提示词里的原文变了）→ 另一问，id 也不同', () => {
    assert.notEqual(reviseMessageId(ticket, 'slide', prompt), reviseMessageId(ticket, 'slide', prompt.replace('旧标题', '别人改过的标题')));
  });

  test('接线：主进程那一侧和文本改写同一套（合并、写完不再做、messageId、retrySame、记结局、写完记 done、排队提示按 ticket）', () => {
    const at = M.indexOf("ipcMain.handle('deck:revise-slide-text'");
    const h = M.slice(at, M.indexOf("ipcMain.handle('deck:read-slide-text'", at));
    /* 在排 / 在跑就合并、写完了就不再做（reviseAlready），在 openTicket 之前判 */
    assert.ok(h.indexOf("reviseAlready(input?.ticket, 'slide')") > 0);
    assert.ok(h.indexOf("reviseAlready(input?.ticket, 'slide')") < h.indexOf('const tk = openTicket('));
    const ra = M.slice(M.indexOf('const reviseAlready = '), M.indexOf('const reviseAlready = ') + 900);
    assert.match(ra, /const running = revisesInFlight\.get\(`\$\{t\}\|\$\{scope\}`\);/);
    assert.match(ra, /if \(doneTickets\.has\(t\)\) \{[\s\S]{0,200}?return \{ ok: false, cancelled: true, alreadyDone: true \}; \}/);
    assert.match(h, /\(slideAsk = reviseMessageId\(input\?\.ticket, 'slide', prompt\)\)\)/);
    assert.match(h, /error: tr\('Cannot connect to this session[^']*'\), retrySame: true \}/);
    /* 问过模型之后失败：只有模型对这一问还什么都没做时才带 retrySame（retrySameIf）；还没问到就失败（读这一页出错）照样带 */
    assert.match(h, /if \(!usable\.ok\) return \{ ok: false, error: usable\.why, \.\.\.retrySameIf\(sid, slideAsk\) \};/);
    assert.match(h, /\.\.\.\(slideAsk \? retrySameIf\(sid, slideAsk, err\) : \{ retrySame: true as const \}\)/);
    assert.match(h, /markTicketDone\(input\?\.ticket\);\s*\n\s*return \{ ok: true, changed \};/);
    /* 排队提示按 ticket 只说一次；enqueueRevise 的 trackScope 登记 revisesInFlight（在跑再来就合并）、结束时记结局 */
    assert.match(h, /\}, tr\('\{file\} slide \{page\} text', \{ file: path\.basename\(want\), page \}\), input\?\.ticket, 'slide'\);/);
    const eq = M.slice(M.indexOf('function enqueueRevise<T>('), M.indexOf('function enqueueRevise<T>(') + 3500);
    assert.match(eq, /if \(noticeKey && trackScope\) \{\s*\n\s*const key = `\$\{noticeKey\}\|\$\{trackScope\}`;\s*\n\s*revisesInFlight\.set\(key, next\);\s*\n\s*next\.then\(\(res\) => recordReviseOutcome\(noticeKey, res\), \(\) => \{\}\);/);
  });

  test('接线：渲染层 queueSlide 走 slideVia、失败放回时 rememberRetry、带着 persist 让 enqueue 能沿用', () => {
    const at = PANE.indexOf('const queueSlide = ');
    const body = PANE.slice(at, at + 2200);
    assert.match(body, /await slideVia\(\{ sessionId: sessionId!, filePath: path, page, note: instruction, ticket \}\);/);
    assert.match(body, /rememberRetry\(path, String\(page\), instruction, ticket\);/);
    assert.match(body, /\{ key: String\(page\), text: instruction \}\);/);
    assert.equal((PANE.match(/window\.kiroApi\.deckReviseSlideText\?\.\(/g) || []).length, 1, '只剩 slideVia 里那一处');
  });
});
