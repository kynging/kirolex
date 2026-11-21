import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPlaceholderTitle, pickTitleBackfills, titleFromFirstUserMessage, displayTitleFor } from '../src/main/titleBackfill.ts';

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf8');
const MAIN = read('src', 'main', 'index.ts');

describe('备份里老会话显示 New Chat：把侧栏标题补进磁盘记录', () => {
  test('占位标题：空 / New Chat 开头的都算', () => {
    assert.equal(isPlaceholderTitle(''), true);
    assert.equal(isPlaceholderTitle(undefined), true);
    assert.equal(isPlaceholderTitle('   '), true);
    assert.equal(isPlaceholderTitle('New Chat'), true);
    assert.equal(isPlaceholderTitle('New Chat 3'), true);
    assert.equal(isPlaceholderTitle('Research'), false);
    assert.equal(isPlaceholderTitle('New Chatbot 设计'), false);
  });

  test('记录是 New Chat / 空、侧栏是正常标题 → 补；磁盘已有正常标题 → 不补；侧栏也是 New Chat → 不补', () => {
    const records = [
      { id: 's_a', title: 'New Chat' },
      { id: 's_b', title: '' },
      { id: 's_c', title: '磁盘上的名字' },
      { id: 's_d', title: 'New Chat' },
      { id: 's_e' },
      { id: 's_f', title: 'New Chat' },
    ];
    const sidebar = [
      { id: 's_a', title: 'Research' },
      { id: 's_b', title: '  兑换码  ' },
      { id: 's_c', title: '侧栏上的名字' },
      { id: 's_d', title: 'New Chat' },
      { id: 's_e', title: '' },
      // s_f 侧栏里没有
      { id: 's_x', title: '没有记录的会话' },
    ];
    assert.deepEqual(pickTitleBackfills(records, sidebar), [
      { id: 's_a', title: 'Research' },
      { id: 's_b', title: '兑换码' },
    ]);
  });

  test('侧栏数据坏了（不是数组 / 条目缺字段）不报错', () => {
    assert.deepEqual(pickTitleBackfills([{ id: 's_a', title: 'New Chat' }], null as any), []);
    assert.deepEqual(pickTitleBackfills([{ id: 's_a', title: 'New Chat' }], [null, { id: 1, title: 'x' }, { id: 's_a', title: 3 }] as any), []);
  });

  test('兜底标题：取第一条用户消息、去换行、截 40 字；没有用户消息回 New Chat', () => {
    assert.equal(titleFromFirstUserMessage([
      { role: 'assistant', content: '你好' },
      { role: 'user', content: '  帮我查一下\n空之色水之色的台词\r\n在哪一集  ' },
      { role: 'user', content: '第二条' },
    ]), '帮我查一下 空之色水之色的台词 在哪一集');
    const long = '一'.repeat(50);
    assert.equal(titleFromFirstUserMessage([{ role: 'user', content: long }]), '一'.repeat(40));
    // 按字符截，不把 emoji 劈成半个
    assert.equal(titleFromFirstUserMessage([{ role: 'user', content: '😀'.repeat(45) }]), '😀'.repeat(40));
    assert.equal(titleFromFirstUserMessage([{ role: 'assistant', content: 'hi' }]), 'New Chat');
    assert.equal(titleFromFirstUserMessage([]), 'New Chat');
    // 空内容的用户消息跳过；KiroLex 自己插的提示不算你说的话
    assert.equal(titleFromFirstUserMessage([
      { role: 'user', content: '   ' },
      { role: 'user', content: '这条会话现在跑在别的模型上', kirolex: true },
      { role: 'user', content: 'Trade' },
    ]), 'Trade');
  });

  test('displayTitleFor：记录有正常标题就用它，不读 transcript', () => {
    let reads = 0;
    const tx = () => { reads += 1; return [{ role: 'user', content: '第一句' }]; };
    assert.equal(displayTitleFor('Research', tx), 'Research');
    assert.equal(reads, 0);
    assert.equal(displayTitleFor('New Chat', tx), '第一句');
    assert.equal(displayTitleFor(undefined, tx), '第一句');
    assert.equal(displayTitleFor('', () => { throw new Error('读不了'); }), 'New Chat');
  });
});

describe('接线', () => {
  test('启动时按 ui-state 的 kirolex-sessions 补标题：不改 updatedAt、advanced 的跳过', () => {
    const fn = MAIN.slice(MAIN.indexOf('function backfillRecordTitlesFromSidebar'));
    const body = fn.slice(0, 1600);
    assert.match(body, /uiState\(\)\['kirolex-sessions'\]/);
    assert.match(body, /pickTitleBackfills\(/);
    assert.match(body, /refuseAdvancedOnly\(/);
    assert.match(body, /store\.writeRecordKeepUpdatedAt\(/);
    assert.doesNotMatch(body, /store\.patchRecord\(|store\.writeRecord\(/);
    assert.match(MAIN, /try \{ backfillRecordTitlesFromSidebar\(\); \} catch/);
  });

  test('备份 catalog 条目和备份对话框列表用兜底标题', () => {
    const cat = MAIN.slice(MAIN.indexOf('function catalogEntriesFor('));
    assert.match(cat.slice(0, 900), /title: backupDisplayTitle\(r\)/);
    const list = MAIN.slice(MAIN.indexOf('const byProject = new Map<string, Row>();'));
    assert.match(list.slice(0, 1500), /title: backupDisplayTitle\(rec\)/);
    const fn = MAIN.slice(MAIN.indexOf('function backupDisplayTitle'));
    assert.match(fn.slice(0, 400), /displayTitleFor\(/);
    assert.match(fn.slice(0, 400), /store\.readTranscript\(/);
  });
});
