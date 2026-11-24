import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BG_COMMAND_MAX, applyFetchedState, bgObjectRel, bgRunnerLost, bgStateBody, collectBucketBgJobs, emptyLedger, forgetBgSession, mergeBgState,
  parseBgObjectRel, parseRemoteBgState, parseRerunMark, parseStopRequest, planBgSync, planStopRequests, readBgLedger, rerunHash,
  stopRequestBody, writeBgLedger, type BgSyncLedger, type BgSyncState, type OwnBgJob,
} from '../src/main/bgJobSync.ts';

const ME = { id: 'dev-me', name: 'my-pc' };
const MAC = { id: 'dev-mac', name: 'macbook' };
const SID = 'sess_1';

function own(over: Partial<OwnBgJob> = {}): OwnBgJob {
  return {
    jobId: 'bg_a1', sessionId: SID, kind: 'run', label: 'build', command: 'npm run build && echo done', cwd: '/proj',
    timeoutMs: 3600_000, state: 'running', startedAt: 1000, endedAt: null, exitCode: null, events: 0, tail: null, ...over,
  };
}

function remoteState(over: Partial<BgSyncState> = {}): BgSyncState {
  return {
    jobId: 'bg_m1', sessionId: SID, kind: 'run', label: 'tests', command: 'npm test', cwd: '/Users/x/proj', timeoutMs: 3600_000,
    runner: MAC.id, runnerName: MAC.name, state: 'running', startedAt: 1000, endedAt: null, exitCode: null, events: 0, tail: null,
    updatedAt: 5000, ...over,
  };
}

const bucketOf = (rels: string[]) => collectBucketBgJobs(rels.map((rel) => ({ rel, etag: `"${rel}"` })));

describe('桶里的布局', () => {
  test('状态 / 停止请求 / 重跑标记 / 删除标记各是一个对象，能互相解析回来', () => {
    for (const kind of ['state', 'stop', 'rerun', 'deleted'] as const) {
      assert.deepEqual(parseBgObjectRel(bgObjectRel(SID, 'bg_x1', kind)), { sessionId: SID, jobId: 'bg_x1', kind });
    }
    assert.equal(parseBgObjectRel('bg-jobs/s/../x.json'), null);
    assert.equal(parseBgObjectRel('schedules/s/x.json'), null);
  });

  test('有删除标记就是删了', () => {
    const b = bucketOf([bgObjectRel(SID, 'bg_x1', 'state'), bgObjectRel(SID, 'bg_x1', 'deleted')]);
    assert.equal(b.get('bg_x1')!.deleted, true);
  });
});

describe('状态合并只认跑它那台写的', () => {
  test('第一次见到别的电脑的：收', () => {
    assert.deepEqual(mergeBgState(undefined, remoteState(), ME.id), remoteState());
  });

  test('说 runner 是本机的：不收（本机的只来自本机进程表）', () => {
    assert.equal(mergeBgState(undefined, remoteState({ runner: ME.id }), ME.id), null);
  });

  test('本机记着 runner = mac，桶里那份换了 runner：不收', () => {
    const local = remoteState();
    assert.equal(mergeBgState(local, remoteState({ runner: 'dev-evil', updatedAt: 9000, state: 'exited' }), ME.id), null);
  });

  test('同一个 runner 写的新版本：收；旧版本：不收', () => {
    const local = remoteState({ updatedAt: 5000 });
    assert.equal(mergeBgState(local, remoteState({ updatedAt: 4000, state: 'exited' }), ME.id), null);
    const newer = remoteState({ updatedAt: 6000, state: 'exited', exitCode: 0, tail: 'ok' });
    assert.deepEqual(mergeBgState(local, newer, ME.id), newer);
  });

  test('下载到「runner 是本机」、本机进程表里却没有的：补删除标记，不记进 foreign 账', () => {
    const r = applyFetchedState(emptyLedger(), 'bg_m1', remoteState({ runner: ME.id }), '"e"', ME.id, new Set());
    assert.equal(r.tombstone, true);
    assert.deepEqual(r.ledger.foreign, {});
  });
});

describe('解析：桶里的内容不可信', () => {
  test('只挑认得的字段；jobId / 会话对不上、没有 runner 的不收', () => {
    const body = bgStateBody(remoteState());
    const parsed = parseRemoteBgState(JSON.stringify({ ...JSON.parse(body), state: { ...remoteState(), extra: 'x', pid: 42 } }), 'bg_m1', SID);
    assert.ok(parsed);
    assert.equal((parsed as any).extra, undefined);
    assert.equal((parsed as any).pid, undefined);
    assert.equal(parseRemoteBgState(body, 'bg_other', SID), null);
    assert.equal(parseRemoteBgState(body, 'bg_m1', 'sess_other'), null);
    assert.equal(parseRemoteBgState(JSON.stringify({ jobId: 'bg_m1', sessionId: SID, state: { ...remoteState(), runner: '' } }), 'bg_m1', SID), null);
    assert.equal(parseRemoteBgState('not json', 'bg_m1', SID), null);
  });

  test('停止请求只能停：别的 op 不收，带的命令 / 参数一律扔掉', () => {
    const req = parseStopRequest(JSON.stringify({ v: 1, op: 'stop', jobId: 'bg_a1', sessionId: SID, at: 1, by: MAC.id, command: 'rm -rf /', args: ['x'] }), 'bg_a1', SID);
    assert.deepEqual(req, { jobId: 'bg_a1', sessionId: SID, at: 1, by: MAC.id });
    assert.equal(parseStopRequest(JSON.stringify({ op: 'restart', jobId: 'bg_a1', sessionId: SID, at: 1, by: MAC.id, command: 'x' }), 'bg_a1', SID), null);
    assert.equal(parseStopRequest(JSON.stringify({ op: 'run', jobId: 'bg_a1', sessionId: SID, at: 1, by: MAC.id }), 'bg_a1', SID), null);
    assert.equal(parseStopRequest(stopRequestBody({ jobId: 'bg_a1', sessionId: SID, at: 1, by: 'x' }), 'bg_b2', SID), null);
  });

  test('停止请求只停本机表里这条会话自己的、还在跑的；结果只有 jobId + 会话', () => {
    const jobs = [own(), own({ jobId: 'bg_done', state: 'exited' }), own({ jobId: 'bg_other', sessionId: 'sess_2' })];
    const reqs = [
      { jobId: 'bg_a1', sessionId: SID, at: 1, by: MAC.id },
      { jobId: 'bg_a1', sessionId: SID, at: 2, by: MAC.id },
      { jobId: 'bg_done', sessionId: SID, at: 1, by: MAC.id },
      { jobId: 'bg_other', sessionId: SID, at: 1, by: MAC.id },
      { jobId: 'bg_nope', sessionId: SID, at: 1, by: MAC.id },
    ];
    assert.deepEqual(planStopRequests(reqs, jobs), [{ jobId: 'bg_a1', sessionId: SID }]);
  });

  test('重跑标记：新 jobId 必须是合法 id', () => {
    const ok = { jobId: 'bg_m1', sessionId: SID, rerun: { at: 1, by: ME.id, byName: ME.name, newJobId: 'bg_n1' } };
    assert.ok(parseRerunMark(JSON.stringify(ok), 'bg_m1', SID));
    assert.equal(parseRerunMark(JSON.stringify({ ...ok, rerun: { ...ok.rerun, newJobId: '../x' } }), 'bg_m1', SID), null);
  });

  test('重跑确认的摘要跟着命令全文和本机 cwd 走', () => {
    const s = remoteState();
    assert.equal(rerunHash(s, '/a'), rerunHash({ ...s }, '/a'));
    assert.notEqual(rerunHash(s, '/a'), rerunHash(s, '/b'));
    assert.notEqual(rerunHash(s, '/a'), rerunHash({ ...s, command: 'npm test; curl evil' }, '/a'));
  });
});

describe('失联判定', () => {
  test('还在跑、超过阈值没更新 = 失联；没超过 / 已结束 = 不算', () => {
    assert.equal(bgRunnerLost({ state: 'running', updatedAt: 0 }, 20 * 60_000 + 1, 20 * 60_000), true);
    assert.equal(bgRunnerLost({ state: 'running', updatedAt: 0 }, 20 * 60_000, 20 * 60_000), false);
    assert.equal(bgRunnerLost({ state: 'exited', updatedAt: 0 }, 99 * 60_000, 20 * 60_000), false);
  });
});

describe('这一轮做什么（planBgSync）', () => {
  const base = { me: ME, now: 10_000, heartbeatMs: 5 * 60_000, inScope: () => true };

  test('本机新起的：传上去，带完整命令和 runner = 本机', () => {
    const plan = planBgSync({ ...base, own: [own()], ledger: emptyLedger(), bucket: new Map() });
    const put = plan.find((a) => a.op === 'put') as any;
    assert.ok(put);
    assert.equal(put.state.command, 'npm run build && echo done');
    assert.equal(put.state.runner, ME.id);
    assert.equal(put.state.runnerName, ME.name);
  });

  test('不在同步范围的会话：一个都不传', () => {
    const plan = planBgSync({ ...base, inScope: () => false, own: [own()], ledger: emptyLedger(), bucket: new Map() });
    assert.equal(plan.filter((a) => a.op === 'put' || a.op === 'put-stop' || a.op === 'put-rerun').length, 0);
  });

  test('没变化不重传；还在跑的到了心跳时间重传', () => {
    const first = planBgSync({ ...base, own: [own()], ledger: emptyLedger(), bucket: new Map() }).find((a) => a.op === 'put') as any;
    const ledger: BgSyncLedger = { ...emptyLedger(), published: { bg_a1: { sessionId: SID, hash: first.hash, putAt: 10_000 } } };
    const bucket = bucketOf([bgObjectRel(SID, 'bg_a1', 'state')]);
    assert.equal(planBgSync({ ...base, now: 11_000, own: [own()], ledger, bucket }).filter((a) => a.op === 'put').length, 0);
    assert.equal(planBgSync({ ...base, now: 10_000 + 5 * 60_000, own: [own()], ledger, bucket }).filter((a) => a.op === 'put').length, 1);
    /* 结束了的不心跳 */
    const ended = own({ state: 'exited', exitCode: 0, endedAt: 2000, tail: 'done' });
    const e1 = planBgSync({ ...base, own: [ended], ledger: emptyLedger(), bucket: new Map() }).find((a) => a.op === 'put') as any;
    const l2: BgSyncLedger = { ...emptyLedger(), published: { bg_a1: { sessionId: SID, hash: e1.hash, putAt: 0 } } };
    assert.equal(planBgSync({ ...base, now: 99 * 60_000, own: [ended], ledger: l2, bucket }).filter((a) => a.op === 'put').length, 0);
  });

  test('本机传过、进程表里已经没了（重启过 = 本机清理了）：写删除标记', () => {
    const ledger: BgSyncLedger = { ...emptyLedger(), published: { bg_a1: { sessionId: SID, hash: 'h', putAt: 1 } } };
    const plan = planBgSync({ ...base, own: [], ledger, bucket: bucketOf([bgObjectRel(SID, 'bg_a1', 'state')]) });
    const t = plan.find((a) => a.op === 'put-tombstone') as any;
    assert.ok(t);
    assert.equal(t.jobId, 'bg_a1');
    assert.deepEqual(t.extra, [bgObjectRel(SID, 'bg_a1', 'state')]);
  });

  test('删除标记不被补回：本机记着删除的不再传，桶里是删除标记的也不再传', () => {
    const ledger: BgSyncLedger = { ...emptyLedger(), tombstones: { bg_a1: { sessionId: SID, at: 1, pushed: true } } };
    assert.equal(planBgSync({ ...base, own: [own()], ledger, bucket: new Map() }).filter((a) => a.op === 'put').length, 0);
    const bucket = bucketOf([bgObjectRel(SID, 'bg_a1', 'deleted'), bgObjectRel(SID, 'bg_a1', 'state')]);
    assert.equal(planBgSync({ ...base, own: [own()], ledger: emptyLedger(), bucket }).filter((a) => a.op === 'put').length, 0);
    /* 别的电脑的：桶里删了 → 本机账里拿掉并记一笔，不再下载 */
    const l2: BgSyncLedger = { ...emptyLedger(), foreign: { bg_m1: { state: remoteState() } } };
    const b2 = bucketOf([bgObjectRel(SID, 'bg_m1', 'deleted'), bgObjectRel(SID, 'bg_m1', 'state')]);
    const plan = planBgSync({ ...base, own: [], ledger: l2, bucket: b2 });
    assert.deepEqual(plan, [{ op: 'forget', jobId: 'bg_m1', sessionId: SID, tombstone: true }]);
  });

  test('删会话：本机传过的和别的电脑的都记删除标记，下一轮传上去', () => {
    const ledger: BgSyncLedger = {
      ...emptyLedger(),
      published: { bg_a1: { sessionId: SID, hash: 'h', putAt: 1 } },
      foreign: { bg_m1: { state: remoteState() }, bg_z: { state: remoteState({ jobId: 'bg_z', sessionId: 'sess_keep' }) } },
    };
    const next = forgetBgSession(ledger, SID, 77);
    assert.deepEqual(Object.keys(next.tombstones).sort(), ['bg_a1', 'bg_m1']);
    assert.deepEqual(Object.keys(next.foreign), ['bg_z']);
    const plan = planBgSync({ ...base, own: [], ledger: next, bucket: bucketOf([bgObjectRel(SID, 'bg_m1', 'state')]) });
    assert.deepEqual(plan.filter((a) => a.op === 'put-tombstone').map((a: any) => a.jobId).sort(), ['bg_a1', 'bg_m1']);
  });

  test('别的电脑的新任务：下载看看；本机记着的、ETag 没变：不再下载', () => {
    const bucket = bucketOf([bgObjectRel(SID, 'bg_m1', 'state')]);
    assert.ok(planBgSync({ ...base, own: [], ledger: emptyLedger(), bucket }).some((a) => a.op === 'fetch-state'));
    const etag = bucket.get('bg_m1')!.state!.etag;
    const ledger: BgSyncLedger = { ...emptyLedger(), foreign: { bg_m1: { state: remoteState(), etag } } };
    assert.equal(planBgSync({ ...base, own: [], ledger, bucket }).length, 0);
  });

  test('别的电脑的：会话不在同步范围 / 桶里没了 → 本机账里拿掉', () => {
    const ledger: BgSyncLedger = { ...emptyLedger(), foreign: { bg_m1: { state: remoteState() } } };
    assert.deepEqual(planBgSync({ ...base, own: [], ledger, bucket: new Map() }), [{ op: 'forget', jobId: 'bg_m1', sessionId: SID, tombstone: false }]);
    const bucket = bucketOf([bgObjectRel(SID, 'bg_m1', 'state')]);
    assert.deepEqual(planBgSync({ ...base, inScope: () => false, own: [], ledger, bucket }), [{ op: 'forget', jobId: 'bg_m1', sessionId: SID, tombstone: false }]);
  });

  test('本机点了停止：传停止请求；runner 那台看到给自己任务的停止请求：下载它', () => {
    const bucket = bucketOf([bgObjectRel(SID, 'bg_m1', 'state')]);
    const etag = bucket.get('bg_m1')!.state!.etag;
    const ledger: BgSyncLedger = { ...emptyLedger(), foreign: { bg_m1: { state: remoteState(), etag, stopRequestedAt: 42 } } };
    assert.deepEqual(planBgSync({ ...base, own: [], ledger, bucket }), [{ op: 'put-stop', jobId: 'bg_m1', sessionId: SID, at: 42 }]);
    const runnerBucket = bucketOf([bgObjectRel(SID, 'bg_a1', 'state'), bgObjectRel(SID, 'bg_a1', 'stop')]);
    assert.ok(planBgSync({ ...base, own: [own()], ledger: emptyLedger(), bucket: runnerBucket }).some((a) => a.op === 'fetch-stop' && a.jobId === 'bg_a1'));
  });
});

describe('长命令：不静默截断', () => {
  const base = { me: ME, now: 10_000, heartbeatMs: 5 * 60_000, inScope: () => true };
  test('20021 字的命令原样同步、原样解析回来', () => {
    const command = 'echo ' + 'a'.repeat(20_011) + ' && x';
    assert.equal(command.length, 20_021);
    const put = planBgSync({ ...base, own: [own({ command })], ledger: emptyLedger(), bucket: new Map() }).find((a) => a.op === 'put') as any;
    assert.equal(put.state.command, command);
    assert.equal(put.state.commandTruncated, undefined);
    const parsed = parseRemoteBgState(bgStateBody({ ...put.state, runner: MAC.id }), 'bg_a1', SID)!;
    assert.equal(parsed.command, command);
    assert.equal(parsed.commandTruncated, undefined);
  });

  test('超过上限的：只传开头并标 commandTruncated（别的电脑据此不给重跑），不冒充全文', () => {
    const command = 'x'.repeat(BG_COMMAND_MAX + 1);
    const put = planBgSync({ ...base, own: [own({ command })], ledger: emptyLedger(), bucket: new Map() }).find((a) => a.op === 'put') as any;
    assert.equal(put.state.commandTruncated, true);
    assert.equal(put.state.command.length, BG_COMMAND_MAX);
    const parsed = parseRemoteBgState(bgStateBody({ ...put.state, runner: MAC.id }), 'bg_a1', SID)!;
    assert.equal(parsed.commandTruncated, true);
  });
});

describe('原执行电脑恢复连接', () => {
  const base = { me: ME, now: 10_000, heartbeatMs: 5 * 60_000, inScope: () => true };
  test('本机任务在桶里有重跑标记：下载它（本机还在跑也照旧上传状态，不停）', () => {
    const bucket = bucketOf([bgObjectRel(SID, 'bg_a1', 'state'), bgObjectRel(SID, 'bg_a1', 'rerun')]);
    const plan = planBgSync({ ...base, own: [own()], ledger: emptyLedger(), bucket });
    assert.ok(plan.some((a) => a.op === 'fetch-rerun' && a.jobId === 'bg_a1'));
    assert.ok(plan.some((a) => a.op === 'put' && a.jobId === 'bg_a1'));
    /* 记下来之后不再下载 */
    const ledger: BgSyncLedger = { ...emptyLedger(), ownReruns: { bg_a1: { at: 1, by: MAC.id, byName: MAC.name, newJobId: 'bg_n1' } } };
    assert.ok(!planBgSync({ ...base, own: [own()], ledger, bucket }).some((a) => a.op === 'fetch-rerun'));
  });
});

describe('重跑之后的旧任务（那台上的进程还在跑）', () => {
  const base = { me: ME, now: 10_000, heartbeatMs: 5 * 60_000, inScope: () => true };
  const mark = { at: 1, by: ME.id, byName: ME.name, newJobId: 'bg_n1' };
  test('照样能传停止请求，照样拉它的新状态', () => {
    const bucket = bucketOf([bgObjectRel(SID, 'bg_m1', 'state'), bgObjectRel(SID, 'bg_m1', 'rerun')]);
    const ledger: BgSyncLedger = { ...emptyLedger(), foreign: { bg_m1: { state: remoteState(), etag: '"old"', rerun: mark, rerunPushed: true, stopRequestedAt: 42 } } };
    const plan = planBgSync({ ...base, own: [], ledger, bucket });
    assert.ok(plan.some((a) => a.op === 'put-stop' && a.jobId === 'bg_m1'), '重跑过就发不出停止请求了');
    assert.ok(plan.some((a) => a.op === 'fetch-state' && a.jobId === 'bg_m1'), '重跑过就不再拉旧任务的状态了');
  });
});

describe('本地账', () => {
  let dir = '';
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = ''; });

  test('写了能读回来；坏文件当空账', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-bgsync-'));
    const ledger: BgSyncLedger = { ...emptyLedger(), foreign: { bg_m1: { state: remoteState() } } };
    writeBgLedger(dir, ledger);
    assert.deepEqual(readBgLedger(dir), ledger);
    fs.writeFileSync(path.join(dir, '.kirolex', 'bg-sync.json'), '{bad');
    assert.deepEqual(readBgLedger(dir), emptyLedger());
  });
});
