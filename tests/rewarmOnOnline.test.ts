import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

/*
  **断线之后要能自己回来** ——「我看到现在远程会话断了，为什么没有自动刷新」。

  原来的链条断在一个很具体的地方：`disconnected` 事件上的 AUTO-RECOVERY 只试**一次**
  （600ms 后），失败就 `stay dormant`。那次失败的原因是笔记本 VPN 掉线
  （`ssh: connect to host … Network is unreachable`），之后 2.5 小时没有任何东西再试。

  这些判据盯的是**接线**，不是实现细节：App 必须在 `online`/`focus` 上重接看得见的会话，
  而且不能把全部会话一次拉起来（31 条 × ssh 握手会撑满 sshd 的 MaxStartups）。
*/
const app = fs.readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

/** 把那个 effect 的代码单独取出来 —— 判据只对它生效，别被同名的别处写法蒙过去。 */
function rewarmEffect(): string {
  const at = app.indexOf('const rewarm = () => {');
  assert.ok(at > 0, '找不到 rewarm 那个监听器');
  return app.slice(at, at + 900);
}

test('online 和 focus 两个事件都接了 —— 只接一个会漏掉另一半', () => {
  const body = rewarmEffect();
  assert.match(body, /addEventListener\('online', rewarm\)/);
  assert.match(body, /addEventListener\('focus', rewarm\)/);
  /* 摘挂要成对，否则每次 warmSession 变化都多留一个监听器 */
  assert.match(body, /removeEventListener\('online', rewarm\)/);
  assert.match(body, /removeEventListener\('focus', rewarm\)/);
});

test('只重接看得见的那几条，不是全部会话', () => {
  const body = rewarmEffect();
  assert.match(body, /panesRef\.current/);
  /*
    不能出现"遍历所有会话"的形状。31 条远程会话一起 attach 会撞 sshd 的 MaxStartups，
    而那正是之前"连不上"的成因之一。
  */
  assert.equal(/for \(const [a-z]+ of sessions\b/.test(body), false, '不该遍历 sessions');
  assert.equal(/sessions\.(map|forEach)\(/.test(body), false, '不该遍历 sessions');
});

test('有节流 —— focus 在切窗口时很密', () => {
  const body = rewarmEffect();
  assert.match(body, /lastRewarmRef/);
  assert.match(body, /Date\.now\(\) - lastRewarmRef\.current < 5_?000/);
});

test('依赖里没有 panes —— 放进去会让监听器反复摘挂', () => {
  const at = app.indexOf('const rewarm = () => {');
  const tail = app.slice(at, at + 1600);
  const dep = /\}, \[([^\]]*)\]\);/.exec(tail)?.[1] || '';
  assert.equal(dep.includes('panes'), false, `依赖里不该有 panes（现在是 [${dep}]）`);
  assert.match(dep, /warmSession/);
});

test('panesRef 在用它的 effect 之前声明', () => {
  assert.ok(
    app.indexOf('const panesRef = useRef<string[]>([]);') < app.indexOf('const rewarm = () => {'),
    'ref 的声明要在 effect 前面，否则读起来是倒的',
  );
});
