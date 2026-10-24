import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { markForwardUnavailable, clearForwardUnavailable, unavailableForwardHelp } from '../src/main/forwardMcp.ts';
import { remoteContextBlock } from '../src/main/remoteContext.ts';
import { sessionInfoRows, sessionInfoText } from '../src/renderer/sessionInfo.ts';
import { startLocalMcp } from '../src/main/localMcp.ts';

/*
 * 跟进 8c4af3fa：HTTP MCP 探测失败时以前只发一条会话提示，`localToolsBySession` 里照旧当它拿到了 ——
 * 会话信息的「本机工具」照列、注入给模型的运行环境说明也照列为可用。
 * 这里守：记下失败和原因；两处都标「不可用」；下次调用成功 / 重连重探成功后恢复。
 */

const tr = (s: string, vars?: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_m, k) => String(vars?.[k] ?? ''));

describe('记下 / 清掉不可用', () => {
  test('探测失败记一条（同名再失败只更新原因），成功后清掉并告诉调用方变了没有', () => {
    const spec: { unavailable?: Array<{ name: string; reason: string }> } = {};
    markForwardUnavailable(spec, 'mx', '鉴权失败');
    markForwardUnavailable(spec, 'mx', '连不上');
    markForwardUnavailable(spec, 'other', 'x');
    assert.deepEqual(spec.unavailable, [{ name: 'mx', reason: '连不上' }, { name: 'other', reason: 'x' }]);
    assert.equal(clearForwardUnavailable(spec, 'mx'), true);
    assert.equal(clearForwardUnavailable(spec, 'mx'), false, '已经是可用的：没变化');
    assert.equal(clearForwardUnavailable({}, 'mx'), false);
    assert.deepEqual(spec.unavailable, [{ name: 'other', reason: 'x' }]);
  });

  test('原因为空时也有一句', () => {
    const spec: { unavailable?: Array<{ name: string; reason: string }> } = {};
    markForwardUnavailable(spec, 'mx', '');
    assert.ok(spec.unavailable![0].reason.length > 0);
  });
});

describe('运行环境说明：不可用的不再列为可用', () => {
  const base = { hostLabel: 'ec2', remoteDir: '/home/u/w', localDir: 'C:\\u', forwarded: ['playwright'], forwardedHttp: ['mx', 'ok-http'] };

  test('不可用的从「接过来的工具」和「中转」两句里拿掉，另起一句注明当前不可用和原因', () => {
    const t = remoteContextBlock({ ...base, unavailable: [{ name: 'mx', reason: '本机→上游（mx）鉴权失败：HTTP 401' }] });
    const got = t.split('\n').find((l) => l.includes('这一轮从用户机器接过来的工具'))!;
    assert.match(got, /`playwright`/);
    assert.match(got, /`ok-http`/);
    assert.doesNotMatch(got, /`mx`/);
    const relay = t.split('\n').find((l) => l.includes('由 KiroLex 从用户机器中转'))!;
    assert.doesNotMatch(relay, /`mx`/);
    assert.match(relay, /`ok-http`/);
    assert.match(t, /当前不可用.*`mx`.*鉴权失败：HTTP 401/);
  });

  test('全都不可用：中转那句不出现，接过来的工具只剩 kirolex-local', () => {
    const t = remoteContextBlock({ hostLabel: 'ec2', remoteDir: '/r', localDir: '/l', forwardedHttp: ['mx'], unavailable: [{ name: 'mx', reason: 'r' }] });
    assert.doesNotMatch(t, /由 KiroLex 从用户机器中转/);
    assert.match(t, /这一轮从用户机器接过来的工具.*只有 `kirolex-local`/);
    assert.match(t, /当前不可用.*`mx`/);
  });

  test('没有不可用的：和以前一样，没有那句', () => {
    const t = remoteContextBlock(base);
    assert.doesNotMatch(t, /当前不可用/);
    assert.equal(unavailableForwardHelp([]), '');
  });
});

describe('会话信息：标「不可用（原因）」', () => {
  const info = {
    id: 's_1_abcdef', engine: 'claude' as const, remote: { label: 'gpu', sshHost: 'u@h' }, dir: '/d',
    localTools: {
      state: 'ready' as const, forwarded: ['playwright', 'mx'],
      skipped: [{ name: 'gone', reason: '没定义' }],
      unavailable: [{ name: 'mx', reason: '鉴权失败' }],
    },
  };

  test('本机工具那一行：不可用的带原因，可复制的只有能用的', () => {
    const row = sessionInfoRows(info, tr).find((r) => r.key === 'tools')!;
    assert.match(row.value, /kirolex-local, playwright/);
    assert.match(row.value, /mx \(unavailable: 鉴权失败\)/);
    assert.match(row.value, /not forwarded: gone \(没定义\)/);
    assert.equal(row.copy, 'kirolex-local, playwright');
  });

  test('「全部复制」的 localTools= 里不含不可用的', () => {
    assert.match(sessionInfoText(info), /^localTools=kirolex-local,playwright$/m);
  });

  test('没有 unavailable 字段（老数据）照旧', () => {
    const row = sessionInfoRows({ ...info, localTools: { state: 'ready', forwarded: ['mx'], skipped: [] } }, tr).find((r) => r.key === 'tools')!;
    assert.equal(row.value, 'kirolex-local, mx');
  });
});

describe('下次调用成功 → 通知主进程恢复', () => {
  test('HTTP 转发拿到正常答复时调 onProxyOk；上游报错 / 连不上时不调', async () => {
    let healthy = false;
    const up = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        if (!healthy) { res.writeHead(401).end('no'); return; }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } }));
      });
    });
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(up.address() as any).port}/mcp`;
    const oks: string[] = [];
    const server = await startLocalMcp({ log: () => {}, notice: () => {}, onProxyOk: (sid, name) => oks.push(`${sid}/${name}`) });
    try {
      const token = server.register({ sessionId: 's1', workdir: process.cwd() });
      server.setProxies('s1', [{ type: 'http', name: 'mx', url }]);
      const call = async () => (await fetch(`http://127.0.0.1:${server.port()}/mcp/${token}/mx`, {
        method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })).json();
      const bad: any = await call();
      assert.ok(bad.error);
      assert.deepEqual(oks, []);
      healthy = true;
      const good: any = await call();
      assert.ok(good.result);
      assert.deepEqual(oks, ['s1/mx']);
      /* kirolex-local 自己的调用不算 */
      await fetch(`http://127.0.0.1:${server.port()}/mcp/${token}`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
      assert.deepEqual(oks, ['s1/mx']);
    } finally {
      server.stop();
      await new Promise<void>((r) => { up.closeAllConnections?.(); up.close(() => r()); });
    }
  });
});

describe('接线（源码扫描）', () => {
  const M = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const at = M.indexOf('async function ensureLocalTools(');
  const body = M.slice(at, M.indexOf('\n}\n', at));

  test('两条分支的探测都在 localToolsBySession.set 之后、结果都交给 noteHttpProbe（失败才能记到这份 spec 上）', () => {
    /* 探测挪进 watchHttpForwards（两条分支各调一次）：调用都在 spec 登记之后，里面的结果都交给 noteHttpProbe */
    const calls = [...body.matchAll(/\n\s*watchHttpForwards\(sessionId, spec, /g)];
    assert.equal(calls.length, 2);
    for (const c of calls) {
      const before = body.slice(0, c.index);
      assert.ok(before.lastIndexOf('localToolsBySession.set(sessionId, spec);') > before.lastIndexOf('const spec'), '先登记 spec 再探测');
    }
    const at = M.indexOf('function startHttpWatch(');
    const w = M.slice(at, M.indexOf('\n}\n', at));
    assert.match(w, /const probe = \(\) => probeHttpMcp\(h, log\);/);
    assert.match(w, /\n\s*probe,\n/);
    assert.match(w, /noteResult: \(r\) => noteHttpProbe\(sessionId, spec, h\.name, r\)/);
    /* 失败记下了（noteHttpProbe 回 true）才说，且只在第一次失败时说（规则在 watchHttpForward） */
    const rf = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'forwardReconnect.ts'), 'utf8');
    assert.match(rf, /if \(d\.noteResult\(r\) && failures === 1\) d\.noticeFailed\(r, d\.mounted\);/);
    assert.match(w, /noticeFailed: \(r, isMounted\) => noteInSession\(sessionId,\n\s*isMounted \? httpDroppedNotice\(h\.name, r\.error \|\| ''\) : httpPendingNotice\(h\.name, r\.error \|\| ''\)/);
  });

  test('noteHttpProbe：失败记到当前这份 spec 并要求提示（被重连换掉的不记、不提示），成功清掉', () => {
    const fat = M.indexOf('function noteHttpProbe(');
    assert.ok(fat > 0);
    const fn = M.slice(fat, M.indexOf('\n}\n', fat));
    assert.match(fn, /if \(localToolsBySession\.get\(sessionId\) !== spec\) return false;/);
    assert.match(fn, /markForwardUnavailable\(spec, /);
    assert.match(fn, /clearForwardUnavailable\(spec, /);
    assert.match(fn, /return true;/);
  });

  test('本地 MCP 服务的 onProxyOk 清掉不可用；会话信息和运行环境说明都带上 unavailable', () => {
    assert.match(M, /onProxyOk: forwardRecovered,/);
    const fr = M.slice(M.indexOf('function forwardRecovered('));
    assert.match(fr.slice(0, 500), /clearForwardUnavailable\(lt, name\)/);
    const si = M.slice(M.indexOf("ipcMain.handle('acp:session-info'"));
    assert.match(si.slice(0, 4000), /unavailable: lt\.unavailable \|\| \[\]/);
    const rc = M.slice(M.indexOf('function remoteContextFor('));
    assert.match(rc.slice(0, 3000), /unavailable: localToolsBySession\.get\(sessionId\)\?\.unavailable/);
  });
});
