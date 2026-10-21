import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { SLIDE_TEXT_SCRIPT, WRITE_SLIDE_TEXT_SCRIPT, parseSlideRuns } from '../src/main/deckPreview.ts';
import { reviseSlideTextPrompt, parseSlideEdits } from '../src/main/reviseBlock.ts';

/**
 * 「现在就做一个工具吧」——「改第 N 页幻灯片上的文字」这件事从"让模型现写 python-pptx 代码"变成一个工具。
 *
 * 为什么值得：量过今天全部数据 —— 工具本身 498 次合计 1513 秒（中位 0.3 秒），而**工具之间等模型
 * 10143 秒**（占 87%）。改 PPT 那一段更直白：九次 `python3` 每次跑 0.3–1.1 秒，相邻两次之间隔 20–45 秒，
 * 四分多钟里工具只占 6 秒。所以省的不是执行时间，是**往返次数**：现在一次往返，模型只出文本。
 */
describe('按 run 寻址：为什么不是按段', () => {
  test('读脚本只列**非空的 run**，地址是 `形状.段.run`', () => {
    /*
      设成 `text_frame.text` 或按段替换会把 run 级格式碾平（一段里的加粗、变色、不同字号全变成第一个
      run 的样子）—— 对一份做过设计的客户 deck 那是毁掉它。只改 `run.text` 则格式一个字节不动。

      前提量过：这份 deck 509 段 / 382 run，**平均每段 0.75 个 run** —— 绝大多数段就是一个 run，
      所以"按 run 寻址"和"按段编辑"在实际文档里几乎是同一件事，而它多保住了格式。
    */
    assert.match(SLIDE_TEXT_SCRIPT, /for ri, run in enumerate\(para\.runs\)/);
    /* 现在写成早退（`if not t.strip(): continue`）—— 后面还要给这一条挂格式，嵌套会更深 */
    assert.match(SLIDE_TEXT_SCRIPT, /if not t\.strip\(\):\s*\n\s*continue/, '空 run 是排版占位，不该列出来');
    assert.match(SLIDE_TEXT_SCRIPT, /"%d\.%d\.%d" % \(si, pi, ri\)/);
  });

  test('写脚本**只改点到名的那些 run**，而且改完重读', () => {
    assert.match(WRITE_SLIDE_TEXT_SCRIPT, /if key in edits:\s*\n\s*run\.text = edits\[key\]/);
    assert.match(WRITE_SLIDE_TEXT_SCRIPT, /for si, sh in enumerate\(list\(Presentation\(path\)\.slides\)\[idx\]\.shapes\)/);
  });

  test('**一个地址都没命中就不保存** —— 那说明地址是编的', () => {
    /* 保存一份什么都没改的 pptx 会白改 mtime，于是缓存失效、十四页重转一次 */
    assert.match(WRITE_SLIDE_TEXT_SCRIPT, /if hit == 0:/);
    assert.match(WRITE_SLIDE_TEXT_SCRIPT, /给的地址在这一页上都不存在/);
  });

  test('改动走 stdin（`地址<TAB>文本`）—— 文字里带引号逗号都不影响', () => {
    assert.match(WRITE_SLIDE_TEXT_SCRIPT, /for line in sys\.stdin\.read\(\)/);
    assert.match(WRITE_SLIDE_TEXT_SCRIPT, /at, text = line\.split/);
  });
});

describe('提示词：只回改动的那几行', () => {
  const p = reviseSlideTextPrompt({
    runs: [{ at: '1.0.0', text: 'PAYMENTS INTELLIGENCE' }, { at: '2.0.0', text: '同一套支付智能' }],
    note: '标题太长', page: 3, path: '/tmp/a.pptx',
  });

  test('把地址和原文一起给它 —— 它要按地址回，就得先看见地址', () => {
    assert.match(p, /1\.0\.0\tPAYMENTS INTELLIGENCE/);
    assert.match(p, /第 3 页/);
    assert.match(p, /\/tmp\/a\.pptx/, '一条会话里可能同时开着几份 deck');
  });

  test('**只回要改的那几行** —— 没回的地址一个字节不动，不必把整页抄一遍', () => {
    assert.match(p, /\*\*只回你要改的那几行\*\*/);
    assert.match(p, /没回的地址我一个字节都不动/);
  });

  test('**一条文字一行** —— 换行会被当成下一条', () => {
    assert.match(p, /\*\*一条文字要放在一行里\*\*/);
  });

  test('不许它自己动文件 —— 两个写者对同一个文件要么改两遍要么互相覆盖', () => {
    assert.match(p, /\*\*不要自己去动这个文件\*\*/);
  });
});

describe('解析模型那几行', () => {
  test('正常的收下', () => {
    const got = parseSlideEdits('1.0.0\t新标题\n2.0.0\t新正文');
    assert.deepEqual(got.edits, [{ at: '1.0.0', text: '新标题' }, { at: '2.0.0', text: '新正文' }]);
  });

  test('**地址后面那一下写成什么都认** —— 差一个字符不该让整次改写作废', () => {
    /*
      「改写失败：它没有给出可用的改动行」。约定是 `地址<TAB>新文本`，而原来只认制表符和
      "两个以上空格"。模型很容易把那个制表符写成**一个空格**，或者顺手加个冒号、箭头、项目符号 ——
      那时整份回复一条都不匹配，而它其实给了。一次改写 5–25 秒，还要你重新措辞再试，代价太大。
    */
    for (const line of [
      '1.0.0\t新标题',
      '1.0.0   新标题',
      '1.0.0 新标题',
      '1.0.0: 新标题',
      '1.0.0：新标题',
      '1.0.0 -> 新标题',
      '1.0.0 → 新标题',
      '- 1.0.0 新标题',
      '* 1.0.0\t新标题',
      '  1.0.0  新标题  ',
      '1.0.0:新标题',
      '1.0.0→新标题',
    ]) {
      assert.deepEqual(parseSlideEdits(line).edits, [{ at: '1.0.0', text: '新标题' }], line);
    }
  });

  test('散文照旧丢掉，地址形状不对的也丢掉', () => {
    const got = parseSlideEdits('好的，已按意见修改：\n1.0 新标题\n2.0.0\t新正文\n（以上）');
    assert.deepEqual(got.edits, [{ at: '2.0.0', text: '新正文' }]);
    /* 地址必须是三段数字：两段（`1.0`）或者纯文字都不是地址 */
    assert.deepEqual(parseSlideEdits('1.0 新标题').edits, []);
    assert.deepEqual(parseSlideEdits('把标题改成"新标题"').edits, []);
  });

  test('**空文本不当"清空"** —— 那多半是格式没对上', () => {
    assert.deepEqual(parseSlideEdits('1.0.0\t   ').edits, []);
  });

  test('**`<DELETE>` 才算删掉那段字** ——「我让他把 subtitle 删掉，不行吗」', () => {
    /*
      这条路原来只能"替换"：空文本被故意丢掉，于是"把副标题删掉"这个意见**没有表达方式** ——
      模型回一行空的，被丢掉，你看到的是"它没有给出可用的改动行"，像是它没听懂。

      所以给一个明确的标记，而不是"回一行空的就当清空"：一个写错格式的回复不该把一段字清掉 ——
      那是不可逆的（原文只在备份里）。
    */
    assert.deepEqual(parseSlideEdits('1.0.0\t<DELETE>').edits, [{ at: '1.0.0', text: '' }]);
    /* 大小写和空格都别计较 —— 这类标记模型写法很随意 */
    for (const t of ['<delete>', '< DELETE >', '<Delete>']) {
      assert.deepEqual(parseSlideEdits(`2.1.0 ${t}`).edits, [{ at: '2.1.0', text: '' }], t);
    }
    /* 整段去掉 = 每个 run 都标一遍（提示词里就是这么说的） */
    assert.deepEqual(parseSlideEdits('1.0.0\t<DELETE>\n1.0.1\t<DELETE>').edits,
      [{ at: '1.0.0', text: '' }, { at: '1.0.1', text: '' }]);
  });

  test('提示词里要教这个标记，并说清它**不删那个框**', () => {
    const prompt = reviseSlideTextPrompt({
      runs: [{ at: '1.0.0', text: '副标题' }], note: '把副标题删掉', page: 1, path: '/x/a.pptx',
    });
    assert.match(prompt, /<DELETE>/);
    /* 措辞跟着"能删框了"改了：`<DELETE>` 只清字，删框现在有专门的 `DELETE-SHAPE`（见 slideOps 那组） */
    assert.match(prompt, /它只清字，框还留着/);
    assert.match(prompt, /DELETE-SHAPE <编号>/);
    /* 实测（LibreOffice 转出来的 PDF）：清掉那个 run 之后整页只剩 1 条画字指令、0 条描边 ——
       所以"框还在但看不见"这句话是量过的，不是猜的 */
    assert.match(prompt, /空框在导出的 PDF 上看不见/);
  });

  test('它说改不了就带上来，而且和"格式没对上"分开', () => {
    const got = parseSlideEdits('CANNOT-REVISE-LOCALLY: 要新增一个文本框');
    assert.equal(got.edits.length, 0);
    assert.match(got.cannot!, /新增一个文本框/);
    /* 一条都没解析出来又没说改不了 = 格式没对上，调用方要分开处置 */
    assert.equal(parseSlideEdits('随便说了点什么').cannot, undefined);
  });

  test('**一条都没解析出来时把它回的原话记进日志** —— 不然这个失败查不了', () => {
    /*
      实测撞到过一次「改写失败：它没有给出可用的改动行」，而日志里只有成功那几条 ——
      回复本身被丢掉，于是"它到底写了什么"这个唯一有用的线索哪儿都没有。
    */
    const MAIN2 = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const at = MAIN2.indexOf('const got = parseSlideEdits(reply.text);');
    assert.ok(at > 0);
    const body = MAIN2.slice(at, at + 1200);
    assert.match(body, /slide text: 一条都没解析出来/);
    assert.match(body, /String\(reply\.text\)\.slice\(0, 600\)/, '截断 —— 够看清格式，又不会灌一整页进日志');
    /* 它明说改不了的时候不记：那不是格式问题，那句话已经原样给到界面上了 */
    assert.match(body, /if \(!got\.cannot\) logger\.warn/);
  });
});

describe('接线', () => {
  const MAIN = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const RV = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/ReviewPane.tsx'), 'utf8');

  test('一次往返：读这一页 → 问会话 → 自己写', () => {
    const at = MAIN.indexOf("ipcMain.handle('deck:revise-slide-text'");
    assert.ok(at > 0);
    /* 截到这个 handler 结束为止（下一个是 deck:read-slide-text）—— 原来按 4000 个字符截，handler 加了去重的几行就截不全了 */
    const body = MAIN.slice(at, MAIN.indexOf("ipcMain.handle('deck:read-slide-text'", at));
    assert.match(body, /SLIDE_TEXT_SCRIPT/, '先读出地址');
    /* 形状表和页面尺寸也一起给它 —— 加/删/挪框全靠这个（见 slideOps 那组） */
    assert.match(body, /\.\.\.\(cur\.shapes\?\.length \? \{ shapes: cur\.shapes \} : null\)/);
    assert.match(body, /reviseSlideTextPrompt\(\{\s*\n\s*runs: cur\.runs, note, page, path: want,/);
    /* 文字先改、版面后动（版面一动下标就全变了）—— 见 slideOps 那组 */
    assert.match(body, /const wroteText = await writeSlideText\(want, page, got\.edits\);/);
    assert.match(body, /await writeSlideOps\(want, page, got\.ops\)/);
  });

  test('**写入逻辑只有一份** —— 两个入口共用，闸门不会分岔', () => {
    assert.match(MAIN, /const writeSlideText = async \(/);
    assert.match(MAIN, /ipcMain\.handle\('deck:write-slide-text', async \([\s\S]{0,300}?return writeSlideText\(g\.want, g\.at, edits\);/);
  });

  test('三道闸和别的写盘一致：主人会话读过 / 只有 `.pptx` / 写前备份', () => {
    const gate = MAIN.slice(MAIN.indexOf('const deckTarget = '), MAIN.indexOf('const deckTarget = ') + 700);
    assert.match(gate, /reviewTarget\(sessionId, filePath\)/);
    assert.match(gate, /Only \.pptx can be edited this way/);
    const at = MAIN.indexOf('const writeSlideText');
    const body = MAIN.slice(at, at + 2600);
    assert.match(body, /const bad = backupDeck\(want\);/);
    /* 地址形状也要校验 —— 别把模型编的东西直接塞进脚本 */
    assert.match(body, /\/\^\\d\+\\\.\\d\+\\\.\\d\+\$\//);
  });

  test('会话在忙就排队，不报错（和别的改写同一条链）', () => {
    const at = MAIN.indexOf("ipcMain.handle('deck:revise-slide-text'");
    assert.match(MAIN.slice(at, at + 1500), /return enqueueRevise\(sid, async \(\) => \{/);
  });

  test('界面：deck 的页走这条，文本文件走改正文那条', () => {
    assert.ok(RV.includes('if (live) queueSlide(page, t);'));
    assert.match(RV, /window\.kiroApi\.deckReviseSlideText\?\./);
    /* 改不了时交给会话 —— 那种意见确实需要它自己动手 */
    assert.ok(RV.includes('（KiroLex 当场改不了这一条：${res.cannot}）'));
  });
});
