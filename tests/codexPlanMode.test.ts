/**
 * Codex 的「Plan」开关（它的 `collaboration_mode`）—— Codex 的 request_user_input（向你提问 → 提问卡片）只在 Plan 模式下能用。
 *
 * 原来 KiroLex 没有进 Plan 模式的入口：输入 `/plan` 也不行（codex-acp 只认 prompt 的**第一个**文本块是不是命令，
 * 而 KiroLex 会在前面拼上下文块）。现在 Codex 报的 `collaboration_mode` 选项在输入框旁边是一个开关，
 * 和模型 / effort / 权限模式一样走 `session/set_config_option`、记在会话上、下次连上设回去。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AcpClient } from '../src/main/acp-client.ts';
import { INSTANT_ORDER, withEngineOption } from '../src/main/pendingSwitch.ts';

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf8');

/* codex-acp 2.1.1 session/new 返回的 configOptions（2026-10-23 实测，截掉了模型清单） */
const CODEX_OPTIONS = [
  { id: 'mode', category: 'mode', currentValue: 'agent', options: [{ value: 'read-only', name: 'Read-only' }, { value: 'agent', name: 'Auto review' }] },
  { id: 'collaboration_mode', category: 'collaboration_mode', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] },
  { id: 'reasoning_effort', category: 'thought_level', currentValue: 'low', options: [{ value: 'low', name: 'Low' }] },
];

describe('AcpClient：collaboration_mode 和别的选项一样认、一样设', () => {
  test('selectOptions 读得到；setSelectOption 发 session/set_config_option configId=collaboration_mode', async () => {
    const c: any = new AcpClient('m', {}, undefined, 'ask', undefined, undefined, 'codex');
    c.noteConfigOptions(CODEX_OPTIONS);
    assert.deepEqual(c.selectOptions('collaboration_mode'), { current: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] });
    const sent: any[] = [];
    c.sendRequest = async (method: string, params: any) => {
      sent.push({ method, params });
      return { configOptions: CODEX_OPTIONS.map((o) => (o.id === 'collaboration_mode' ? { ...o, currentValue: 'plan' } : o)) };
    };
    await c.setSelectOption('s1', 'collaboration_mode', 'plan');
    assert.deepEqual(sent, [{ method: 'session/set_config_option', params: { sessionId: 's1', configId: 'collaboration_mode', value: 'plan' } }]);
    assert.equal(c.selectOptions('collaboration_mode').current, 'plan');
  });

  test('没有这一项的引擎（Claude Code）：selectOptions 为 null —— 界面上不显示开关', () => {
    const c: any = new AcpClient('m', {}, undefined, 'ask', undefined, undefined, 'claude');
    c.noteConfigOptions([{ id: 'mode', category: 'mode', currentValue: 'default', options: [{ value: 'default', name: 'Manual' }] }]);
    assert.equal(c.selectOptions('collaboration_mode'), null);
  });
});

describe('记在会话上、忙时排到这一轮之后', () => {
  test('写进 profile.engineOptions.codex.collaboration_mode（和 mode / effort 同一个形状）', () => {
    const p = withEngineOption({ engineOptions: { codex: { mode: 'agent' } } }, 'codex', 'collaboration_mode', 'plan');
    assert.deepEqual(p.engineOptions, { codex: { mode: 'agent', collaboration_mode: 'plan' } });
  });
  test('engineCollab 是「不换执行器就能改」的一类（忙时登记成 pending，这一轮结束再设）', () => {
    assert.ok((INSTANT_ORDER as readonly string[]).includes('engineCollab'));
  });
});

describe('接线（源码）', () => {
  const M = read('main', 'index.ts');
  const CA = read('renderer', 'components', 'ChatArea.tsx');
  test('主进程：engine-models 带上 plan；下次连上按记录设回去；set-engine-option 收 collaboration_mode；忙时归 engineCollab', () => {
    const payload = M.slice(M.indexOf('function engineModelsPayload('), M.indexOf('function engineModelsPayload(') + 1200);
    assert.match(payload, /plan: entry\.client\.selectOptions\('collaboration_mode'\),/);
    const wanted = M.slice(M.indexOf('function wantedEngineOptions('), M.indexOf('function wantedEngineOptions(') + 1200);
    assert.match(wanted, /if \(collab\) out\.push\(\['collaboration_mode', collab\]\);/);
    assert.match(M, /if \(category === 'collaboration_mode'\) return setEngineOption\(sessionId, category, value\);/);
    assert.match(M, /category === 'collaboration_mode' \? 'engineCollab'/);
  });
  test('界面：只在引擎给了 plan 这一档时显示开关；点一下在 plan 和另一档之间切', () => {
    assert.match(CA, /enginePlan=\{nonKiro && engineModels\?\.plan\?\.options\.some\(\(o\) => o\.value === 'plan'\)/);
    assert.match(CA, /onToggle: \(\) => void onEngineOptionChange\('collaboration_mode', on \? off : 'plan'\)/);
    assert.match(CA, /\{enginePlan && \(\s*<button[\s\S]{0,200}className=\{`composer-mode composer-plan\$\{enginePlan\.on \? ' on' : ''\}`\}/);
  });
});
