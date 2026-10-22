import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { connectFailureNotice, historyBeforeNotice, isConnectFailureNotice, replaceConnectFailureNotices } from '../src/renderer/connectFailure.ts';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

/**
 * 一条没连上的会话（本机没配 kiro 而失败）右键换到远程之后，原来只改了记录 ——
 * 旧的「⚠️ 这条会话没连上：…本机…」和失败状态都还在，看着像切到远程还在报本机的错。
 * 现在：换完立刻按新记录连；连上了摘掉失败状态和旧提示；连不上换成新机器的那一条。
 */
describe('没连上的会话换机器：立刻在新机器上连，旧报错不留', () => {
  const MAIN = read('src/main/index.ts');
  const ACP = read('src/renderer/hooks/useAcp.ts');

  test('只摘连接失败的提示，用户和模型的消息一条不动', () => {
    const msgs: any[] = [
      { id: 'u1', role: 'user', content: '⚠️ 这条会话没连上：我自己打的字' },
      connectFailureNotice('还没有设置本机的 kiro 启动命令', 1),
      { id: 'a1', role: 'assistant', content: 'hi' },
      { id: 'k1', role: 'kirolex', content: '🔀 换机器了' },
    ];
    const cleared = replaceConnectFailureNotices(msgs);
    assert.deepEqual(cleared.map((m) => m.id), ['u1', 'a1', 'k1']);
    assert.equal(isConnectFailureNotice(msgs[0]), false);
    assert.equal(isConnectFailureNotice(msgs[1]), true);
  });

  test('连不上：换成新机器的那一条，不两条并存', () => {
    const msgs: any[] = [{ id: 'u1', role: 'user', content: 'x' }, connectFailureNotice('本机没配 kiro', 1)];
    const next = replaceConnectFailureNotices(msgs, connectFailureNotice('远端 ec2: Connection timed out', 2));
    const fails = next.filter(isConnectFailureNotice);
    assert.equal(fails.length, 1);
    assert.match(fails[0].content, /远端 ec2/);
    assert.equal(next[0].id, 'u1');
  });

  test('主进程「没连着」那条分支不再说"下次打开"，因为界面马上就去连', () => {
    const at = MAIN.indexOf('if (!oldEntry) {', MAIN.indexOf('const applySessionTarget = async ('));
    const branch = MAIN.slice(at, MAIN.indexOf('await awaitAttachIdle(sessionId);', at));
    assert.doesNotMatch(branch, /下次打开会跑在/);
    assert.match(branch, /'session:targets-changed', \{ sessionId, remoteHost: hostLabelOf\(target\), remoteId: remoteIdOf\(target\), localDir: nextLocalDir \}/);
  });

  test('渲染层收到换机器事件就对没连着的会话按新记录重连，成功清失败状态和旧提示，失败换成新报错', () => {
    const at = ACP.indexOf('onTargetsChanged?.(');
    const block = ACP.slice(at, ACP.indexOf('return () =>', at));
    assert.match(block, /void reconnectAfterRetargetRef\.current\?\.\(d\.sessionId\)/);
    const fn = ACP.slice(ACP.indexOf('const reconnectAfterRetarget = '));
    const body = fn.slice(0, fn.indexOf('reconnectAfterRetargetRef.current = reconnectAfterRetarget;'));
    assert.match(body, /markConnecting\(sessionId\)/);
    assert.match(body, /window\.kiroApi\.loadSession\(sessionId, attachCwdFor\(sessionId\), modelForSession\(sessionId\)\)/);
    assert.match(body, /addAttached\(sessionId\);\s*clearFailed\(sessionId\);[\s\S]{0,200}?mutateSessionMessages\(sessionId, \(cur\) => replaceConnectFailureNotices\(cur\)\)/);
    assert.match(body, /markFailed\(sessionId\);[\s\S]{0,800}?mutateSessionMessages\(sessionId, \(cur\) => replaceConnectFailureNotices\(cur, connectFailureNotice\(/);
    assert.match(body, /clearConnecting\(sessionId\)/);
    /* 已经连着的走主进程换执行器那条路，这里不碰 */
    assert.match(body, /attachedIdsRef\.current\.has\(sessionId\)\) return;/);
    /* 走的是按记录 attach，不新建 —— 远程会话不会被悄悄建成本地 */
    assert.doesNotMatch(body, /newSession\(/);
  });

  test('有历史、没缓存的后台休眠会话换机器失败：先把历史读进来再加提示，打开时历史还在', async () => {
    const transcript = [
      { id: 'u1', role: 'user', content: '你好', ts: 1 },
      { id: 'a1', role: 'assistant', content: '在', ts: 2, kirolex: false },
    ];
    let reads = 0;
    const seeded = await historyBeforeNotice(undefined, async () => { reads++; return transcript; });
    assert.equal(reads, 1);
    assert.deepEqual(seeded!.map((m) => m.id), ['u1', 'a1']);
    const next = replaceConnectFailureNotices(seeded!, connectFailureNotice('远端连不上', 3));
    assert.deepEqual(next.map((m) => m.content), ['你好', '在', '⚠️ 这条会话没连上：远端连不上']);
    /* 已经有缓存就不去读盘，也不覆盖 */
    assert.equal(await historyBeforeNotice([{ id: 'x' } as any], async () => { reads++; return transcript; }), null);
    assert.equal(reads, 1);
    /* 读不到 / 读坏了：不挡路 */
    assert.equal(await historyBeforeNotice(undefined, async () => { throw new Error('x'); }), null);
  });

  test('失败分支在写提示之前，对没缓存的后台会话先把历史读进缓存', () => {
    const fn = ACP.slice(ACP.indexOf('const reconnectAfterRetarget = '));
    const body = fn.slice(0, fn.indexOf('reconnectAfterRetargetRef.current = reconnectAfterRetarget;'));
    const failAt = body.indexOf('} catch (err: any) {');
    const fail = body.slice(failAt);
    const seedAt = fail.indexOf('historyBeforeNotice(messagesCacheRef.current.get(sessionId)');
    assert.ok(seedAt > 0, '失败分支没读历史');
    assert.ok(seedAt < fail.indexOf('mutateSessionMessages('), '要先读历史再写提示');
    assert.match(fail, /currentSessionRef\.current !== sessionId/);
  });

  test('新建失败留下的那条提示，判据认得出来（开头和 role 对得上）', () => {
    // 新建失败那条现在也由 connectFailureNotice 构造 —— 构造出来的判据必须认得（两种语言都是）
    assert.match(ACP, /mutateSessionMessages\(id, \(cur\) => \[\.\.\.cur, connectFailureNotice\(why, Date\.now\(\), uiLangNow\(\)\)\]\);/);
    assert.equal(isConnectFailureNotice(connectFailureNotice('x', 1, 'zh')), true);
    assert.equal(isConnectFailureNotice(connectFailureNotice('x', 1, 'en')), true);
    // 英文界面写下的那条，判据也认得（只在界面上、不落盘，换机器时一样要摘掉）
    assert.equal(isConnectFailureNotice({ role: 'kirolex' as any, content: "⚠️ This chat couldn't connect: x" }), true);
    assert.equal(isConnectFailureNotice({ role: 'kirolex' as any, content: '⚠️ 这条会话没连上：x' }), true);
  });
});
