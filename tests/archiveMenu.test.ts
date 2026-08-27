import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 归档会话的右键菜单里只能有**一个**恢复动作。
 *
 * 来自实测：「现在恢复会话还是有两个一样的按钮」。当时菜单里同时存在
 * `♻️ 恢复到 Unassigned`（解档 + 移到 Unassigned）和 `♻️ Unarchive`（只解档），图标相同、
 * 措辞相近，唯一的区别写在括号里的补充说明中 —— 那个说明还是假的：`archiveSession` 归档时会把
 * projectId 清成 undefined，所以不存在「留在原 project」这回事。
 */
const SIDEBAR = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'Sidebar.tsx'),
  'utf8',
);

describe('右键菜单里的归档/恢复', () => {
  test('只有一处会调用解档（archived=false）', () => {
    const unarchiveCalls = SIDEBAR.match(/onArchiveSession\([^)]*,\s*false\s*\)/g) || [];
    assert.equal(unarchiveCalls.length, 1,
      `解档动作只应有一个入口，实际有 ${unarchiveCalls.length} 个：${unarchiveCalls.join(' | ')}`);
  });

  test('那个入口是「恢复到 Unassigned」，并且真的顺带移出项目', () => {
    const at = SIDEBAR.indexOf('onArchiveSession(ctxSession.id, false)');
    assert.ok(at > 0);
    const around = SIDEBAR.slice(at, at + 220);
    assert.match(around, /onMoveSession\(ctxSession\.id, null\)/,
      '恢复必须同时把会话移到 Unassigned —— 原项目可能已不存在或已被流程托管');
    // 文案现在走 i18n（`t('Restore to Unassigned')`），所以断言的是那个 key 而不是中文原文 ——
    // 中文在 `i18n.ts` 的字典里，由 tests/i18n.test.ts 钉住。
    assert.match(around, /t\('Restore to Unassigned'\)/);
  });
});
