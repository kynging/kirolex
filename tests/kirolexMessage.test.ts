import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isKirolexNote, modelFacing } from '../src/main/kirolexNote.ts';

const source = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');

/**
 * KiroLex 自己说的话（`kirolex: true`，以及按固定开头认出来的老通知）用独立的居中卡片显示，
 * 不再画成用户气泡 —— 它不是你说的，也不该有"编辑 / Rerun"。
 * 落盘形状照旧是 `role: 'user'` + `kirolex: true`（判据以 `isKirolexNote` 为准）。
 */
describe('KiroLex 自己的提示', () => {
  test('带标记的和按开头认出的老通知都算 KiroLex 的话，且都不发给模型', () => {
    const tagged = { role: 'user', kirolex: true as const, content: '已写入第 3 页的演讲者备注' };
    const legacy = { role: 'user', content: '⚠️ 这条会话现在跑在 gpt-5.6-sol 上' };
    for (const m of [tagged, legacy]) {
      assert.equal(isKirolexNote(m), true);
      assert.equal(modelFacing(m), false);
    }
  });

  test('noteInSession 照旧以 role user + kirolex 标记落盘并推给界面', () => {
    const main = source('src/main/index.ts');
    const at = main.indexOf('function noteInSession(');
    assert.ok(at >= 0);
    const body = main.slice(at, at + 1500);
    assert.match(body, /role: 'user', content: text, ts: Date\.now\(\), kirolex: true/);
    assert.match(body, /send\('acp:user-message'/);
  });

  test('ChatArea 把它们分成独立的一组，用居中的 KirolexMessageItem 画', () => {
    const chat = source('src/renderer/components/ChatArea.tsx');
    assert.match(chat, /\{ kind: 'kirolex'; message: Message; count\?: number \}/);
    assert.match(chat, /if \(m\.role === 'user' && isKirolexNote\(m\)\) \{\s*groups\.push\(\{ kind: 'kirolex', message: m \}\);/);
    assert.match(chat, /const KirolexMessageItem = memo/);
    assert.match(chat, /<KirolexMessageItem/);
    assert.match(chat, /<NoticeBody text=\{message\.content\} count=\{count\} render=\{\(s\) => withPathLinks\(s, message\.id\)\} \/>/);
    const css = source('src/renderer/styles/global.css');
    assert.match(css, /\.kirolex-message\s*\{[\s\S]*?justify-content:\s*center/);
  });

  test('它不能被当成提问，也不能当 steer 的归属', () => {
    const chat = source('src/renderer/components/ChatArea.tsx');
    /* steer 归位时找的"本轮原始提问"要跳过 KiroLex 的话 */
    assert.match(chat, /out\[i\]\.role === 'user' && !out\[i\]\.steer && !isKirolexNote\(out\[i\]\)/);
  });
});
