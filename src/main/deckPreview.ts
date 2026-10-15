/**
 * `.pptx` → **一个 PDF**，交给内置查看器显示 —— 判据是纯的，spawn 由调用方注入。
 *
 * ## 为什么是 PDF，而不是每页一张 PNG
 *
 * 第一版做的是逐页 PNG。「pdf 化是不是更好一些」—— 是，而且我原来"不做 PDF"的理由（iframe 里没法在页上
 * 叠评论框）站不住：**评论不必叠在页上**，摆在 PDF 下面一排「第 N 页 💬」同样能逐页提意见。
 *
 * 换过来省掉/换来的东西：
 *
 *   · **少一半依赖** —— PNG 那条要 `pptx → PDF → 切图`，切图还得有 `pdftoppm` 或 PyMuPDF。PDF 只要第一步。
 *   · **查看体验好得多** —— Chromium 自带 PDF 查看器：滚动、缩放、**选字、Cmd+F 搜索**。一列 PNG 三样都没有。
 *   · **缓存小** —— 一个 PDF 对十几张图。
 *   · **`.pdf` 文件本身也能预览了** —— 它现在也是被甩给系统应用的，这次顺带收进来。
 *
 * 让掉的只有"评论框紧贴那一页"这一点直观性。
 *
 * ## 为什么还是必须有 LibreOffice（macOS）
 *
 * 转 PDF 那一步要一个会**排版 pptx** 的程序，而这台机器上别的都实测过、都不行：
 *
 *   · **Keynote**：`osascript` 打开 `.pptx` 会先弹导入提示，没人点它 —— 实测 120 秒零输出、进程挂着。
 *     表现成"超时"，而真正的原因是一个看不见的对话框。
 *   · **PowerPoint**：沙盒。`open POSIX file /tmp/…` 静默失败，`save … as save as PDF` 返回 rc=0 却一个字节
 *     都不写；而且它通常开着**用户自己的**文档，脚本一不小心就在动它。
 *   · **`python-pptx`**：不渲染，只给 XML 里的形状和文字。
 *   · **`qlmanage`**：只出第一页缩略图。
 *
 * **Windows 上**：PowerPoint 不是沙盒的，COM 自动化（`Presentation.ExportAsFixedFormat`）本来是最标准的
 * 一条。这里**刻意还是只认 LibreOffice** —— 一条没在真机上跑过的 COM 分支比不写更危险（它会看着像已经
 * 支持了），而 LibreOffice 在两个平台上是同一条命令、同一套判据。Windows 只是多了几个常见的安装位置
 * （`Program Files` / `Program Files (x86)`），以及 PATH 要用 `where` 而不是 `command -v` 去找。
 */

import { tr, uiLang } from './uiText.ts';

/**
 * LibreOffice 的常规落点 —— **PATH 里通常没有它**，两个平台都是。
 *
 * 实测（macOS）：从 dmg 装完之后 `which soffice` 找不到（dmg 安装不放软链，`brew --cask` 也不放）。
 * Windows 的安装包同样不改 PATH。只按 PATH 探测的话，一台**装好了**的机器仍然会被判成"没有转换器" ——
 * 而那种错最气人：你照提示装了，它还说你没装。
 *
 * 所以探测要同时看 PATH 和这些固定位置。两个平台的都列在这里：判据只是"这个文件在不在"，
 * 在另一个平台上它们自然都不在，不需要按平台分叉。
 */
export const SOFFICE_BUNDLE_PATHS = [
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/Applications/OpenOffice.app/Contents/MacOS/soffice',
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
];

/** PATH 上找哪几个名字。Windows 上 `where` 会自己补 `.exe`。 */
export const SOFFICE_PATH_NAMES = ['soffice', 'libreoffice'];

/** 这台机器上探测到的东西。调用方探测，这里只做选择。 */
export interface ConvertTools {
  /** `soffice` / `libreoffice` 在 PATH 里，**或者**固定安装位置里那个二进制存在 —— 唯一真正必须的那个 */
  soffice?: boolean;
  /** Keynote.app 在不在。探测但**永远不会被选中**，理由见文件头。 */
  keynote?: boolean;
}

export type ConverterChoice = 'soffice' | null;

/**
 * 用什么转 PDF —— PURE。只认 LibreOffice（为什么见文件头）。
 */
export function pickConverter(tools: ConvertTools | null | undefined): ConverterChoice {
  return tools?.soffice ? 'soffice' : null;
}

/** 用哪个可执行文件转 —— PATH 里那个优先，其次固定安装位置。找不到返回 null。 */
export function sofficeBinary(
  inPath: string | null | undefined,
  exists: (p: string) => boolean,
): string | null {
  const onPath = String(inPath || '').trim();
  if (onPath) return onPath;
  return SOFFICE_BUNDLE_PATHS.find((p) => exists(p)) || null;
}

/**
 * PATH 上探测用的那条命令 —— PURE。
 *
 * Windows 没有 `command -v`（cmd.exe 里它是"找不到命令"，于是**每台** Windows 都被判成没装）。
 * `where` 找到时把完整路径一行一个打出来，取第一行就是能直接 spawn 的那个。
 */
export function pathProbeCommand(name: string, platform: string): string {
  return platform === 'win32' ? `where ${name}` : `command -v ${name}`;
}

/** `where` / `command -v` 的输出 → 第一个路径（没有就 null）。 */
export function firstProbeHit(stdout: string | null | undefined): string | null {
  const line = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return line || null;
}

/** 装 LibreOffice 的命令 —— 单独拿出来是为了让界面能给一个**一键复制**，而不是让你从一段话里选中它。 */
export function installConverterCmd(platform: string): string {
  if (platform === 'win32') return 'winget install --id TheDocumentFoundation.LibreOffice -e';
  if (platform === 'darwin') return 'brew install --cask libreoffice';
  return 'sudo apt install libreoffice';
}

/**
 * 转不了时说给人听的话 —— PURE。
 *
 * 「如果电脑上没有是不是应该给个提示之类的？」—— 有，就是这一段。要点名**找过哪里**、
 * **缺的怎么装**、以及**在此之前还能干什么**：少任何一条，"打不开"就是条死路。
 * 命令本身不拼进这段话 —— 界面单独渲染它并配一个复制按钮（见 `installConverterCmd`）。
 */
export function noConverterWhy(opts: { platform: string; looked?: string[]; ext?: string }): string {
  const ext = String(opts.ext || '').replace(/^\./, '').toLowerCase() || 'pptx';
  const looked = (opts.looked && opts.looked.length ? opts.looked : [
    ...SOFFICE_PATH_NAMES.map((n) => tr('{name} on PATH', { name: n })),
    ...SOFFICE_BUNDLE_PATHS,
  ]);
  const where = opts.platform === 'win32'
    ? tr('download it from https://www.libreoffice.org/download/ (installs to C:\\Program Files\\LibreOffice by default), or use the winget command below')
    : opts.platform === 'darwin'
      ? tr('download it from https://www.libreoffice.org/download/, or use the brew command below')
      : tr("install it with your system's package manager (the command below), or download it from https://www.libreoffice.org/download/");
  return tr("LibreOffice isn't installed on this machine, so the .{ext} file can't be converted to PDF and can't be previewed here yet.", { ext }) + '\n\n'
    + tr('Just install LibreOffice: {where}. Afterwards, come back and click "⟳ Refresh" or reopen the file; no need to restart KiroLex.', { where }) + '\n\n'
    + tr('Places checked:') + `\n${looked.map((l) => `  · ${l}`).join('\n')}\n\n`
    + tr('Meanwhile: "↗ Open file" in the top bar opens it in the default app; .pdf files don\'t need LibreOffice and preview here as usual.');
}

/**
 * 跑 python-pptx 那几段脚本用哪个解释器 —— PURE，按平台给候选，调用方依次探测。
 *
 * macOS / Linux 上是 `python3`；**Windows 上通常没有 `python3`**（Microsoft Store 那个占位符会弹商店，
 * 或者干脆不存在），装的是 `python` 或者启动器 `py -3`。只认 `python3` 的话，Windows 上所有讲稿/改字
 * 功能都会以一句看不懂的 ENOENT 失败。
 */
export function pythonCandidates(platform: string): Array<{ cmd: string; args: string[] }> {
  if (platform === 'win32') {
    return [{ cmd: 'python', args: [] }, { cmd: 'py', args: ['-3'] }, { cmd: 'python3', args: [] }];
  }
  return [{ cmd: 'python3', args: [] }, { cmd: 'python', args: [] }];
}

/** 探测一个解释器能不能用 python-pptx 的那一句。 */
export const PPTX_PROBE_SCRIPT = 'import pptx;print("ok")';

/**
 * 子进程要带的环境 —— **Windows 上不加这两个，中文必坏**。
 *
 * Windows 上 Python 的管道 stdin/stdout 用的是 ANSI 代码页（中文系统是 cp936），而 Node 这边按 UTF-8
 * 读写：讲稿从 stdin 进去就是乱码，`print(json.dumps(..., ensure_ascii=False))` 碰到 GBK 里没有的字符
 * 直接 `UnicodeEncodeError`。`PYTHONUTF8=1` + `PYTHONIOENCODING=utf-8` 把两头都钉成 UTF-8；
 * 在 macOS 上它们本来就是这个值，加了也无害。
 */
export function pythonEnv(base: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...base, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
}

/** 没有可用的 python-pptx 时说给人听的话 —— 预览照样能看，只是讲稿那一列和"当场改字"用不了。 */
export function noPythonPptxWhy(platform: string): string {
  const py = platform === 'win32' ? 'python' : 'python3';
  return tr('Speaker notes and "edit slide text in place" need Python 3 + python-pptx, which wasn\'t found on this machine.')
    + tr(' Install it: `{py} -m pip install python-pptx` (no Python? Get it from https://www.python.org/downloads/ first).', { py })
    + tr(' Preview and per-slide comments still work; comments can still be sent to the session via "Session for this file", which makes the edits itself.');
}

/**
 * 缓存目录的 key —— PURE。
 *
 * `路径 + mtime + 大小` 一起进 key，不是只用路径：deck 改过一版之后必须重转，而"文件变了没有"最便宜的
 * 判据就是这两个。只用路径的话，你改完 PPT 再点开看到的还是旧的 —— 而那种错**看不出来**，
 * 你会以为改动没生效。
 *
 * ## 为什么还要一个版本号
 *
 * 源文件没变，但**转出来的东西变了**：这台机器上 LibreOffice 原来一个中日韩字形都画不出来
 * （它不扫 `~/Library/Fonts`，只认自己 bundle 里那个字体目录），转出来的 PDF 中文整段消失 ——
 * 文本层是对的，只是没有字形可画，所以既不报错也搜得到字，光看缓存判断不出它是坏的。
 * 补上字体之后旧缓存必须失效，而 mtime 和大小都没变。以后任何影响转换结果的改动都该把这个号 +1。
 */
export const PREVIEW_FORMAT_VERSION = 2;

/**
 * 缓存 key —— PURE。
 *
 * ## 为什么不是"只哈希影响 PDF 的那些 part"
 *
 * 「为什么 ppt 一页变化需要整个重新导？」改一句讲稿会改 mtime 和大小，于是 key 失效、十四页白重转一次
 * —— 而讲稿根本不进 PDF（`--convert-to pdf` 导出的是幻灯片本体）。
 *
 * 我试过把 key 换成"排除 `ppt/notesSlides/**` 之后各 part 的 CRC"，**不成立**：`python-pptx` 的
 * `save()` 是整包重新序列化，slide 那些 part 的 CRC 也全变了 —— 实测改第 3 页备注，那个指纹
 * `1e74edb6…` → `ae47df71…`。语义没变而字节变了，哈希看不出区别。**这条路别再试第二遍。**
 *
 * 所以走另一条：**知道"只有讲稿变了"的那个人自己把缓存搬过去** —— `deck:write-note` 在写之前算旧 key、
 * 写之后算新 key，把那份 PDF 复制到新 key 下面。判断不用猜，因为那次改动就是它做的。
 */
export function previewKey(
  file: { path: string; mtimeMs: number; size: number },
  hash: (text: string) => string,
): string {
  return hash(`v${PREVIEW_FORMAT_VERSION} ${file.path} ${Math.round(file.mtimeMs)} ${file.size}`);
}

/*
  页数**不再靠 PyMuPDF 数** —— 原来有一段 `import fitz` 的 python 专门数页，拿不到就没有逐页评论。
  pdf.js 打开文档就有 `numPages`（`PdfView.onPages`），所以那条依赖整个去掉了：Windows 上本来就少有人装它。
*/

/**
 * 要先过 LibreOffice 转成 PDF 的那些 —— 演示文稿和文字文档。
 *
 * 表格（xlsx/ods）刻意不在里面：它们转成 PDF 是按打印分页切的，一张宽表被切成几十页碎片，比交给
 * 系统应用打开糟得多。`.key`（Keynote）LibreOffice 只能读个大概，也不收。
 */
export const CONVERTIBLE_EXTS = ['pptx', 'ppt', 'ppsx', 'pps', 'odp', 'docx', 'doc', 'odt', 'rtf'];

function extOf(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(path || '').trim());
  return m ? m[1].toLowerCase() : '';
}

/** 这个文件用不用转 —— `.pdf` 直接看，其余（`CONVERTIBLE_EXTS`）要先过 LibreOffice。 */
export function needsConversion(path: string): boolean {
  return CONVERTIBLE_EXTS.includes(extOf(path));
}

/** 内置查看器认不认这个文件（转完之后都是 PDF）。 */
export function isPreviewable(path: string): boolean {
  return extOf(path) === 'pdf' || needsConversion(path);
}

/**
 * 讲稿 / 改字 / 动版面这几条**写**的路只对 `.pptx` 开 —— python-pptx 只认 OOXML。
 * `.ppt`（老的二进制格式）、`.odp`、文档类都只能看、逐页提意见、整体提交给会话。
 */
export function canEditDeck(path: string): boolean {
  return extOf(path) === 'pptx';
}

/**
 * 抽每页的**演讲者备注** —— 那段 python，只读不写。
 *
 * 「你也应该把每页 note 抽取出来和 pdf 一起 review」。备注是讲稿：一份 deck 的图上只有几个词，
 * 真正要审的话术全在 notes 里（实测 Stripe 那份 v2 每页 600 字左右，14 页全有）。而 PDF 里**看不到它们**
 * —— `--convert-to pdf` 导出的是幻灯片本体，不含备注。
 *
 * 用 `python-pptx` 而不是自己解 XML：备注在 `notesSlide` 里，位置和继承关系有一堆边界，
 * 而这个库正是为读这些东西写的。它**不渲染**，所以只能干这件事 —— 恰好也只需要它干这件事。
 *
 * 空字符串表示"这一页没写备注"，不是失败 —— 调用方据此决定要不要显示那一格。
 */
export const NOTES_SCRIPT = [
  'import sys, json, zipfile, hashlib',
  'from pptx import Presentation',
  'p = Presentation(sys.argv[1])',
  'out = []',
  'for s in p.slides:',
  '    t = ""',
  '    if s.has_notes_slide and s.notes_slide.notes_text_frame is not None:',
  '        t = (s.notes_slide.notes_text_frame.text or "").strip()',
  '    out.append(t)',
  /*
    顺手算一个**只认"会影响 PDF 的那些 part"**的指纹 —— 见 `previewKey`。
    `ppt/notesSlides/**` 排除在外：讲稿不进 PDF，改它不该让十四页重转一次。
    用 zip 里现成的 CRC，不读内容 —— 一次遍历中央目录就够。
  */
  'z = zipfile.ZipFile(sys.argv[1])',
  'parts = [(i.filename, i.CRC) for i in z.infolist() if not i.filename.startswith("ppt/notesSlides/")]',
  'parts.sort()',
  'stamp = hashlib.sha1(repr(parts).encode()).hexdigest()',
  'print(json.dumps({"notes": out, "visual": stamp}, ensure_ascii=False))',
].join('\n');

/**
 * **改一页的演讲者备注** —— 那段 python，一页一个 XML part。
 *
 * 「你觉得整份重导设计合理吗，为什么不能分页处理」—— 不合理，所以这里按页改。`.pptx` 是一堆 XML part
 * 的 zip（`ppt/slides/slideN.xml`、`ppt/notesSlides/notesSlideN.xml`），编辑单位天然是一页；
 * 而抽备注用的 `python-pptx` 本来就能写：`notes_text_frame.text = …` 然后 `save()`。
 *
 * 关键的收益是**没有任何重排**：改的只有你说的那一页的讲稿，模型碰不到版面。
 * 让它重导整份最糟的不是慢，是它会把你已经看过的十三页重新排一遍（模型每次落笔都不一样）——
 * 这和门上那条「按照 comment 修改」被砍掉是同一个理由：改一句话不该让你重看全部。
 *
 * **但要说准一件事**：`save()` 是**整包重新序列化**，不是只重写那一个 part。实测（14 页那份 Stripe deck，
 * 改第 3 页备注）：141 个 part 数量不变、一个都没丢、8 个媒体文件字节完全一致、每页形状数一致、
 * 十四页的版面文字逐页比对全部相同 —— 只有第 3 页的备注变了。也就是说**语义是按页的**，
 * 而字节层面有一批 part 被重写（属性顺序、空白之类）。风险低但不是零（python-pptx 不认识的东西按原样搬），
 * 所以调用方写前必须留一份二进制备份。
 *
 * 新文本走 **stdin**，不走 argv：讲稿动辄六百字、带引号和换行，塞进命令行参数迟早在某个字符上翻车。
 * 写完顺手把**所有**页的备注重抽一遍返回 —— 界面要的是新的那一份，而重抽一次实测不到一秒。
 * 这一页原来没有备注也行：`s.notes_slide` 会替它建一个。
 */
export const WRITE_NOTE_SCRIPT = [
  'import sys, json',
  'from pptx import Presentation',
  'path = sys.argv[1]',
  'idx = int(sys.argv[2]) - 1',
  'text = sys.stdin.read()',
  'p = Presentation(path)',
  'slides = list(p.slides)',
  'if idx < 0 or idx >= len(slides):',
  '    print(json.dumps({"ok": False, "error": "页码超出范围"})); sys.exit(0)',
  'slides[idx].notes_slide.notes_text_frame.text = text',
  'p.save(path)',
  'out = []',
  'for s in Presentation(path).slides:',
  '    t = ""',
  '    if s.has_notes_slide and s.notes_slide.notes_text_frame is not None:',
  '        t = (s.notes_slide.notes_text_frame.text or "").strip()',
  '    out.append(t)',
  'print(json.dumps({"ok": True, "notes": out}, ensure_ascii=False))',
].join('\n');

/**
 * 读一页**幻灯片上的文字** —— 按 run 寻址，那段 python。
 *
 * 「现在就做一个工具吧」：让模型每次现写 python-pptx 代码的代价量过 —— 九次 `python3` 每次跑
 * 0.3–1.1 秒，而**相邻两次之间等模型 20–45 秒**，四分多钟里工具只占 6 秒。把"改第 N 页的字"变成
 * 一个工具之后，编辑这一步是**零往返**：模型只出文本，不写代码（备注那条就是这么从几分钟变成 10–17 秒的）。
 *
 * ## 为什么按 run，不按段
 *
 * 设成 `text_frame.text` 或 `paragraph` 级替换会**把 run 级格式碾平**（一段里的加粗、变色、不同字号
 * 全变成第一个 run 的样子）—— 对一份做过设计的客户 deck 那是毁掉它。只改 `run.text` 则一个字节的格式
 * 都不动。
 *
 * 这么做的前提量过：这份 deck 509 段 / 382 run，**平均每段 0.75 个 run** —— 也就是绝大多数段就是一个
 * run（空段 0 个）。所以"按 run 寻址"和"按段编辑"在实际文档里几乎是同一件事，而它多保住了格式。
 *
 * 地址是 `形状.段.run`（都从 0 起）。空 run 不列出来 —— 那些是排版占位，改不了也不该改。
 */
export const SLIDE_TEXT_SCRIPT = [
  'import sys, json',
  'from pptx import Presentation',
  'from pptx.util import Emu',
  'p = Presentation(sys.argv[1])',
  'idx = int(sys.argv[2]) - 1',
  'slides = list(p.slides)',
  'if idx < 0 or idx >= len(slides):',
  '    print(json.dumps({"ok": False, "error": "页码超出范围"})); sys.exit(0)',
  'out = []',
  /*
    **形状表也一起给** —— 「所以我甚至不能让 comment 添加或者修改页面上的文本框吗」。
    只给 run 的话，模型能改的就只有"已经存在的那几个字"：加一个框要有落点、删一个框要有编号、
    挪一个框要知道它现在在哪。位置用**厘米**（一页宽 25.4cm）而不是 EMU：EMU 是 914400 分之一英寸，
    让模型拿那种数字算版面，它算不准，而厘米它有直觉。
  */
  'shapes = []',
  'W = Emu(p.slide_width).cm',
  'H = Emu(p.slide_height).cm',
  'for si, sh in enumerate(slides[idx].shapes):',
  '    try:',
  '        geo = {"l": round(Emu(sh.left).cm, 2), "t": round(Emu(sh.top).cm, 2),',
  '               "w": round(Emu(sh.width).cm, 2), "h": round(Emu(sh.height).cm, 2)}',
  '    except Exception:',
  '        geo = {}',
  '    kind = "text" if sh.has_text_frame else ("picture" if sh.shape_type == 13 else str(sh.shape_type))',
  '    preview = (sh.text_frame.text or "")[:40] if sh.has_text_frame else ""',
  '    shapes.append(dict({"i": si, "name": sh.name, "kind": kind, "text": preview}, **geo))',
  /*
    **每一条也带上格式** ——「这个页面中怎么有大 bullet 有小 bullet，统一下格式，kirolex 处理不了？」

    之前只给"地址 + 文字"，于是"统一格式"这类意见模型**无从判断**：哪一行大、哪一行小、
    谁是真项目符号谁是手打的字符，它一个都看不见，只能猜或者回一句改不了。
    实测那一页 12 个 bullet 全是手打进正文的 `●`（U+25CF）、10.5pt、PingFang SC、`lvl=0`，
    根本没用真正的项目符号 —— 这种事只有把 `size/font/lvl/bullet` 摆出来它才说得清。

    `bullet` 三种值：`char:●`（真项目符号）/ `none`（明确关掉）/ `-`（没设，跟版式走）。
  */
  'NS = "{http://schemas.openxmlformats.org/drawingml/2006/main}"',
  'def bullet_of(para):',
  '    pPr = para._p.find(NS + "pPr")',
  '    if pPr is None:',
  '        return "-"',
  '    if pPr.find(NS + "buNone") is not None:',
  '        return "none"',
  '    bc = pPr.find(NS + "buChar")',
  '    if bc is not None:',
  '        return "char:" + (bc.get("char") or "?")',
  '    if pPr.find(NS + "buAutoNum") is not None:',
  '        return "num"',
  '    return "-"',
  'for si, sh in enumerate(slides[idx].shapes):',
  '    if not sh.has_text_frame:',
  '        continue',
  '    for pi, para in enumerate(sh.text_frame.paragraphs):',
  '        bu = bullet_of(para)',
  '        for ri, run in enumerate(para.runs):',
  '            t = run.text or ""',
  '            if not t.strip():',
  '                continue',
  '            row = {"at": "%d.%d.%d" % (si, pi, ri), "text": t, "lvl": para.level, "bullet": bu}',
  '            try:',
  '                if run.font.size is not None: row["pt"] = round(run.font.size.pt, 1)',
  '            except Exception: pass',
  '            try:',
  '                if run.font.name: row["font"] = run.font.name',
  '            except Exception: pass',
  '            try:',
  '                if run.font.bold: row["bold"] = True',
  '            except Exception: pass',
  '            out.append(row)',
  'print(json.dumps({"ok": True, "runs": out, "shapes": shapes, "page": {"w": round(W, 2), "h": round(H, 2)}}, ensure_ascii=False))',
].join('\n');

/**
 * **动版面**：删一个形状、加一个文本框、挪/缩一个形状 —— 「所以我甚至不能让 comment 添加或者
 * 修改页面上的文本框吗，WTF」。
 *
 * 之前这条当场生效的路只会**替换已有 run 的文字**，所以"把这个空框删掉"、"这儿加一句"都只能回
 * `CANNOT-REVISE-LOCALLY`，然后走提交那条（会话自己写 python，实测 2–4 分钟）。而这三件事
 * python-pptx 各自只有一两行 —— 实测过：删形状 `sh._element.getparent().remove(sh._element)`、
 * 加框 `shapes.add_textbox`、挪框改 `left/top/width/height`。
 *
 * 指令走 **stdin 的 JSON**（一行一条），不走 argv：文本里有引号、换行、中文，拼命令行迟早在某个
 * 字符上翻车（`WRITE_NOTE_SCRIPT` 已经吃过这个教训）。
 *
 * 新框的字**照抄一个参考 run**（`like`）：不抄的话它是 18pt 黑色宋体，在一份定过样式的 deck 上
 * 一眼就是补丁。抄不到就随它默认 —— 宁可字不对，也不要因为一个颜色抄不动就整条指令失败。
 *
 * **删除按下标从大到小执行**：删一个之后后面的 index 全变，从小往大删第二条就删错对象了。
 */
export const SLIDE_OPS_SCRIPT = [
  'import sys, json',
  'from pptx import Presentation',
  'from pptx.util import Cm, Pt',
  'NS = "{http://schemas.openxmlformats.org/drawingml/2006/main}"',
  'path = sys.argv[1]',
  'idx = int(sys.argv[2]) - 1',
  'ops = []',
  'for line in sys.stdin.read().split("\\n"):',
  '    line = line.strip()',
  '    if not line:',
  '        continue',
  '    try:',
  '        ops.append(json.loads(line))',
  '    except Exception:',
  '        pass',
  'p = Presentation(path)',
  'slides = list(p.slides)',
  'if idx < 0 or idx >= len(slides):',
  '    print(json.dumps({"ok": False, "error": "页码超出范围"})); sys.exit(0)',
  'slide = slides[idx]',
  'done = 0',
  'errs = []',
  'def ref_run(addr):',
  '    try:',
  '        si, pi, ri = [int(x) for x in str(addr).split(".")]',
  '        return list(slide.shapes)[si].text_frame.paragraphs[pi].runs[ri]',
  '    except Exception:',
  '        return None',
  /* 加和挪先做（下标还是模型看到的那一套），删最后做、从大到小 */
  'for op in [o for o in ops if o.get("op") == "add-text"]:',
  '    try:',
  '        tb = slide.shapes.add_textbox(Cm(float(op["l"])), Cm(float(op["t"])), Cm(float(op["w"])), Cm(float(op["h"])))',
  '        tf = tb.text_frame',
  '        tf.word_wrap = True',
  '        r = tf.paragraphs[0].add_run()',
  '        r.text = str(op.get("text") or "")',
  '        ref = ref_run(op.get("like"))',
  '        if ref is not None:',
  '            try: r.font.size = ref.font.size',
  '            except Exception: pass',
  '            try: r.font.bold = ref.font.bold',
  '            except Exception: pass',
  '            try: r.font.name = ref.font.name',
  '            except Exception: pass',
  '            try:',
  '                if ref.font.color is not None and ref.font.color.type is not None:',
  '                    r.font.color.rgb = ref.font.color.rgb',
  '            except Exception: pass',
  '        done += 1',
  '    except Exception as e:',
  '        errs.append("add-text: %s" % e)',
  /*
    **挪之前先把四个值都读出来，然后四个都写回去** —— 实测踩到的坑：占位符（Title/Subtitle）的
    几何是从版式**继承**的，只写 `left/top/width` 会让 python-pptx 落一个显式的 `<a:ext>`，
    而没给的那个（这里是 `cy`）被写成 **0** —— 那一页的标题当场变成 0 厘米高。
    所以缺的那几个用它现在的有效值补上；读不到就那一项不动。
  */
  'for op in [o for o in ops if o.get("op") == "move"]:',
  '    try:',
  '        sh = list(slide.shapes)[int(op["i"])]',
  '        cur = {}',
  '        for k, attr in (("l", "left"), ("t", "top"), ("w", "width"), ("h", "height")):',
  '            try: cur[k] = getattr(sh, attr)',
  '            except Exception: cur[k] = None',
  '        for k, attr in (("l", "left"), ("t", "top"), ("w", "width"), ("h", "height")):',
  '            if op.get(k) is not None:',
  '                setattr(sh, attr, Cm(float(op[k])))',
  '            elif cur[k] is not None:',
  '                setattr(sh, attr, cur[k])',
  '        done += 1',
  '    except Exception as e:',
  '        errs.append("move: %s" % e)',
  /*
    **改字号 / 改项目符号 / 改缩进层级** ——「怎么有大 bullet 有小 bullet，统一下格式」。
    
    这三样都是"格式"，不是文字：改字号是 run 上的 `sz`，项目符号和层级是**段落**上的
    （`a:pPr` 的 `buChar` / `buNone` 和 `lvl`）。python-pptx 只给了 `para.level`，
    buChar 得自己动 XML —— 所以这里直接操作 `pPr`：先把已有的 `buChar/buNone/buAutoNum` 清掉，
    再按要的那种插一个（**顺序有讲究**：`a:pPr` 的子元素在 schema 里是有序的，`buChar` 要放在末尾
    那一组里，插错位置 PowerPoint 会拒绝打开）。
    
    `set-size` 收的是**run 地址**（`形状.段.run`），另两个收**段地址**（`形状.段`）——
    字号是逐 run 的（一行里可以半句大半句小），项目符号是整段的。
  */
  'def pPr_of(para):',
  '    pPr = para._p.find(NS + "pPr")',
  '    if pPr is None:',
  '        pPr = para._p.makeelement(NS + "pPr", {})',
  '        para._p.insert(0, pPr)',
  '    return pPr',
  'for op in [o for o in ops if o.get("op") == "set-size"]:',
  '    try:',
  '        si, pi, ri = [int(x) for x in str(op["at"]).split(".")]',
  '        list(slide.shapes)[si].text_frame.paragraphs[pi].runs[ri].font.size = Pt(float(op["pt"]))',
  '        done += 1',
  '    except Exception as e:',
  '        errs.append("set-size %s: %s" % (op.get("at"), e))',
  'for op in [o for o in ops if o.get("op") == "set-bullet"]:',
  '    try:',
  '        si, pi = [int(x) for x in str(op["at"]).split(".")[:2]]',
  '        para = list(slide.shapes)[si].text_frame.paragraphs[pi]',
  '        pPr = pPr_of(para)',
  '        for tag in ("buChar", "buNone", "buAutoNum"):',
  '            for el in pPr.findall(NS + tag):',
  '                pPr.remove(el)',
  '        ch = str(op.get("char") or "")',
  '        if ch and ch != "none":',
  '            el = pPr.makeelement(NS + "buChar", {"char": ch[0]})',
  '        else:',
  '            el = pPr.makeelement(NS + "buNone", {})',
  '        pPr.append(el)',
  '        done += 1',
  '    except Exception as e:',
  '        errs.append("set-bullet %s: %s" % (op.get("at"), e))',
  'for op in [o for o in ops if o.get("op") == "set-level"]:',
  '    try:',
  '        si, pi = [int(x) for x in str(op["at"]).split(".")[:2]]',
  '        list(slide.shapes)[si].text_frame.paragraphs[pi].level = int(op["lvl"])',
  '        done += 1',
  '    except Exception as e:',
  '        errs.append("set-level %s: %s" % (op.get("at"), e))',
  'dels = sorted({int(o["i"]) for o in ops if o.get("op") == "delete-shape"}, reverse=True)',
  'for i in dels:',
  '    try:',
  '        sh = list(slide.shapes)[i]',
  '        sh._element.getparent().remove(sh._element)',
  '        done += 1',
  '    except Exception as e:',
  '        errs.append("delete-shape %d: %s" % (i, e))',
  'if done == 0:',
  '    print(json.dumps({"ok": False, "error": "一条都没做成：%s" % ("；".join(errs) or "指令都不认识")}, ensure_ascii=False)); sys.exit(0)',
  'p.save(path)',
  'out = []',
  'for si, sh in enumerate(list(Presentation(path).slides)[idx].shapes):',
  '    if not sh.has_text_frame:',
  '        continue',
  '    for pi, para in enumerate(sh.text_frame.paragraphs):',
  '        for ri, run in enumerate(para.runs):',
  '            t = run.text or ""',
  '            if t.strip():',
  '                out.append({"at": "%d.%d.%d" % (si, pi, ri), "text": t})',
  'print(json.dumps({"ok": True, "changed": done, "runs": out, "errors": errs}, ensure_ascii=False))',
].join('\n');

/**
 * 改一页**幻灯片上的文字** —— 按 run 地址逐个替换，那段 python。
 *
 * 改动走 **stdin**（一行一条 `形状.段.run<TAB>新文本`）：文字里带引号、逗号、换行都不影响。
 * 只改**点到名的那些 run**，别的一个字节不动 —— 这是"只改这条意见说的地方"在文件层面的落实。
 * 写完把这一页重读一遍返回，界面显示的是磁盘上那份，不是我们以为写进去的那份。
 */
export const WRITE_SLIDE_TEXT_SCRIPT = [
  'import sys, json',
  'from pptx import Presentation',
  'path = sys.argv[1]',
  'idx = int(sys.argv[2]) - 1',
  'edits = {}',
  'for line in sys.stdin.read().split("\\n"):',
  '    if "\\t" not in line:',
  '        continue',
  '    at, text = line.split("\\t", 1)',
  '    edits[at.strip()] = text',
  'p = Presentation(path)',
  'slides = list(p.slides)',
  'if idx < 0 or idx >= len(slides):',
  '    print(json.dumps({"ok": False, "error": "页码超出范围"})); sys.exit(0)',
  'hit = 0',
  'for si, sh in enumerate(slides[idx].shapes):',
  '    if not sh.has_text_frame:',
  '        continue',
  '    for pi, para in enumerate(sh.text_frame.paragraphs):',
  '        for ri, run in enumerate(para.runs):',
  '            key = "%d.%d.%d" % (si, pi, ri)',
  '            if key in edits:',
  '                run.text = edits[key]',
  '                hit += 1',
  'if hit == 0:',
  '    print(json.dumps({"ok": False, "error": "给的地址在这一页上都不存在"})); sys.exit(0)',
  'p.save(path)',
  'out = []',
  'for si, sh in enumerate(list(Presentation(path).slides)[idx].shapes):',
  '    if not sh.has_text_frame:',
  '        continue',
  '    for pi, para in enumerate(sh.text_frame.paragraphs):',
  '        for ri, run in enumerate(para.runs):',
  '            t = run.text or ""',
  '            if t.strip():',
  '                out.append({"at": "%d.%d.%d" % (si, pi, ri), "text": t})',
  'print(json.dumps({"ok": True, "changed": hit, "runs": out}, ensure_ascii=False))',
].join('\n');

/** 一个 run：地址 + 现在的文字。 */
export interface SlideRun { at: string; text: string }

/**
 * 上面两段脚本的输出 → run 列表 —— PURE。形状不对一律当失败：半截 JSON 说明那一步出了事，
 * 而这时当成功会让界面显示一页**并不在磁盘上**的文字。
 */
/** 一页上的一个形状 —— 加/删/挪框要用（编号、类型、当前位置大小、里面的字）。 */
export interface SlideShape {
  i: number; kind: string; name: string; text?: string;
  l?: number; t?: number; w?: number; h?: number;
}

/**
 * 上面那几段 python 脚本自己说的几句话是写死的中文（脚本本身有测试钉着，不在 python 里翻）——
 * 解析时按界面语言换掉。认不出的（python 异常原文等）原样返回。PURE（除了读当前界面语言）。
 */
export function localizeScriptError(raw: string): string {
  const msg = String(raw ?? '');
  if (msg === '页码超出范围') return tr('Page number out of range');
  if (msg === '给的地址在这一页上都不存在') return tr('None of the given addresses exist on this page');
  const none = /^一条都没做成：([\s\S]*)$/.exec(msg);
  if (none) {
    const detail = none[1] === '指令都不认识'
      ? tr('none of the instructions were recognized')
      : none[1].split('；').join(uiLang() === 'en' ? '; ' : '；');
    return tr('None of the edits went through: {detail}', { detail });
  }
  return msg;
}

export function parseSlideRuns(
  stdout: string | null | undefined,
): { ok: true; runs: SlideRun[]; changed?: number; shapes?: SlideShape[]; page?: { w: number; h: number } }
  | { ok: false; error: string } {
  try {
    const v = JSON.parse(String(stdout || ''));
    if (!v || typeof v !== 'object') return { ok: false, error: tr('The script returned no result') };
    if (v.ok !== true) return { ok: false, error: v.error ? localizeScriptError(String(v.error)) : tr('The script reported an error') };
    if (!Array.isArray(v.runs)) return { ok: false, error: tr('The script returned data in an unexpected shape') };
    const runs: SlideRun[] = [];
    for (const r of v.runs) {
      if (!r || typeof r.at !== 'string' || typeof r.text !== 'string') return { ok: false, error: tr('The script returned data in an unexpected shape') };
      runs.push({ at: r.at, text: r.text });
    }
    /*
      形状表和页面尺寸是**可选**的：写入那两个脚本只回 runs，而读的那个还会带形状 ——
      两边共用这一个解析器（那是有意的：runs 的形状必须只有一处判据），所以这两项缺了也算成功。
    */
    const shapes: SlideShape[] = Array.isArray(v.shapes)
      ? v.shapes.filter((sh: any) => sh && Number.isFinite(Number(sh.i))).map((sh: any) => ({
        i: Number(sh.i),
        kind: String(sh.kind || ''),
        name: String(sh.name || ''),
        ...(sh.text ? { text: String(sh.text) } : null),
        ...(Number.isFinite(Number(sh.l)) ? { l: Number(sh.l) } : null),
        ...(Number.isFinite(Number(sh.t)) ? { t: Number(sh.t) } : null),
        ...(Number.isFinite(Number(sh.w)) ? { w: Number(sh.w) } : null),
        ...(Number.isFinite(Number(sh.h)) ? { h: Number(sh.h) } : null),
      }))
      : [];
    const page = v.page && Number.isFinite(Number(v.page.w)) && Number.isFinite(Number(v.page.h))
      ? { w: Number(v.page.w), h: Number(v.page.h) }
      : undefined;
    return {
      ok: true, runs,
      ...(Number.isFinite(Number(v.changed)) ? { changed: Number(v.changed) } : null),
      ...(shapes.length ? { shapes } : null),
      ...(page ? { page } : null),
    };
  } catch { return { ok: false, error: tr("Couldn't parse the script output") }; }
}

/**
 * 那段写入脚本的输出 —— PURE。形状不对一律当失败：一份半截的 JSON 说明写盘那一步出了事，
 * 而这时把它当成功会让界面显示一份**并不在磁盘上**的备注。
 */
export function parseWriteNote(stdout: string | null | undefined): { ok: true; notes: string[] } | { ok: false; error: string } {
  try {
    const v = JSON.parse(String(stdout || ''));
    if (!v || typeof v !== 'object') return { ok: false, error: tr('The write script returned no result') };
    if (v.ok !== true) return { ok: false, error: v.error ? localizeScriptError(String(v.error)) : tr('The write script reported an error') };
    if (!Array.isArray(v.notes) || v.notes.some((x: any) => typeof x !== 'string')) {
      return { ok: false, error: tr('The write script returned notes in an unexpected shape') };
    }
    return { ok: true, notes: v.notes as string[] };
  } catch { return { ok: false, error: tr("Couldn't parse the write script output") }; }
}

/**
 * 那段 python 的输出 → 每页备注。拿不到就是 `null`（调用方据此不显示备注那一列）。
 *
 * 只在**确实是字符串数组**时才收：一个半截的 JSON 或者别的形状，宁可当成"没有备注"，
 * 也不要把垃圾摆进评审界面 —— 那会让人以为讲稿真的是那样。
 */
export function parseNotes(stdout: string | null | undefined): string[] | null {
  const parsed = parseNotesResult(stdout);
  return parsed ? parsed.notes : null;
}

/**
 * 那段 python 的输出 → 每页备注 —— PURE。
 *
 * 两种形状都收：裸数组（现在这版）和 `{notes}`（我试过在这里顺手带一个"视觉指纹"给缓存 key 用，
 * 那条路不成立 —— 见 `previewKey` 里的说明）。读不懂就当没有备注，比崩掉好。
 */
export function parseNotesResult(
  stdout: string | null | undefined,
): { notes: string[]; visual?: string } | null {
  try {
    const v = JSON.parse(String(stdout || ''));
    if (Array.isArray(v)) {
      return v.some((x) => typeof x !== 'string') ? null : { notes: v as string[] };
    }
    if (!v || typeof v !== 'object' || !Array.isArray(v.notes)) return null;
    if (v.notes.some((x: any) => typeof x !== 'string')) return null;
    return {
      notes: v.notes as string[],
      ...(typeof v.visual === 'string' && v.visual ? { visual: v.visual } : null),
    };
  } catch { return null; }
}
