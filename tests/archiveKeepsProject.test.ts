import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

/*
  **归档不该销毁项目绑定** ——「可是你现在所有的 archive 会话都显示在未分组中」。

  原来 `acp:archive-session` 里有 `if (archived) rec.profile.projectId = undefined`。
  它想保证"归档期间不带项目记忆"，但那件事已经被别的守卫满足了（归档会话发不了消息）；
  代价却是备份界面按项目分组时所有归档会话掉进「未分组」，而且取消归档回不到原项目。
  这个代价不可逆：记录里没有第二处记着这个对应关系，`localDir` 同时也被清掉。
*/
const raw = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');

/**
 * 把注释剥掉再断言。
 *
 * **这是必须的**：解释"原来为什么错"的注释里必然出现那段被删掉的代码，
 * 直接 grep 源码会命中自己的注释，于是判据永远通不过（这个坑踩过几次）。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}
const code = stripComments(raw);

/** 取一个 ipcMain.handle 的代码体（已剥注释）。 */
function handlerBody(channel: string): string {
  const at = code.indexOf(`ipcMain.handle('${channel}'`);
  assert.ok(at > 0, `找不到 ${channel}`);
  return code.slice(at, at + 1200);
}

test('归档不再把 projectId 抹成 undefined', () => {
  const body = handlerBody('acp:archive-session');
  assert.match(body, /rec\.archived = !!archived/);
  assert.equal(
    /projectId\s*=\s*undefined/.test(body), false,
    '归档时又在抹 projectId —— 备份界面会把所有归档会话塞进「未分组」，而且这一步不可逆',
  );
});

test('"归档期间不带项目记忆"改成显式守卫 —— 它不能再靠那个被抹掉的字段', () => {
  /*
    字段留着了，所以这条不变量必须自己站得住：归档会话一轮都不该产生。
    判据盯 prompt 这条路，因为项目记忆只在 prompt 时注入。
  */
  const at = code.indexOf('deletedSessionIds.has(sessionId)');
  assert.ok(at > 0);
  const near = code.slice(at, at + 900);
  assert.match(near, /readRecord\(sessionId\)\?\.archived/, 'prompt 路径上没有归档守卫');
  assert.match(near, /throw new Error\(/);
});

test('侧栏按项目分组仍然筛掉归档 —— 保留 projectId 不该让它们跑回侧栏', () => {
  const app = stripComments(fs.readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8'));
  assert.match(app, /\(s\.projectId \|\| ''\) !== project \|\| s\.archived\) continue/);
});
