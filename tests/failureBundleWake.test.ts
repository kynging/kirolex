import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundleOmitsSessionContent, diagnosticPromptText, writeFailureBundle, _resetCooldown } from '../src/main/failureBundle.ts';
import { LocalHost } from '../src/main/hostOps.ts';

/*
 * 后台命令 / 监视的输出**只回到会话，不额外落盘**（凭证安全）。那一轮发送失败时，诊断包
 * （~/.kirolex/failures/…）既不能在 prompt.txt 里留那段输出，也不能抄 kiro-cli 自己那份会话历史（里面也有它）。
 */

test('普通消息：诊断包照旧留原文', () => {
  assert.equal(diagnosticPromptText([{ type: 'text', text: 'hello' }], false), 'hello');
});

test('后台输出那一轮：只留一句占位，不含输出', () => {
  const t = diagnosticPromptText([{ type: 'text', text: '🔔 后台命令结束\nAWS_SECRET=abc123' }], true);
  assert.doesNotMatch(t, /abc123/);
  assert.match(t, /omitted/);
});

test('omitConversation：prompt.txt 没有输出、不抄 kiro-cli 的会话历史，日志和元信息照旧', async () => {
  _resetCooldown();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-wake-'));
  try {
    fs.mkdirSync(path.join(home, 'kiro-log'), { recursive: true });
    fs.writeFileSync(path.join(home, 'kiro-log', 'kiro-chat.log'), 'ERROR something\n');
    const cliDir = path.join(home, '.kiro', 'sessions', 'cli');
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(path.join(cliDir, 'abc.json'), '{"history":"AWS_SECRET=abc123"}');
    fs.writeFileSync(path.join(cliDir, 'abc.jsonl'), '{"prompt":"AWS_SECRET=abc123"}\n');
    const host = new LocalHost({ TMPDIR: home, HOME: home } as any);
    const promptText = diagnosticPromptText([{ type: 'text', text: '🔔 后台命令结束\nAWS_SECRET=abc123' }], true);
    const dir = await writeFailureBundle({ sessionId: 's_w', cliSessionId: 'abc', promptText, error: 'Internal error', host, home, omitConversation: true });
    assert.ok(dir);
    const files = fs.readdirSync(dir!).sort();
    assert.deepEqual(files, ['kiro-log.txt', 'meta.json', 'prompt.txt']);
    for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(dir!, f), 'utf8'), /abc123/, f);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('这条会话收到过后台输出之后：之后**任何一轮**（普通消息 / 定时提示）失败也不留 prompt、不抄会话历史', () => {
  assert.equal(bundleOmitsSessionContent({ bgOutputThisTurn: true, sessionSawBgOutput: false }), true);
  assert.equal(bundleOmitsSessionContent({ bgOutputThisTurn: false, sessionSawBgOutput: true }), true, '后台输出成功进了会话，下一条普通消息失败');
  assert.equal(bundleOmitsSessionContent({ bgOutputThisTurn: false, sessionSawBgOutput: false }), false);
});
