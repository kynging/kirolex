/**
 * `scripts/kiro-multisession-probe.mjs` 的「释放一条**正在跑**的会话」那一项（docs/DESIGN_remote_sessions.md
 * 「一个 kiro-cli 进程带多条会话」）：只有 C、D 两条都出过字、**而且两条的 prompt 都还没回**时才 terminate C；
 * 有一条在重叠出现前就结束了，记 UNVERIFIED，并且不发那次 terminate（那时释放的是一条空闲会话，什么都没测到）。
 *
 * 用 `fixtures/fakeKiroAcp.mjs` 当 kiro-cli 真跑一遍探针：它把收到的 terminate 和每轮的起止记进日志。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const PROBE = path.join(ROOT, 'scripts', 'kiro-multisession-probe.mjs');
const FAKE = path.join(ROOT, 'tests', 'fixtures', 'fakeKiroAcp.mjs');

function runProbe(mode: string): Promise<{ out: string; log: string[] }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-mprobe-'));
  const logFile = path.join(dir, 'fake.log');
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [PROBE, '--turns', '--', process.execPath, FAKE], {
      env: { ...process.env, FAKE_MODE: mode, FAKE_LOG: logFile, PROBE_CWD: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => { p.kill(); reject(new Error(`probe timed out:\n${out}`)); }, 150_000);
    p.on('close', () => {
      clearTimeout(t);
      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : [];
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ out, log });
    });
  });
}

/** C = s3、D = s4；第二轮（n=2）就是释放检查那一轮 */
const at = (log: string[], line: string) => log.indexOf(line);

test('两条都出过字但 C 已经结束：记 UNVERIFIED，不在检查里 terminate C', { timeout: 180_000 }, async () => {
  const { out, log } = await runProbe('early');
  assert.match(out, /UNVERIFIED terminate a running C leaves running D alone — C finished before both were streaming/);
  assert.doesNotMatch(out, /terminate a running C succeeds/);
  assert.doesNotMatch(out, /D keeps running and finishes after C was terminated/);
  /* C 的 terminate 只能是收尾那次（D 第二轮已经结束之后），而且绝不是"在跑的时候" */
  assert.equal(log.includes('terminate s3 running=true'), false, log.join('\n'));
  const dEnd = log.findIndex((l) => l.startsWith('prompt-end s4 2 '));
  assert.ok(dEnd >= 0, log.join('\n'));
  const firstTermC = log.findIndex((l) => l.startsWith('terminate s3 '));
  assert.ok(firstTermC === -1 || firstTermC > dEnd, log.join('\n'));
});

test('两条都在跑时才 terminate C：terminate 落在 C 在跑的时候，D 照常跑完', { timeout: 180_000 }, async () => {
  const { out, log } = await runProbe('');
  assert.match(out, /PASS terminate a running C succeeds/);
  assert.match(out, /PASS C's in-flight prompt ends after terminate/);
  assert.match(out, /PASS D keeps running and finishes after C was terminated/);
  const term = at(log, 'terminate s3 running=true');
  assert.ok(term >= 0, log.join('\n'));
  /* 发 terminate 那一刻 D 的第二轮也还没结束 */
  assert.ok(at(log, 'prompt-start s4 2') < term && term < log.findIndex((l) => l.startsWith('prompt-end s4 2 ')), log.join('\n'));
  assert.ok(log.includes('prompt-end s4 2 end_turn'), log.join('\n'));
});
