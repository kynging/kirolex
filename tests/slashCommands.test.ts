import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { toSlashCommands } from '../src/renderer/slashCommands.ts';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

/**
 * 「原先增加过一个 kiro 命令比如 clear agent model 的自动识别怎么没有了」。
 *
 * 输入框里打 `/` 会弹出后端**这条会话真正支持**的那些命令（`/clear`、`/agent`、`/model`…），
 * 表由后端在 `_kiro.dev/commands/available` 里推来。查下来功能一直在，坏的是那份表的**寿命**：
 * 后端一条会话只推一次（连上之后），而渲染进程原来只把它放在一个内存 Map 里 —— 窗口一重载
 * （开发时一次 HMR 也算）就空了，后端不会再推，于是打 `/` 什么都不弹，直到你新建会话或重连。
 *
 * 修法和 agent 列表那次同一个形状：**放到活得更久的那一层**（主进程），空了就去取。
 */
describe('斜杠命令表要活过一次窗口重载', () => {
  const MAIN = read('src/main/index.ts');
  const ACP = read('src/renderer/hooks/useAcp.ts');
  const PRE = read('src/main/preload.ts');

  test('主进程把推来的那份留在会话上', () => {
    assert.match(MAIN, /commands\?: any\[\];/);
    assert.match(MAIN, /if \(data\?\.update\?\.method === '_kiro\.dev\/commands\/available' && Array\.isArray\(data\.update\.commands\)\) \{/);
    assert.match(MAIN, /entry\.commands = data\.update\.commands;/);
    /* 存**原始形状**：解析只有渲染进程那一处，两条路才一定一致 */
    assert.doesNotMatch(MAIN, /toSlashCommands/);
  });

  test('**同一份表不重复记日志** —— 后端一次启动推了 10 次，内容一条没变', () => {
    /*
      实测：06:47:23 那 160ms 里九次 `commands: 25 条`，之后又一次，25 条一条没变 —— 像是每个
      MCP server 初始化完就重发整表（合理，MCP 可以带命令）。不是重复监听：同一份日志里
      `[prompt] done` 只有一条。代价是一行没有信息量的日志刷十遍，盖住同一时刻真正该看的东西。
    */
    const at = MAIN.indexOf("if (data?.update?.method === '_kiro.dev/commands/available'");
    const body = MAIN.slice(at, at + 1600);
    assert.match(body, /if \(names !== before\) \{/);
    /* 比名字，不比整对象：描述/提示词后端可能顺手改字，而这行日志答的是"能用哪些命令" */
    assert.match(body, /const names = data\.update\.commands\.map\(\(c: any\) => String\(c\?\.name \|\| ''\)\)\.join\(','\);/);
    /* 缓存照旧每次都写 —— 那是幂等的，而且描述真变了也该跟上 */
    assert.ok(body.indexOf('entry.commands = data.update.commands;') < body.indexOf('if (names !== before)'));
  });

  test('有个口能把它取回来，拿不到就是空数组（照旧不弹菜单，不会更差）', () => {
    assert.match(MAIN, /ipcMain\.handle\('acp:session-commands'/);
    const h = MAIN.slice(MAIN.indexOf("ipcMain.handle('acp:session-commands'"));
    assert.match(h.slice(0, 400), /Array\.isArray\(entry\?\.commands\) \? entry!\.commands : \[\]/);
    assert.match(PRE, /sessionCommands: \(sessionId: string\) => ipcRenderer\.invoke\('acp:session-commands', sessionId\)/);
  });

  test('渲染进程**空了才取**，选中会话时补一次', () => {
    assert.match(ACP, /if \(!sid \|\| commandsMapRef\.current\.get\(sid\)\?\.length\) return;/);
    assert.match(ACP, /if \(currentSessionId\) void fetchCommands\(currentSessionId\);/);
    /* 取回来只在它还是当前会话时才更新界面 —— 中间你可能已经切走了 */
    assert.match(ACP, /if \(currentSessionRef\.current === sid\) setCommands\(rows\);/);
  });

  test('**两条路共用一段解析** —— 各写一遍的话，同一条会话会因为"表从哪来"而表现不同', () => {
    const SC = read('src/renderer/slashCommands.ts');
    assert.match(SC, /export function toSlashCommands\(raw: unknown\): SlashCommand\[\]/);
    /* 判据自己一个文件（可测），`useAcp` 只是两条路各调一次 */
    assert.equal((ACP.match(/toSlashCommands\(/g) || []).length, 2);
  });

  test('解析本身：拿名字和 meta 里的提示，形状不对的丢掉', () => {
    const rows = toSlashCommands([
      { name: '/clear', description: 'Clear the conversation' },
      { name: '/agent', meta: { hint: '<name>', subcommands: ['list', 'set'] } },
      { description: '没有名字，丢掉' },
      'not an object',
    ]);
    assert.deepEqual(rows, [
      { name: '/clear', description: 'Clear the conversation', hint: undefined, subcommands: undefined },
      { name: '/agent', description: undefined, hint: '<name>', subcommands: ['list', 'set'] },
    ]);
  });

  test('不是数组一律空数组 —— 一份读不懂的表不该把输入框弄崩', () => {
    assert.deepEqual(toSlashCommands(undefined), []);
    assert.deepEqual(toSlashCommands(null), []);
    assert.deepEqual(toSlashCommands({ commands: [] }), []);
  });

  test('菜单本身还在（这次没动它）—— 按 `/` 之后按前缀过滤', () => {
    const CHAT = read('src/renderer/components/ChatArea.tsx');
    assert.match(CHAT, /className="slash-command-menu"/);
    assert.match(CHAT, /commands\.filter\(\(command\) => command\.name\.toLowerCase\(\)\.startsWith\(`\/\$\{slashMatch\[1\]\.toLowerCase\(\)\}`\)\)/);
  });
});
