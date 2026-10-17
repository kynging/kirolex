import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRpc, type LocalMcpDeps } from '../src/main/localMcp.ts';

/* local_browser_* 挂在本地工具通道上：总开关控制出不出现；本地会话（browserOnly）只给浏览器那几个 */

function deps(enabled: boolean, calls: any[] = []): LocalMcpDeps {
  return {
    log: () => {},
    notice: () => {},
    browser: {
      enabled: () => enabled,
      call: async (name, args, sessionId) => { calls.push({ name, args, sessionId }); return { text: `ok ${name}` }; },
    },
  };
}

const list = async (d: LocalMcpDeps, browserOnly?: boolean): Promise<string[]> => {
  const r = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { sessionId: 's', workdir: '.', browserOnly }, d);
  return r.result.tools.map((t: any) => t.name);
};

test('总开关关着：工具清单里没有 local_browser_*，调到了说"没开"', async () => {
  const names = await list(deps(false));
  assert.ok(names.includes('local_read'));
  assert.ok(!names.some((n) => n.startsWith('local_browser_')));
  const r = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'local_browser_tabs', arguments: {} } },
    { sessionId: 's', workdir: '.' }, deps(false));
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /没开/);
});

test('开着：远程会话的清单 = 文件工具 + 浏览器工具；调用带着会话 id 转给浏览器那层', async () => {
  const calls: any[] = [];
  const names = await list(deps(true, calls));
  assert.ok(names.includes('local_bash') && names.includes('local_browser_open'));
  const r = await handleRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'local_browser_open', arguments: { url: 'https://x' } } },
    { sessionId: 'sess-9', workdir: '.' }, deps(true, calls));
  assert.equal(r.result.content[0].text, 'ok local_browser_open');
  assert.deepEqual(calls, [{ name: 'local_browser_open', args: { url: 'https://x' }, sessionId: 'sess-9' }]);
});

test('本地会话（browserOnly）：只列、只认浏览器工具', async () => {
  const names = await list(deps(true), true);
  assert.deepEqual(names, ['local_browser_tabs', 'local_browser_open', 'local_browser_read', 'local_browser_screenshot', 'local_browser_close']);
  const r = await handleRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'local_bash', arguments: { command: 'echo hi' } } },
    { sessionId: 's', workdir: '.', browserOnly: true }, deps(true));
  assert.equal(r.result.isError, true);
});
