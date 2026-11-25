import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { parseTranscriptText, parseTranscriptTextChunked } from '../src/main/transcriptParse.ts';

/**
 * 「远程会话连接的前半段输入框没法输入」：attach / hydrate 时对 MB 级 transcript.jsonl 同步整读 + 逐行 JSON.parse，
 * 多条会话一起 attach 时叠起来把主进程钉住（Windows 上窗口跟着不响应键盘）。
 * 改成 fs.promises 读 + 分片解析、每片之后让出事件循环。这里守的是：
 *   - 分片解析的结果和老的同步解析**完全一样**（含 steer 并进用户消息、撕裂的最后一行）；
 *   - 真的会让出（片够长就 yield），而且每片之间都 yield。
 */
const lines = [
  { id: 'u1', role: 'user', content: '你好', ts: 1 },
  { id: 'a1', role: 'assistant', content: '在', ts: 2 },
  { id: 's1', role: 'user', content: '追加一句', ts: 3, mergeIntoMessageId: 'u1' },
  { id: 'n1', role: 'user', content: '⚠️ 提示', ts: 4, kirolex: true, noteGroup: 'x' },
  { id: 's2', role: 'user', content: '并不进提示', ts: 5, mergeIntoMessageId: 'n1' },
].map((m) => JSON.stringify(m));
const RAW = `${lines.join('\n')}\n\n{"id":"torn","role":"assis`;

describe('transcript 分片解析', () => {
  test('结果和同步解析完全一样', async () => {
    const sync = parseTranscriptText(RAW);
    let yields = 0;
    const chunked = await parseTranscriptTextChunked(RAW, { sliceMs: 0, yieldFn: async () => { yields++; } });
    assert.deepEqual(chunked, sync);
    assert.equal(sync.length, 4, 'steer 并进了 u1、撕裂的最后一行丢掉');
    assert.ok(yields > 0, 'sliceMs=0 时每行之后都让出');
  });

  test('一片没用完就不让出（小文件不白白多绕事件循环）', async () => {
    let yields = 0;
    await parseTranscriptTextChunked(RAW, { sliceMs: 10_000, yieldFn: async () => { yields++; } });
    assert.equal(yields, 0);
  });

  test('大文件：按时间分片，片与片之间让出', async () => {
    const big = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(200), ts: i })).join('\n');
    let clock = 0;
    let yields = 0;
    const out = await parseTranscriptTextChunked(big, {
      sliceMs: 8,
      now: () => { clock += 1; return clock; },   // 每读一次时钟走 1ms：大约每 8 行一片
      yieldFn: async () => { yields++; },
    });
    assert.equal(out.length, 5000);
    assert.ok(yields > 100, `让出了 ${yields} 次`);
  });

  test('接线：attach / hydrate 读 transcript 走异步分片那条（acp:read-transcript 不再同步整读）', () => {
    const src = (p: string) => fs.readFileSync(path.join(import.meta.dirname, '..', p), 'utf8');
    const store = src('src/main/sessionStore.ts');
    const fn = store.slice(store.indexOf('export async function readTranscriptAsync'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.match(body, /fs\.promises\.readFile\(transcriptPath\(id\)/);
    assert.match(body, /parseTranscriptTextChunked\(raw, \{ yieldFn: yieldToLoop \}\)/);
    assert.doesNotMatch(body, /readFileSync/);
    const main = src('src/main/index.ts');
    const h = main.slice(main.indexOf("ipcMain.handle('acp:read-transcript'"));
    const handler = h.slice(0, h.indexOf('\n  });'));
    assert.match(handler, /store\.readTranscriptAsync\(sessionId\)/);
    assert.match(handler, /heavyLane\(/, '多条会话同时 hydrate 时串行，不一次叠满');
    assert.doesNotMatch(handler, /store\.readTranscript\(|readFileSync/);
  });
});
