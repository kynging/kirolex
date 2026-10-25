import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

/**
 * 对话列只有一个宽度。
 *
 * 用户反馈（2026-10-25）：会话里 KiroLex 的提示 / 卡片和对话消息宽度不一样 —— 消息 `width: 80%`、
 * 提示卡 `max-width: min(92%, 760px)`、权限条 / 卡死提示各写一份 `80%`，输入区里的提示条干脆没有宽度。
 * 宽窗口下提示卡比消息窄、窄窗口 / 分屏下又比消息宽，左边缘也对不齐。
 *
 * 现在 `.chat-main`（一格分屏，本身就是 `container-name: pane`）上定义 `--chat-col-width`，
 * 按这一格的宽度（cqw）算，所以不管元素挂在消息列表、输入区还是直接挂在 `.chat-main` 下面，
 * 算出来都是同一个宽度、同一条中线。这里扫 global.css：列出的这些类的宽度只能来自这个变量，
 * 嵌在它们里面的卡片只能 100% 填满；新加的卡片 / 提示条写回 `80%` 之类的百分比就失败。
 */
const CSS = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'renderer', 'styles', 'global.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

type Rule = { selector: string; body: string; at: string };

/** 叶子规则（含 @media / @container 里面的），带上外层 at-rule 头。 */
function rules(css: string, at = ''): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    const head = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    const inner = css.slice(open + 1, j - 1);
    if (head.startsWith('@')) out.push(...rules(inner, head));
    else out.push({ selector: head, body: inner, at });
    i = j;
  }
  return out;
}

const ALL = rules(CSS);

const WIDTH_PROPS = /(?:^|;|\s)((?:min-|max-)?(?:width|inline-size))\s*:\s*([^;]+)/g;

function widths(body: string): Array<[string, string]> {
  return [...body.matchAll(WIDTH_PROPS)].map((m) => [m[1], m[2].trim()]);
}

/** 选择器列表里每一项的「主体」（最后一个复合选择器）。 */
function subjects(selector: string): string[] {
  return selector.split(',').map((s) => s.trim().split(/\s*[\s>+~]\s*/).pop() ?? '');
}

function hasClass(compound: string, cls: string): boolean {
  return new RegExp(`\\.${cls}(?![\\w-])`).test(compound);
}

/** 直接排在对话列里的东西：宽度必须是 `var(--chat-col-width)`。 */
const COLUMN = [
  'message',                    // 对话消息（助手 / 用户整行；用户气泡在里面靠右、70%）
  'kirolex-message',            // KiroLex 提示卡、⏰ 定时卡、后台命令 / 监视卡、切换中卡片
  'stall-notice',               // 卡死提示
  'agent-activity',             // 正在用工具的那条
  'turn-panels',                // 末尾的计划 / 改动面板
  'interrupted-bar',            // 上一轮被打断
  'rebuild-pending-item',       // 重建历史中，结束后发送
  'permission-bar',             // 权限条（贴在输入框上沿）
  'session-notice',             // 输入框上方的会话提示条
  'mcp-unavailable-badge-wrap', // 输入框上方「N 个 MCP 不可用」
  'queue-stack',                // 排队卡片
  'attached-files',
  'prompt-suggestions',
  'chat-input-wrapper',
  'input-model-row',
  'composer',
  'composer-belowbar',
  'archived-composer-banner',
];

/** 嵌在对话列元素里的卡片：只能 100% 填满（或不写宽度），不另起一套。 */
const NESTED = [
  'kirolex-message-card',
  'schedule-card',
  'schedule-card-box',
  'bg-wake-card',
  'question-card',
  'message-turn-panels',
];

const OK_COLUMN = new Set(['var(--chat-col-width)']);
const OK_NESTED = new Set(['100%', 'auto', 'none']);

describe('对话列只有一个宽度变量', () => {
  test('变量定义在一格分屏（.chat-main，container pane）上，按这一格的宽度算', () => {
    const main = ALL.find((r) => r.selector === '.chat-main' && r.at === '');
    assert.ok(main, 'no .chat-main rule');
    assert.match(main!.body, /container-type:\s*inline-size/);
    assert.match(main!.body, /--chat-col-gutter:\s*\d+px/);
    const defs = ALL.filter((r) => /--chat-col-width\s*:/.test(r.body));
    assert.ok(defs.length >= 1, '--chat-col-width is never defined');
    for (const d of defs) {
      assert.ok(d.selector.startsWith('.chat-main'), `--chat-col-width defined outside the pane: ${d.selector}`);
      const value = /--chat-col-width\s*:\s*([^;]+)/.exec(d.body)![1];
      // 按 pane 宽度算（同一格里处处相同），并用 min(100%, …) 兜住：父容器再窄也不横向溢出
      assert.match(value, /cqw/, `${d.selector}: must be based on the pane width`);
      assert.match(value, /^min\(100%,/, `${d.selector}: must be capped at 100% of the parent`);
      assert.match(value, /var\(--chat-col-gutter\)/);
    }
  });

  test('窄的一格（≤900px）整列一起变宽，不是只把输入框改成 100%', () => {
    const narrow = ALL.filter((r) => /@container pane \(max-width: 900px\)/.test(r.at));
    assert.ok(narrow.some((r) => /--chat-col-width\s*:/.test(r.body)), 'no narrow-pane column width');
  });

  for (const cls of COLUMN) {
    test(`.${cls} 的宽度来自 --chat-col-width`, () => {
      const own = ALL.filter((r) => subjects(r.selector).some((s) => hasClass(s, cls)));
      assert.ok(own.length > 0, `no rule for .${cls}`);
      const declared = own.flatMap((r) => widths(r.body).map(([p, v]) => ({ r, p, v })));
      assert.ok(
        own.some((r) => !/:/.test(r.selector) && widths(r.body).some(([p, v]) => p === 'width' && OK_COLUMN.has(v))),
        `.${cls} never sets width: var(--chat-col-width)`);
      for (const { r, p, v } of declared) {
        assert.ok(OK_COLUMN.has(v) || OK_NESTED.has(v) && p !== 'width',
          `${r.at ? r.at + ' ' : ''}${r.selector} { ${p}: ${v} } — use var(--chat-col-width)`);
      }
    });
  }

  for (const cls of NESTED) {
    test(`.${cls} 只填满它所在的对话列元素`, () => {
      for (const r of ALL.filter((x) => subjects(x.selector).some((s) => hasClass(s, cls)))) {
        for (const [p, v] of widths(r.body)) {
          assert.ok(OK_NESTED.has(v), `${r.selector} { ${p}: ${v} } — nested cards fill their column item (100%)`);
        }
      }
    });
  }

  test('新加的卡片 / 提示条 / 横条没有自己写一份百分比宽度', () => {
    // 旧写法就是各抄一份 `width: 80%` / `max-width: min(92%, 760px)`：只要类名像卡片、提示条、
    // 横条、面板、栈，宽度又写成了 100% 以外的百分比，就是忘了接变量。
    const looksLikeColumnItem = /\.[\w-]+-(?:card|notice|bar|banner|panels|stack)(?![\w-])/;
    const bad: string[] = [];
    for (const r of ALL) {
      if (!subjects(r.selector).some((s) => looksLikeColumnItem.test(s))) continue;
      for (const [p, v] of widths(r.body)) {
        if (/\d%/.test(v) && v !== '100%') bad.push(`${r.selector} { ${p}: ${v} }`);
      }
    }
    assert.deepEqual(bad, []);
  });

  test('对话列里不再有硬编码的 80% / min(92%, 760px)', () => {
    const bad: string[] = [];
    for (const r of ALL) {
      if (!/chat-|message|composer|permission|notice|queue|turn-panels|agent-activity|rebuild-pending/.test(r.selector)) continue;
      // 用户那一侧（气泡 70%、没追加上的 steer）本来就窄一点、靠右，不在这里管
      if (subjects(r.selector).every((s) => /\.user|steer/.test(r.selector) || /steer/.test(s))) continue;
      for (const [p, v] of widths(r.body)) {
        if (/^80%$|min\(92%/.test(v)) bad.push(`${r.selector} { ${p}: ${v} }`);
      }
    }
    assert.deepEqual(bad, []);
  });

  test('用户气泡保持右对齐、最大宽度 70% 不变', () => {
    const user = ALL.find((r) => r.selector === '.message.user .message-content');
    assert.match(user!.body, /max-width:\s*70%/);
    const row = ALL.find((r) => r.selector === '.message.user');
    assert.match(row!.body, /align-items:\s*flex-end/);
  });
});

/* ───────────── 新加的会话卡片忘了接变量 ─────────────
 * 上面那条只拦「100% 以外的百分比」：`.x-card { width: 420px }`、只写固定 max-width、或者干脆
 * 不写宽度又没放进对话列元素里，都拦不住。这里从会话里渲染的组件（JSX，用 TypeScript 解析）
 * 收集所有「像卡片」的类，每一个都必须：
 *   - 自己的规则写 `width: var(--chat-col-width)`（对话列元素），或者
 *   - 每一处都挂在对话列元素里面（同一个元素或祖先带对话列类；在组件里就顺着这个组件被用的
 *     地方往上找），宽度只能 100% / auto / none；
 *   - 否则只能是下面 PANE_STRIPS 里列明理由的整格横条。
 * 任何一张卡片写固定 px / 百分比宽度都算没接变量。 */

const COMPONENTS = ['ChatArea.tsx', 'PermissionBar.tsx', 'QuestionCard.tsx'];
const SOURCES = Object.fromEntries(COMPONENTS.map((f) => [f,
  fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', f), 'utf8')]));

/** 像会话卡片的类名：卡片、提示、横条、横幅、面板、栈。 */
const CARD_LIKE = /^[a-z][a-z0-9-]*-(?:card|notice|bar|banner|panel|panels|stack)$/;

/** 不在对话列里、按设计横跨整格的条（在消息列表上方 / 输入框工具栏里），不接对话列宽度。 */
const PANE_STRIPS: Record<string, string> = {
  'startup-banner': '新建会话的启动阶段，消息列表上方整格横条',
  'chat-error-banner': '连接出错，消息列表上方整格横条',
  'schedule-banner': '正在跑的定时任务，消息列表上方整格横条',
  'bg-jobs-banner': '正在跑的后台命令 / 监视，消息列表上方整格横条',
  'memory-warn-bar': '内存告警，消息列表上方整格横条',
  'chat-crew-bar': '子代理一览，消息列表上方整格横条',
  'composer-usage-bar': '输入框工具栏里的上下文用量小进度条，不是卡片',
};

type Occurrence = { classes: string[]; ancestors: string[][]; component: string | null };

/** className 里能静态看出来的所有类（字符串、模板字符串的字面部分、三元两边）。 */
function classTokens(attr: ts.JsxAttribute): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    else if (ts.isTemplateExpression(n)) {
      out.push(n.head.text);
      for (const s of n.templateSpans) { visit(s.expression); out.push(s.literal.text); }
      return;
    }
    ts.forEachChild(n, visit);
  };
  if (attr.initializer) visit(attr.initializer);
  return out.join(' ').split(/\s+/).filter((c) => /^[a-z][\w-]*$/.test(c));
}

function elementClasses(el: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string[] {
  for (const a of el.attributes.properties) {
    if (ts.isJsxAttribute(a) && a.name.getText() === 'className') return classTokens(a);
  }
  return [];
}

/** 这个 JSX 在哪个具名组件里（往上找到第一个有名字的函数 / `const X = memo(…)`）。 */
function componentName(node: ts.Node): string | null {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
      && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer) || ts.isCallExpression(n.initializer))) return n.name.text;
  }
  return null;
}

type Scan = { occurrences: Occurrence[]; usages: Map<string, Occurrence[]> };

/** ChatArea 很大：同一份源码只扫一次。 */
const SCANNED = new Map<string, { text: string; found: Array<{ occ: Occurrence; tag: string }> }>();

function scanFile(file: string, text: string): Array<{ occ: Occurrence; tag: string }> {
  const cached = SCANNED.get(file);
  if (cached?.text === text) return cached.found;
  const found: Array<{ occ: Occurrence; tag: string }> = [];
  const walk = (n: ts.Node, ancestors: string[][]): void => {
    let next = ancestors;
    const open = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null;
    if (open) {
      const occ: Occurrence = { classes: elementClasses(open), ancestors, component: componentName(n) };
      found.push({ occ, tag: open.tagName.getText() });
      next = [...ancestors, occ.classes];
    }
    ts.forEachChild(n, (c) => walk(c, next));
  };
  walk(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), []);
  SCANNED.set(file, { text, found });
  return found;
}

function scanJsx(sources: Record<string, string>): Scan {
  const occurrences: Occurrence[] = [];
  const usages = new Map<string, Occurrence[]>();
  for (const [file, text] of Object.entries(sources)) {
    for (const { occ, tag } of scanFile(file, text)) {
      occurrences.push(occ);
      if (/^[A-Z]/.test(tag)) usages.set(tag, [...(usages.get(tag) ?? []), occ]);
    }
  }
  return { occurrences, usages };
}

/** 这一处是不是在对话列元素里：本元素 / 祖先带对话列类；在组件里就看这个组件每一处被用的地方。 */
function inColumn(occ: Occurrence, column: Set<string>, scan: Scan, seen = new Set<string>()): boolean {
  if ([occ.classes, ...occ.ancestors].some((cs) => cs.some((c) => column.has(c)))) return true;
  const comp = occ.component;
  if (!comp || seen.has(comp)) return false;
  const used = scan.usages.get(comp) ?? [];
  return used.length > 0 && used.every((u) => inColumn(u, column, scan, new Set([...seen, comp])));
}

/** 所有没接上对话列宽度的会话卡片（空 = 都接上了）。 */
function columnProblems(css: string, sources: Record<string, string>): string[] {
  // 类名 → 以它为主体的规则（先建好索引：类有几百个、规则有几千条）
  const byClass = new Map<string, Rule[]>();
  for (const r of rules(css.replace(/\/\*[\s\S]*?\*\//g, ''))) {
    const names = new Set(subjects(r.selector).flatMap((s) => [...s.matchAll(/\.([\w-]+)/g)].map((m) => m[1])));
    for (const n of names) byClass.set(n, [...(byClass.get(n) ?? []), r]);
  }
  const ownRules = (cls: string) => byClass.get(cls) ?? [];
  const takesVar = (cls: string) => ownRules(cls).some((r) => !/:/.test(r.selector)
    && widths(r.body).some(([p, v]) => p === 'width' && v === 'var(--chat-col-width)'));
  const scan = scanJsx(sources);
  const tokens = new Set(scan.occurrences.flatMap((o) => o.classes));
  // 对话列元素 = CSS 里真的写了 width: var(--chat-col-width) 的类（从 CSS 算出来，不是手写名单）
  const column = new Set([...tokens].filter(takesVar));
  const problems: string[] = [];
  for (const cls of [...tokens].filter((c) => CARD_LIKE.test(c)).sort()) {
    if (PANE_STRIPS[cls]) continue;
    for (const r of ownRules(cls)) {
      for (const [p, v] of widths(r.body)) {
        if (v !== 'var(--chat-col-width)' && !OK_NESTED.has(v)) {
          problems.push(`.${cls}: ${r.selector} { ${p}: ${v} } — use var(--chat-col-width) / 100%`);
        }
      }
    }
    if (column.has(cls)) continue;
    const where = scan.occurrences.filter((o) => o.classes.includes(cls));
    if (!where.every((o) => inColumn(o, column, scan))) {
      problems.push(`.${cls}: not inside a column item and never sets width: var(--chat-col-width)`);
    }
  }
  return problems;
}

describe('会话里渲染的每一张卡片都接上了对话列宽度', () => {
  test('现在的源码：没有漏接的', () => {
    assert.deepEqual(columnProblems(CSS, SOURCES), []);
  });

  test('整格横条的例外名单里每一个都还在用（删了的要从名单里拿掉）', () => {
    const tokens = new Set(scanJsx(SOURCES).occurrences.flatMap((o) => o.classes));
    for (const cls of Object.keys(PANE_STRIPS)) assert.ok(tokens.has(cls), `.${cls} is no longer rendered`);
  });

  // 下面用一张假的「新卡片」验证这条检查本身真的会失败
  const withNewCard = (css: string, jsx: string) => columnProblems(CSS + '\n' + css, {
    ...SOURCES,
    'NewCard.tsx': `export function NewCard() { return ${jsx}; }\n`
      + `export function Host() { return <div className="chat-messages"><NewCard /></div>; }\n`,
  });

  test('新卡片写固定 px 宽度：失败', () => {
    const problems = withNewCard('.example-card { width: 420px; }', '<div className="example-card">x</div>');
    assert.ok(problems.some((p) => p.includes('width: 420px')), problems.join('\n'));
  });

  test('新卡片只写固定 max-width：失败', () => {
    const problems = withNewCard('.example-card { max-width: 640px; }', '<div className="example-card">x</div>');
    assert.ok(problems.some((p) => p.includes('max-width: 640px')), problems.join('\n'));
  });

  test('新卡片完全没写宽度、也不在对话列元素里：失败', () => {
    const problems = withNewCard('.example-card { padding: 4px; }', '<div className="example-card">x</div>');
    assert.deepEqual(problems, ['.example-card: not inside a column item and never sets width: var(--chat-col-width)']);
  });

  test('新卡片写 var(--chat-col-width)：通过', () => {
    assert.deepEqual(withNewCard('.example-card { width: var(--chat-col-width); margin: 0 auto; }',
      '<div className="example-card">x</div>'), []);
  });

  test('新卡片放在 .kirolex-message 里、100% 填满：通过；挪到外面：失败', () => {
    assert.deepEqual(withNewCard('.example-card { width: 100%; }',
      '<div className="kirolex-message"><div className="example-card">x</div></div>'), []);
    assert.equal(withNewCard('.example-card { width: 100%; }',
      '<div className="chat-input-area"><div className="example-card">x</div></div>').length, 1);
  });
});
