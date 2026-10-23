import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  shouldConsolidate, buildConsolidationPrompt, mergeSessionMemory, CONSOLIDATE_EVERY, MAX_CHARS,
  consolidatedSessionMemory, appendNewMemoryLines, autoConsolidationSkipReason, applyAutoConsolidation,
} from '../src/main/sessionMemory.ts';

/**
 * 会话记忆的自动维护 —— 「你在 memory 里加一个 session memory」。
 *
 * 存储、分层注入（全局 ⊕ project ⊕ 会话）和那个编辑 tab 早就有了；缺的是**没人写这一层**——
 * 它是个手填文本框，而没人会在聊天中途停下来写笔记。这个模块管的就是「什么时候压、压出来怎么并」。
 */
describe('什么时候值得压一次', () => {
  test('攒够新消息才压 —— 一句「好」不值得一次模型调用', () => {
    assert.equal(shouldConsolidate({ messages: CONSOLIDATE_EVERY - 1 }), false);
    assert.equal(shouldConsolidate({ messages: CONSOLIDATE_EVERY }), true);
  });

  test('按「上次压到哪」算增量，不是按总数反复压', () => {
    assert.equal(shouldConsolidate({ messages: 20, consolidatedAt: 14 }), false);
    assert.equal(shouldConsolidate({ messages: 26, consolidatedAt: 14 }), true);
  });

  test('正在压的不重入 —— 两次并发写同一个文件只会写坏它', () => {
    assert.equal(shouldConsolidate({ messages: 99, consolidatedAt: 0, inFlight: true }), false);
  });

  test('脏数据不炸', () => {
    assert.equal(shouldConsolidate({ messages: NaN as any }), false);
    assert.equal(shouldConsolidate({ messages: 30, consolidatedAt: -5 }), true);
  });
});

describe('压出来的东西怎么并回去', () => {
  test('要求合并而不是重写 —— 最早定下的约束最不该被丢', () => {
    const prompt = buildConsolidationPrompt('User: 用 opus', '- 周报只统计客户侧活动');
    assert.match(prompt, /MERGE/);
    assert.match(prompt, /周报只统计客户侧活动/);
    assert.match(prompt, /at most 12 lines/);
  });

  test('没有旧笔记时明说没有，而不是塞一段空引用', () => {
    assert.match(buildConsolidationPrompt('User: x', '  '), /no note yet/);
  });

  test('模型什么都没给 → 保持原样，绝不把已有记忆清空', () => {
    assert.equal(mergeSessionMemory('- 旧的还在', ''), '- 旧的还在');
    assert.equal(mergeSessionMemory('- 旧的还在', '   \n  '), '- 旧的还在');
  });

  test('统一成一行一条，去掉模型自己加的符号', () => {
    assert.equal(mergeSessionMemory('', '* 用 opus\n- 只算客户侧\n\n• 路径是 ~/周报.md'),
      '- 用 opus\n- 只算客户侧\n- 路径是 ~/周报.md');
  });

  test('最多 12 行，而且不超过上限 —— 它每一轮都要被注入', () => {
    const many = Array.from({ length: 30 }, (_, i) => `第 ${i} 条`).join('\n');
    const out = mergeSessionMemory('', many);
    assert.equal(out.split('\n').length, 12);
    assert.ok(out.length <= MAX_CHARS);
  });

  test('超长时从后面截 —— 靠前的是更早定下的约束', () => {
    const long = Array.from({ length: 12 }, (_, i) => `${i} ${'长'.repeat(200)}`).join('\n');
    const out = mergeSessionMemory('', long, 300);
    assert.ok(out.length <= 300);
    assert.ok(out.startsWith('- 0 '), '第一条必须还在');
  });
});

/**
 * 「会话记忆自动整理不许把大份手写记忆整份换成 12 行」：
 * 超过上限就不自动整理；整理前先备份；新结果行数变少时只追加、不删旧行。
 */
describe('自动整理不许压没已有记忆', () => {
  function tmpMemory(body: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kxsm-'));
    const file = path.join(dir, 'memory.md');
    fs.writeFileSync(file, body);
    return file;
  }
  function fileIo(file: string) {
    const calls: string[] = [];
    const logs: string[] = [];
    return {
      calls, logs,
      io: {
        readCurrent: () => fs.readFileSync(file, 'utf8'),
        backup: () => {
          calls.push('backup');
          const dest = `${file}.stamp.bak`;
          fs.copyFileSync(file, dest);
          return dest;
        },
        write: (text: string) => { calls.push('write'); fs.writeFileSync(file, text); },
        log: (m: string) => { logs.push(m); },
      },
    };
  }

  test('原记忆 9 KB → 跳过、文件不变、有日志、不备份不写', () => {
    const big = Array.from({ length: 400 }, (_, i) => `- 手写的第 ${i} 条约束：xxxxxxxx`).join('\n');
    assert.ok(Buffer.byteLength(big) > 9 * 1024);
    const file = tmpMemory(big);
    const f = fileIo(file);
    assert.equal(applyAutoConsolidation(big, '- 新事实', f.io), 'skipped');
    assert.equal(fs.readFileSync(file, 'utf8'), big);
    assert.deepEqual(f.calls, []);
    assert.equal(f.logs.length, 1);
    assert.match(f.logs[0], /skip auto consolidation/);
  });

  test('刚好在上限内照常整理；超一个字就跳过', () => {
    assert.equal(autoConsolidationSkipReason('a'.repeat(MAX_CHARS)), null);
    assert.ok(autoConsolidationSkipReason('a'.repeat(MAX_CHARS + 1)));
  });

  test('原记忆 < 1200 字 → 正常整理，写回前先备份，日志写明备份路径', () => {
    const before = '- 用 opus\n- 只算客户侧';
    const file = tmpMemory(before);
    const f = fileIo(file);
    assert.equal(applyAutoConsolidation(before, '用 opus\n只算客户侧\n路径是 ~/周报.md', f.io), 'written');
    assert.deepEqual(f.calls, ['backup', 'write']);
    assert.equal(fs.readFileSync(`${file}.stamp.bak`, 'utf8'), before, '备份是原文');
    assert.equal(fs.readFileSync(file, 'utf8'), '- 用 opus\n- 只算客户侧\n- 路径是 ~/周报.md');
    assert.ok(f.logs.some((m) => m.includes(`${file}.stamp.bak`)));
  });

  test('等模型期间记忆从空 / 小改成了 9 KB 手写记忆 → 不写、不备份，新文件原样保留', () => {
    const big = Array.from({ length: 400 }, (_, i) => `- 刚保存的手写第 ${i} 条：xxxxxxxx`).join('\n');
    assert.ok(Buffer.byteLength(big) > 9 * 1024);
    for (const before of ['', '- 用 opus']) {
      const file = tmpMemory(before);
      const f = fileIo(file);
      fs.writeFileSync(file, big); // 模型调用的那几秒里用户保存了
      assert.equal(applyAutoConsolidation(before, '- 用 opus\n- 新事实', f.io), 'skipped');
      assert.equal(fs.readFileSync(file, 'utf8'), big);
      assert.deepEqual(f.calls, []);
      assert.equal(f.logs.length, 1);
      assert.match(f.logs[0], /changed while consolidating/);
    }
  });

  test('原记忆不空、备份没成功 → 不写', () => {
    const logs: string[] = [];
    let wrote = false;
    const r = applyAutoConsolidation('- 旧的', '- 新的\n- 更新的', {
      readCurrent: () => '- 旧的', backup: () => null, write: () => { wrote = true; }, log: (m) => logs.push(m),
    });
    assert.equal(r, 'skipped');
    assert.equal(wrote, false);
    assert.equal(logs.length, 1);
  });

  test('原记忆为空 → 没东西可备份，照样写', () => {
    const calls: string[] = [];
    const r = applyAutoConsolidation('', '- 第一条', {
      readCurrent: () => '', backup: () => { calls.push('backup'); return null; }, write: () => { calls.push('write'); }, log: () => {},
    });
    assert.equal(r, 'written');
    assert.deepEqual(calls, ['write']);
  });

  test('没变化 → 不备份也不写', () => {
    const calls: string[] = [];
    assert.equal(applyAutoConsolidation('- 服务已恢复', '服务已恢复', {
      readCurrent: () => '- 服务已恢复', backup: () => { calls.push('backup'); return 'x'; }, write: () => { calls.push('write'); }, log: () => {},
    }), 'unchanged');
    assert.deepEqual(calls, []);
  });

  test('新结果比原记忆行数少 → 旧行全保留、新行追加（按行去重）', () => {
    const before = '- 周报只统计客户侧活动\n- 用 opus\n手写的一行没有列表符号\n- 路径是 ~/周报.md';
    assert.equal(consolidatedSessionMemory(before, '用 opus\n新决定：每周一发'), `${before}\n- 新决定：每周一发`);
  });

  test('新结果行数少、但全是已有的 → 不写', () => {
    assert.equal(consolidatedSessionMemory('- a\n- b\n- c', 'a\nb'), null);
  });

  test('新结果行数不少于原记忆 → 照旧按模型的合并结果替换', () => {
    assert.equal(consolidatedSessionMemory('- 旧的已过时', '新的\n另一条'), '- 新的\n- 另一条');
  });

  test('appendNewMemoryLines：原文原样、去重、只接新行', () => {
    assert.equal(appendNewMemoryLines('- a\n- b\n', '- b\n- c\n\n- c'), '- a\n- b\n- c');
    assert.equal(appendNewMemoryLines('- a', '- a'), '- a');
  });
});
