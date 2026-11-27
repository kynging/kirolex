import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createSchedule, type ScheduleSpec, type ScheduleState } from '../src/main/schedule.ts';
import { ENDED_PRUNE_AFTER_MS, planScheduleAutoPrune, planScheduleSync, scheduleEndedAt, stampLocalWrite } from '../src/main/scheduleSync.ts';
import * as scheduleStore from '../src/main/scheduleStore.ts';
import { recordedScheduleEndIds, scheduleEndGroup } from '../src/main/scheduleWakeView.ts';
import { ENDED_SCHEDULE_SHOW_MS, endedElsewhereSummary, sessionScheduleSummary, type ScheduleView } from '../src/renderer/scheduleView.ts';

/*
  第 11 轮（用户 2026-11-27）：已结束的定时任务要自动消失。现场：5 条由 Mac 跑完的任务，结束 10~20 天了还挂在 Windows 的聊天顶部，
  删一条换下一条，看起来删不掉；任务文件也从没被清掉。
*/
const NOW = new Date(2026, 10, 27, 12, 0, 0).getTime();
const MIN = 60_000;
const DAY = 24 * 3600_000;
const MAC = 'd_0ac2aab9fab14ae8';
const ME = { id: 'd_win', name: 'kyn-desktop' };

function view(id: string, endedAgoMs: number, over: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id, sessionId: 's1', prompt: 'p', describe: 'Every 1 h', runs: 3, maxRuns: 3, paused: false, terminal: 'exhausted',
    lastRunAt: NOW - endedAgoMs, lastError: null, nextRunAt: null, runsHere: false, runnerName: 'mac',
    endedAt: NOW - endedAgoMs, endedText: `Scheduled task ended: ${id}`, ...over,
  };
}

describe('the "ended" card is a short notice, not a permanent banner', () => {
  test('① ended more than 30 minutes ago → no card', () => {
    assert.equal(endedElsewhereSummary([view('a', ENDED_SCHEDULE_SHOW_MS + MIN)], 'en', { now: NOW }), null);
    assert.ok(endedElsewhereSummary([view('a', 5 * MIN)], 'en', { now: NOW }), 'within 30 min it shows');
    /* the reported state: 5 tasks ended 10–20 days ago → nothing at the top */
    const old = [10, 12, 15, 18, 20].map((d, i) => view(`old${i}`, d * DAY));
    assert.equal(endedElsewhereSummary(old, 'en', { now: NOW }), null);
  });

  test('hidden once the end message has synced into this chat, or after "dismiss"; no end time (unknown) → hidden', () => {
    assert.equal(endedElsewhereSummary([view('a', MIN, { endRecorded: true })], 'en', { now: NOW }), null);
    assert.equal(endedElsewhereSummary([view('a', MIN)], 'en', { now: NOW, dismissed: new Set(['a']) }), null);
    assert.equal(endedElsewhereSummary([view('a', MIN, { endedAt: null })], 'en', { now: NOW }), null);
  });

  test('② three ended → one card, "2 more", and delete / dismiss cover all three', () => {
    const s = endedElsewhereSummary([view('a', 20 * MIN), view('b', 2 * MIN), view('c', 10 * MIN)], 'en', { now: NOW })!;
    assert.ok(s);
    assert.equal(s.next?.id, 'b', 'the most recently ended one is described');
    assert.match(s.text, /2 more ended/);
    assert.deepEqual([...s.endedIds!].sort(), ['a', 'b', 'c'], 'all three are acted on');
    /* dismissing all three hides the card (not "next one in line") */
    assert.equal(endedElsewhereSummary([view('a', 20 * MIN), view('b', 2 * MIN), view('c', 10 * MIN)], 'en', { now: NOW, dismissed: new Set(s.endedIds) }), null);
  });

  test('wired: delete loops over endedIds, dismiss button passes all endedIds; App passes now + dismissed', () => {
    const CHAT = fs.readFileSync(new URL('../src/renderer/components/ChatArea.tsx', import.meta.url), 'utf-8');
    const APP = fs.readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf-8');
    assert.match(CHAT, /for \(const id of scheduleSummary\.ended && scheduleSummary\.endedIds\?\.length \? scheduleSummary\.endedIds : \[scheduleSummary\.next!\.id\]\) onCancelSchedule\?\.\(id\);/);
    assert.match(CHAT, /className="schedule-banner-dismiss"\s*onClick=\{\(\) => onDismissEndedSchedules\(scheduleSummary\.endedIds\?\.length \? scheduleSummary\.endedIds : \[scheduleSummary\.next!\.id\]\)\}/);
    assert.match(APP, /endedElsewhereSummary\(byId\.get\(sid\) \|\| \[\], settings\.language, \{ now: scheduleNow, dismissed \}\)/);
  });

  test('live jobs and the sidebar badge are untouched (sessionScheduleSummary only counts live jobs)', () => {
    assert.equal(sessionScheduleSummary([view('a', MIN)], NOW, 'en'), null, 'an ended job never counts as live');
  });

  test('end message detection reads the schedule-end note group', () => {
    const ids = recordedScheduleEndIds([{ noteGroup: scheduleEndGroup('y7ofdq') }, { noteGroup: 'mcp-unavailable:x' }, {}]);
    assert.deepEqual([...ids], ['y7ofdq']);
  });
});

function ended(over: Partial<ScheduleState> = {}): ScheduleState {
  const spec: ScheduleSpec = { prompt: 'p', kind: 'interval', everySec: 3600, maxRuns: 3 };
  return { ...createSchedule('s1', spec, NOW - 30 * DAY), runs: 3, lastRunAt: NOW - 8 * DAY, terminal: 'exhausted', runner: ME.id, ...over };
}

describe('③ auto-prune 7 days after the end', () => {
  const never = () => false;

  test('runner: ended ≥ 7 days → pruned with a tombstone; < 7 days, or still live → left alone', () => {
    const plan = planScheduleAutoPrune([
      { id: 'old', state: ended({ endedAt: NOW - 8 * DAY }) },
      { id: 'recent', state: ended({ endedAt: NOW - 6 * DAY }) },
      { id: 'live', state: { ...ended(), terminal: null, runs: 1 } },
    ], ME.id, NOW, never);
    assert.deepEqual(plan.map((p) => [p.id, p.tombstone, p.terminal]), [['old', true, 'exhausted']]);
  });

  test('non-runner: only when the runner is lost, and then without a tombstone', () => {
    const job = [{ id: 'm', state: ended({ runner: MAC, endedAt: NOW - 9 * DAY }) }];
    assert.deepEqual(planScheduleAutoPrune(job, ME.id, NOW, never), [], 'runner alive: it cleans up itself');
    const lost = planScheduleAutoPrune(job, ME.id, NOW, () => true);
    assert.deepEqual(lost.map((p) => [p.id, p.tombstone]), [['m', false]]);
  });

  test('④ an old file without endedAt is dated by lastRunAt (then expiresAt / createdAt)', () => {
    const { endedAt: _e, ...legacy } = ended({ lastRunAt: NOW - 8 * DAY });
    assert.equal(scheduleEndedAt(legacy as ScheduleState), NOW - 8 * DAY);
    assert.equal(planScheduleAutoPrune([{ id: 'l', state: legacy as ScheduleState }], ME.id, NOW, never).length, 1);
    assert.equal(scheduleEndedAt({ ...(legacy as ScheduleState), lastRunAt: null, expiresAt: NOW - 9 * DAY }), NOW - 9 * DAY);
    assert.equal(scheduleEndedAt({ ...(legacy as ScheduleState), lastRunAt: null, expiresAt: null }), NOW - 30 * DAY);
    assert.equal(scheduleEndedAt({ ...ended(), terminal: null, runs: 1 }), null, 'not ended');
    assert.equal(ENDED_PRUNE_AFTER_MS, 7 * DAY);
  });

  test('endedAt is stamped by the write that ends the job', () => {
    const before = { ...ended(), terminal: null, runs: 2, endedAt: undefined };
    const after = stampLocalWrite(before, { ...before, runs: 3, terminal: 'exhausted' }, ME, NOW);
    assert.equal(after.endedAt, NOW);
    assert.equal(stampLocalWrite(after, { ...after, lastError: 'x' }, ME, NOW + 5).endedAt, NOW, 'not re-stamped later');
  });

  test('store: runner prune leaves a tombstone that sync uploads; a local-only prune is neither uploaded nor re-adopted', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-prune-'));
    scheduleStore.setLocalScheduleMachine(ME);
    try {
      scheduleStore.writeScheduleRaw('mine', ended({ endedAt: NOW - 8 * DAY }), home);
      scheduleStore.writeScheduleRaw('macs', ended({ runner: MAC, endedAt: NOW - 9 * DAY }), home);
      scheduleStore.removeSchedule('mine', home);
      scheduleStore.removeScheduleLocalOnly('macs', home);
      assert.equal(scheduleStore.readSchedule('mine', home), null);
      assert.equal(scheduleStore.readSchedule('macs', home), null);
      const tombs = scheduleStore.readScheduleTombstones(home);
      assert.equal(tombs.mine.localOnly, undefined);
      assert.equal(tombs.macs.localOnly, true);
      /* the bucket still has both live objects */
      const live = (s: ScheduleState) => ({ sessionId: 's1', parsed: { kind: 'live' as const, state: s } });
      const plan = planScheduleSync({
        me: ME.id, local: [], tombstones: tombs, inScope: () => true, upload: true,
        remote: new Map([['mine', live(ended())], ['macs', live(ended({ runner: MAC }))]]),
      });
      assert.deepEqual(plan.map((a) => `${a.op}:${a.id}`), ['put-tombstone:mine'], 'runner prune syncs out; local-only is not uploaded and not pulled back');
    } finally {
      scheduleStore.setLocalScheduleMachine(null);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('wired: main prunes at startup and hourly, logs `auto-prune id=… terminal=… endedAt=…`, list rows carry endedAt / endRecorded', () => {
    const MAIN = fs.readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf-8');
    const at = MAIN.indexOf('function pruneEndedSchedules(');
    assert.ok(at > 0);
    const body = MAIN.slice(at, MAIN.indexOf('\n  }\n', at));
    assert.match(body, /planScheduleAutoPrune\(jobs, scheduleMachine\(\)\.id, now, runnerLost\)/);
    assert.match(body, /if \(p\.tombstone\) scheduleStore\.removeSchedule\(/);
    assert.match(body, /else scheduleStore\.removeScheduleLocalOnly\(/);
    assert.match(body, /logger\.info\('schedule', `auto-prune id=\$\{p\.id\} terminal=\$\{p\.terminal\} endedAt=/);
    assert.match(body, /filter\(\(j\) => !schedulesInFlight\.has\(j\.id\)\)/);
    assert.doesNotMatch(body, /noteScheduleRemoved/, 'no "cancelled" note for an auto-prune');
    assert.match(MAIN, /pruneEndedSchedules\(\);\s*const schedulePruneTimer = setInterval\(pruneEndedSchedules,/);
    assert.match(MAIN, /endedAt: scheduleEndedAt\(job\.state\),/);
    assert.match(MAIN, /endRecorded: scheduleTerminal\(job\.state\) && !runsHere \? scheduleEndRecorded\(job\.state\.sessionId, job\.id\) : false,/);
  });
});
