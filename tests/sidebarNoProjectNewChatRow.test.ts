import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const SIDEBAR = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/Sidebar.tsx'), 'utf8');
const CSS = fs.readFileSync(path.join(process.cwd(), 'src/renderer/styles/global.css'), 'utf8');

/**
 * 「每个项目展开后第一行那个『＋ 在此项目中新建会话』没用，占地方，删掉」。
 *
 * 新建会话的入口只留两个：顶部「＋ 新建会话」（对话框里能选项目）和项目右键菜单里的
 * 「＋ 在此项目中新建会话」。
 */
describe('侧栏项目组里不再有「在此项目中新建会话」那一行', () => {
  test('Sidebar.tsx 不再渲染 project-newchat，也不再给项目组传 onNewChat', () => {
    assert.ok(!SIDEBAR.includes('project-newchat'));
    assert.ok(!/\bonNewChat\b/.test(SIDEBAR));
  });

  test('global.css 里 .project-newchat 的样式一并去掉', () => {
    assert.ok(!CSS.includes('.project-newchat'));
  });

  test('项目右键菜单仍然调用 onNewSessionInProject', () => {
    assert.match(
      SIDEBAR,
      /onClick=\{\(\) => \{ onNewSessionInProject\(projectMenu\.project\); setProjectMenu\(null\); \}\}[\s\S]{0,80}t\('New chat in project'\)/,
    );
  });

  test('顶部「新建会话」按钮仍然接到 onNewSession', () => {
    assert.match(SIDEBAR, /onClick=\{onNewSession\}/);
  });
});
