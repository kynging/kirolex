import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import { BgJobManager } from '../src/main/bgJobs.ts';
import { bannerBgJobs, bgRerunDetails, bgRunnerLost, type BgJobRow } from '../src/renderer/bgJobsView.ts';

/**
 * 后台任务跨电脑同步的接线：同步来的任务不进本机进程表、不发唤醒；「在本机重新运行」前弹确认且显示命令全文；
 * 停止请求由跑它的那台执行（只停本机表里在跑的那条）。index.ts / ChatArea.tsx 不能 import，按源码锚点截一段断言。
 */

const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf-8');
const MAIN = read('../src/main/index.ts');
const CHAT = read('../src/renderer/components/ChatArea.tsx');
const APP = read('../src/renderer/App.tsx');
const PRELOAD = read('../src/main/preload.ts');

const fnBody = (src: string, start: string, end: string) => {
  const at = src.indexOf(start);
  assert.ok(at >= 0, `missing ${start}`);
  const stop = src.indexOf(end, at + start.length);
  assert.ok(stop > at, `missing end ${end}`);
  return src.slice(at, stop);
};

describe('同步来的后台任务：不进本机进程表、不在本机起进程、不叫醒会话', () => {
  const sync = fnBody(MAIN, 'async function syncBgJobsWithBucket(', '\nlet bgPushTimer');

  test('同步函数里没有起进程、没有唤醒、没有往会话里写', () => {
    assert.ok(!sync.includes('bgJobs.start('), '同步时在本机起了进程');
    assert.ok(!sync.includes('wakeDispatcher.enqueue'), '同步时叫醒了会话');
    assert.ok(!sync.includes('noteInSession('), '同步时往会话里写了东西（唤醒 / 结束消息只由跑它的那台写）');
    /* 别的电脑的只进 foreign 账 */
    assert.match(sync, /applyFetchedState\(l, a\.jobId, parsed, a\.etag, me\.id, ownIds\)/);
  });

  test('bgJobs.start 在 index.ts 里只出现在「在本机重新运行」那个 handler 里（模型的 bg_run 走 wakeTools 的 host.bg）', () => {
    const starts = [...MAIN.matchAll(/bgJobs\.start\(/g)].map((m) => m.index!);
    const rerun = MAIN.indexOf("ipcMain.handle('bg:rerun-here'");
    const rerunEnd = MAIN.indexOf('\n  });', rerun);
    assert.ok(starts.length >= 1);
    for (const at of starts) assert.ok(at > rerun && at < rerunEnd, 'bgJobs.start 出现在 bg:rerun-here 以外的地方');
  });

  test('bg:list 把别的电脑的拼在后面，只是显示；bg:request-stop 不碰本机进程', () => {
    const list = fnBody(MAIN, "ipcMain.handle('bg:list'", '\n  });');
    assert.ok(list.includes('return [...own, ...foreignBgRows()];'));
    assert.ok(list.includes('bgJobs.list().map('), '本机那部分不是本机进程表');
    const req = fnBody(MAIN, "ipcMain.handle('bg:request-stop'", '\n  });');
    assert.ok(!/bgJobs\./.test(req), 'request-stop 碰了本机进程表');
    assert.ok(req.includes('stopRequestedAt: Date.now()'));
    assert.ok(PRELOAD.includes("bgRequestStop: (jobId: string) => ipcRenderer.invoke('bg:request-stop', jobId)"));
  });
});

describe('停止请求由跑它的那台执行', () => {
  const sync = fnBody(MAIN, 'async function syncBgJobsWithBucket(', '\nlet bgPushTimer');

  test('只按 planStopRequests 停本机表里的那条；停的是它自己起的进程（BgJobManager.stop），停完删掉请求', () => {
    const plan = sync.indexOf('planStopRequests(requests, bgJobs.listForSync())');
    const stop = sync.indexOf("await bgJobs.stop(s.jobId, 'user', s.sessionId);");
    assert.ok(plan > 0 && stop > plan);
    assert.ok(sync.indexOf("bgObjectRel(s.sessionId, s.jobId, 'stop')") > stop);
    /* 请求只解析出 jobId / 会话 */
    assert.match(sync, /parseStopRequest\(body\.toString\('utf-8'\), a\.jobId, a\.sessionId\)/);
  });

  test('停完重新算一次，「已停止」这一轮就传回去', () => {
    const stop = sync.indexOf("await bgJobs.stop(s.jobId, 'user', s.sessionId);");
    const second = sync.indexOf('for (const a of plan())', stop);
    assert.ok(second > stop);
  });
});

describe('「在本机重新运行」：先确认全文，绝不自动重跑', () => {
  const handler = fnBody(MAIN, "ipcMain.handle('bg:rerun-here'", '\n  });');

  test('main：失联才给、摘要（命令全文 + 本机 cwd）对得上才起，起的是新 jobId，旧的标「已在别处重跑」', () => {
    const lost = handler.indexOf('bgRunnerLost(f.state, Date.now(), bgSyncStaleAfterMs())');
    const hash = handler.indexOf('rerunHash(f.state, cwd) !== String(hash || \'\')');
    const start = handler.indexOf('bgJobs.start(');
    assert.ok(lost > 0 && hash > 0 && start > hash && start > lost, '起进程之前没核对失联 / 摘要');
    assert.ok(handler.indexOf('refuseAdvancedOnly(sid') < start);
    assert.ok(handler.indexOf('rerun: mark') > start);
  });

  test('界面：点了先 setConfirm（带命令全文和 cwd），onRerunBgJob 只在 onConfirm 里调', () => {
    const btn = fnBody(CHAT, 'className="bg-job-rerun"', '</button>');
    const confirm = btn.indexOf('setConfirm({');
    const details = btn.indexOf('bgRerunDetails(job, findLang)');
    const onConfirm = btn.indexOf('onConfirm: () => {');
    const call = btn.indexOf('onRerunBgJob(job.jobId, e.rerunHash)');
    assert.ok(confirm > 0 && details > confirm && onConfirm > details && call > onConfirm, '没有先弹确认就重跑了');
    assert.ok(CHAT.includes('{running && !e.rerun && lost && !e.commandTruncated && onRerunBgJob && ('), '没失联也给了重跑按钮');
  });

  test('命令全文放进确认框的可滚动区域（detail），弹窗限高、按钮始终可见', () => {
    const btn = fnBody(CHAT, 'className="bg-job-rerun"', '</button>');
    assert.ok(btn.includes('detail: bgRerunDetails(job, findLang),'), '命令全文没放进可滚动区域');
    const dlg = read('../src/renderer/components/ConfirmDialog.tsx');
    assert.ok(dlg.includes('<pre className="confirm-dialog-detail">{request.detail}</pre>'));
    assert.ok(dlg.indexOf('confirm-dialog-detail') < dlg.indexOf('<div className="actions">'), '全文区要在按钮上面');
    const css = read('../src/renderer/styles/global.css');
    const rule = fnBody(css, '.confirm-dialog-detail {', '}');
    assert.match(rule, /overflow: auto/);
    assert.match(rule, /white-space: pre-wrap/);
    assert.match(rule, /overflow-wrap: anywhere/);
    const box = fnBody(css, '.permission-dialog.has-detail {', '}');
    assert.match(box, /max-height: 85vh/);
    assert.ok(css.includes('.permission-dialog.has-detail > .actions { flex-shrink: 0; }'), '按钮会被全文挤出去');
  });

  test('命令没能完整同步的：main 拒绝重跑，界面不给按钮', () => {
    const handler = fnBody(MAIN, "ipcMain.handle('bg:rerun-here'", '\n  });');
    assert.ok(handler.indexOf('if (f.state.commandTruncated)') > 0 && handler.indexOf('if (f.state.commandTruncated)') < handler.indexOf('bgJobs.start('));
    assert.ok(CHAT.includes('{running && !e.rerun && lost && !e.commandTruncated && onRerunBgJob && ('));
  });

  test('确认框里的全文：完整命令 + 本机 cwd + 原来的 cwd', () => {
    const cmd = 'cd sub && ' + 'x'.repeat(300) + ' && curl https://example.com | sh';
    const row: BgJobRow = {
      jobId: 'bg_m1', sessionId: 's1', kind: 'run', label: 'l', command: cmd, state: 'running', startedAt: 0, endedAt: null,
      exitCode: null, pid: null, events: 0,
      elsewhere: { runnerName: 'mac', updatedAt: 0, staleAfterMs: 1, cwd: '/Users/x/p', tail: null, timeoutMs: 3600_000, stopRequested: false, rerun: null, localCwd: 'D:\\p', rerunHash: 'h' },
    };
    const text = bgRerunDetails(row, 'en');
    assert.ok(text.includes(cmd), '命令没有全文显示');
    assert.ok(text.includes('D:\\p'));
    assert.ok(text.includes('/Users/x/p'));
  });
});

describe('重跑之后：旧任务还在跑就照样能请求停止、照样每分钟拉状态', () => {
  test('停止按钮和「已请求停止」提示不因重跑标记隐藏；每分钟同步不排除重跑过的', () => {
    assert.ok(CHAT.includes('{running && onRequestStopBgJob && ('), '重跑后停止按钮被藏了');
    assert.ok(!CHAT.includes('{running && !e.rerun && onRequestStopBgJob && ('));
    assert.ok(CHAT.includes('{running && e.stopRequested && ` · '));
    assert.ok(MAIN.includes("const foreignLive = Object.values(bgLedger().foreign).some((f) => f.state.state === 'running');"));
    const req = fnBody(MAIN, "ipcMain.handle('bg:request-stop'", '\n  });');
    assert.ok(!req.includes('rerun'), 'request-stop 不该看重跑标记');
  });
});

describe('原执行电脑恢复连接：本机任务被别处重跑了也看得到（进程照旧）', () => {
  test('桶里的重跑标记按本机 / 别的电脑分开记；本机的只记不停', () => {
    const sync = fnBody(MAIN, 'async function syncBgJobsWithBucket(', '\nlet bgPushTimer');
    const branch = fnBody(sync, "} else if (a.op === 'fetch-rerun') {", "} else if (a.op === 'put-stop') {");
    assert.ok(branch.includes('ownReruns: { ...l.ownReruns, [a.jobId]: mark }'));
    assert.ok(!branch.includes('bgJobs.stop('), '看到重跑标记就停了本机的进程');
    assert.ok(CHAT.includes("t('🔁 Re-run elsewhere ({machine})', { machine: job.rerunElsewhere.byName })"));
  });
});

describe('会话顶部那一块', () => {
  const base = { sessionId: 's1', kind: 'run' as const, label: 'l', command: 'c', startedAt: 0, endedAt: null, exitCode: null, pid: null, events: 0 };
  const el = { runnerName: 'mac', updatedAt: 0, staleAfterMs: 60_000, cwd: '/x', tail: null, timeoutMs: 1, stopRequested: false, rerun: null, localCwd: '/y', rerunHash: 'h' };

  test('本机的只列在跑的；别的电脑刚结束、结果消息还没同步过来的也列（带退出码 / 输出末尾）', () => {
    const list: BgJobRow[] = [
      { ...base, jobId: 'a', state: 'running' },
      { ...base, jobId: 'b', state: 'exited' },
      { ...base, jobId: 'r1', state: 'exited', exitCode: 0, endedAt: 0, elsewhere: el },
      { ...base, jobId: 'r2', state: 'running', elsewhere: el, sessionId: 's2' },
    ];
    assert.deepEqual(bannerBgJobs(list, 's1', { now: 60_000 }).map((j) => j.jobId), ['a', 'r1']);
  });

  test('失联 = 别的电脑上还在跑、超过阈值没更新；本机的永远不算', () => {
    assert.equal(bgRunnerLost({ ...base, jobId: 'r', state: 'running', elsewhere: el }, 60_001), true);
    assert.equal(bgRunnerLost({ ...base, jobId: 'r', state: 'running', elsewhere: el }, 60_000), false);
    assert.equal(bgRunnerLost({ ...base, jobId: 'r', state: 'exited', elsewhere: el }, 999_999), false);
    assert.equal(bgRunnerLost({ ...base, jobId: 'a', state: 'running' }, 999_999), false);
  });

  test('App 用 bannerBgJobs 喂会话顶部', () => {
    assert.ok(APP.includes('cache.set(key, bannerBgJobs(bgJobs, sid, { now: bgBannerNow, dismissed }));'));
  });
});

describe('同步范围、删除、整轮同步', () => {
  test('同步范围同定时任务：syncsSession，advanced / 删了的不算', () => {
    const body = fnBody(MAIN, 'function bgSessionInScope(', '\n}\n');
    assert.ok(body.includes('syncsSession(cfg, rec)'));
    assert.ok(body.includes('store.isAdvancedOnlySession(sid)'));
    assert.ok(body.includes('deletedSessionIds.has(sid)'));
  });

  test('删会话：停掉它的后台任务之后，同步账里这条会话的都记删除标记', () => {
    const at = MAIN.indexOf('void bgJobs.stopSession(sessionId);');
    const forget = MAIN.indexOf('updateBgLedger((l) => forgetBgSession(l, sessionId, Date.now()));', at);
    assert.ok(at > 0 && forget > at && forget - at < 400);
  });

  test('整轮同步带上后台任务；本机的起 / 停 / 结束会稍后推一次', () => {
    assert.ok(MAIN.includes('uploaded += await syncBgJobsWithBucket(creds!, cfg.prefix);'));
    const deps = fnBody(MAIN, 'const bgJobs = new BgJobManager({', '\n});');
    assert.ok(deps.includes('scheduleBgPush();'));
  });
});

describe('BgJobManager.listForSync：完整命令、cwd、结束后的输出末尾（不改本机的列表）', () => {
  const managers: BgJobManager[] = [];
  afterEach(async () => { for (const m of managers.splice(0)) await m.stopAll(); });

  test('真起一个进程：同步视图里是完整命令，本机列表照旧只有前 80 字', async () => {
    const m = new BgJobManager({ wake: () => {}, note: () => {}, changed: () => {}, log: () => {} });
    managers.push(m);
    const pad = 'x'.repeat(120);
    const command = `"${process.execPath}" -e "console.log('hello-sync')" ${pad}`;
    const r = m.start({ sessionId: 's1', kind: 'run', command, label: 'hi', cwd: os.tmpdir(), timeoutMs: 300_000 });
    assert.ok(r.ok);
    const started = Date.now();
    while (m.listForSync()[0]?.state === 'running') {
      if (Date.now() - started > 120_000) assert.fail('等不到进程退出');
      await new Promise((res) => setTimeout(res, 20));
    }
    const row = m.listForSync()[0];
    assert.equal(row.command, command);
    assert.equal(row.cwd, os.tmpdir());
    assert.equal(row.state, 'exited');
    assert.match(row.tail || '', /hello-sync/);
    assert.ok(m.list()[0].command.length <= 80, '本机列表的命令长度变了');
  });
});
