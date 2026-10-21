import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  messageIdStatus, messageIdStatusInText, decidePromptDedupe, InFlightPrompts, reviseMessageId, turnCompletedNormally, completedReplyInText, carryReplyMarks, canRetrySame,
} from '../src/main/promptDedupe.ts';

/*
  守的是：「网络不稳时同一条消息被反复发进会话」——同一次提交（同一个 messageId）只落盘一次、只发给模型一次。
  实测那条会话里同一条【改写 · …第 10 行】出现了 11 次，每次都有一份几乎一样的回复。
*/

const line = (m: object) => JSON.stringify(m);

describe('messageIdStatus：这个 id 在盘上是什么状态', () => {
  test('不在盘上 → absent', () => {
    assert.equal(messageIdStatus([{ id: 'a', role: 'user' }], 'b'), 'absent');
  });
  test('在盘上、后面没有助手回复 → unanswered（上一次没发成）', () => {
    const msgs = [{ id: 'x', role: 'assistant' }, { id: 'u1', role: 'user' }, { id: 'n', role: 'user', kirolex: true }];
    assert.equal(messageIdStatus(msgs, 'u1'), 'unanswered');
  });
  test('在盘上、有回它的完整回复（replyTo + replyComplete）→ answered（再发就是重复）', () => {
    const msgs = [{ id: 'u1', role: 'user' }, { id: 'a1', role: 'assistant', replyTo: 'u1', replyComplete: true }];
    assert.equal(messageIdStatus(msgs, 'u1'), 'answered');
  });
  test('A 网络失败没回复、你另发 B 得到了回复 → A 仍是 unanswered，还能重试', () => {
    const msgs = [
      { id: 'A', role: 'user' },
      { id: 'B', role: 'user' },
      { id: 'b1', role: 'assistant', replyTo: 'B', replyComplete: true },
    ];
    assert.equal(messageIdStatus(msgs, 'A'), 'unanswered');
    assert.equal(messageIdStatus(msgs, 'B'), 'answered');
  });
  test('A 重试成功，回复落在 B 后面 → A 认作 answered（再来一次就拒）', () => {
    const msgs = [
      { id: 'A', role: 'user' },
      { id: 'B', role: 'user' },
      { id: 'b1', role: 'assistant', replyTo: 'B', replyComplete: true },
      { id: 'a1', role: 'assistant', replyTo: 'A', replyComplete: true },
    ];
    assert.equal(messageIdStatus(msgs, 'A'), 'answered');
  });
  test('出错 / 取消时 flush 的半截（有 replyTo、没有 replyComplete）：不算答过，但模型已经开始做了 → started', () => {
    const msgs = [{ id: 'A', role: 'user' }, { id: 'p', role: 'assistant', replyTo: 'A' }];
    assert.equal(messageIdStatus(msgs, 'A'), 'started');
  });
  test('主进程记着它已经开始做了（跑过工具、没出字，盘上没有半截）→ started', () => {
    assert.equal(messageIdStatus([{ id: 'A', role: 'user' }], 'A', new Set(['A'])), 'started');
    assert.equal(messageIdStatus([{ id: 'A', role: 'user' }], 'A', new Set(['B'])), 'unanswered');
  });
  test('答过了优先于 started（完整回复在盘上）', () => {
    const msgs = [{ id: 'A', role: 'user' }, { id: 'a', role: 'assistant', replyTo: 'A', replyComplete: true }];
    assert.equal(messageIdStatus(msgs, 'A', new Set(['A'])), 'answered');
  });
  test('老记录（没有 replyTo）：紧跟着的助手消息算回它的；中间隔着 KiroLex 提示也算；隔着别的提问不算', () => {
    assert.equal(messageIdStatus([{ id: 'u1', role: 'user' }, { id: 'a1', role: 'assistant' }], 'u1'), 'answered');
    assert.equal(messageIdStatus([{ id: 'u1', role: 'user' }, { id: 'n', role: 'user', kirolex: true }, { id: 'a1', role: 'assistant' }], 'u1'), 'answered');
    assert.equal(messageIdStatus([{ id: 'u1', role: 'user' }, { id: 'u2', role: 'user' }, { id: 'a1', role: 'assistant' }], 'u1'), 'unanswered');
  });
});

describe('messageIdStatusInText：直接读 transcript.jsonl 的文本', () => {
  test('没出现这个 id 时不解析整份（快路径）也判 absent', () => {
    const text = [line({ id: 'u1', role: 'user', content: 'hi' }), line({ id: 'a1', role: 'assistant', content: 'yo' })].join('\n') + '\n';
    assert.equal(messageIdStatusInText(text, 'u2'), 'absent');
    assert.equal(messageIdStatusInText(text, 'u1'), 'answered');
    assert.equal(messageIdStatusInText(text + line({ id: 'u2', role: 'user', content: 'again' }) + '\n', 'u2'), 'unanswered');
  });
  test('content 里恰好写着这个 id 不算（只认 id 字段）', () => {
    const text = line({ id: 'u1', role: 'user', content: '"id":"u9"' }) + '\n';
    assert.equal(messageIdStatusInText(text, 'u9'), 'absent');
  });
  test('坏掉的最后一行不影响判断', () => {
    const text = line({ id: 'u1', role: 'user', content: 'hi' }) + '\n{"id":"a1","role":"assi';
    assert.equal(messageIdStatusInText(text, 'u1'), 'unanswered');
  });
  test('真文件：写进临时目录再读', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-dedupe-'));
    try {
      const f = path.join(dir, 'transcript.jsonl');
      fs.writeFileSync(f, line({ id: 'u_rv_1', role: 'user', content: '【改写 · a.md 第 10 行】x' }) + '\n');
      assert.equal(messageIdStatusInText(fs.readFileSync(f, 'utf-8'), 'u_rv_1'), 'unanswered');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('decidePromptDedupe：同一个 messageId 再来一次怎么办', () => {
  test('没有调用方给的 id（主进程自己生成的）→ 照常发、照常落盘', () => {
    assert.deepEqual(decidePromptDedupe({ explicitId: false, attempt: 0, status: 'answered' }), { action: 'send', persist: true });
  });
  test('自动重发（attempt > 0）是同一轮 → 照常发、不再落盘', () => {
    assert.deepEqual(decidePromptDedupe({ explicitId: true, attempt: 2, status: 'unanswered' }), { action: 'send', persist: false });
  });
  test('第一次 → 发、落盘', () => {
    assert.deepEqual(decidePromptDedupe({ explicitId: true, attempt: 0, status: 'absent' }), { action: 'send', persist: true });
  });
  test('盘上已经有、上一次没交到模型手里（网络失败，模型什么都没做）→ 再发一次，但不再追加一条', () => {
    assert.deepEqual(decidePromptDedupe({ explicitId: true, attempt: 0, status: 'unanswered' }), { action: 'send', persist: false });
  });
  test('盘上已经有、模型已经开始做了（出过字 / 跑过工具）又断了 → 拒绝自动再发（外层以 attempt=0 绕过 planRetry 的那条路）', () => {
    assert.deepEqual(decidePromptDedupe({ explicitId: true, attempt: 0, status: 'started' }), { action: 'reject', reason: 'started' });
  });
  test('canRetrySame：只有模型还什么都没做时，同一次提交才能按同一个 messageId 接着来', () => {
    assert.equal(canRetrySame('absent'), true);
    assert.equal(canRetrySame('unanswered'), true);
    assert.equal(canRetrySame('started'), false);
    assert.equal(canRetrySame('answered'), false);
  });
  test('盘上已经有、而且已经答过 → 拒绝：不追加、不发', () => {
    assert.deepEqual(decidePromptDedupe({ explicitId: true, attempt: 0, status: 'answered' }), { action: 'reject', reason: 'answered' });
  });
});

describe('InFlightPrompts：同一个 id 正在跑时，重复的请求合并到那一次', () => {
  test('同一个 id 并发两次 → 只跑一次，两个调用方拿到同一个结果', async () => {
    const inflight = new InFlightPrompts<string>();
    let runs = 0;
    let release!: (v: string) => void;
    const job = () => { runs += 1; return new Promise<string>((r) => { release = r; }); };
    const a = inflight.run('s1', 'u1', job);
    const b = inflight.run('s1', 'u1', job);
    assert.equal(inflight.has('s1', 'u1'), true);
    release('done');
    assert.deepEqual(await Promise.all([a, b]), ['done', 'done']);
    assert.equal(runs, 1);
    assert.equal(inflight.has('s1', 'u1'), false);
  });
  test('跑完（成功或失败）之后同一个 id 可以再跑 —— 例如没发成之后的重试', async () => {
    const inflight = new InFlightPrompts<number>();
    await assert.rejects(inflight.run('s1', 'u1', async () => { throw new Error('net'); }));
    assert.equal(await inflight.run('s1', 'u1', async () => 2), 2);
  });
  test('不同会话、不同 id 互不影响；没有 id 的不合并', async () => {
    const inflight = new InFlightPrompts<number>();
    let runs = 0;
    const job = async () => { runs += 1; return runs; };
    await Promise.all([inflight.run('s1', 'u1', job), inflight.run('s2', 'u1', job), inflight.run('s1', 'u2', job), inflight.run('s1', undefined, job), inflight.run('s1', undefined, job)]);
    assert.equal(runs, 5);
  });
});

describe('reviseMessageId：一次改写的用户消息 id 跟着 ticket 走', () => {
  test('同一个 ticket、同一档 → 同一个 id（重复的请求能被认出来）', () => {
    assert.equal(reviseMessageId('rv:a.md#1:1:x', 'block'), reviseMessageId('rv:a.md#1:1:x', 'block'));
  });
  test('同一个 ticket 升级到 patch / 追问 → 不同的 id（那是另一问）', () => {
    const t = 'rv:a.md#1:1:x';
    const ids = new Set([reviseMessageId(t, 'block', 'p'), reviseMessageId(t, 'patch', 'p'), reviseMessageId(t, 'patch', 'p', true)]);
    assert.equal(ids.size, 3);
  });
  test('不同 ticket → 不同 id；没有 ticket → undefined（主进程照旧自己生成）', () => {
    assert.notEqual(reviseMessageId('rv:a#1', 'block'), reviseMessageId('rv:a#2', 'block'));
    assert.equal(reviseMessageId(undefined, 'block'), undefined);
  });
  test('id 只含安全字符（ticket 里有路径）', () => {
    assert.match(reviseMessageId('rv:C:\\x y\\a.md#1:2:z', 'insert', 'prompt')!, /^u_rv_[0-9a-f]+_[0-9a-f]+_insert$/);
  });
  test('同一张 ticket 再提交：问的还是同一件事（提示词一样）→ 同一个 id；那一段被改过（提示词变了）→ 不同的 id', () => {
    const t = 'rv:a.md#1:1:x';
    assert.equal(reviseMessageId(t, 'block', '改第 10 行：原文 A'), reviseMessageId(t, 'block', '改第 10 行：原文 A'));
    assert.notEqual(reviseMessageId(t, 'block', '改第 10 行：原文 A'), reviseMessageId(t, 'block', '改第 10 行：原文 A2'));
  });
});

describe('turnCompletedNormally：只有正常、完整结束的一轮才算"答过了"', () => {
  test('end_turn 且没卡死 → 完整', () => {
    assert.equal(turnCompletedNormally({ stopReason: 'end_turn', wedged: false }), true);
  });
  test('被停掉 / 截断 / 卡死 / 没报 stopReason → 都不算（同一条还能重试）', () => {
    for (const stopReason of ['cancelled', 'max_tokens', 'max_turn_requests', 'refusal', '', undefined, null]) {
      assert.equal(turnCompletedNormally({ stopReason, wedged: false }), false, String(stopReason));
    }
    assert.equal(turnCompletedNormally({ stopReason: 'end_turn', wedged: true }), false);
  });
});

describe('completedReplyInText：盘上回这一问的完整回复', () => {
  test('只认 replyTo + replyComplete 的那份；半截的、回别的的都不算', () => {
    const text = [
      line({ id: 'u1', role: 'user', content: 'q' }),
      line({ id: 'p', role: 'assistant', content: '半截', replyTo: 'u1' }),
      line({ id: 'b', role: 'assistant', content: '别的', replyTo: 'u2', replyComplete: true }),
    ].join('\n') + '\n';
    assert.equal(completedReplyInText(text, 'u1'), null);
    const done = text + line({ id: 'a', role: 'assistant', content: 'CANNOT-REVISE-LOCALLY: 跨段', replyTo: 'u1', replyComplete: true }) + '\n';
    assert.equal(completedReplyInText(done, 'u1'), 'CANNOT-REVISE-LOCALLY: 跨段');
    assert.equal(completedReplyInText(done, 'u9'), null);
  });
});

describe('carryReplyMarks：整份重写 transcript（编辑后重跑）时回复的去重标记不丢', () => {
  const disk = [
    line({ id: 'rv1', role: 'user', content: '【改写】a' }),
    line({ id: 'a1', role: 'assistant', content: '改好的一段', replyTo: 'rv1', replyComplete: true }),
    line({ id: 'q2', role: 'user', content: 'B' }),
    line({ id: 'p2', role: 'assistant', content: '半截', replyTo: 'q2' }),
    line({ id: 'u3', role: 'user', content: '后面那条（要编辑重跑）' }),
  ].join('\n') + '\n';
  /* 渲染层手里那一份：没带 replyTo / replyComplete（例如刚流式出来的、老窗口读回来的），并且截掉了 u3 */
  const fromRenderer = [
    { id: 'rv1', role: 'user', content: '【改写】a' },
    { id: 'a1', role: 'assistant', content: '改好的一段' },
    { id: 'q2', role: 'user', content: 'B' },
    { id: 'p2', role: 'assistant', content: '半截' },
  ];
  const rewritten = carryReplyMarks(disk, fromRenderer).map((m) => line(m)).join('\n') + '\n';

  test('重写后：完整回复还认得出、正文还能复用（storedReplyFor 用的就是它）', () => {
    assert.equal(messageIdStatusInText(rewritten, 'rv1'), 'answered');
    assert.equal(completedReplyInText(rewritten, 'rv1'), '改好的一段');
  });
  test('重写后：半截回复还是半截 —— 认作"已经开始做了"，不被老记录兼容逻辑当成答过了', () => {
    assert.equal(messageIdStatusInText(rewritten, 'q2'), 'started');
    assert.equal(completedReplyInText(rewritten, 'q2'), null);
  });
  test('对照：不补的话，半截那条就被当成"答过了"、完整那条的正文也取不回来', () => {
    const naive = fromRenderer.map((m) => line(m)).join('\n') + '\n';
    assert.equal(messageIdStatusInText(naive, 'q2'), 'answered');
    assert.equal(completedReplyInText(naive, 'rv1'), null);
  });
  test('传进来的已经带着标记的不动；用户消息不加', () => {
    const out = carryReplyMarks(disk, [{ id: 'a1', role: 'assistant', replyTo: 'x' }, { id: 'rv1', role: 'user' }]);
    assert.deepEqual(out, [{ id: 'a1', role: 'assistant', replyTo: 'x' }, { id: 'rv1', role: 'user' }]);
  });
});

describe('自动重发（attempt > 0）也过 started 检查', () => {
  test('这一轮已经开始做了 → 拒绝；还没开始 → 照发、不落盘', () => {
    assert.deepEqual(decidePromptDedupe({ explicitId: false, attempt: 1, status: 'started' }), { action: 'reject', reason: 'started' });
    assert.deepEqual(decidePromptDedupe({ explicitId: true, attempt: 2, status: 'started' }), { action: 'reject', reason: 'started' });
    assert.deepEqual(decidePromptDedupe({ explicitId: false, attempt: 1, status: 'absent' }), { action: 'send', persist: false });
  });
  test('不在盘上、但记着开始做过（自动重发那几次的 id 不落盘）→ started', () => {
    assert.equal(messageIdStatus([], 'u_1', new Set(['u_1'])), 'started');
    assert.equal(messageIdStatusInText('', 'u_1', new Set(['u_1'])), 'started');
    assert.equal(messageIdStatusInText('', 'u_1'), 'absent');
  });
});
