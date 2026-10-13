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
  /* 清单里也没有（真跑不了）：同样留着偏好，只记这台机器挣的 —— 见 retargetDuringAttach.test.ts */
  assert.match(M, /\? \{ \.\.\.entry\.profile, model, modelEarnedOn: undefined \}\n\s+: \{ \.\.\.entry\.profile, model, modelEarnedOn: machineKeyOf\(entry\.profile\) \};/);
  assert.match(M, /if \(!stillListed\) deadModelsFor\(machineKeyOf\(entry\.profile\)\)\.add\(failedModel\);/);
});

test('Windows：无边框窗口 + 自己画的标题条和三个按钮；最大化时标题条自动隐藏、碰顶边滑下来', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const A = fs.readFileSync(path.join(process.cwd(), 'src/renderer/App.tsx'), 'utf8');
  const C = fs.readFileSync(path.join(process.cwd(), 'src/renderer/styles/global.css'), 'utf8');
  assert.match(M, /\.\.\.\(process\.platform === 'darwin' \? \{\} : \{ frame: false \}\),/);
  assert.doesNotMatch(M, /titleBarOverlay: \{/, '系统按钮藏不掉，所以不再用 overlay');
  assert.match(M, /ipcMain\.handle\('window:control', \(_event, action: string\) => \{/);
  assert.match(A, /\{isWinFrame && winMaxed && !titlebarShown && <div className="win-titlebar-hotzone" onMouseEnter=\{revealTitlebar\} \/>\}/);
  assert.match(A, /windowControl\('toggle-maximize'\)/);
  assert.match(C, /\.win-titlebar\.auto-hide \{\n  transform: translateY\(-100%\);/);
  assert.match(C, /\.app-layout\.no-toolbar\.win\.maxed \{ height: 100%; margin-top: 0; \}/);
});
