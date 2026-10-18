import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 「模型自己安排的定时检查 / 后台命令 / 监视」在 index.ts / preload / 渲染端的接线 —— 源码扫描
 * （index.ts、App.tsx、ChatArea.tsx 不能被测试 import）。逻辑本身在 wakeQueue / bgJobs / wakeTools 的单测里。
 */
const SRC = path.join(import.meta.dirname, '..', 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const MAIN = strip(read('main', 'index.ts'));
const PRELOAD = strip(read('main', 'preload.ts'));
const HOOK = strip(read('renderer', 'hooks', 'useAcp.ts'));
const APP = strip(read('renderer', 'App.tsx'));
const CHAT = strip(read('renderer', 'components', 'ChatArea.tsx'));

const fnBody = (src: string, anchor: string, len = 3000) => {
  const at = src.indexOf(anchor);
  assert.ok(at >= 0, `找不到 ${anchor}`);
  return src.slice(at, at + len);
};

describe('调度复用：模型建的定时任务就是现有的定时任务', () => {
  test('schedule_create 写进同一个 scheduleStore、标 createdBy: model，广播同一个 schedule:changed', () => {
    const host = fnBody(MAIN, 'const wakeHost: WakeHost = {', 2500);
    assert.match(host, /newSchedule\(sessionId, spec, Date\.now\(\)\), createdBy: 'model'/);
    assert.match(host, /scheduleStore\.writeSchedule\(id, state, os\.homedir\(\)/);
    assert.match(host, /webContents\.send\('schedule:changed'/);
    assert.doesNotMatch(MAIN, /setInterval\([^)]*wake/i, '不另起一套计时器');
  });

  test('到点时经 wakeDispatcher 发进创建它的那条会话（忙就等这一轮结束），不再直接 sendPromptOnce', () => {
    const run = fnBody(MAIN, 'async function runScheduledJob(', 2500);
    assert.match(run, /wakeDispatcher\.enqueue\(\{\s*sessionId: state\.sessionId, text: state\.spec\.prompt/);
    assert.doesNotMatch(run, /sendPromptOnce\(/);
  });

  test('忙的判据：busyReasonFor（含换执行器 / 重建历史）+ 等待退出', () => {
    assert.match(MAIN, /isBusy: \(sid\) => quitPending \|\| !!busyReasonFor\(sid\)/);
  });

  test('真正发送：挂回执行器 → sendPromptOnce(announce)，删掉 / 归档的不发', () => {
    const d = fnBody(MAIN, 'wakeDeliver = async (item) => {', 2000);
    assert.match(d, /deletedSessionIds\.has\(sid\)/);
    assert.match(d, /archived/);
    assert.match(d, /await ensureAttached\(sid\)/);
    assert.match(d, /announce: true/);
  });

  test('过期：ticker 里先判 expireSchedule 再判 isDue', () => {
    assert.match(MAIN, /if \(expireSchedule\(job, now\)\) continue;\s*if \(isDue\(job\.state, now\)\)/);
  });
});

describe('工具挂在 kirolex-local 上，本地会话和远程会话都有', () => {
  test('startLocalMcp 带上 wake 工具', () => {
    const start = fnBody(MAIN, 'localMcpStarting = startLocalMcp({', 800);
    assert.match(start, /wake: wakeMcpTools,/);
    assert.match(MAIN, /const wakeMcpTools = \{\s*call: \(name: string, args: any, sid: string, workdir: string\) => callWakeTool\(name, args, sid, workdir, wakeHost\)/);
  });

  test('本地会话（新建 + 重连）不再只在浏览器开关开着时才挂', () => {
    assert.match(MAIN, /if \(!remote\?\.sshHost\) return withLocalBrowser\(sessionId, localComboTools\(sessionId, profile\)\);/);
    const fn = fnBody(MAIN, 'async function withLocalBrowser(', 900);
    assert.doesNotMatch(fn, /if \(!localBrowser\(\)\.enabled\(\)\) return spec;/);
    assert.match(fn, /name: 'kirolex-local'/);
  });

  test('后台命令的 cwd 是会话的本地工作目录（远程会话的 entry.cwd 是远端草稿目录，不能用）', () => {
    assert.match(MAIN, /cwdFor: \(sessionId, fallback\) => sessionClients\.get\(sessionId\)\?\.localDir \|\| store\.readRecord\(sessionId\)\?\.localDir \|\| fallback/);
  });
});

describe('重启 / 退出 / 删除', () => {
  test('启动时把上次没结束的后台任务在会话里补一句「已中断」', () => {
    assert.match(MAIN, /for \(const job of takeInterruptedJobs\(os\.homedir\(\)\)\) \{[\s\S]{0,200}noteInSession\(job\.sessionId, interruptedNotice\(job\)\)/);
  });
  test('退出时同步结束后台命令（before-quit 不等 Promise）', () => {
    assert.match(MAIN, /app\.on\('before-quit', \(\) => bgJobs\.stopAllSync\(\)\)/);
  });
  test('删会话：停掉它的后台任务、作废排着的唤醒', () => {
    const p = fnBody(MAIN, 'const purgeSession = async', 2500);
    assert.match(p, /bgJobs\.stopSession\(sessionId\)/);
    assert.match(p, /wakeDispatcher\.drop\(sessionId/);
  });
});

describe('看得见、停得掉', () => {
  test('IPC：bg:list / bg:stop（用户停）+ bg:changed 广播；preload 有包装', () => {
    assert.match(MAIN, /ipcMain\.handle\('bg:list'/);
    assert.match(MAIN, /ipcMain\.handle\('bg:stop', \(_event, jobId: string\) => bgJobs\.stop\(String\(jobId \|\| ''\), 'user'\)\)/);
    assert.match(MAIN, /webContents\.send\('bg:changed'\)/);
    for (const k of ['bgList:', 'bgStop:', 'onBgChanged:', 'onMainTurn:']) assert.ok(PRELOAD.includes(k), k);
  });

  test('会话顶部列出后台任务（标签、运行时长、停止按钮）', () => {
    assert.match(CHAT, /bgJobs && bgJobs\.length > 0 &&/);
    assert.match(CHAT, /className="bg-job-stop"[\s\S]{0,80}onStopBgJob\?\.\(job\.jobId\)/);
    assert.match(CHAT, /bgElapsedText\(job\.startedAt/);
    assert.match(APP, /bgJobs=\{bgJobsFor\(sid\)\}/);
    assert.match(HOOK, /onBgChanged\?\.\(refresh\)/);
  });

  test('横幅标「由模型创建」', () => {
    assert.match(CHAT, /scheduleSummary\.byModel &&/);
  });

  test('主进程发起的一轮在界面上可见：插进用户消息、接管流（结束信号走 busy 那条）', () => {
    assert.match(MAIN, /if \(display\?\.announce\) \{\s*mainWindow\?\.webContents\.send\('acp:main-turn'/);
    const h = fnBody(HOOK, 'const removeMainTurn = window.kiroApi.onMainTurn?.(', 900);
    assert.match(h, /list\.some\(\(m\) => m\.id === messageId\)/, '按 id 去重');
    assert.match(h, /adoptedTurnsRef\.current\.add\(sid\);\s*addStreaming\(sid\);/);
    assert.match(HOOK, /removeMainTurn\?\.\(\);/);
  });

  test('唤醒不进渲染端的排队卡片（主进程自己的队列，不经 queuesBySession）', () => {
    assert.doesNotMatch(HOOK, /onMainTurn[\s\S]{0,600}queuesBySession/);
    assert.doesNotMatch(MAIN, /kirolex-queues[\s\S]{0,200}wake/);
  });
});

describe('审查跟进：排着的定时提示能撤、后台输出不进诊断包', () => {
  test('暂停 / 删除（用户或模型）都撤掉排着的那一次；发之前再按盘上状态判一次', () => {
    assert.match(MAIN, /if \(paused\) wakeDispatcher\.dropRef\(id, 'paused'\)/);
    assert.equal((MAIN.match(/wakeDispatcher\.dropRef\(id, 'removed'\)/g) || []).length, 2, 'schedule:remove 和 schedule_delete 各一处');
    assert.match(MAIN, /isStale: \(item\) => \(item\.source === 'schedule' && item\.ref\s*\? scheduleDeliveryBlocker\(scheduleStore\.readSchedule\(item\.ref/);
    const run = fnBody(MAIN, 'async function runScheduledJob(', 2500);
    assert.match(run, /if \(delivered\.skipped\) \{[\s\S]{0,400}refundRun\(latest\.state, state\)/);
  });
  test('后台命令 / 监视那一轮标 bgOutput；诊断包据此只留占位、不抄会话历史', () => {
    const d = fnBody(MAIN, 'wakeDeliver = async (item) => {', 2000);
    assert.match(d, /bgOutput: item\.source !== 'schedule'/);
    const b = fnBody(MAIN, 'const bundle = await writeFailureBundle({', 700);
    assert.match(b, /omitConversation: omitSessionContent/);
  });
});

describe('审查跟进 2：挂执行器期间被取消、会话收到过后台输出之后的诊断包', () => {
  test('挂上执行器之后、提交提示之前各再判一次；不发就是 WakeSkipped（skipped、退回次数）', () => {
    const d = fnBody(MAIN, 'wakeDeliver = async (item) => {', 2000);
    const attach = d.indexOf('await ensureAttached(sid)');
    const recheck = d.indexOf('if (blocked) throw new WakeSkipped(blocked)');
    assert.ok(attach > 0 && recheck > attach, '挂执行器之后再判');
    assert.match(d, /stillWanted,\s*\}\)/);
    const s = fnBody(MAIN, 'async function sendPromptOnce(', 40000);
    const check = s.indexOf('const blocked = display.stillWanted();');
    const persist = s.indexOf('store.appendMessage(sessionId, {');
    assert.ok(check > 0 && persist > check, '在用户消息落盘之前判');
  });
  test('后台输出进会话前记 bgOutputSeen；之后任何一轮的诊断包都按它去掉会话内容', () => {
    const d = fnBody(MAIN, 'wakeDeliver = async (item) => {', 2000);
    assert.match(d, /if \(item\.source !== 'schedule'\) markBgOutputSeen\(sid\);/);
    assert.match(fnBody(MAIN, 'function markBgOutputSeen(', 300), /store\.patchRecord\(sessionId, \{ bgOutputSeen: true \}\)/);
    /* bg_status 把输出交给模型那条路也打同一个标记 */
    assert.match(MAIN, /markOutputSeen: \(sessionId\) => markBgOutputSeen\(sessionId\)/);
    assert.match(MAIN, /bundleOmitsSessionContent\(\{ bgOutputThisTurn: !!display\?\.bgOutput, sessionSawBgOutput: !!store\.readRecord\(sessionId\)\?\.bgOutputSeen \}\)/);
    const b = fnBody(MAIN, 'const bundle = await writeFailureBundle({', 700);
    assert.match(b, /omitConversation: omitSessionContent/);
  });
});

describe('审查跟进 3：收到过后台输出的会话不再另存上下文快照', () => {
  const STORE = strip(read('main', 'sessionStore.ts'));
  test('writeLastInjection 对 bgOutputSeen 的会话不写，并删掉旧的那份（之后重连 / 普通消息走的都是这一个入口）', () => {
    const fn = fnBody(STORE, 'export function writeLastInjection(', 600);
    assert.match(fn, /if \(readRecord\(id\)\?\.bgOutputSeen\) \{[\s\S]{0,200}rmSync\(lastInjectionPath\(id\)[\s\S]{0,80}return;/);
    assert.ok(fn.indexOf('bgOutputSeen') < fn.indexOf('writeFileSync'), '判断在写之前');
    /* 快照只有这一个写入口 */
    assert.equal((MAIN.match(/writeLastInjection\(/g) || []).length, 1);
    assert.doesNotMatch(MAIN, /last-injection\.md['"`][^\n]*writeFileSync/);
  });
});

describe('审查跟进 5：判忙不看界面语言', () => {
  test('sendPromptOnce 的忙拒绝带 SESSION_BUSY；dispatcher 用错误码 / 会话此刻是否忙来判，不再匹配英文文字', () => {
    assert.match(MAIN, /throw Object\.assign\(new Error\(tr\('Wait for the active turn \(including context compaction\) to finish before sending the queued message\.'\)\), \{ code: SESSION_BUSY \}\)/);
    assert.match(MAIN, /isBusyError: \(err, item\) => isWakeBusyError\(err, quitPending \|\| !!busyReasonFor\(item\.sessionId\)\)/);
    assert.doesNotMatch(MAIN, /isBusyError: \(err\) => \/active turn/);
  });
});
