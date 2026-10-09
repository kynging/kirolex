import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { savedScrollOf, scrollStep } from '../src/renderer/tabScroll.ts';

/**
 * 右侧预览标签开回来要停在上次的位置 —— 存档里的位置怎么读、每一步往哪滚。
 */
describe('savedScrollOf reads the saved position, old archives mean top', () => {
  test('old entries without scroll, and junk values, are the top', () => {
    assert.equal(savedScrollOf({ path: '/a.md', raw: false }), 0);
    assert.equal(savedScrollOf(undefined), 0);
    assert.equal(savedScrollOf(null), 0);
    assert.equal(savedScrollOf({ scroll: 'abc' }), 0);
    assert.equal(savedScrollOf({ scroll: -40 }), 0);
    assert.equal(savedScrollOf({ scroll: Infinity }), 0);
  });
  test('a real position comes back (rounded)', () => {
    assert.equal(savedScrollOf({ path: '/a.md', scroll: 1834 }), 1834);
    assert.equal(savedScrollOf({ scroll: 120.6 }), 121);
    assert.equal(savedScrollOf({ scroll: '300' }), 300);
  });
});

describe('scrollStep: reach the target, or wait at the bottom for content to grow', () => {
  test('tall enough: go straight there', () => {
    assert.deepEqual(scrollStep(1200, 5000, 800), { top: 1200, reached: true });
  });
  test('content still short: sit at the bottom and keep waiting', () => {
    assert.deepEqual(scrollStep(1200, 1500, 800), { top: 700, reached: false });
  });
  test('content shorter than the viewport: top, not negative', () => {
    assert.deepEqual(scrollStep(1200, 300, 800), { top: 0, reached: false });
  });
  test('target exactly at the end counts as reached', () => {
    assert.deepEqual(scrollStep(4200, 5000, 800), { top: 4200, reached: true });
  });
  test('top target is always reached', () => {
    assert.deepEqual(scrollStep(0, 0, 0), { top: 0, reached: true });
    assert.deepEqual(scrollStep(NaN, 100, 50), { top: 0, reached: true });
  });
});

/** 假的滚动面板：高度可以慢慢长，记得谁在监听用户输入。 */
function fakeBody(scrollHeight: number, clientHeight = 800) {
  const listeners: Record<string, Function[]> = {};
  const body: any = {
    scrollTop: 0, scrollHeight, clientHeight,
    querySelector: () => null,
    addEventListener: (ev: string, fn: Function) => { (listeners[ev] ||= []).push(fn); },
    removeEventListener: (ev: string, fn: Function) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); },
    fire: (ev: string) => { for (const fn of listeners[ev] || []) fn(); },
    listening: () => Object.values(listeners).some((l) => l.length > 0),
  };
  return body;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('restoreScroll keeps trying while content grows, and yields to the user', async () => {
  (globalThis as any).requestAnimationFrame ||= (cb: () => void) => setTimeout(cb, 0);
  const { restoreScroll } = await import('../src/renderer/tabScroll.ts');

  test('waits for the content to get tall enough, then stops', async () => {
    const body = fakeBody(1000);
    let stopped = false;
    restoreScroll(body, 2000, () => { stopped = true; }, 3000);
    await sleep(150);
    assert.equal(body.scrollTop, 200, 'parked at the bottom so far');
    assert.equal(stopped, false);
    body.scrollHeight = 6000;                       // 内容长上来了
    await sleep(300);
    assert.equal(body.scrollTop, 2000);
    assert.equal(stopped, true);
    assert.equal(body.listening(), false);
  });

  test('file got shorter: ends at the bottom when the time runs out', async () => {
    const body = fakeBody(1500);
    let stopped = false;
    restoreScroll(body, 5000, () => { stopped = true; }, 300);
    await sleep(600);
    assert.equal(body.scrollTop, 700);
    assert.equal(stopped, true);
  });

  test('the user scrolling by hand stops it — no pulling back', async () => {
    const body = fakeBody(1000);
    let stopped = false;
    restoreScroll(body, 3000, () => { stopped = true; }, 3000);
    await sleep(150);
    body.fire('wheel');
    assert.equal(stopped, true);
    body.scrollTop = 50;
    body.scrollHeight = 9000;
    await sleep(300);
    assert.equal(body.scrollTop, 50);
  });
});

/**
 * 预览栏藏着重启 → 开回标签那一下滚动容器根本没挂上；展开时标签 id / 内容都没变。
 * 所以"滚回原处"也要跟着容器节点本身：它一挂上（展开、重新挂载）就再滚一次。
 */
test('scroll restore re-runs when the preview body mounts again (panel was hidden across a restart)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const APP = fs.readFileSync(path.join(process.cwd(), 'src/renderer/App.tsx'), 'utf8');
  assert.ok(APP.includes('ref={setFileBody}'), 'the body uses the callback ref, not the bare ref');
  assert.ok(/const setFileBody = useCallback\(\(node: HTMLDivElement \| null\) => \{\s*fileBodyRef\.current = node;\s*setFileBodyNode\(node\);/.test(APP));
  assert.ok(APP.includes('}, [activeFileTabId, fileViewer?.content, scrollRestoreTick, fileBodyNode]);'));
  /* 藏着的时候容器确实不渲染 —— 这正是需要上面那一条的原因 */
  assert.ok(APP.includes('{(fileViewerLoading || fileViewer) && !fileViewerHidden && ('));
});
