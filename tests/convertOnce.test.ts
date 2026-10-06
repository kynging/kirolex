import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { ConvertOnce, LO_PROFILE_DIR, userInstallationArg } from '../src/main/convertOnce.ts';

/**
 * 「怎么还能转 PDF 失败」—— 同一份文件被**同时**转了两次。
 *
 * 日志里两条紧挨着：`06:15:36.166 WARN 转 PDF 失败` / `06:15:36.318 INFO converted`，相差 152 毫秒。
 * 命令行复现得很干净：第二个 `soffice` 实例**一个字都不输出、也不产出 PDF**，直接退出 ——
 * LibreOffice 是单实例的，第二个进程把活儿交给已经在跑的那个就算完事。
 *
 * 两个请求从哪来：dev 下 React StrictMode 把 effect 跑两遍，加上"读不到就带 force 重转一次"那条退路。
 */
describe('同一份 deck 只转一次', () => {
  test('并发的第二个请求等第一个，不再起一次转换', async () => {
    const once = new ConvertOnce<string>();
    let runs = 0;
    const slow = async () => { runs += 1; await new Promise((r) => setTimeout(r, 20)); return 'pdf'; };
    const [a, b] = await Promise.all([once.run('k', slow), once.run('k', slow)]);
    assert.equal(runs, 1, '只该跑一次 —— 第二次是纯浪费，而且会把第一次踢掉');
    assert.equal(a, 'pdf');
    assert.equal(b, 'pdf', '两边拿到同一个结果');
  });

  test('不同的 key 各跑各的 —— 两份不同的 deck 不该互相等', async () => {
    const once = new ConvertOnce<string>();
    let runs = 0;
    const run = async () => { runs += 1; return 'x'; };
    await Promise.all([once.run('a', run), once.run('b', run)]);
    assert.equal(runs, 2);
  });

  test('跑完就不占位 —— 第二次点开要真的重转（缓存那层在外面判）', async () => {
    const once = new ConvertOnce<string>();
    let runs = 0;
    const run = async () => { runs += 1; return 'x'; };
    await once.run('k', run);
    await once.run('k', run);
    assert.equal(runs, 2);
    assert.equal(once.size, 0);
  });

  test('**失败也不占位** —— 否则一次瞬时失败变成永久的"这个文件转不了"', async () => {
    const once = new ConvertOnce<string>();
    await assert.rejects(once.run('k', async () => { throw new Error('boom'); }));
    assert.equal(once.size, 0);
    assert.equal(await once.run('k', async () => 'ok'), 'ok');
  });

  test('一次失败让**两边**都失败，而不是一边成功一边报错', async () => {
    /* "一失败一成功"正是这次的症状：两个请求看到的世界不一样，界面上就是随机地报转换失败 */
    const once = new ConvertOnce<string>();
    const boom = async () => { throw new Error('boom'); };
    const results = await Promise.allSettled([once.run('k', boom), once.run('k', boom)]);
    assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
  });
});

/**
 * 独立的 LibreOffice user profile。
 *
 * 去重只解决"同一份文件被要两次"。两份**不同**的 deck 同时点开、或者用户自己正开着 LibreOffice，
 * 仍然会抢同一份默认 profile —— 症状一样。实测两个独立 profile 并发跑，两份 PDF 都出来了、
 * 字体也没退化。
 */
describe('独立的 LO profile', () => {
  test('必须是 file:// URL —— 给路径的话 LO 不报错，只是当没设', () => {
    /* 又一个"不报错的错"：看着设了，实际又回到抢默认 profile 那条老路上 */
    assert.equal(userInstallationArg('/Users/x/.kirolex/loffice-profile'),
      '-env:UserInstallation=file:///Users/x/.kirolex/loffice-profile');
  });

  test('末尾的斜杠去掉', () => {
    assert.equal(userInstallationArg('/a/b/'), '-env:UserInstallation=file:///a/b');
    assert.equal(userInstallationArg('/a/b///'), '-env:UserInstallation=file:///a/b');
  });

  test('**Windows 路径**拼成 file:///C:/… —— 直接接在 file:// 后面 LO 会把 C: 当主机名', () => {
    assert.equal(userInstallationArg('C:\\Users\\x\\.kirolex\\loffice-profile'),
      '-env:UserInstallation=file:///C:/Users/x/.kirolex/loffice-profile');
    /* 带空格 / 中文的用户目录按 URL 编码 —— Windows 上并不少见 */
    assert.equal(userInstallationArg('C:\\Users\\张 三\\.kirolex\\p\\'),
      '-env:UserInstallation=file:///C:/Users/%E5%BC%A0%20%E4%B8%89/.kirolex/p');
  });

  test('放在 ~/.kirolex 下面，不动用户自己那份', () => {
    assert.equal(LO_PROFILE_DIR, 'loffice-profile');
  });
});

describe('接线', () => {
  const MAIN = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const h = MAIN.slice(MAIN.indexOf("ipcMain.handle('preview:deck'"));
  const body = h.slice(0, h.indexOf("ipcMain.handle('preview:pdf-bytes'"));

  test('去重器在 handler 外面 —— 每次请求各建一个等于没去重', () => {
    const at = MAIN.indexOf('const deckConversions = new ConvertOnce');
    assert.ok(at > 0);
    assert.ok(at < MAIN.indexOf("ipcMain.handle('preview:deck'"), '要在 handler 之前声明');
  });

  test('转换那段真的包在去重里', () => {
    assert.match(body, /await deckConversions\.run\(key, async \(\) => \{/);
  });

  test('soffice 带着独立 profile 跑', () => {
    assert.match(body, /userInstallationArg\(profile\)/);
    assert.match(body, /LO_PROFILE_DIR/);
    assert.match(body, /fs\.mkdirSync\(profile, \{ recursive: true \}\)/, 'profile 目录要先建出来');
  });

  test('讲稿在去重之外 —— 它便宜，两个请求各要一份不冲突；页数交给 pdf.js（不再要 PyMuPDF）', () => {
    const at = body.indexOf('if (!outcome.ok');
    assert.ok(at > 0);
    assert.match(body.slice(at), /return done\(outcome\.pdf\);/);
    assert.ok(body.indexOf('runPy(NOTES_SCRIPT') < body.indexOf('deckConversions.run('), '讲稿在转换之前、去重之外抽');
    assert.doesNotMatch(body, /fitz|countPages/);
  });
});
