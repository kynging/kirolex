/**
 * 负责人 2026-10-23 定下的几项（docs/claude-code-feature-audit.md）：1b effort、2b 计划正文、
 * 3a 只读工具留痕 / 3b Edit diff / 12 子代理分组的接线。纯逻辑在 toolTrace / editFork 两份测试里；这里是
 * 判定函数 + 「源码真的接上了、kiro 那条路没变」。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { planEffortForModel } from '../src/main/engineEffort.ts';
import { effortPickerView } from '../src/renderer/effortPick.ts';
import { planTextOf, planIsLong } from '../src/renderer/permissionButtons.ts';

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');
const tt = (k: string, v?: Record<string, string | number>) => (v ? k.replace(/\{(\w+)\}/g, (_, n) => String(v[n])) : k);

/* 2026-10-26 用户改了口径：effort 单独一个下拉（模型下拉左边），不再放在 MCP 配置里 —— 细节见 tests/engineEffort.test.ts */
describe('1b effort：当前模型不支持时不设、不报错，界面明说（独立的 effort 下拉）', () => {
  test('haiku（没有 effort 那一项）：不设；下拉禁用并写着不支持', () => {
    assert.deepEqual(planEffortForModel('high', null), { kind: 'unsupported', wanted: 'high' });
    const v = effortPickerView(null, { connected: true }, tt);
    assert.equal(v.disabled, true);
    assert.match(v.title, /does not support adjusting reasoning effort/);
  });
  test('接线：组合旁边不再有「effort 暂不生效」；换模型后按会话记住的 effort 重对', () => {
    const M = read('main', 'index.ts');
    const s = M.slice(M.indexOf('const setEngineOption = async ('), M.indexOf("ipcMain.handle('acp:set-engine-model'"));
    assert.match(s, /if \(category === 'model'\) \{[\s\S]*?await reconcileEffort\(/);
    const C = read('renderer', 'components', 'ChatArea.tsx');
    assert.doesNotMatch(C, /comboEffortNote|composer-combo-effort-note/);
  });
});

describe('2b 批准计划：权限卡里渲染计划正文', () => {
  const exitPlan = {
    name: 'ExitPlanMode', kind: 'switch_mode', title: 'Approve Plan',
    rawInput: { plan: '## Plan\nCreate `plan.txt` containing "p".\n' },
    content: [{ type: 'content', content: { type: 'text', text: 'from content' } }],
  };
  test('优先 rawInput.plan，没有再用 content[0]', () => {
    assert.equal(planTextOf(exitPlan), '## Plan\nCreate `plan.txt` containing "p".');
    assert.equal(planTextOf({ ...exitPlan, rawInput: {} }), 'from content');
    assert.equal(planTextOf({ kind: 'switch_mode', content: [{ content: { text: ' x ' } }] }), 'x');
  });
  test('别的权限请求（Bash / WebFetch）没有计划正文', () => {
    assert.equal(planTextOf({ name: 'Bash', kind: 'execute', rawInput: { command: 'git init' }, content: [{ content: { text: 'git init' } }] }), undefined);
    assert.equal(planTextOf(undefined), undefined);
  });
  test('长了默认折起来', () => {
    assert.equal(planIsLong('短计划'), false);
    assert.equal(planIsLong('x'.repeat(800)), true);
    assert.equal(planIsLong(Array.from({ length: 20 }, () => 'line').join('\n')), true);
  });
  test('接线：请求里带 plan；权限卡用聊天那套 Markdown 渲染，可折叠', () => {
    const A = read('renderer', 'hooks', 'useAcp.ts');
    assert.match(A, /const plan = planTextOf\(update\.toolCall\);/);
    assert.match(A, /\.\.\.\(plan \? \{ plan \} : \{\}\),/);
    const P = read('renderer', 'components', 'PermissionBar.tsx');
    assert.match(P, /\{request\.plan && \(\n\s+<div className=\{`permission-plan\$\{planOpen \? '' : ' collapsed'\}`\}>/);
    assert.match(P, /renderMarkdown \? renderMarkdown\(request\.plan\)/);
    assert.match(P, /planIsLong\(request\.plan\) && \(/);
    const C = read('renderer', 'components', 'ChatArea.tsx');
    assert.equal((C.match(/renderMarkdown=\{renderPlanMarkdown\}/g) || []).length, 2, '主输入区和只读分屏格两处权限卡都要');
    assert.match(C, /const renderPlanMarkdown = \(md: string\): React\.ReactNode => <MarkdownView content=\{md\} \/>;/);
  });
});

describe('3a / 3b / 12 接线：只对 Claude Code / Codex，kiro 不变', () => {
  const M = read('main', 'index.ts');
  const A = read('renderer', 'hooks', 'useAcp.ts');
  const C = read('renderer', 'components', 'ChatArea.tsx');
  test('主进程：每条都记（判据换成 shouldRecordToolCall，kiro 分支和原来等价），追踪字段只给非 kiro', () => {
    assert.match(M, /if \(shouldRecordToolCall\(engineOf\(entry\.profile\), next\)\) \{/);
    assert.doesNotMatch(M, /if \(next\.locations\?\.length \|\| next\.diffs\?\.length \|\| ranSomething \|\| kindLower === 'browser'\) \{/);
    assert.match(M, /\.\.\.\(engineOf\(entry\.profile\) !== 'kiro'\n\s+\? \{ \.\.\.mergeToolTrace\(previous, toolTraceFields\(u\)\), \.\.\.toolTimes\(previous, status, Date\.now\(\)\) \}\n\s+: \{\}\),/);
  });
  test('渲染层实时那一侧：同一个判据；kiro 的 update 判据原样保留', () => {
    assert.match(A, /if \(shouldRecordToolCall\(traceEngine, tc\)\) attachFileChangeToLatestTurn\(targetSid, tc, isActiveSession\);/);
    assert.match(A, /if \(traceEngine && traceEngine !== 'kiro' \? true : \(existing\.locations\?\.length \|\| existing\.diffs\?\.length\n\s+\|\| RUN_KINDS\.has\(\(existing\.kind \|\| ''\)\.toLowerCase\(\)\)\)\) \{/);
    assert.match(A, /\.\.\.\(traced \? \{ \.\.\.toolTraceFields\(update\), \.\.\.toolTimes\(undefined, update\.status, Date\.now\(\)\) \} : \{\}\),/);
  });
  test('界面：工具面板挂在回合面板里；命令面板只列主线；diff 只对非 kiro 换成按行显示', () => {
    /* 只给非 kiro：kiro 也落盘带 locations 的 Read（老判据），不能让它们在 kiro 会话里冒出一块新面板 */
    assert.match(C, /\{!!engine && engine !== 'kiro' && <ToolsPanel calls=\{turnFileChanges\} live=\{isStreaming && isLastAssistant\} \/>\}/);
    assert.match(C, /const cmds = useMemo\(\(\) => mainlineCommands\(fileChanges\), \[fileChanges\]\);/);
    assert.match(C, /<FileChangesPanel fileChanges=\{turnFileChanges\} remoteHost=\{remoteHost\} engine=\{engine\} \/>/);
    assert.match(C, /const lineDiff = nonKiro && !!f\.diffs\?\.length;/);
    assert.match(C, /\{f\.diff && expanded && !lineDiff && \(\n\s+<pre className="files-item-diff">\n\s+<code>\{f\.diff\.newText\}<\/code>/, 'kiro 那份显示原样保留');
    assert.match(C, /\{expanded && lineDiff && f\.diffs!\.map\(\(d, i\) => <DiffLines key=\{i\} diff=\{d\} \/>\)\}/);
    assert.match(C, /<MessageItem\n\s+remoteHost=\{remoteHostLabel\}\n\s+engine=\{engine\}/);
  });
  test('界面：子代理行（Task）下面挂孩子、显示调用数 / 用时；失败标红', () => {
    const p = C.slice(C.indexOf('const ToolsPanel = memo<'), C.indexOf('const FileChangesPanel = memo<'));
    assert.match(p, /const sub = isSubagentCall\(call\) \|\| children\.length > 0;/);
    assert.match(p, /<ul className="tool-row-children">/);
    assert.match(p, /const took = toolDuration\(call, now\);/);
    assert.match(p, /st === 'failed' \? <span className="stat-del">\{t\('Failed'\)\}<\/span>/);
    const css = read('renderer', 'styles', 'global.css');
    assert.match(css, /\.tool-row\[data-state="failed"\] > \.files-item-row \.tool-row-title \{ color: #e5534b; \}/);
    assert.match(css, /\.diff-line\.diff-del \{/);
    assert.match(css, /\.diff-line\.diff-add \{/);
  });
  test('落盘类型：StoredToolCall 带上新字段（可选，kiro 的记录不写）', () => {
    const S = read('main', 'sessionStore.ts');
    for (const f of ['toolName?: string;', 'input?: string;', 'parentToolCallId?: string;', 'startedAt?: number;', 'endedAt?: number;', 'acpMessageId?: string;', 'acpSessionId?: string;']) assert.ok(S.includes(f), f);
  });
});
