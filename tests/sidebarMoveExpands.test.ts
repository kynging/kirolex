import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { projectsToWarmNow } from '../src/renderer/projectActivity.ts';

const SIDEBAR = fs.readFileSync(path.join(process.cwd(), 'src/renderer/components/Sidebar.tsx'), 'utf8');

/**
 * 「这个会话在移到 dev 之后，dev 没有自动展开，这个不应该」。
 *
 * 多数 project 是折起来的（启动时只留热的那个展开，见 `projectActivity.projectsToCollapse`），所以往一个
 * 折起来的组里搬会话，界面上的结果是**那条会话当场消失**：从原来的位置被拿走，而新位置是收起的。
 *
 * 搬动有几个入口（拖放、右键「移动项目」子菜单、恢复到未分组、指派弹窗的回车和确认按钮）。展开这件事
 * 必须落在**一个**地方，否则下一个入口又会漏 —— 所以这里钉的是「除了 `moveInto` 自己那一次，没有别人
 * 直接调 `onMoveSession`」。
 */
describe('把会话搬进一个组，那个组要自动展开', () => {
  const at = SIDEBAR.indexOf('const moveInto = (');
  const body = SIDEBAR.slice(at, at + 700);

  test('存在一个统一的搬动入口，它会把目标组从 collapsed 里摘掉', () => {
    assert.ok(at > 0, '搬动要走一个统一的 moveInto，而不是各入口各写一遍');
    assert.match(body, /targetProject \?\? UNASSIGNED/, '未分组也是个可折叠的组，同样要展开');
    assert.match(body, /setCollapsed\(/, '展开就是把它从 collapsed 里摘掉');
    assert.match(body, /next\.delete\(key\)/);
    assert.match(body, /onMoveSession\(sessionId, targetProject\)/, '展开完还是要真的搬');
  });

  test('本来就展开着的组不白改一次状态', () => {
    // 无条件 new Set 会让每次搬动都产生一个新的 collapsed 引用，白触发一轮依赖它的 effect
    assert.match(body, /if \(!prev\.has\(key\)\) return prev;/);
  });

  test('没有别的地方直接调 onMoveSession —— 漏一个入口就漏一种搬法', () => {
    const direct = SIDEBAR.split('\n')
      .map((line, i) => ({ line, no: i + 1 }))
      .filter(({ line }) => /(?<!\.)\bonMoveSession\(/.test(line));
    // 只允许 moveInto 自己那一次（props 类型声明是 `onMoveSession: (...)`，不会被正则捞到）
    assert.equal(
      direct.length, 1,
      `onMoveSession 只该在 moveInto 里被调一次，现在有 ${direct.length} 处：`
      + direct.map((d) => `L${d.no}`).join(', '),
    );
  });

  test('各个入口都走 moveInto', () => {
    assert.match(SIDEBAR, /moveInto\(sessionId, targetProject\);\n\s*\};/, '拖放');
    assert.match(SIDEBAR, /onArchiveSession\(ctxSession\.id, false\);\s*moveInto\(ctxSession\.id, null\);/, '恢复到未分组');
    assert.match(SIDEBAR, /moveInto\(ctxSession\.id, p\)/, '「移动项目」子菜单');
    assert.equal((SIDEBAR.match(/if \(val\) moveInto\(assignPopup\.sessionId, val\);/g) || []).length, 2, '指派弹窗的回车和确认');
  });
});

/**
 * 「我已经在分屏中的会话为什么他的 project 能被折叠呢，一定得是一直展开的啊」。
 */
describe('分屏里有会话的组一直展开', () => {
  test('折叠判据里减掉了"分屏里有它"这一种', () => {
    assert.match(SIDEBAR, /const inSplit = \(key: string\) => sessions\.some\(/);
    assert.match(SIDEBAR, /collapsed\.has\(key\) && !inSplit\(key\)/);
  });

  test('判据和会话行上那个「分屏第 N 格」角标同一个来源 —— 两边不能各算一套', () => {
    const fn = SIDEBAR.slice(SIDEBAR.indexOf('const inSplit ='), SIDEBAR.indexOf('const isCollapsed ='));
    assert.match(fn, /splitOrder\(x\.id\) > 0/);
    assert.match(fn, /!x\.archived/, '归档的不算 —— 它们在自己那个组里');
  });

  test('搜索时照旧全部展开 —— 这一条不受影响', () => {
    assert.match(SIDEBAR, /search\.idle \? \(collapsed\.has\(key\) && !inSplit\(key\)\) : false/);
  });
});

/*
 * 「为什么 blog 这个 project 打开的时候没有预热」。
 *
 * 判据原来是「折叠 → 展开的**跃变**」，靠"上一次渲染时它是折叠的"这个记忆；那个 effect 的依赖里有
 * `onWarmProject`（App 里是内联箭头，每次渲染都是新引用），于是它每次渲染都跑、每跑一次就把"上一次"
 * 覆盖掉 —— 跃变被吃掉，而 `warmed` 里又没记录，这个 project 这次运行里再也不会预热。
 */
describe('展开着的 project 就该是热的（按状态判，不按跃变判）', () => {
  const at = SIDEBAR.indexOf('const warmBaselined');
  const body = SIDEBAR.slice(at, at + 900);

  test('Sidebar 用 projectsToWarmNow 按"此刻展开着"判，跃变那套记忆去掉了', () => {
    assert.ok(at > 0);
    assert.match(body, /projectsToWarmNow\(projects, collapsed, ledger, landed\)/);
    assert.match(body, /for \(const project of toWarm\) onWarmProject\(project\);/);
    assert.equal(SIDEBAR.includes('prevCollapsed'), false, '跃变那套记忆彻底去掉，否则两套判据会打架');
  });

  test('「落到 state 上」按 collapsed 换没换对象判，不按"冷的那些都在 collapsed 里"判', () => {
    assert.match(body, /const landed = collapsed !== collapsedBeforeAuto\.current;/);
    assert.equal(SIDEBAR.includes('cold.every('), false, '那个集合条件会被同一轮的自动展开永久破坏');
    assert.match(SIDEBAR, /collapsedBeforeAuto\.current = collapsed;\s*setCollapsed\(\(prev\) => new Set\(\[\.\.\.prev, \.\.\.cold\]\)\);/);
  });
});

/** 状态顺序的行为测试：照 Sidebar 里几个 effect 的先后，一步步喂给 `projectsToWarmNow` */
describe('projectsToWarmNow：启动记账、之后展开就热', () => {
  const projects = ['A', 'B', 'C'];
  const fresh = () => ({ warmed: new Set<string>(), baselined: false });

  test('自动折叠还没落到 state 上：什么都不热、也不记账', () => {
    const ledger = fresh();
    assert.deepEqual(projectsToWarmNow(projects, new Set(), ledger, false), []);
    assert.equal(ledger.baselined, false);
    assert.equal(ledger.warmed.size, 0);
  });

  test('启动那一遍只记账不预热 —— 冷热由 sessionsToWarm 决定', () => {
    const ledger = fresh();
    assert.deepEqual(projectsToWarmNow(projects, new Set(['A', 'B']), ledger, true), []);
    assert.equal(ledger.baselined, true);
    assert.deepEqual([...ledger.warmed], ['C']);
  });

  test('之后点开一个折叠的组 → 热它，而且只热一次', () => {
    const ledger = fresh();
    projectsToWarmNow(projects, new Set(['A', 'B']), ledger, true);
    assert.deepEqual(projectsToWarmNow(projects, new Set(['A']), ledger, true), ['B']);
    assert.deepEqual(projectsToWarmNow(projects, new Set(['A']), ledger, true), [], '重渲染不再热第二次');
  });

  test('审查发现的顺序：自动折叠 A、B，同一轮里活动会话又把 A 展开 —— 启动那一遍照样结束，之后点开 B 会热', () => {
    const ledger = fresh();
    // 第 1 轮 commit：自动折叠刚 setCollapsed，effect 看到的还是折叠前的对象
    assert.deepEqual(projectsToWarmNow(projects, new Set(), ledger, false), []);
    // 活动会话 effect：A 里有活动会话 → 记成已热（自动展开不触发整组预热），并把 A 从折叠里摘掉
    ledger.warmed.add('A');
    // 第 2 轮：两次 setCollapsed 合并生效，collapsed = {B}（A 已经不在里面了），对象换了 → 落地
    assert.deepEqual(projectsToWarmNow(projects, new Set(['B']), ledger, true), []);
    assert.equal(ledger.baselined, true, '不能因为 A 不在 collapsed 里就永远卡在启动那一遍');
    // 之后你点开 B
    assert.deepEqual(projectsToWarmNow(projects, new Set(), ledger, true), ['B']);
  });
});
