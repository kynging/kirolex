import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 侧栏常驻搜索框 ——「左下角找会话……把这个按钮删了，找会话应该新建会话下面显示一个搜索框就完了」（2026-10-22）。
 * 守的是接线：🔍 按钮和弹框没了；框紧跟在「＋ 新建会话 / ＋ 新建项目」那排下面；过滤吃的是可写的 query。
 */
const SIDEBAR = fs.readFileSync(path.join(import.meta.dirname, '../src/renderer/components/Sidebar.tsx'), 'utf8');
const ZH = fs.readFileSync(path.join(import.meta.dirname, '../src/renderer/i18nZh/shell.ts'), 'utf8');

describe('侧栏搜会话：常驻框，不是左下角的弹框', () => {
  test('左下角 🔍 按钮和「找会话」弹框都删了', () => {
    assert.ok(!SIDEBAR.includes('find-session-btn'));
    assert.ok(!SIDEBAR.includes('finderOpen'));
    assert.ok(!SIDEBAR.includes('finderQuery'));
    assert.ok(!SIDEBAR.includes('session-finder'));
  });

  test('搜索框紧跟在 .sidebar-top-btns 那排按钮后面', () => {
    const at = SIDEBAR.indexOf('<div className="sidebar-top-btns">');
    assert.ok(at > 0);
    const close = SIDEBAR.indexOf('</div>', at);
    const rest = SIDEBAR.slice(close + '</div>'.length).trimStart();
    assert.ok(rest.startsWith('<div className="sidebar-search'), `top-btns 之后的下一个元素应是搜索框，实际是：${rest.slice(0, 80)}`);
  });

  test('searchSessions 吃的是可写的 query 状态，框是受控的', () => {
    assert.match(SIDEBAR, /const \[query, setQuery\] = useState\(''\)/);
    assert.match(SIDEBAR, /searchSessions\(sessions, query\)/);
    assert.match(SIDEBAR, /value=\{query\}/);
    assert.match(SIDEBAR, /onChange=\{\(e\) => setQuery\(e\.target\.value\)\}/);
  });

  test('回车打开第一条、Esc 清空并失焦、有字时有 ✕', () => {
    assert.match(SIDEBAR, /firstShown\(/);
    assert.match(SIDEBAR, /e\.key === 'Escape'[^\n]*setQuery\(''\)[^\n]*blur\(\)/);
    assert.match(SIDEBAR, /\{query && \([\s\S]{0,300}sidebar-search-clear/);
  });

  test('placeholder 和「没有匹配的会话」都有中文', () => {
    assert.ok(SIDEBAR.includes("t('Search chats (title / project / id)')"));
    assert.ok(ZH.includes("'Search chats (title / project / id)': '搜会话（标题 / 项目 / id）'"));
    assert.ok(SIDEBAR.includes("t('No matching chats')"));
    assert.ok(ZH.includes("'No matching chats': '没有匹配的会话'"));
  });
});
