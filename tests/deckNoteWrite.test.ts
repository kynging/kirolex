import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { WRITE_NOTE_SCRIPT, parseWriteNote } from '../src/main/deckPreview.ts';
import { ZH_REVIEW } from '../src/renderer/i18nZh/review.ts';

/**
 * 「你觉得整份重导设计合理吗，为什么不能分页处理」—— 不合理，能分页。
 *
 * `.pptx` 是一堆 XML part 的 zip，一页一个（`ppt/slides/slideN.xml`、`ppt/notesSlides/notesSlideN.xml`），
 * 编辑单位天然是一页；而抽备注用的 `python-pptx` 本来就能写。让模型重导整份最糟的不是慢，
 * 是**它会把你已经看过的十三页重新排一遍**（模型每次落笔都不一样）—— 和门上那条
 * 「按照 comment 修改」被砍掉是同一个理由。
 *
 * 实测（14 页那份 Stripe deck，改第 3 页备注）：141 个 part 数量不变、一个都没丢、8 个媒体文件字节
 * 完全一致、每页形状数一致、十四页版面文字逐页相同 —— 只有第 3 页备注变了。
 */
describe('改一页的备注：脚本本身', () => {
  test('新文本走 **stdin**，不走 argv', () => {
    /* 讲稿动辄六百字、带引号和换行，塞进命令行参数迟早在某个字符上翻车 */
    assert.match(WRITE_NOTE_SCRIPT, /text = sys\.stdin\.read\(\)/);
    assert.doesNotMatch(WRITE_NOTE_SCRIPT, /sys\.argv\[3\]/);
  });

  test('页码从 1 起，越界要**说**而不是写错一页', () => {
    assert.match(WRITE_NOTE_SCRIPT, /idx = int\(sys\.argv\[2\]\) - 1/);
    assert.match(WRITE_NOTE_SCRIPT, /if idx < 0 or idx >= len\(slides\):/);
    assert.match(WRITE_NOTE_SCRIPT, /页码超出范围/);
  });

  test('这一页原来没有备注也能写 —— `notes_slide` 会替它建一个', () => {
    assert.match(WRITE_NOTE_SCRIPT, /slides\[idx\]\.notes_slide\.notes_text_frame\.text = text/);
  });

  test('写完**重抽一遍**再返回 —— 界面要显示磁盘上那一份', () => {
    /* 返回"我们以为写进去的那份"会让界面显示一份并不在磁盘上的备注 */
    assert.match(WRITE_NOTE_SCRIPT, /for s in Presentation\(path\)\.slides:/);
  });
});

describe('改一页的备注：输出解析', () => {
  test('正常输出收下', () => {
    assert.deepEqual(parseWriteNote('{"ok":true,"notes":["a","b"]}'), { ok: true, notes: ['a', 'b'] });
  });

  test('形状不对一律当失败 —— 半截 JSON 说明写盘那步出了事', () => {
    for (const bad of ['', '{', 'null', '{"ok":true}', '{"ok":true,"notes":[1]}', '[]']) {
      assert.equal(parseWriteNote(bad).ok, false, bad);
    }
  });

  test('脚本自己报的错要带上来', () => {
    const out = parseWriteNote('{"ok":false,"error":"页码超出范围"}');
    assert.equal(out.ok, false);
    assert.match((out as any).error, /页码超出范围/);
  });
});

describe('接线', () => {
  const MAIN = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const PRE = fs.readFileSync(path.join(process.cwd(), 'src/main/preload.ts'), 'utf8');
  const RV = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/ReviewPane.tsx'), 'utf8');
  const at = MAIN.indexOf("ipcMain.handle('deck:write-note'");
  const body = MAIN.slice(at, at + 3000);

  test('三道闸：主人会话读过 / 只有 `.pptx` / 写前备份', () => {
    assert.ok(at > 0);
    /* 闸在 `deckTarget`：路径按主人会话解析（resolveUserPath）、必须是这条会话读过的、只认 .pptx */
    assert.match(body, /const g = deckTarget\(sessionId, filePath, page\);/);
    const gate = MAIN.slice(MAIN.indexOf('const deckTarget = '), MAIN.indexOf('const deckTarget = ') + 700);
    assert.match(gate, /reviewTarget\(sessionId, filePath\)/);
    assert.match(gate, /canEditDeck\(t\.want\)/);
    /* 备份是**二进制原样**存的：`save()` 会整包重新序列化，出事时要能整份换回来；拷不成就不写 */
    const bk = MAIN.slice(MAIN.indexOf('const backupDeck = '), MAIN.indexOf('const backupDeck = ') + 500);
    assert.match(bk, /saveReviewBackup\(want, fs\.readFileSync\(want\)\)/);
    assert.ok(body.indexOf('backupDeck(want)') < body.indexOf('runPy(WRITE_NOTE_SCRIPT'));
  });

  test('接到备注那个框的「确认」上，而且用重抽的那份刷新界面', () => {
    assert.match(PRE, /deckWriteNote:/);
    assert.ok(RV.includes('if (live) queueNote(page, t);'));
    assert.match(RV, /window\.kiroApi\.deckWriteNote\?\.\(sessionId, path, page, res\.text\)/);
    assert.ok(RV.includes('if (Array.isArray(wrote.notes)) livePane().setNotes(wrote.notes);'));
  });

  test('**PDF 不用重转** —— 备注不在 PDF 里', () => {
    /* `--convert-to pdf` 导出的是幻灯片本体，不含备注；改讲稿不该让人等一次 LibreOffice */
    assert.match(RV, /PDF 不用重转/);
    assert.doesNotMatch(RV.slice(RV.indexOf('const queueNote'), RV.indexOf('const queueNote') + 2200), /fetchDeck|previewDeck/);
  });
});

/**
 * 「为什么 ppt 一页变化需要整个重新导？」
 *
 * 编辑那半早就是按页的（`WRITE_NOTE_SCRIPT` 只改那一页的讲稿），**渲染那半在白重转**：
 * 转换缓存的 key 是 `路径|mtime|大小`，而改一句讲稿必然改这两个 —— 于是下次打开预览十四页
 * 重跑一次 LibreOffice，而讲稿根本不进 PDF（`--convert-to pdf` 导出的是幻灯片本体）。
 *
 * 我先试的是"key 只哈希影响 PDF 的那些 part"（排除 `ppt/notesSlides/**`），**不成立**：
 * `python-pptx` 的 `save()` 是整包重新序列化，slide 那些 part 的 CRC 也全变了 ——
 * 实测改第 3 页备注，那个指纹 `1e74edb6…` → `ae47df71…`。语义没变而字节变了，哈希看不出区别。
 *
 * 所以由**知道这件事的人**来搬：这一次改动是我们做的，我们清楚只有讲稿变了。
 */
describe('改一页备注不该让十四页重转', () => {
  const MAIN = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const DECK = fs.readFileSync(path.join(process.cwd(), 'src/main/deckPreview.ts'), 'utf8');
  const at = MAIN.indexOf("ipcMain.handle('deck:write-note'");
  const body = MAIN.slice(at, at + 4000);

  test('写前记旧 key、写后算新 key，把那份 PDF 搬过去', () => {
    assert.match(body, /const beforeStat = fs\.statSync\(want\);/);
    assert.match(body, /const oldKey = previewKey\(\{ path: want, mtimeMs: beforeStat\.mtimeMs, size: beforeStat\.size \}, sha16\);/);
    assert.match(body, /const newKey = previewKey\(\{ path: want, mtimeMs: st2\.mtimeMs, size: st2\.size \}, sha16\);/);
    assert.match(body, /fs\.renameSync\(path\.join\(from, 'deck\.pdf'\), path\.join\(to, 'deck\.pdf'\)\)/);
    assert.match(body, /fs\.copyFileSync\(path\.join\(from, 'deck\.pdf'\), path\.join\(to, 'deck\.pdf'\)\)/);
  });

  test('**搬不动就什么都不做** —— 那时只是多转一次，不会出错', () => {
    /* 缓存本来就没有、磁盘出事、目标已经有了：三种都不该让"改备注"这件事失败 */
    assert.match(body, /if \(oldKey !== newKey && fs\.existsSync\(path\.join\(from, 'deck\.pdf'\)\) && !fs\.existsSync\(path\.join\(to, 'deck\.pdf'\)\)\)/);
    assert.match(body, /preview cache carry skipped/);
  });

  test('那条"哈希影响 PDF 的 part"的死路要写在判据旁边', () => {
    /* 不写的话下一个人（包括我）会再试一次，再花一遍时间发现 save() 整包重写 */
    assert.match(DECK, /整包重新序列化/);
    assert.match(DECK, /1e74edb6/, '把实测的两个指纹留着');
  });
});

/**
 * 「那就让它多说一句已经修改之类的，不然不知道修改成功了没有」+「我建议回复中写一下 ppt 路径」。
 */
describe('落盘之后在会话里报一句', () => {
  const MAIN2 = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const RV = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/ReviewPane.tsx'), 'utf8');
  const RB2 = fs.readFileSync(path.join(process.cwd(), 'src/main/reviseBlock.ts'), 'utf8');

  test('**这句话由 KiroLex 说，不是让模型说**', () => {
    /*
      模型说"已修改"只证明它输出了正文，而真正会失败的是**写盘**那一步（路径不对、文件被占、
      python 报错）—— 那件事只有主进程知道。让模型报告一件它看不见的事，得到的是一句必然为真的空话。
      而且提示词里刚禁止它写开场白（那些话会被原样写进产出），转头又让它加一句，
      风险是那句某次跟着正文落进讲稿里。
    */
    assert.match(MAIN2, /ipcMain\.handle\('session:note'/);
    assert.match(RB2, /不要写"好的"、"已按意见修改如下"这类开场|不要写"好的""已修改如下"这类开场/);
    assert.match(RV, /window\.kiroApi\.sessionNote\?\.\(/);
  });

  test('报的是**已经发生的事实**：哪一页、多少字、哪个文件', () => {
    assert.match(RV, /t\('✅ Wrote the speaker notes for page \{page\} \(\{n\} chars\)\\nFile: \{path\}\\n[^']*backed up first[^']*', \{ page, n: String\(res\.text\)\.length, path \}\)/);
    /* 「我建议回复中写一下 ppt 路径」—— 一条会话里可能同时开着几份 deck（v1/v2、中英两版） */
    assert.equal(ZH_REVIEW['✅ Wrote the speaker notes for page {page} ({n} chars)\nFile: {path}\nKiroLex saved it to disk (backed up first to ~/.kirolex/backups/review-files/).'],
      '✅ 已写入第 {page} 页的演讲者备注（{n} 字）\n文件：{path}\nKiroLex 落盘完成（写前已备份到 ~/.kirolex/backups/review-files/）。');
    /*
      **说完就停** ——「每次修改都有『不用你再动这个文件』这个废话，能把这个删掉吗」。

      那句话原来是防它自己再写一遍文件（两个写者对同一个文件）。但那件事该在**它下笔之前**说，
      而提示词里已经说了（`reviseSlideTextPrompt` 的「不要自己去动这个文件」）—— 事后再嘱咐一遍
      拦不住任何东西，只是每改一次就在会话里多一行。
    */
    assert.doesNotMatch(RV, /不用你再动这个文件|不用你再改这个文件/);
    /* 而下笔之前那一句要留着 —— 那是真的在起作用的那句 */
    assert.match(RB2, /\*\*不要自己去动这个文件\*\*/);
  });

  test('那条路径**点得开** —— 用户气泡和 KiroLex 的提示里的裸路径都变成链接', () => {
    /* 用户气泡是纯文本渲染（不走 markdown），所以单独过一遍 `withPathLinks`；KiroLex 的提示是居中卡片，用同一个链接器 */
    const CA = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/ChatArea.tsx'), 'utf8');
    assert.match(CA, /function withPathLinks\(text: string, keyBase: string\)/);
    /* 命中的那几段换成 `FileRef`（它自己会先确认文件在盘上，否则退回普通文本） */
    assert.match(CA, /out\.push\(<FileRef key=\{`\$\{keyBase\}:\$\{m\.index\}`\} path=\{m\[0\]\} as="a">\{m\[0\]\}<\/FileRef>\);/);
    /* 两种段落都要过一遍 —— 普通的和 steer 的 */
    assert.match(CA, /<p key=\{key\}>\{withPathLinks\(paragraph\.text, key\)\}<\/p>/);
    assert.match(CA, /\{withPathLinks\(paragraph\.text, key\)\}\n\s*<\/p>/);
    /* KiroLex 的居中提示也用同一个链接器 */
    assert.match(CA, /\{withPathLinks\(message\.content, message\.id\)\}/);
    /* 判据和助手那侧同一条正则 —— 两侧对"什么算路径"必须一致 */
    assert.match(CA, /PATH_RE\.exec\(text\)/);
  });

  test('那条正则接得住实际写法：中文文件名 + 后面紧跟换行', () => {
    /* `文件：/Users/…/周报 2026-09-07.pptx\nKiroLex…` —— 全角冒号打头、空格在文件名里、结尾是换行 */
    const src = fs.readFileSync(path.join(process.cwd(), 'src/renderer/filePaths.ts'), 'utf8');
    const re = new RegExp(
      String(src.match(/export const PATH_RE = \/(.*)\/[a-z]*;/)?.[1]),
      String(src.match(/export const PATH_RE = \/.*\/([a-z]*);/)?.[1]),
    );
    const line = '文件：/Users/keyinan/Documents/周报 2026-09-07.pptx\nKiroLex 落盘完成';
    assert.deepEqual(line.match(re), ['/Users/keyinan/Documents/周报 2026-09-07.pptx']);
  });

  test('提示词里也带全路径 —— 它改的时候就该知道是哪一份', () => {
    assert.match(RV, /about: `\$\{path\} 第 \$\{page\} 页的演讲者备注/);
  });

  test('角色用 `user` —— 读起来像工具回报，而且下一轮它看得见"这件事做完了"', () => {
    /* 不然它可能自己再去写一遍文件（两个写者对同一个文件） */
    /* 落盘那三件事搬进了 `noteInSession`（和"⏳ 已排队"那句共用）—— 断言跟着搬 */
    assert.match(MAIN2, /function noteInSession\(sessionId: string, body: string, variants\?: TextVariants\): boolean \{/);
    const at = MAIN2.indexOf('function noteInSession(');
    const body = MAIN2.slice(at, at + 1400); /* 多了两版文案（variants）那两行，窗口放宽一点 */
    assert.match(body, /role: 'user'/);
    assert.match(body, /send\('acp:user-message'/, '要推给界面，否则只在盘上');
    assert.match(body, /refreshHistoryFile\(sid\)/, 'history.md 也要跟上');
    /* IPC 那一侧只剩转发 —— 同一件事不该有两份实现 */
    assert.match(MAIN2, /return noteInSession\(sessionId, text, asVariants\(variants\)\) \? \{ ok: true \} : \{ ok: false \};/);
  });
});
