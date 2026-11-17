/**
 * 「会话卡住 → 恢复」选择器：什么时候自动弹（`sessionRecovery.ts`），以及卡片 / 入口在代码里确实聚合了四个出口。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  isStuckDeadEnd, autoRecoveryCard, STUCK_NOTE_GROUP, isStuckNoteGroup, isRecoveryNoteGroup,
  rollbackChoices, rollbackBackupDir,
} from '../src/main/sessionRecovery.ts';
import { POISONED_AFTER } from '../src/main/staleSession.ts';
import { safeguardNoteGroup, COMPACT_FAILED_NOTE_GROUP } from '../src/main/safeguardError.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf-8');

const SAFEGUARD = 'API Error: 400 Our safeguards flagged this session (https://www.anthropic.com/legal/aup). Details: [cyber]';

describe('isStuckDeadEnd：连续失败、自愈也试过了还不行', () => {
  const base = { error: 'Internal error — Kiro failed to generate a response', consecutiveFailures: POISONED_AFTER, selfHealTried: true, transient: false };
  test('正例：笼统 Internal error、连着到阈值、自愈已经试过', () => {
    assert.equal(isStuckDeadEnd(base), true);
    assert.equal(isStuckDeadEnd({ ...base, consecutiveFailures: 5 }), true);
  });
  test('反例：普通一次性报错（只失败一次）', () => {
    assert.equal(isStuckDeadEnd({ ...base, consecutiveFailures: 1 }), false);
    assert.equal(isStuckDeadEnd({ ...base, consecutiveFailures: 0 }), false);
  });
  test('反例：自愈还没试过（还有自动重发 / 换会话的机会）', () => {
    assert.equal(isStuckDeadEnd({ ...base, selfHealTried: false }), false);
  });
  test('反例：网络抖动（传输层瞬时错误）', () => {
    assert.equal(isStuckDeadEnd({ ...base, error: 'Internal error — dispatch failure', transient: true }), false);
  });
  test('反例：不是笼统 Internal error 的普通报错', () => {
    assert.equal(isStuckDeadEnd({ ...base, error: 'Permission denied: /etc/shadow' }), false);
    assert.equal(isStuckDeadEnd({ ...base, error: 'prompt already in progress (Internal error)' }), false);
    assert.equal(isStuckDeadEnd({ ...base, error: '' }), false);
  });
  test('反例：安全过滤那一类有自己的卡（不重复弹）', () => {
    assert.equal(isStuckDeadEnd({ ...base, error: `Internal error: ${SAFEGUARD}` }), false);
  });
});

describe('autoRecoveryCard：一轮报错收尾时弹哪一种（或者不弹）', () => {
  const quiet = { error: 'Internal error', compactTurn: false, produced: false, consecutiveFailures: 1, selfHealTried: false, transient: false };
  test('安全过滤 → safeguard（哪怕是第一次）', () => {
    assert.equal(autoRecoveryCard({ ...quiet, error: SAFEGUARD }), 'safeguard');
  });
  test('压缩失败、什么都没出 → compact-failed；出过东西 → 不弹', () => {
    assert.equal(autoRecoveryCard({ ...quiet, error: 'Error during compaction', compactTurn: true }), 'compact-failed');
    assert.equal(autoRecoveryCard({ ...quiet, error: 'Error during compaction', compactTurn: true, produced: true }), null);
  });
  test('自愈上限之后还不行 → stuck', () => {
    assert.equal(autoRecoveryCard({ ...quiet, consecutiveFailures: POISONED_AFTER, selfHealTried: true }), 'stuck');
  });
  test('普通一次性报错 / 网络抖动 → 不弹', () => {
    assert.equal(autoRecoveryCard(quiet), null);
    assert.equal(autoRecoveryCard({ ...quiet, error: 'Internal error — dispatch failure', transient: true, consecutiveFailures: 4, selfHealTried: true }), null);
    assert.equal(autoRecoveryCard({ ...quiet, error: 'ECONNRESET', transient: true, consecutiveFailures: 4, selfHealTried: true }), null);
    assert.equal(autoRecoveryCard({ ...quiet, error: 'Model not found: foo' }), null);
  });
});

describe('noteGroup', () => {
  test('三类卡都认成恢复卡；别的不认', () => {
    assert.equal(isStuckNoteGroup(STUCK_NOTE_GROUP), true);
    for (const g of [STUCK_NOTE_GROUP, COMPACT_FAILED_NOTE_GROUP, safeguardNoteGroup(false), safeguardNoteGroup(true)]) assert.equal(isRecoveryNoteGroup(g), true, g);
    for (const g of ['backend-session-swap', 'bedrock-denied:x', '', undefined]) assert.equal(isRecoveryNoteGroup(g), false, String(g));
  });
});

describe('rollbackChoices：能回到哪几条', () => {
  test('只列真实的用户 / 助手消息（去掉 KiroLex 提示、steer、还没落盘的），新的在前', () => {
    const list = rollbackChoices([
      { id: 'u1', role: 'user', content: 'hello' },
      { id: 'a1', role: 'assistant', content: 'hi there' },
      { id: 'n1', role: 'assistant', content: 'note', kirolex: true },
      { id: 's1', role: 'user', content: 'steer', steer: true },
      { id: 'u2', role: 'user', content: 'second\nline' },
      { id: 'pending_x', role: 'user', content: 'optimistic', pending: true },
    ]);
    assert.deepEqual(list.map((c) => c.id), ['u2', 'a1', 'u1']);
    assert.equal(list[0].after, 0);
    assert.equal(list[1].after, 1);       // 回到 a1：u2 去掉
    assert.equal(list[2].after, 2);
    assert.equal(list[0].preview, 'second line');
  });
  test('预览截短', () => {
    const [c] = rollbackChoices([{ id: 'u', role: 'user', content: 'x'.repeat(500) }]);
    assert.ok(c.preview.length <= 81);
  });
});

describe('rollbackBackupDir：备份进回收站的位置', () => {
  test('trash/rollback-<时间>/<id>：不会被认成「这条会话删过」', async () => {
    const { deletionsFromTrashNames } = await import('../src/main/cloudTrash.ts');
    const [top, id] = rollbackBackupDir('abc', new Date('2026-11-17T01:02:03.004Z'));
    assert.equal(top, 'rollback-20261117-010203-004');
    assert.equal(id, 'abc');
    assert.deepEqual(deletionsFromTrashNames([top]), {});
    assert.ok(!top.startsWith('abc__'));
  });
});

describe('代码里可见：同一张卡片聚合四个出口，复用既有入口', () => {
  const chat = read('src/renderer/components/ChatArea.tsx');
  const card = chat.slice(chat.indexOf('const SafeguardCard = memo'), chat.indexOf('// Kiro CLI does not expose exact per-turn token counts'));
  test('换模型 / 换引擎 / 回滚 / 换后端会话 + 申请链接', () => {
    assert.ok(card.includes('modelSwitch.pick(target)'));
    assert.ok(card.includes('switchEngine?.(sessionId'));
    assert.ok(card.includes('onRollback(sessionId, point.id)'));
    assert.ok(read('src/renderer/hooks/useAcp.ts').includes('window.kiroApi.rollbackToMessage?.(sid, messageId)'));
    assert.ok(card.includes('newBackendSession?.(sessionId)'));
    assert.ok(card.includes('openExternal?.(url)'));
    assert.ok(card.includes('a new session may not help; switch models first'));
    assert.ok(card.includes('Messages after that point are removed from this chat'));
  });
  test('主进程：回滚先把整份记录备份进回收站，再用编辑重跑同一个 rewriteTranscript，再走换后端会话同一个入口', () => {
    const index = read('src/main/index.ts');
    const at = index.indexOf("ipcMain.handle('acp:rollback-to-message'");
    assert.ok(at > 0);
    const body = index.slice(at, index.indexOf('ipcMain.handle(', at + 10));
    /* 步骤本身在 sessionRollback.performRollback（单测见 sessionRollback.test.ts），这里看接的是既有零件 */
    assert.ok(body.includes('path.join(SESSION_TRASH_DIR, ...rollbackBackupDir(sid))'));
    assert.ok(body.includes('performRollback(mid, {'));
    assert.ok(body.includes('rewriteTranscript: (kept) => store.rewriteTranscript(sid, kept)'));
    assert.ok(body.includes('clearContextOverride: () => { store.clearContextOverride(sid); }'));
    assert.ok(body.includes("swapBackend: () => swapBackendSessionWhenIdle(sid, 'card-rollback')"));
    /* 失败不报 ok:true */
    assert.match(body, /if \(!r\.ok\) \{[\s\S]*?ok: false,/);
    assert.ok(!/rmSync|unlinkSync/.test(body));
  });
  test('自动弹只在不再重发的最后出口，且用 autoRecoveryCard 判', () => {
    const index = read('src/main/index.ts');
    assert.ok(index.includes('autoRecoveryCard({'));
    assert.ok(index.includes('noteSessionStuck('));
  });
  test('手动入口：侧栏会话菜单', () => {
    const side = read('src/renderer/components/Sidebar.tsx');
    assert.ok(side.includes('requestRecovery('));
  });
});
