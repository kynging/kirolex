import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  pickConverter, noConverterWhy, previewKey, needsConversion, isPreviewable, canEditDeck, CONVERTIBLE_EXTS,
  sofficeBinary, SOFFICE_BUNDLE_PATHS, SOFFICE_PATH_NAMES, pathProbeCommand, firstProbeHit, installConverterCmd,
  pythonCandidates, pythonEnv, noPythonPptxWhy, PPTX_PROBE_SCRIPT, NOTES_SCRIPT, parseNotes, parseNotesResult,
} from '../src/main/deckPreview.ts';

/**
 * 侧栏文件预览的 PDF / deck 那一半 —— 从 feature/flow 的 `deckPreview.test.ts` 改写。
 *
 * 那边的测试一大半钉的是 macOS 和 flow 里的接线（`acp:list-models` 前后的切片、门上的按钮）；这里留下
 * 判据本身，加上这条分支在 Windows 上要成立的那几条：转换器去哪儿找、找不到时说什么、python 叫什么、
 * 子进程的编码。
 */
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const MAIN = read('src/main/index.ts');
const deckHandler = (() => {
  const h = MAIN.slice(MAIN.indexOf("ipcMain.handle('preview:deck'"));
  return h.slice(0, h.indexOf("ipcMain.handle('preview:pdf-bytes'"));
})();

describe('LibreOffice 去哪儿找 —— Windows 和 macOS 都要认', () => {
  test('**Windows 的两个默认安装位置**都在候选里，macOS 那两个也还在', () => {
    assert.ok(SOFFICE_BUNDLE_PATHS.includes('C:\\Program Files\\LibreOffice\\program\\soffice.exe'));
    assert.ok(SOFFICE_BUNDLE_PATHS.includes('C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'));
    assert.ok(SOFFICE_BUNDLE_PATHS.includes('/Applications/LibreOffice.app/Contents/MacOS/soffice'));
    assert.ok(SOFFICE_BUNDLE_PATHS.includes('/Applications/OpenOffice.app/Contents/MacOS/soffice'));
    assert.deepEqual(SOFFICE_PATH_NAMES, ['soffice', 'libreoffice']);
  });

  test('PATH 上：Windows 用 `where`，别处用 `command -v` —— cmd.exe 里没有 command -v', () => {
    assert.equal(pathProbeCommand('soffice', 'win32'), 'where soffice');
    assert.equal(pathProbeCommand('soffice', 'darwin'), 'command -v soffice');
    assert.equal(pathProbeCommand('soffice', 'linux'), 'command -v soffice');
  });

  test('`where` 可能打出好几行（还是 CRLF）—— 取第一行', () => {
    assert.equal(firstProbeHit('C:\\LO\\program\\soffice.exe\r\nC:\\Other\\soffice.exe\r\n'), 'C:\\LO\\program\\soffice.exe');
    assert.equal(firstProbeHit(''), null);
    assert.equal(firstProbeHit('\r\n'), null);
  });

  test('PATH 里有就用它；没有就找固定安装位置；两处都没有才是真没有', () => {
    assert.equal(sofficeBinary('C:\\x\\soffice.exe', () => false), 'C:\\x\\soffice.exe');
    const win = 'C:\\Program Files\\LibreOffice\\program\\soffice.exe';
    assert.equal(sofficeBinary(null, (p) => p === win), win);
    assert.equal(sofficeBinary('', () => false), null);
    assert.equal(pickConverter({ soffice: true }), 'soffice');
    assert.equal(pickConverter({ soffice: false, keynote: true }), null, 'Keynote 永远不选');
    assert.equal(pickConverter(null), null);
  });

  test('接线：主进程按平台探测，PATH 和固定位置都看，候选只写在 deckPreview 里', () => {
    const at = MAIN.indexOf('const findSoffice = ');
    const fn = MAIN.slice(at, at + 1200);
    assert.match(fn, /pathProbeCommand\(name, process\.platform\)/);
    assert.match(fn, /looked\.push\(\.\.\.SOFFICE_BUNDLE_PATHS\)/);
    assert.doesNotMatch(MAIN, /Program Files\\\\LibreOffice/, '路径不在 index.ts 里再写一份');
  });
});

describe('没有 LibreOffice 时那句话', () => {
  const looked = ['PATH 上的 soffice（where）', 'C:\\Program Files\\LibreOffice\\program\\soffice.exe'];
  const why = noConverterWhy({ platform: 'win32', looked, ext: '.pptx' });

  test('说清**缺什么、去哪下、找过哪里、在此之前能干什么**', () => {
    assert.match(why, /没有 LibreOffice，没法把 \.pptx 转成 PDF/);
    assert.match(why, /https:\/\/www\.libreoffice\.org\/download\//);
    assert.match(why, /C:\\Program Files\\LibreOffice/);
    for (const l of looked) assert.ok(why.includes(l), `要列出找过的：${l}`);
    assert.match(why, /↗ 打开文件/);
    assert.match(why, /\.pdf 文件不需要 LibreOffice/);
    assert.match(why, /不用重启 KiroLex/);
  });

  test('扩展名跟着文件走（docx 也是这句话）；不给 looked 时列默认那几处', () => {
    assert.match(noConverterWhy({ platform: 'win32', ext: 'docx' }), /\.docx 转成 PDF/);
    const dflt = noConverterWhy({ platform: 'darwin' });
    for (const p of SOFFICE_BUNDLE_PATHS) assert.ok(dflt.includes(p));
  });

  test('安装命令单独给（界面配复制按钮），按平台', () => {
    assert.match(installConverterCmd('win32'), /^winget install .*LibreOffice/);
    assert.equal(installConverterCmd('darwin'), 'brew install --cask libreoffice');
    assert.match(installConverterCmd('linux'), /libreoffice/);
  });

  test('接线：IPC 把 why / install / noConverter 一起返回，界面显示原文 + 复制按钮', () => {
    assert.match(deckHandler, /why: noConverterWhy\(\{ platform: process\.platform, looked, ext: path\.extname\(file\) \}\),/);
    assert.match(deckHandler, /install: installConverterCmd\(process\.platform\),/);
    assert.match(deckHandler, /noConverter: true,/);
    const RV = read('src/renderer/components/ReviewPane.tsx');
    assert.match(RV, /<p className="rv-review-why">\{why\}<\/p>/);
    assert.match(RV, /navigator\.clipboard\?\.writeText\(install\)/);
    /* 没有转换器就别重试 —— 再转一次结果一样 */
    assert.match(RV, /if \(!cancelled && !got\.base64 && !got\.final\) got = await fetchDeck\(true\);/);
  });
});

describe('哪些文件走这条路', () => {
  test('`.pdf` 直接看（**不需要 LibreOffice**），演示和文字文档要先转', () => {
    assert.equal(needsConversion('/a/b.pdf'), false);
    assert.equal(isPreviewable('/a/b.pdf'), true);
    for (const e of ['pptx', 'PPT', 'odp', 'docx', 'doc', 'odt', 'rtf', 'ppsx']) {
      assert.equal(needsConversion(`/a/b.${e}`), true, e);
      assert.equal(isPreviewable(`C:\\x\\b.${e}`), true, e);
    }
  });

  test('表格不收 —— 按打印分页切成碎片，比交给系统应用糟', () => {
    for (const e of ['xlsx', 'xls', 'ods', 'csv', 'key', 'md']) assert.equal(isPreviewable(`/a/b.${e}`), false, e);
  });

  test('**只有 .pptx 能改**（讲稿 / 改字 / 动版面）—— python-pptx 只认 OOXML', () => {
    assert.equal(canEditDeck('/a/b.pptx'), true);
    for (const e of ['ppt', 'odp', 'pdf', 'docx']) assert.equal(canEditDeck(`/a/b.${e}`), false, e);
  });

  test('渲染层那张表和主进程这张一致 —— 多一个就卡在"转不了"，少一个就被甩给系统应用', () => {
    const RV = read('src/renderer/components/ReviewPane.tsx');
    const m = /export const DECK_EXTS = \[([^\]]*)\]/.exec(RV);
    assert.ok(m);
    const list = m![1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
    assert.deepEqual([...list].sort(), ['pdf', ...CONVERTIBLE_EXTS].sort());
  });

  test('`.pdf` 那条返回不经过转换、不探测 LibreOffice', () => {
    const at = deckHandler.indexOf('if (!needsConversion(file))');
    assert.ok(at > 0);
    assert.ok(at < deckHandler.indexOf('findSoffice()'));
    assert.match(deckHandler, /return \{ ok: true, pdf: file, pages: null, notes: null, pdfHash: pdfStamp\(file\), editable: false \};/);
  });
});

describe('python-pptx 在 Windows 上', () => {
  test('候选：Windows 是 python / py -3（通常没有 python3），别处 python3 优先', () => {
    assert.deepEqual(pythonCandidates('win32').map((c) => [c.cmd, ...c.args].join(' ')), ['python', 'py -3', 'python3']);
    assert.equal(pythonCandidates('darwin')[0].cmd, 'python3');
  });

  test('**子进程钉成 UTF-8** —— Windows 管道默认 cp936，中文讲稿进出都会坏', () => {
    const env = pythonEnv({ PATH: 'x' });
    assert.equal(env.PYTHONUTF8, '1');
    assert.equal(env.PYTHONIOENCODING, 'utf-8');
    assert.equal(env.PATH, 'x');
    /* 每一处 spawn python 都带它 */
    const at = MAIN.indexOf('const runPy = async');
    assert.match(MAIN.slice(at, at + 700), /env: pythonEnv\(process\.env\)/);
    const probe = MAIN.slice(MAIN.indexOf('const findPythonPptx = async'), MAIN.indexOf('const findPythonPptx = async') + 900);
    assert.match(probe, /env: pythonEnv\(process\.env\)/);
    assert.match(probe, /PPTX_PROBE_SCRIPT/);
    assert.match(PPTX_PROBE_SCRIPT, /import pptx/);
  });

  test('没有 python-pptx：预览照样能看，讲稿那一列说清为什么没有、怎么装', () => {
    assert.match(noPythonPptxWhy('win32'), /python -m pip install python-pptx/);
    assert.match(noPythonPptxWhy('darwin'), /python3 -m pip install python-pptx/);
    assert.match(noPythonPptxWhy('win32'), /预览和逐页意见不受影响/);
    assert.match(deckHandler, /notesWhy = err instanceof NoPythonPptx \? err\.message/);
    const RV = read('src/renderer/components/ReviewPane.tsx');
    assert.match(RV, /\{notesWhy && <p className="rv-review-hint">\{notesWhy\}<\/p>\}/);
  });

  test('找到了才缓存 —— 照提示装完，下一次打开就该能用，不用重启', () => {
    const fn = MAIN.slice(MAIN.indexOf('const findPythonPptx = async'), MAIN.indexOf('const findPythonPptx = async') + 900);
    assert.match(fn, /if \(pythonPptx\) return pythonPptx;/);
    assert.match(fn, /if \(ok\) \{ pythonPptx = c;/);
  });
});

describe('缓存 key 和缓存', () => {
  const h = (t: string) => t;
  test('mtime 或大小变了 key 就变；同一状态命中同一个 key', () => {
    const a = previewKey({ path: '/a.pptx', mtimeMs: 1, size: 10 }, h);
    assert.notEqual(a, previewKey({ path: '/a.pptx', mtimeMs: 2, size: 10 }, h));
    assert.notEqual(a, previewKey({ path: '/a.pptx', mtimeMs: 1, size: 11 }, h));
    assert.equal(a, previewKey({ path: '/a.pptx', mtimeMs: 1, size: 10 }, h));
  });

  test('命中条件是"能读且非空"；坏的扔掉；force 跳过；转到临时目录再原子改名', () => {
    assert.match(deckHandler, /fs\.existsSync\(cached\) && !force && usable\(cached\)/);
    assert.match(deckHandler, /fs\.openSync\(pdf, 'r'\)/);
    assert.match(deckHandler, /stale cache dropped/);
    assert.match(deckHandler, /const stage = `\$\{outDir\}\.partial-\$\{Date\.now\(\)\}`;/);
    assert.match(deckHandler, /fs\.renameSync\(stage, outDir\);/);
  });

  test('转完顺手清老的（key 里有 mtime，改一次就多一份）', () => {
    assert.match(deckHandler, /keepNewestIn\(previewsRoot, PREVIEW_CACHE_KEPT, '预览缓存'\);/);
  });
});

describe('每页讲稿', () => {
  test('正常输出解析成每页一条；空串是"这一页没写"，不是失败', () => {
    assert.deepEqual(parseNotes('["a","","c"]'), ['a', '', 'c']);
    assert.deepEqual(parseNotesResult('{"notes":["x"],"visual":"v"}'), { notes: ['x'], visual: 'v' });
  });

  test('形状不对宁可当没有', () => {
    for (const bad of ['', '["a"', '{"a":1}', '3', '[1,2]', null, undefined]) {
      assert.equal(parseNotes(bad as any), null, JSON.stringify(bad));
    }
  });

  test('那段 python 只读不写，输出不转义中文', () => {
    assert.match(NOTES_SCRIPT, /from pptx import Presentation/);
    assert.doesNotMatch(NOTES_SCRIPT, /\.save\(/);
    assert.match(NOTES_SCRIPT, /ensure_ascii=False/);
  });
});

describe('路径和闸门 —— 和文本那侧同一套', () => {
  test('预览按**主人会话**解析路径，并且记成这条会话读过', () => {
    assert.match(deckHandler, /file = resolveUserPath\(String\(rawPath\), sessionId\)/);
    assert.match(deckHandler, /markReviewed\(sessionId, file\);/);
  });

  test('PDF 字节只给预览缓存里的、或者这条会话读过的 .pdf', () => {
    const at = MAIN.indexOf("ipcMain.handle('preview:pdf-bytes'");
    const body = MAIN.slice(at, at + 1200);
    assert.match(body, /resolveUserPath\(String\(rawPath \|\| ''\), sessionId\)/);
    assert.match(body, /if \(!inCache && !wasReviewed\(sessionId, file\)\)/);
    assert.match(body, /base64: buf\.toString\('base64'\)/);
  });

  test('preload 把会话一路带过去', () => {
    const PRE = read('src/main/preload.ts');
    assert.match(PRE, /invoke\('preview:deck', sessionId, filePath, force\)/);
    assert.match(PRE, /invoke\('preview:pdf-bytes', sessionId, pdfPath\)/);
    assert.match(PRE, /invoke\('deck:write-note', sessionId, filePath, page, text, expect\)/);
  });
});

describe('查看器接线：PDF / deck 不再甩给系统应用', () => {
  const APP = read('src/renderer/App.tsx');

  test('两道门都放过 deck（读之前那张扩展名表 / 读之后 binary 那一支）', () => {
    assert.match(APP, /if \(needsSystemApp\(p\) && !isDeckPath\(p\)\) \{/);
    assert.match(APP, /if \(result\.binary && !result\.image && !isDeckPath\(p\)\) \{/);
  });

  test('deck 那一支排在 image / binary 前面，接的是主人会话', () => {
    const at = APP.indexOf('{isDeckPath(fileViewer.path) ? (');
    assert.ok(at > 0);
    assert.ok(at < APP.indexOf(') : fileViewer.image && fileViewer.dataUrl ? ('));
    const seg = APP.slice(at, at + 700);
    assert.match(seg, /sessionId=\{fileViewer\.ownerSessionId\}/);
    assert.match(seg, /changedAt=\{fileViewer\.changedAt\}/);
    assert.match(seg, /handleSendMessage\(prompt, undefined, fileViewer\.ownerSessionId\)/);
  });

  test('刷新（自动或 ⟳）推一下 changedAt —— deck 的预览靠它重取', () => {
    assert.match(APP, /setFileTabs\(\(prev\) => prev\.map\(\(t\) => \(t\.id === tabId \? \{ \.\.\.t, changedAt: Date\.now\(\) \} : t\)\)\);/);
  });
});

describe('PdfView：pdf.js 自己画，worker 打进包里', () => {
  const PDF = read('src/renderer/components/PdfView.tsx');

  test('worker 走 Vite 的 `?url` —— dev 和打包后同一个写法，不联网', () => {
    assert.match(PDF, /import workerUrl from 'pdfjs-dist\/build\/pdf\.worker\.min\.mjs\?url';/);
    assert.match(PDF, /GlobalWorkerOptions\.workerSrc = workerUrl;/);
    assert.ok(fs.existsSync(path.join(process.cwd(), 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs')));
    assert.match(read('src/renderer/vite-env.d.ts'), /reference types="vite\/client"/);
    assert.match(read('package.json'), /"pdfjs-dist": "\^4\.10\.38"/);
  });

  test('给 pdf.js 的是一份拷贝 —— 它会接管 buffer，原数组之后就空了', () => {
    assert.match(PDF, /getDocument\(\{ data: bytes\.slice\(\) \}\)/);
  });

  test('页数由 pdf.js 报，进视口才画，单页失败要说出来', () => {
    assert.match(PDF, /onPages\?\.\(d\.numPages\);/);
    assert.match(PDF, /new IntersectionObserver\(/);
    assert.match(PDF, /\{t\('Couldn\\'t render page \{index\}: \{why\}', \{ index, why: pageWhy \}\)\}/);
  });

  test('字节不走 file:// —— 渲染层拿主进程给的 base64', () => {
    const RV = read('src/renderer/components/ReviewPane.tsx');
    assert.match(RV, /window\.kiroApi\.previewPdfBytes\?\.\(sessionId, r\.pdf\)/);
    assert.match(RV, /const bin = atob\(got\.base64\);/);
    assert.doesNotMatch(RV, /file:\/\/\$\{|<iframe/);
  });
});
