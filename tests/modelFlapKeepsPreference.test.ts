import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/* 「为什么这两个会话的模型又变回 GPT 了」：断线重连后那一轮报了一次 not available，偏好就被永久清掉 */
test('一轮报"模型不可用"时先问那台机器的清单：还在 → 只换这一轮，偏好留着、不记死、不记挣来的', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  assert.match(M, /async function modelStillListed\(profile: AgentProfile, modelId: string\): Promise<boolean> \{/);
  assert.match(M, /const list = profile\.remote\?\.sshHost \? await remotePreflight\(profile\.remote\) : await localModelIds\(\);/);
  assert.match(M, /const stillListed = await modelStillListed\(entry\.profile, failedModel\);/);
  assert.match(M, /\? \{ \.\.\.entry\.profile, model, modelEarnedOn: undefined \}\n\s+: \{ \.\.\.entry\.profile, model, preferredModel: undefined, modelEarnedOn: machineKeyOf\(entry\.profile\) \};/);
  assert.match(M, /if \(!stillListed\) deadModelsFor\(machineKeyOf\(entry\.profile\)\)\.add\(failedModel\);/);
});

test('Windows：系统白标题栏换成自己画的深色条，最大化时收窄', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const A = fs.readFileSync(path.join(process.cwd(), 'src/renderer/App.tsx'), 'utf8');
  const C = fs.readFileSync(path.join(process.cwd(), 'src/renderer/styles/global.css'), 'utf8');
  assert.match(M, /titleBarStyle: process\.platform === 'darwin' \? 'hiddenInset' : 'hidden',/);
  assert.match(M, /titleBarOverlay: \{ color: '#1a1a1a', symbolColor: '#a0a0a0', height: WIN_TITLEBAR_HEIGHT \}/);
  assert.match(M, /win\.setTitleBarOverlay\(\{ height: maximized \? WIN_TITLEBAR_HEIGHT_MAXIMIZED : WIN_TITLEBAR_HEIGHT \}\)/);
  assert.match(A, /\{isWinFrame && <div className="win-titlebar"><span className="win-titlebar-title">KiroLex<\/span><\/div>\}/);
  assert.match(C, /\.win-titlebar \{[^}]*-webkit-app-region: drag;/);
  assert.match(C, /\.app-layout\.no-toolbar\.win \{\n  height: calc\(100% - var\(--win-titlebar-height\)\);/);
});
