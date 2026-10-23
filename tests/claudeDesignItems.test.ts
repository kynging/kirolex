/**
 * 负责人 2026-10-23 定下的几项（docs/claude-code-feature-audit.md）：1b effort、2b 计划正文、
 * 3a 只读工具留痕 / 3b Edit diff / 12 子代理分组的接线。纯逻辑在 toolTrace / editFork 两份测试里；这里是
 * 判定函数 + 「源码真的接上了、kiro 那条路没变」。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { modelOffersEffort } from '../src/main/mcpCombos.ts';
import { comboEffortNote } from '../src/renderer/comboPick.ts';
import { planTextOf, planIsLong } from '../src/renderer/permissionButtons.ts';

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');
const tt = (k: string, v?: Record<string, string | number>) => (v ? k.replace(/\{(\w+)\}/g, (_, n) => String(v[n])) : k);

describe('1b effort：当前模型不支持时不设、不报错，组合旁边说一句', () => {
  test('modelOffersEffort：haiku（没有 effort 那一项）= false', () => {
    assert.equal(modelOffersEffort(null), false);
    assert.equal(modelOffersEffort({ current: '', options: [] }), false);
    assert.equal(modelOffersEffort({ current: 'default', options: [{ value: 'high', name: 'High' }] }), true);
  });
  const list = { combos: [{ id: 'default', name: '通用' }, { id: 'deep', name: '深度', effort: 'high' }], current: 'deep' };
  test('组合设了 effort + 模型不支持 → 说明；支持 / 组合没设 effort / 还没连上 → 不说', () => {
    assert.match(comboEffortNote(list, 'deep', { effort: null }, tt)!, /does not support effort.*\(high\)/);
    assert.match(comboEffortNote(list, 'deep', {}, tt)!, /high/);
    assert.equal(comboEffortNote(list, 'deep', { effort: { options: [{ value: 'high' }] } }, tt), null);
    assert.equal(comboEffortNote(list, 'default', { effort: null }, tt), null);
    assert.equal(comboEffortNote(list, 'deep', null, tt), null);
    assert.equal(comboEffortNote(null, 'deep', { effort: null }, tt), null);
  });
  test('接线：applyEngineModel 遇到不支持就跳过；换模型后按组合重新对 effort；组合旁边显示说明', () => {
    const M = read('main', 'index.ts');
    const a = M.slice(M.indexOf('async function applyEngineModel('), M.indexOf('async function applyEngineModel(') + 2500);
    assert.ok(a.indexOf('if (!modelOffersEffort(opts)) {') > 0);
    assert.ok(a.indexOf('if (!modelOffersEffort(opts)) {') < a.indexOf('await applyComboEffort('), '先判支不支持，再设');
    const s = M.slice(M.indexOf('const setEngineOption = async ('), M.indexOf("ipcMain.handle('acp:set-engine-model'"));
    assert.match(s, /if \(category === 'model'\) \{[\s\S]*?if \(combo\.effort && modelOffersEffort\(entry\.client\.selectOptions\('thought_level'\)\)\) \{[\s\S]*?applyComboEffort\(/);
    assert.match(s, /\} catch \(err\) \{\n\s+logger\.warn\('mcp-combo', `换模型后重设组合 effort 失败/, '设不上只记日志，不挡换模型');
    const C = read('renderer', 'components', 'ChatArea.tsx');
    assert.match(C, /const effortNote = comboEffortNote\(mcpCombos, comboView\.value, engineModels, t\);/);
    assert.match(C, /\{effortNote && \(\n\s+<span className="composer-combo-effort-note" title=\{effortNote\}/);
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
