import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseSlideEdits, reviseSlideTextPrompt } from '../src/main/reviseBlock.ts';
import { SLIDE_OPS_SCRIPT, parseSlideRuns } from '../src/main/deckPreview.ts';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

/**
 * 「所以我甚至不能让 comment 添加或者修改页面上的文本框吗，WTF」。
 *
 * 之前当场生效那条路只会**替换已有 run 的文字**，所以"把这个空框删掉"、"右下角加一句来源"、
 * "把这块挪下去"全都只能回 `CANNOT-REVISE-LOCALLY`，然后走提交那条（会话自己写 python，实测 2–4 分钟）。
 * 而这三件事 python-pptx 各自只有一两行 —— 都在真实 pptx 上跑通了才写进来的。
 */
describe('动版面：删框 / 加框 / 挪框', () => {
  test('三条指令都解析得出来，和文字改动混在一份回复里', () => {
    const got = parseSlideEdits([
      '0.0.0\t新标题',
      'DELETE-SHAPE 1',
      'ADD-TEXT 14 16.5 10 1.2 0.0.0\t来源：Stripe 2025 年报',
      'MOVE 0 1 1',
    ].join('\n'));
    assert.deepEqual(got.edits, [{ at: '0.0.0', text: '新标题' }]);
    assert.deepEqual(got.ops, [
      { op: 'delete-shape', i: 1 },
      { op: 'add-text', l: 14, t: 16.5, w: 10, h: 1.2, text: '来源：Stripe 2025 年报', like: '0.0.0' },
      { op: 'move', i: 0, l: 1, t: 1 },
    ]);
  });

  test('写法宽松：大小写、项目符号、连字符有没有都认', () => {
    /* 和分隔符那次同一个理由：一次改写 5–25 秒，为一个连字符作废不值得 */
    assert.deepEqual(parseSlideEdits('- delete shape 3').ops, [{ op: 'delete-shape', i: 3 }]);
    assert.deepEqual(parseSlideEdits('deleteshape 4').ops, [{ op: 'delete-shape', i: 4 }]);
    assert.deepEqual(parseSlideEdits('move 2 2.5 3.5 8 4').ops, [{ op: 'move', i: 2, l: 2.5, t: 3.5, w: 8, h: 4 }]);
  });

  test('散文不当指令；`ADD-TEXT` 没有文字就不算一条', () => {
    assert.deepEqual(parseSlideEdits('随便一句散文，说要删掉那个框').ops, []);
    assert.deepEqual(parseSlideEdits('ADD-TEXT 1 2 3 4 -\t   ').ops, []);
    /* 参考地址写 `-` 就是"不抄格式" —— `like` 不出现，而不是记一个假地址 */
    assert.deepEqual(parseSlideEdits('ADD-TEXT 1 2 3 4 - 一句话').ops,
      [{ op: 'add-text', l: 1, t: 2, w: 3, h: 4, text: '一句话' }]);
  });

  test('提示词里有形状表和这三条指令，位置一律厘米', () => {
    const p = reviseSlideTextPrompt({
      runs: [{ at: '0.0.0', text: '标题' }],
      shapes: [{ i: 1, kind: 'text', name: 'Subtitle 2', l: 3.8, t: 10.8, w: 17.8, h: 4.9 }],
      pageW: 25.4, pageH: 19.05, note: '删掉副标题', page: 1,
    });
    assert.match(p, /这一页的形状/);
    assert.match(p, /1\ttext\t位置 3\.8,10\.8 大小 17\.8×4\.9cm\tSubtitle 2/);
    assert.match(p, /页面 25\.4×19\.05cm/);
    assert.match(p, /DELETE-SHAPE <编号>/);
    assert.match(p, /ADD-TEXT <左> <上> <宽> <高> <参考地址>/);
    assert.match(p, /MOVE <编号> <左> <上> \[<宽> <高>\]/);
    /* 新框要抄格式 —— 不抄的话它是默认黑色小字，在定过样式的页上一眼就是补丁 */
    assert.match(p, /照抄它/);
  });

  test('没有形状表就不摆那一节 —— 老调用方（只传 runs）照旧能用', () => {
    const p = reviseSlideTextPrompt({ runs: [{ at: '0.0.0', text: '标题' }], note: 'x', page: 1 });
    assert.doesNotMatch(p, /这一页的形状/);
  });
});

/**
 * 那段 python 的判据。**都是在真实 pptx 上验过的**，不是照着文档写的：
 * 删形状用 `sh._element.getparent().remove(...)`、加框用 `add_textbox` + 抄参考 run 的字体、
 * 挪框直接写 `left/top/width/height`。
 */
describe('落盘脚本里那几条必须成立的判据', () => {
  test('**删除按下标从大到小** —— 从小往大删，第二条就删错对象了', () => {
    assert.match(SLIDE_OPS_SCRIPT, /dels = sorted\(\{int\(o\["i"\]\) for o in ops if o\.get\("op"\) == "delete-shape"\}, reverse=True\)/);
  });

  test('**挪之前把四个值都读出来再写回去** —— 占位符只写三个会把高度写成 0', () => {
    /*
      实测踩到的：Title/Subtitle 的几何是从版式继承的，只写 left/top/width 会落一个显式 <a:ext>，
      没给的 cy 变成 0 —— 那一页标题当场 0 厘米高。
    */
    assert.match(SLIDE_OPS_SCRIPT, /elif cur\[k\] is not None:/);
    assert.match(SLIDE_OPS_SCRIPT, /setattr\(sh, attr, cur\[k\]\)/);
  });

  test('新框的字**照抄参考 run**，抄不动也不让整条失败', () => {
    assert.match(SLIDE_OPS_SCRIPT, /r\.font\.size = ref\.font\.size/);
    assert.match(SLIDE_OPS_SCRIPT, /except Exception: pass/);
  });

  test('一条都没做成就**不保存** —— 半截的 pptx 比不动更糟', () => {
    const at = SLIDE_OPS_SCRIPT.indexOf('if done == 0:');
    assert.ok(at > 0);
    assert.ok(at < SLIDE_OPS_SCRIPT.indexOf('p.save(path)'), '这道判断必须在 save 之前');
  });

  test('指令走 stdin 的 JSON，不走 argv —— 文本里有引号和中文', () => {
    assert.match(SLIDE_OPS_SCRIPT, /ops\.append\(json\.loads\(line\)\)/);
  });

  test('形状表解析得出来，而且是**可选**的（写入脚本只回 runs）', () => {
    const withShapes = parseSlideRuns(JSON.stringify({
      ok: true, runs: [{ at: '0.0.0', text: 'a' }],
      shapes: [{ i: 0, name: 'Title 1', kind: 'text', text: 'a', l: 1.9, t: 5.9, w: 21.6, h: 4.1 }],
      page: { w: 25.4, h: 19.05 },
    }));
    assert.equal(withShapes.ok, true);
    assert.equal((withShapes as any).shapes[0].name, 'Title 1');
    assert.deepEqual((withShapes as any).page, { w: 25.4, h: 19.05 });
    const noShapes = parseSlideRuns(JSON.stringify({ ok: true, runs: [], changed: 2 }));
    assert.equal(noShapes.ok, true);
    assert.equal((noShapes as any).shapes, undefined);
  });
});

describe('接线：文字先改、版面后动', () => {
  const MAIN = read('src/main/index.ts');

  test('顺序不能反 —— 版面一动，形状下标就全变了', () => {
    const at = MAIN.indexOf('if (got.edits.length) {');
    assert.ok(at > 0);
    const body = MAIN.slice(at, at + 1400);
    assert.ok(body.indexOf('writeSlideText(want, page, got.edits)') < body.indexOf('writeSlideOps(want, page, got.ops)'));
    assert.match(MAIN, /\*\*文字先改，版面后动\*\*：版面一动形状下标就全变了/);
  });

  test('文字成了、版面没成 = **不算全败**，要说清哪一半没成', () => {
    assert.match(MAIN, /partial: tr\('The layout changes did not go through: \{err\}', \{ err: String\(wroteOps\.error\) \}\)/);
  });

  test('版面这条路同样有那三道闸（主人会话读过 / 只认 pptx / 写前备份）', () => {
    /* 前两道在 `deckTarget`（所有 deck 写盘入口共用），第三道在写之前 */
    const gate = MAIN.slice(MAIN.indexOf('const deckTarget = '), MAIN.indexOf('const deckTarget = ') + 700);
    assert.match(gate, /const t = reviewTarget\(sessionId, filePath\);/);
    assert.match(gate, /if \(!canEditDeck\(t\.want\)\)/);
    const at = MAIN.indexOf('const writeSlideOps = async');
    const body = MAIN.slice(at, at + 1400);
    assert.ok(body.indexOf('backupDeck(want)') > 0 && body.indexOf('backupDeck(want)') < body.indexOf('runPy(SLIDE_OPS_SCRIPT'));
    /* 两个入口都先过闸 */
    const rev = MAIN.slice(MAIN.indexOf("ipcMain.handle('deck:revise-slide-text'"));
    assert.match(rev.slice(0, 900), /const g = deckTarget\(sid, /);
  });
});

/*
 * 「第三页 这个页面中怎么有大 bullet 有小 bullet，统一下格式，kirolex 处理不了？」
 *
 * 之前给模型的只有"地址 + 文字"，所以这类意见它**无从判断**：哪一行大、哪一行小、谁是真项目符号、
 * 谁是把 `●` 打进了正文，它一个都看不见。查那一页实测：12 个 bullet 全是手打进正文的 `●`（U+25CF）、
 * 10.5pt、PingFang SC、`lvl=0`，`buChar` 一个都没有 —— 这种事只有把格式摆出来才说得清。
 */
describe('格式：字号 / 项目符号 / 缩进层级', () => {
  test('读的时候每一条带上 `pt` / `font` / `lvl` / `bullet`', () => {
    const S = read('src/main/deckPreview.ts');
    assert.match(S, /"lvl": para\.level, "bullet": bu/);
    assert.match(S, /row\["pt"\] = round\(run\.font\.size\.pt, 1\)/);
    /* bullet 三种值分得清：真项目符号 / 明确关掉 / 没设跟版式走 */
    assert.match(S, /return "char:" \+ \(bc\.get\("char"\) or "\?"\)/);
    assert.match(S, /return "none"/);
  });

  test('三条指令解析得出来，地址粒度不一样（字号逐 run，符号/缩进整段）', () => {
    const g = parseSlideEdits([
      'SET-SIZE 25.0.0 10.5',
      'SET-BULLET 25.0 ●',
      'set bullet 31.1.0 none',
      'SET-LEVEL 25.2 1',
    ].join('\n'));
    assert.deepEqual(g.ops, [
      { op: 'set-size', at: '25.0.0', pt: 10.5 },
      { op: 'set-bullet', at: '25.0', char: '●' },
      /* 它顺手写了 run 地址（三段）—— 取前两段，而不是整条丢掉 */
      { op: 'set-bullet', at: '31.1', char: 'none' },
      { op: 'set-level', at: '25.2', lvl: 1 },
    ]);
  });

  test('提示词里格式**单独一节** —— 塞进文字表会让它照着三列回', () => {
    const p = reviseSlideTextPrompt({
      runs: [{ at: '25.0.0', text: '● 接入层拦截', pt: 10.5, font: 'PingFang SC', lvl: 0, bullet: '-' }],
      note: '统一 bullet', page: 3,
    });
    /* 文字表还是两列，和回复格式同构 */
    assert.match(p, /25\.0\.0\t● 接入层拦截\n---/);
    assert.match(p, /这一页的格式（`地址<TAB>字号<TAB>字体<TAB>缩进层级<TAB>项目符号`/);
    assert.match(p, /25\.0\.0\t10\.5pt\tPingFang SC\t0\t-/);
    assert.match(p, /SET-SIZE <地址> <磅值>/);
    assert.match(p, /SET-BULLET <形状\.段> <字符>/);
    assert.match(p, /SET-LEVEL <形状\.段> <0-8>/);
    /* 手打的圆点要走"改文字"，不是走 SET-BULLET —— 这一页正是这种情况 */
    assert.match(p, /如果原文里的圆点是手打的字符/);
  });

  test('落盘：`buChar` 要先清干净再插，而且插在 `pPr` 末尾（schema 有序）', () => {
    assert.match(SLIDE_OPS_SCRIPT, /for tag in \("buChar", "buNone", "buAutoNum"\):/);
    assert.match(SLIDE_OPS_SCRIPT, /pPr\.append\(el\)/);
    /* 段落原来没有 pPr 的话要建一个，插在最前面 */
    assert.match(SLIDE_OPS_SCRIPT, /para\._p\.insert\(0, pPr\)/);
  });
});
