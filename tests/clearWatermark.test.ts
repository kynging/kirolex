import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const read = (p: string) => fs.readFileSync(path.join(import.meta.dirname, '..', p), 'utf8');
const STORE = read('src/main/sessionStore.ts');
const MAIN = read('src/main/index.ts');
const PRELOAD = read('src/main/preload.ts');
const APP = read('src/renderer/App.tsx');
const ACP = read('src/renderer/hooks/useAcp.ts');

/*
  源码断言而不是 import：`sessionStore.ts` 在 `node --test` 下不可直接加载（见 sessionRecordPatch.test.ts）。
*/

const readTranscriptBody = (): string => {
  const fn = STORE.slice(STORE.indexOf('export function readTranscript'));
  return fn.slice(0, fn.indexOf('function readTranscriptRaw'));
};

/**
 * `/clear` 之后切走再切回来、或者下一次重建上下文，清空之前的历史又回来了。
 *
 * 根因：`/clear` 只清渲染端缓存（设成 `[]`）并给后端发一句 `/clear`；而 `switchSession` 判"要不要从磁盘
 * 重读"的条件是 `!cached || cached.length === 0`，于是切回来整份 transcript 被读回。快照
 * （`renderHistoryFile` / ride-along）也读 `store.readTranscript`，又把历史喂回模型。
 *
 * 修法：`SessionRecord.clearedAt` 落盘，`readTranscript` 统一只给水位线之后的消息。
 */
describe('/clear 的历史水位线', () => {
  test('水位线记在会话记录上', () => {
    const rec = STORE.slice(STORE.indexOf('export interface SessionRecord'));
    assert.match(rec.slice(0, rec.indexOf('\n}')), /clearedAt\?: number;/);
  });

  test('过滤在 readTranscript 里 —— 视图和快照读的是同一个函数', () => {
    const body = readTranscriptBody();
    assert.match(body, /readRecord\(id\)\?\.clearedAt/);
    assert.match(body, /Number\(\(m as any\)\.ts\) > at/, '只留水位线之后的');
    assert.match(MAIN, /function renderHistoryFile[\s\S]{0,200}store\.readTranscript\(sessionId\)/);
    assert.match(MAIN, /ipcMain\.handle\('acp:read-transcript'[\s\S]{0,120}store\.readTranscript\(sessionId\)/);
  });

  test('没有 ts 的行留着 —— 不确定就不隐藏用户的记录', () => {
    assert.match(readTranscriptBody(), /!Number\.isFinite\(Number\(\(m as any\)\.ts\)\)/);
  });

  test('transcript 本身不删 —— 读的时候过滤，不改文件', () => {
    assert.doesNotMatch(readTranscriptBody(), /writeFileSync|renameSync|rmSync|appendFileSync/);
  });

  test('需要全量的调用方拿得到全量：粘贴文件的引用清扫不能把水位线之前那些消息的附件当成没人用', () => {
    assert.match(readTranscriptBody(), /opts\?\.raw/);
    assert.match(MAIN, /store\.readTranscript\(rec\.id, \{ raw: true \}\)/);
  });

  test('编辑后重跑（整份重写）保住水位线之前的行 —— 否则清空前的历史就真被删了', () => {
    const fn = STORE.slice(STORE.indexOf('export function rewriteTranscript'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /readRecord\(id\)\?\.clearedAt/);
    assert.match(body, /<= at/);
  });

  test('输入框的 /clear：先落水位线，再清屏', () => {
    const at = APP.indexOf("if (text.trim() === '/clear')");
    assert.ok(at > 0);
    const branch = APP.slice(at, at + 1600);
    assert.match(branch, /markCleared\?\.\(sid\)/);
    assert.ok(
      branch.indexOf('markCleared') < branch.indexOf('clearConversation(sid)'),
      '水位线要先落盘 —— 清屏之后再落，中间那一刻切走就复原了',
    );
    // 落水位线要 await —— 这期间切到别的会话，/clear 也必须发给落了水位线、清了屏的那一条
    assert.match(
      branch,
      /sendMessage\(\[\{ type: 'text', text: '\/clear' \}\], undefined, undefined, undefined, undefined, sid \|\| undefined\)/,
      '/clear 要显式发给 sid，不能落回"当前焦点会话"',
    );
    assert.match(PRELOAD, /markCleared: \(sessionId: string\) => ipcRenderer\.invoke\('acp:mark-cleared', sessionId\)/);
    assert.match(APP, /markCleared\?: \(sessionId: string\)/);
  });

  test('acp:mark-cleared 落水位线并摘掉「上下文已建立」那面旗', () => {
    const at = MAIN.indexOf("ipcMain.handle('acp:mark-cleared'");
    assert.ok(at > 0);
    const handler = MAIN.slice(at, at + 900);
    assert.match(handler, /clearedAt: at/);
    assert.match(handler, /clearContextEstablished\(sessionId\)/);
  });

  test('复用会话前的自动清理（acp:clear-context）也落水位线并摘旗', () => {
    const at = MAIN.indexOf("ipcMain.handle('acp:clear-context'");
    assert.ok(at > 0);
    const handler = MAIN.slice(at, at + 1200);
    assert.match(handler, /clearedAt: Date\.now\(\)/);
    assert.match(handler, /clearContextEstablished\(sessionId\)/);
  });

  test('清空之前手改保存的快照（context override）不再生效；清空之后新保存的照旧生效', () => {
    const fn = STORE.slice(STORE.indexOf('export function readContextOverride'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /readRecord\(id\)\?\.clearedAt/);
    assert.match(body, /mtimeMs <= cleared/, '按保存时间和水位线比：之前的忽略，之后的留着');
    assert.doesNotMatch(body, /unlinkSync|rmSync|writeFileSync/, '只是不生效，文件不删');
    // ride-along 和快照页都经由这一个函数拿 override，所以一处判就都对了
    const ride = MAIN.slice(MAIN.indexOf('function buildHistoryRideAlong'));
    assert.match(ride.slice(0, 1500), /store\.readContextOverride\(sessionId\)/);
  });

  test('已有旧快照 → /clear → 打开快照页 → 保存 → 下一次发送：旧历史不会借快照页回到模型', () => {
    // 1) 快照页读的「上一次发出去的快照」档案，水位线之前的不再读回（文件留着）
    const fn = STORE.slice(STORE.indexOf('export function readLastInjection'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /readRecord\(id\)\?\.clearedAt/);
    assert.match(body, /mtimeMs <= cleared/);
    assert.doesNotMatch(body, /unlinkSync|rmSync|writeFileSync/, '只是不读回，文件不删');
    // 2) 快照页的内容就来自这两份：旧 override 和旧档案都被水位线挡住，编辑框里就没有清空前的历史
    const page = MAIN.slice(MAIN.indexOf("ipcMain.handle('acp:read-last-injection'"));
    const pageBody = page.slice(0, 1200);
    assert.match(pageBody, /store\.readLastInjection\(sessionId\)/);
    assert.match(pageBody, /store\.readContextOverride\(sessionId\)/);
    assert.match(pageBody, /text: override\?\.text \?\? rec\?\.text \?\? ''/);
    // 3) 空编辑框保存 = 不覆盖，下一次发送走按水位线过滤后的历史
    const save = MAIN.slice(MAIN.indexOf("ipcMain.handle('acp:write-context-override'"));
    assert.match(save.slice(0, 600), /if \(!text\.trim\(\)\) \{[\s\S]{0,200}store\.clearContextOverride\(sessionId\)/);
  });

  test('"空数组等于没装载"的判据仍然在 —— 故意清空现在由落盘的水位线表达', () => {
    assert.match(ACP, /if \(!cached \|\| cached\.length === 0\) \{/);
  });
});
