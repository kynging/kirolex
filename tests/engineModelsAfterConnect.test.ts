import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { engineModelPlaceholder, engineModelsReaskDelay, shouldReaskEngineModels, ENGINE_MODELS_REASK_STEADY_MS } from '../src/renderer/engineModelView.ts';
import { RemoteRecovery } from '../src/main/remoteRecovery.ts';

/*
 * 「远程 Claude Code 会话：模型下拉连上后显示『默认模型』」（s_1792550354705_bq53af，2026-11-10）
 * 那一轮实际用的是 Opus 5.5，下拉却停在「默认模型」：清单在重连 / 切换期间被清掉，之后没拿回来。
 */

const root = path.join(import.meta.dirname, '..', 'src');
const CHAT = fs.readFileSync(path.join(root, 'renderer', 'components', 'ChatArea.tsx'), 'utf8');
const M = fs.readFileSync(path.join(root, 'main', 'index.ts'), 'utf8');

describe('(b) 模型下拉：connected 且清单未到时不显示「Default model」', () => {
  test('清单没到（null / undefined）：连着也显示「连接中…」', () => {
    assert.equal(engineModelPlaceholder(null, true), 'Connecting…');
    assert.equal(engineModelPlaceholder(undefined, true), 'Connecting…');
    assert.equal(engineModelPlaceholder(null, false), 'Connecting…');
  });
  test('清单到了、适配器就是没给选项：才显示「默认模型」；没连着照旧「连接中…」', () => {
    assert.equal(engineModelPlaceholder({ options: [] }, true), 'Default model');
    assert.equal(engineModelPlaceholder({ options: [] }, false), 'Connecting…');
  });
  test('ChatArea 的占位行按 engineModelPlaceholder 走，不再只看 status', () => {
    assert.equal(CHAT.includes(`{status === 'connected' ? t('Default model') : t('Connecting…')}`), false);
    assert.match(CHAT, /engineModelPlaceholder\(engineModels, status === 'connected'\) === 'Default model' \? t\('Default model'\) : t\('Connecting…'\)/);
  });
  test('连着却没拿到清单：再问，直到拿到（先快后每 5 秒）', () => {
    assert.equal(shouldReaskEngineModels(null, true), true);
    assert.equal(shouldReaskEngineModels(null, false), false);
    assert.equal(shouldReaskEngineModels({ options: [] }, true), false);
    assert.ok(engineModelsReaskDelay(0) < engineModelsReaskDelay(2));
    assert.equal(engineModelsReaskDelay(50), ENGINE_MODELS_REASK_STEADY_MS);
    const eff = CHAT.slice(CHAT.indexOf('const ask = (n: number) =>'), CHAT.indexOf('const ask = (n: number) =>') + 900);
    assert.match(eff, /alive && shouldReaskEngineModels\(d, connected\)\) timer = setTimeout\(\(\) => ask\(n \+ 1\), engineModelsReaskDelay\(n\)\)/);
    assert.match(CHAT, /return \(\) => \{ alive = false; if \(timer\) clearTimeout\(timer\);/);
  });
});

describe('(c) 断线自动恢复后会推 session:engine-models', () => {
  test('remoteRecovery 的 recovered 里推一次；pushEngineModels 按此刻的执行器发 session:engine-models', () => {
    const at = M.indexOf('const remoteRecovery = new RemoteRecovery<');
    const def = M.slice(at, M.indexOf('\n});\n', at));
    const rec = def.slice(def.indexOf('recovered: (sessionId) =>'));
    assert.match(rec, /pushEngineModels\(sessionId\)/);
    const fn = M.slice(M.indexOf('function pushEngineModels('), M.indexOf('function pushEngineModels(') + 400);
    assert.match(fn, /const entry = sessionClients\.get\(sessionId\)/);
    assert.match(fn, /engineOf\(entry\.profile\) === 'kiro'/);
    assert.match(fn, /send\('session:engine-models', engineModelsPayload\(sessionId, entry\)\)/);
  });
  test('applyEngineModel 末尾按执行器认（不按 entry 对象），不会因为 entry 换了对象就不推', () => {
    const fn = M.slice(M.indexOf('async function applyEngineModel('), M.indexOf('function pushEngineModels('));
    assert.equal(fn.includes('sessionClients.get(sessionId) === entry)'), false);
    assert.match(fn, /sessionClients\.get\(sessionId\)\?\.client === entry\.client\) pushEngineModels\(sessionId\)/);
  });
  test('RemoteRecovery 接回来后调 recovered（那里补推清单）', async () => {
    let attached = false;
    const recovered: string[] = [];
    const rr = new RemoteRecovery<{ key: string }>({
      target: () => ({ key: 'h' }),
      attached: () => attached,
      toolless: () => false,
      busy: () => false,
      detach: async () => { attached = false; },
      reattach: async () => { attached = true; return true; },
      notice: () => {},
      recovered: (sid) => { recovered.push(sid); },
      backoffMs: [1],
    });
    rr.start('s1', { quiet: true });
    const t0 = Date.now();
    while (!recovered.length && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(recovered, ['s1']);
  });
});

describe('换执行器途中来的消息不交给正被换下来的那个（本机 → 远端时就是本机那个）', () => {
  test('等过之后还在 reconfiguring：抛错，不往下走', () => {
    const at = M.indexOf('async function sendPromptOnce(');
    const head = M.slice(at, at + 6000);
    const wait = head.indexOf('await awaitReconfigureIdle(sessionId)');
    const guard = head.indexOf("if (reconfiguringSessions.has(sessionId)) throw new Error(tr('Another switch (model / agent / machine) has not finished yet.'));");
    const entry = head.indexOf('let entry = sessionClients.get(sessionId)');
    assert.ok(wait > 0 && guard > wait && entry > guard, '顺序：等 → 还在换就抛 → 才取执行器');
  });
});
