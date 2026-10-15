import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

/**
 * 「❌ Error invoking remote method 'acp:switch-kiro-agent': Error: Session not connected」。
 *
 * 三个 switch（model / agent / permission）原来都是"没有活的执行器就抛错"。可一次重启之后
 * 大多数会话都在休眠 —— 于是点开任意一条老对话换 agent，拿到的是一句 Electron 的原始报错。
 *
 * 而这件事根本不需要执行器：kiro-cli 是在**启动进程时**绑定 `--agent` / `--model` 的，所以
 * "下次挂起时用哪个"本来就只是记录里的一个字段 —— attach 那边读的正是 `existing.profile`。
 * （换引擎 / 换机器早就是这么做的：没连着就只改记录。）
 */
describe('休眠的会话也能改 model / agent / 权限', () => {
  const MAIN = read('src/main/index.ts');
  const ACP = read('src/renderer/hooks/useAcp.ts');

  test('休眠时写记录、返回成功，并标 `dormant`', () => {
    assert.match(MAIN, /const setDormantProfile = \(/);
    const fn = MAIN.slice(MAIN.indexOf('const setDormantProfile = ('));
    const body = fn.slice(0, fn.indexOf('return { ok: true, dormant: true };') + 40);
    assert.match(body, /rec\.profile = \{ \.\.\.rec\.profile, \.\.\.patch \};/);
    assert.match(body, /store\.writeRecord\(rec\);/);
    assert.match(body, /return \{ ok: true, dormant: true \};/);
    /* 没有记录才是真错误 —— attach 那边同样拒绝重建（"ATTACH MUST NOT CREATE"） */
    assert.match(body, /if \(!rec\) throw new Error\(tr\('This session does not exist on disk \(it may have been deleted\)\.'\)\);/);
    /* 不碰 executorState：休眠就是休眠，写成 attached 会让界面说谎 */
    assert.doesNotMatch(body, /executorState/);
  });

  test('三条路都走它 —— 不能只修被报上来的那一条', () => {
    /* 第四条是换「组合」（Claude Code / Codex 专有，见 mcpCombos.test.ts） */
    assert.equal((MAIN.match(/setDormantProfile\(sessionId/g) || []).length, 4);
    assert.match(MAIN, /setDormantProfile\(sessionId, \{ mcpCombo: nextCombo \}/);
    /* 换模型写两个字段：`preferredModel` 是"你选的"（attach 只认它），`model` 是"这次用的" */
    assert.match(MAIN, /setDormantProfile\(sessionId, \{\s*model: normalizedModel, preferredModel: normalizedModel,/);
    assert.match(MAIN, /setDormantProfile\(sessionId, \{ kiroAgent: normalizedAgent \}/);
    assert.match(MAIN, /setDormantProfile\(sessionId, \{ permissionMode: normalizedMode \}/);
  });

  test('那三处 `Session not connected` 的抛错没了', () => {
    for (const h of ['acp:switch-model', 'acp:switch-kiro-agent', 'acp:switch-permission-mode']) {
      const at = MAIN.indexOf(`ipcMain.handle('${h}'`);
      assert.ok(at > 0, `找不到 ${h}`);
      const head = MAIN.slice(at, at + 1500);
      assert.doesNotMatch(head, /throw new Error\('Session not connected'\)/, h);
      assert.match(head, /setDormantProfile\(sessionId/, h);
    }
  });

  test('休眠时引擎检查照旧 —— Claude / Codex 会话不能被写进 kiro 的模型 / agent', () => {
    const fn = MAIN.slice(MAIN.indexOf('const setDormantProfile = ('));
    const body = fn.slice(0, fn.indexOf('return { ok: true, dormant: true };'));
    assert.match(body, /onlyKiro/);
    assert.match(MAIN, /setDormantProfile\(sessionId, \{ kiroAgent: normalizedAgent \}, `[^`]*`, tr\('A kiro agent only applies to Kiro sessions\.'\)\)/);
  });

  test('**休眠成功不算 attached** —— 标了那个绿点就在说谎', () => {
    assert.equal((ACP.match(/if \(!result\.dormant\) addAttached\(sessionId\);/g) || []).length, 2);
  });

  test('挂起失败要**把真实原因打出来** —— 那正是这个错的来源', () => {
    /*
      渲染进程本来就会先试着 attach 一次，但那个 `catch {}` 是空的：真实原因被吞掉，
      接着 switch 抛出一句和原因无关的 "Session not connected"。
    */
    assert.doesNotMatch(ACP, /modelForSession\(sessionId\)\); addAttached\(sessionId\); \} catch \{\}/);
    assert.equal((ACP.match(/改动会记在下次挂起时生效/g) || []).length, 2);
  });
});
