import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { BG_DISMISSED_KEY, ENDED_ELSEWHERE_SHOW_MS, bannerBgJobs, parseBgDismissed, type BgElsewhere, type BgJobRow } from '../src/renderer/bgJobsView.ts';
import {
  FOREIGN_KEEP_MS, bgObjectRel, collectBucketBgJobs, emptyLedger, planBgSync, pruneEndedForeign, recordedBgJobIds,
  type BgSyncLedger, type BgSyncState,
} from '../src/main/bgJobSync.ts';

/**
 * 别的电脑上跑完的后台任务不能永远置顶（2026-11-26：frp 会话顶部挂着 7 张 desktop 上 14 小时前就结束的卡）。
 * 守的是：会话顶部只放还在跑的；别的电脑上结束了的只在结果消息还没同步过来、结束不到 30 分钟、没收起时暂放；
 * 本机 foreign 账里结束超过 7 天的拿掉、不再被下载回来。
 */

const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf-8');
const NOW = 1_000_000_000;
const el = (over: Partial<BgElsewhere> = {}): BgElsewhere => ({
  runnerName: 'afa037-kyn-desktop', updatedAt: NOW - 60_000, staleAfterMs: 20 * 60_000, cwd: '/x', tail: 'ok', timeoutMs: 3600_000,
  stopRequested: false, rerun: null, localCwd: '/y', rerunHash: 'h', ...over,
});
const row = (over: Partial<BgJobRow>): BgJobRow => ({
  jobId: 'bg_1', sessionId: 's1', kind: 'run', label: 'l', command: 'c', state: 'exited', startedAt: NOW - 3600_000,
  endedAt: NOW - 60_000, exitCode: 0, pid: null, events: 0, elsewhere: el(), ...over,
});
const ids = (list: BgJobRow[], dismissed?: Set<string>) => bannerBgJobs(list, 's1', { now: NOW, dismissed }).map((j) => j.jobId);

describe('会话顶部：别的电脑上结束了的', () => {
  test('结束消息已经在本机记录里了：不置顶', () => {
    assert.deepEqual(ids([row({ elsewhere: el({ endRecorded: true }) })]), []);
  });

  test('记录里还没有、结束不到 30 分钟：暂放', () => {
    assert.deepEqual(ids([row({ endedAt: NOW - ENDED_ELSEWHERE_SHOW_MS + 1000 })]), ['bg_1']);
  });

  test('记录里还没有、结束超过 30 分钟：不置顶（那 7 张 14 小时前结束的就是这种）', () => {
    assert.deepEqual(ids([row({ endedAt: NOW - ENDED_ELSEWHERE_SHOW_MS - 1 })]), []);
    assert.deepEqual(ids([row({ endedAt: NOW - 14 * 3600_000, elsewhere: el({ endRecorded: true }) })]), []);
  });

  test('收起过的：不置顶', () => {
    assert.deepEqual(ids([row({})], new Set(['bg_1'])), []);
  });

  test('还在跑的、失联的：照旧置顶（收起 / 时长 / 记录都不影响）', () => {
    const lost = row({ jobId: 'bg_lost', state: 'running', endedAt: null, exitCode: null, elsewhere: el({ updatedAt: NOW - 5 * 3600_000, endRecorded: true }) });
    const live = row({ jobId: 'bg_live', state: 'running', endedAt: null, exitCode: null });
    assert.deepEqual(ids([lost, live], new Set(['bg_lost', 'bg_live'])), ['bg_lost', 'bg_live']);
  });

  test('本机的照旧只列在跑的', () => {
    const local = (over: Partial<BgJobRow>) => row({ elsewhere: undefined, ...over });
    assert.deepEqual(ids([local({ jobId: 'a', state: 'running' }), local({ jobId: 'b', state: 'exited' })]), ['a']);
  });

  test('收起记录：坏了当空、超过 7 天的不再记', () => {
    assert.deepEqual(parseBgDismissed('{bad', NOW), {});
    assert.deepEqual(parseBgDismissed(JSON.stringify({ a: NOW - 1000, old: NOW - 8 * 24 * 3600_000, x: 'no' }), NOW), { a: NOW - 1000 });
  });
});

describe('按 jobId 在会话记录里认结束消息', () => {
  test('中 / 英文唤醒和停止说明里的（jobId）都认', () => {
    const got = recordedBgJobIds([
      { content: '🔔 后台命令「构建」已结束：退出码 0，用时 1 分 4 秒（bg_mvnsetf33）\n\n输出末尾：\nx' },
      { content: '🔔 Background command "npm test" finished: exit code 2, ran 12 sec (bg_abc1)' },
      { content: '👀 Watch "log" ended: the command exited with code 0 (watch_w1)' },
      { content: '随便聊聊 bg_notme 没有括号' },
      { content: { not: 'a string' } },
    ]);
    assert.deepEqual([...got].sort(), ['bg_abc1', 'bg_mvnsetf33', 'watch_w1']);
  });
});

describe('监视的普通输出不算结束结果', () => {
  const outputZh = { content: '👀 监视「看日志」（watch_w9）有新输出：\nERROR something（watch_w9）' };
  const outputEn = { content: '👀 Watch "log" (watch_w9) new output:\nline (watch_w9)' };

  test('记录里只有「有新输出 / new output」：不认', () => {
    assert.equal(recordedBgJobIds([outputZh, outputEn]).has('watch_w9'), false);
  });

  test('只同步过普通输出、刚结束：卡片照样显示；真正的结束消息到了才收起来', () => {
    const card = row({ jobId: 'watch_w9', kind: 'watch' });
    const onlyOutput = recordedBgJobIds([outputZh, outputEn]).has('watch_w9');
    assert.deepEqual(ids([{ ...card, elsewhere: el({ endRecorded: onlyOutput }) }]), ['watch_w9']);
    const withEnd = recordedBgJobIds([outputZh, { content: '👀 监视「看日志」已结束：命令退出，退出码 0（watch_w9）' }]).has('watch_w9');
    assert.deepEqual(ids([{ ...card, elsewhere: el({ endRecorded: withEnd }) }]), []);
  });

  test('结束 / 没能运行 / 超时 / 限流 / 用户停止 / 重启中断（中英文）都认', () => {
    const got = recordedBgJobIds([
      { content: '🔔 后台命令「构建」没能运行：工作目录不存在：D:\\x（bg_a1）' },
      { content: '🔔 Background command "b" timed out after 1 h 0 min and was stopped (bg_a2)\n\nLast output:\nx' },
      { content: '👀 监视「看日志」到了时间上限（30 分钟 0 秒），已结束（watch_a3）' },
      { content: '👀 Watch "log" was stopped: too many events (more than 20 within 60 sec). Use a command that prints less often, or filter its output (watch_a4)' },
      { content: '⏹️ 后台任务「构建」已被用户停止（bg_a5）' },
      { content: '⚠️ KiroLex 重启，后台任务「构建」（bg_a6）已中断，不再运行' },
      { content: '⚠️ KiroLex restarted, so background task "b" (bg_a7) was interrupted and is no longer running' },
    ]);
    assert.deepEqual([...got].sort(), ['bg_a1', 'bg_a2', 'bg_a5', 'bg_a6', 'bg_a7', 'watch_a3', 'watch_a4']);
  });
});

describe('本机 foreign 账：结束超过 7 天的拿掉、不再下载回来', () => {
  const SID = 's1';
  const st = (over: Partial<BgSyncState>): BgSyncState => ({
    jobId: 'bg_old', sessionId: SID, kind: 'run', label: 'l', command: 'c', cwd: '/x', timeoutMs: 1, runner: 'dev-desk', runnerName: 'desk',
    state: 'exited', startedAt: 0, endedAt: NOW - FOREIGN_KEEP_MS - 1, exitCode: 0, events: 0, tail: null, updatedAt: NOW - FOREIGN_KEEP_MS - 1, ...over,
  });
  const ledger: BgSyncLedger = {
    ...emptyLedger(),
    foreign: {
      bg_old: { state: st({}) },
      bg_recent: { state: st({ jobId: 'bg_recent', endedAt: NOW - 3600_000 }) },
      bg_run: { state: st({ jobId: 'bg_run', state: 'running', endedAt: null, updatedAt: 0 }) },
    },
  };
  const bucket = collectBucketBgJobs(['bg_old', 'bg_recent', 'bg_run'].map((id) => ({ rel: bgObjectRel(SID, id, 'state'), etag: `"${id}"` })));

  test('只拿掉结束超过 7 天的；还在跑的（哪怕很久没更新）、最近结束的留着', () => {
    const next = pruneEndedForeign(ledger, NOW, FOREIGN_KEEP_MS, new Set(bucket.keys()));
    assert.deepEqual(Object.keys(next.foreign).sort(), ['bg_recent', 'bg_run']);
    assert.ok(next.pruned.bg_old);
    /* 没有要拿的：原样返回（不白写盘） */
    assert.equal(pruneEndedForeign(next, NOW, FOREIGN_KEEP_MS, new Set(bucket.keys())), next);
  });

  test('拿掉之后，桶里那份还在也不会再被下载回来；也不碰桶（不写删除标记、不删对象）', () => {
    const next = pruneEndedForeign(ledger, NOW, FOREIGN_KEEP_MS, new Set(bucket.keys()));
    const plan = planBgSync({ me: { id: 'dev-me', name: 'me' }, now: NOW, heartbeatMs: 60_000, own: [], ledger: next, bucket, inScope: () => true });
    assert.ok(!plan.some((a) => a.jobId === 'bg_old'), `又碰了 bg_old：${JSON.stringify(plan.filter((a) => a.jobId === 'bg_old'))}`);
  });

  test('桶里那份没了：pruned 那一笔也清掉（账不无限长）', () => {
    const next = pruneEndedForeign(ledger, NOW, FOREIGN_KEEP_MS, new Set(bucket.keys()));
    const later = pruneEndedForeign(next, NOW, FOREIGN_KEEP_MS, new Set(['bg_recent', 'bg_run']));
    assert.equal(later.pruned.bg_old, undefined);
  });
});

describe('接线', () => {
  const MAIN = read('../src/main/index.ts');
  const APP = read('../src/renderer/App.tsx');
  const CHAT = read('../src/renderer/components/ChatArea.tsx');

  test('同步一开始就给 foreign 账瘦身（按桶里这一轮的 jobId）', () => {
    const at = MAIN.indexOf('async function syncBgJobsWithBucket(');
    const body = MAIN.slice(at, MAIN.indexOf('\nlet bgPushTimer', at));
    const prune = body.indexOf('pruneEndedForeign(l, Date.now(), FOREIGN_KEEP_MS, new Set(bucket.keys()))');
    assert.ok(prune > 0 && prune < body.indexOf('const plan = () => planBgSync('));
  });

  test('foreignBgRows 给结束了的带上 endRecorded（按 jobId 查本机记录）', () => {
    assert.ok(MAIN.includes("const endRecorded = f.state.state !== 'running' && bgEndRecorded(f.state.sessionId, jobId);"));
    assert.ok(MAIN.includes('ids = recordedBgJobIds(store.readTranscript(sessionId));'));
  });

  test('App 把时钟和收起记录交给 bannerBgJobs；收起只记本机 ui-state', () => {
    assert.ok(APP.includes('bannerBgJobs(bgJobs, sid, { now: bgBannerNow, dismissed })'));
    assert.ok(APP.includes('uiSet(BG_DISMISSED_KEY, JSON.stringify(next));'));
    assert.equal(BG_DISMISSED_KEY, 'kirolex-bg-dismissed');
    assert.ok(CHAT.includes('{!running && onDismissBgJob && ('), '结束了的卡片没有「✕ 收起」');
  });
});
