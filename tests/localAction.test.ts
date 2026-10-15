import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseLocalActions, localActionHelp, LOCAL_MARKER, MAX_LOCAL_ACTIONS_PER_TURN,
} from '../src/main/localAction.ts';

/*
 * 「那个本地工具调用的问题你能不能想想办法」/「想办法让它打开本地的 chrome 我看看进度」。
 *
 * 远程会话的**所有**工具都在那台机器上跑（kiro-cli 自己拥有工具，ACP 上拦不住也加不了 ——
 * 实测它连客户端声明的 `fs` 能力都不用）。于是它起了服务想让你看一眼，只能 `curl`：
 * 在一台没有图形界面的机器上 `open` 一个 URL，最好的结果是什么都没发生。
 * 这一层是那条窄通道 —— 而通道的**边界**比功能重要。
 */
describe('远程会话要求本地打开一个页面', () => {
  test('认标记，允许 markdown 的装饰（模型一定会包点什么）', () => {
    for (const line of [
      `${LOCAL_MARKER}: open https://example.com/x`,
      `- ${LOCAL_MARKER}: open https://example.com/x`,
      `**${LOCAL_MARKER}**: open \`https://example.com/x\``,
      `${LOCAL_MARKER}：open https://example.com/x`,          // 中文冒号
      `kirolex-local: open https://example.com/x`,            // 大小写不敏感
    ]) {
      const { actions } = parseLocalActions(line);
      assert.equal(actions.length, 1, line);
      assert.equal(actions[0].target, 'https://example.com/x');
    }
  });

  test('**只有 open**，别的动词一律不执行而且要说出来', () => {
    const { actions, rejected } = parseLocalActions(`${LOCAL_MARKER}: run rm -rf /`);
    assert.deepEqual(actions, []);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].why, /只支持 open/);
  });

  test('**只收 http(s)** —— 别的 scheme 在 macOS 上就是应用启动器', () => {
    for (const bad of [
      'file:///Users/keyinan/.aws/credentials',
      'javascript:alert(1)',
      'x-apple-something://do',
      '/Users/keyinan/secret.pem',
      'vscode://file/etc/passwd',
    ]) {
      const { actions, rejected } = parseLocalActions(`${LOCAL_MARKER}: open ${bad}`);
      assert.deepEqual(actions, [], bad);
      assert.equal(rejected.length, 1, bad);
    }
  });

  test('没给地址 / 地址不合法都拒绝（并且说清为什么）', () => {
    assert.match(parseLocalActions(`${LOCAL_MARKER}: open`).rejected[0].why, /没给地址/);
    assert.equal(parseLocalActions(`${LOCAL_MARKER}: open https://`).actions.length, 0);
  });

  test('普通文字里出现这个词不算（必须是标记那一行的形状）', () => {
    assert.deepEqual(parseLocalActions(`我用 ${LOCAL_MARKER} 这个通道给你开页面`).actions, []);
    assert.deepEqual(parseLocalActions('随便说点什么 https://example.com').actions, []);
  });

  test('注入里必须给**例子** —— 只说"有这条通道"它会自己发明格式，而格式错了是静默失败', async () => {
    const help = localActionHelp();
    assert.match(help, new RegExp(`${LOCAL_MARKER}: open <http`));
    const { remoteContextBlock } = await import('../src/main/remoteContext.ts');
    const b = remoteContextBlock({ hostLabel: 'tokyo-ec2', remoteDir: '/r/proj', localDir: '/l' });
    assert.ok(b.includes(localActionHelp()), '注入里要带这段');
    /* 同时要说清"浏览器不在这台机器上" —— 否则它还是会去试 xdg-open */
    assert.match(b, /浏览器在\*\*他自己的机器\*\*上/);
  });
});

describe('接线：边流边认，额度守住，每次都说出来', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('只有远程会话走这条路（本地会话它自己就能 open）', () => {
    assert.match(M, /if \(entry\.profile\.remote\?\.sshHost\) runLocalActions\(sessionId, entry, u\?\.content\?\.text \|\| ''\);/);
  });

  test('**按整行**解析 —— 半行会把 URL 截成另一个仍然合法的地址', () => {
    assert.match(M, /const buf = `\$\{entry\.localLineBuf \|\| ''\}\$\{chunk\}`;/);
    assert.match(M, /entry\.localLineBuf = lines\.pop\(\) \|\| '';/);
    /* 上一轮的半行不能拼到这一轮的第一行上 */
    assert.match(M, /entry\.localLineBuf = '';\s+\/\/ 上一轮的半行/);
  });

  test('额度按轮给，同一个地址一条会话只开一次', () => {
    assert.match(M, /entry\.localActionsThisTurn = 0;/);
    assert.match(M, /if \(entry\.openedLocally\?\.has\(a\.target\)\) continue;/);
    assert.match(M, />= MAX_LOCAL_ACTIONS_PER_TURN/);
    assert.equal(MAX_LOCAL_ACTIONS_PER_TURN, 2);
  });

  test('开了什么、是谁要求的，必须在状态行说出来', () => {
    assert.match(M, /Opened `\{target\}` in \*\*your\*\* browser/);
    assert.match(M, /\(requested by the agent on \{host\}\)\.', \{ target: a\.target, host \}/);
    /* 打不开也要说 —— 静静地什么都没发生是最糟的那种 */
    assert.match(M, /but it couldn\\'t be opened: \{error\}', \{ target: a\.target, error: String\(err\?\.message \|\| err\) \}/);
  });
});

/*
 * 实测（远程会话真跑了一轮）暴露的接线 bug。
 *
 * 原来这里还有一条"摆渡只看你自己写的那段文字"——那是镜像时代的东西（把你提到的文件拷进镜像），
 * 镜像和 `localFileBridge` 已经整个删掉了（远端直接用 `local_read` 读你机器上那一份）。
 */
describe('实测踩到的两个坑', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('**回复最后一行没有换行符** —— 收尾必须把缓冲里那半行当成一整行处理', () => {
    /* 实测：整个回复就是一行 `KIROLEX-LOCAL: open https://…`，没有 \n，
       于是它一直躺在 localLineBuf 里，一轮都结束了也没人执行。 */
    assert.match(M, /if \(entry\.profile\.remote\?\.sshHost\) runLocalActions\(sessionId, entry, '\\n'\);/);
    const flush = M.indexOf("runLocalActions(sessionId, entry, '\\n')");
    const done = M.indexOf("logger.info('prompt', `done sessionId=");
    assert.ok(flush > 0 && done > flush, '要在这一轮判定结束之前冲一次');
  });

});
