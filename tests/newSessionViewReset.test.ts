import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

/*
  新建会话（切焦点）时，「当前会话」的每一项视图状态都要换成新会话的 —— 漏一项，上一条会话的东西就留在
  新会话的界面上。实测（10-21，本机 Electron）：开着一条还在连接的旧会话点「新建会话」，新会话欢迎页下面
  一直挂着旧会话的「正在连接会话…」，新会话早就连上了也不消失（旧会话连完只清它自己的那份，焦点已经不是它）。
  漏的是 activityStatus 和 turnStall：switchSession 按会话还原它们，newSession 的焦点分支没清。
  useAcp.ts 是 React hook 测不了，按源码钉住：switchSession 按会话还原的每一项，newSession 都要清。
*/

const src = fs.readFileSync(new URL('../src/renderer/hooks/useAcp.ts', import.meta.url), 'utf8');

function sliceFrom(marker: string, end: string): string {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, `找不到 ${marker}`);
  const j = src.indexOf(end, i);
  assert.ok(j > i, `找不到 ${marker} 之后的 ${end}`);
  return src.slice(i, j);
}

test('newSession 切焦点时清掉 switchSession 按会话还原的每一项视图状态', () => {
  const sw = sliceFrom('currentSessionRef.current = sessionId; // sync immediately', '// Restore from local cache instantly');
  const restored = [...sw.matchAll(/\b(set[A-Z]\w*)\(\w+MapRef\.current\.get\(sessionId\)/g)].map((m) => m[1]);
  assert.ok(restored.includes('setActivityStatus') && restored.includes('setTurnStall'), `switchSession 还原的：${restored.join(', ')}`);

  const ns = sliceFrom('const newSession = useCallback(', 'if (projectId) setProjects(');
  const focusBlock = ns.slice(ns.indexOf('if (focus) {'));
  for (const setter of restored) {
    assert.ok(new RegExp(`\\b${setter}\\(`).test(focusBlock), `newSession 切焦点时没清 ${setter}：上一条会话的这项会留在新会话界面上`);
  }
});
