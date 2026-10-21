import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { liteHelperSkipReason, resolveAdapter, REMOTE_ADAPTER_BIN } from '../src/main/engines.ts';

/**
 * Claude Code / Codex 运行模式审计（docs/engine-audit-claude-codex.md）第三轮 —— 审查意见要求补的两条：
 * A14（原 U1）辅助小任务不再拿 kiro-cli 跑 Claude / Codex 会话；A15（原 3.3）设置里那两格说清实际用途。
 */
const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf-8');
const M = read('src', 'main', 'index.ts');

function slice(src: string, anchor: string, len = 2500): string {
  const at = src.indexOf(anchor);
  assert.ok(at >= 0, `找不到锚点：${anchor}`);
  return src.slice(at, at + len);
}

describe('A14 标题 / 追问建议 / 会话记忆整理：Claude Code / Codex 会话不交给 kiro-cli', () => {
  test('纯判据：kiro 和「不知道是哪条会话」照旧跑；另外两家跳过并给一句说明', () => {
    assert.equal(liteHelperSkipReason('kiro'), null);
    assert.equal(liteHelperSkipReason(undefined), null);
    assert.ok(liteHelperSkipReason('claude'));
    assert.ok(liteHelperSkipReason('codex'));
  });

  test('判断在起 kiro-cli 之前，一条会话只说一次，跳过时不起进程', () => {
    const fn = slice(M, 'function skipLiteHelperFor(sessionId: string | null | undefined, what: string): boolean {', 900);
    assert.match(fn, /liteHelperSkipReason\(engineOf\(profile\)\)/);
    assert.match(fn, /if \(!liteSkipNoticed\.has\(sessionId\)\) \{\s*liteSkipNoticed\.add\(sessionId\);/);
    assert.equal(fn.includes('runLiteOneShot('), false);
  });

  test('记忆整理：跳过发生在读记忆 / 调 runLiteOneShot 之前（不再每轮失败重试）', () => {
    const body = slice(M, 'async function maybeConsolidateSessionMemory(sessionId: string): Promise<void> {', 2400);
    const skip = body.indexOf("if (skipLiteHelperFor(sessionId, 'session-memory')) return;");
    const run = body.indexOf('runLiteOneShot(');
    assert.ok(skip > 0 && run > skip);
  });

  test('标题、追问建议：IPC 带上会话 id，跳过在 runLiteOneShot 之前', () => {
    const title = slice(M, "ipcMain.handle('app:generate-title'", 1800);
    assert.match(title, /async \(_event, firstUser: string, firstAssistant\?: string, sessionId\?: string\)/);
    assert.ok(title.indexOf("if (skipLiteHelperFor(sessionId, 'title')) return { ok: false, skipped: 'engine' };") < title.indexOf('runLiteOneShot('));
    const sugg = slice(M, "ipcMain.handle('app:generate-suggestions'", 2500);
    assert.ok(sugg.indexOf("if (skipLiteHelperFor(meta?.sessionId, 'suggestions'))") > 0);
    assert.ok(sugg.indexOf("skipLiteHelperFor(meta?.sessionId, 'suggestions')") < sugg.indexOf('runLiteOneShot('));
    assert.match(read('src', 'main', 'preload.ts'), /ipcRenderer\.invoke\('app:generate-title', firstUser, firstAssistant, sessionId\)/);
  });

  test('渲染层：传会话 id；被跳过就直接用第一条消息当标题（不再重试三次）', () => {
    const hook = read('src', 'renderer', 'hooks', 'useAcp.ts');
    const call = slice(hook, 'window.kiroApi.generateTitle?.(firstUser, firstAssistant, sid).then((r) => {', 500);
    assert.match(call, /if \(r\?\.skipped === 'engine'\) \{[\s\S]{0,200}if \(truncated\) applyTitle\(truncated\);\s*return;/);
  });
});

describe('A15 设置里 claude / codex 那两格：说清会话不读它们、实际起的是哪个适配器', () => {
  const ui = read('src', 'renderer', 'components', 'RemoteSettings.tsx');
  test('原来那句「只起 kiro-cli」（已经不对了）不再出现', () => {
    assert.equal(ui.includes(['KiroLex only launches', 'kiro-cli for now'].join(' ')), false);
  });
  test('标签写明「会话不读这一格」，说明里给出真正起的适配器和覆盖用的环境变量', () => {
    for (const engine of ['claude', 'codex'] as const) {
      assert.ok(ui.includes(`label={t('${engine} CLI (for reference; sessions do not use this field)')}`));
      assert.ok(ui.includes(`adapter: '${REMOTE_ADAPTER_BIN[engine]}', env: 'KIROLEX_${engine.toUpperCase()}_ACP'`), `${engine} 的说明要和实际启动一致`);
    }
  });
  test('说明里那个环境变量就是启动时真正认的那个（界面和 resolveAdapter 一致）', () => {
    for (const engine of ['claude', 'codex'] as const) {
      const a = resolveAdapter(engine, { [`KIROLEX_${engine.toUpperCase()}_ACP`]: '/x/adapter.js' }, { roots: [], execPath: '/node' });
      assert.deepEqual(a.args, ['/x/adapter.js']);
    }
  });
});
