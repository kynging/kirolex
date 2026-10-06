#!/usr/bin/env node
/**
 * KiroLex self-hosting dev supervisor.
 *
 * Purpose: edit KiroLex's own source FROM WITHIN KiroLex and have the change take
 * effect without a manual restart.
 *
 *   src/renderer/**  ->  Vite HMR, live in milliseconds, no restart at all.
 *   src/main/**      ->  tsc --watch recompiles, this supervisor relaunches
 *                        Electron. The chat survives it: sessions/transcripts are
 *                        on disk, context is restored automatically on the next
 *                        message, and an interrupted turn is auto-resent.
 *
 * Why a supervisor at all: only a process OUTSIDE Electron can bring Electron back
 * after it exits. Nothing here needs an extra dependency.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** A dependency's executable in node_modules/.bin.
 *
 *  `.cmd` on Windows: npm writes THREE shims there (`vite`, `vite.cmd`, `vite.ps1`)
 *  and the extensionless one is a POSIX shell script that Windows cannot execute, so
 *  spawning the bare name fails with EACCES/ENOENT and `npm run dev:hot` never
 *  starts. */
const bin = (name) => path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);

/** How to start a tool: `[command, leadingArgs]`.
 *
 *  Windows does NOT go through the `.cmd` shim: since the CVE-2024-27980 fix (Node
 *  18.20.2 / 20.12.2 and later) `spawn()` refuses `.cmd`/`.bat` without `shell: true`
 *  and throws `spawn EINVAL` synchronously, so `npm run dev:hot` died on the first
 *  line. `shell: true` would put every argument through cmd.exe quoting, so instead
 *  run the tool's own entry point with this Node, and Electron as the real
 *  `electron.exe` -- which also means killing the child kills Electron itself rather
 *  than a launcher in front of it. */
const ENTRY = { vite: ['vite', 'bin', 'vite.js'], tsc: ['typescript', 'bin', 'tsc'] };
function tool(name) {
  if (process.platform !== 'win32') return [bin(name), []];
  if (name === 'electron') {
    const dir = path.join(root, 'node_modules', 'electron');
    return [path.join(dir, 'dist', fs.readFileSync(path.join(dir, 'path.txt'), 'utf8').trim()), []];
  }
  return [process.execPath, [path.join(root, 'node_modules', ...ENTRY[name])]];
}
const runTool = (name, args, opts) => { const [cmd, pre] = tool(name); return run(name, cmd, [...pre, ...args], opts); };
const MAIN_OUT = path.join(root, 'dist', 'main');
/** Windows-only graceful-quit channel; must match DEV_QUIT_REQUEST in src/main/index.ts. */
const DEV_QUIT_REQUEST = path.join(os.homedir(), '.kirolex', 'dev-quit-request');
/** Matches the main process's exit code for "another instance owns the lock". */
const EXIT_ALREADY_RUNNING = 42;
const DEV_PORT = Number(process.env.KIROLEX_DEV_PORT || 5173);
/** Supervisor log, alongside the app's own log. See `log()`. */
const SUPERVISOR_LOG = path.join(os.homedir(), '.kirolex', 'logs', 'dev-hot.log');
try { fs.mkdirSync(path.dirname(SUPERVISOR_LOG), { recursive: true }); } catch {}

const log = (tag, msg) => {
  const line = `[dev-hot:${tag}] ${msg}`;
  console.log(line);
  // Mirror to a file. Everything the supervisor knows -- how long Vite took, why a
  // restart was deferred, whether a rebuild was a no-op -- used to exist ONLY in
  // whatever terminal happened to be running it. So "startup is slow, it keeps
  // waiting for :5173" was undiagnosable after the fact: main.log has zero
  // `[vite]` lines. Now the timings are on disk next to the app's own log.
  try {
    fs.appendFileSync(SUPERVISOR_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {}
};

/** Child processes we own, so Ctrl-C tears everything down. */
const owned = new Set();
function run(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
  owned.add(child);
  child.on('exit', () => owned.delete(child));
  child.on('error', (err) => log(name, `failed to start: ${err.message}`));
  return child;
}

// ---------------------------------------------------------------- renderer (HMR)
log('vite', 'starting renderer dev server (HMR) on :5173');
runTool('vite', []);

// ------------------------------------------------------------ main (tsc --watch)
log('tsc', 'watching src/main for changes');
runTool('tsc', ['-p', 'tsconfig.main.json', '--watch', '--preserveWatchOutput']);

// ---------------------------------------------------------------------- electron
let electron = null;
let restarting = false;
let shuttingDown = false;
let crashStreak = 0;
/** 上一次重启的时刻 + 这之后多久里的 42 算"旧实例还没放锁"（见 exit 处理） */
let lastRestartAt = 0;
let lockRetries = 0;
const RESTART_LOCK_GRACE_MS = 60_000;

/**
 * **只有一个"待启动"** —— 实测两条重试链并行（每条各自 setTimeout 一次 startElectron），
 * 日志里 retry 7、8 隔一秒、9、10 又隔一秒，两个新实例抢同一把锁。
 */
let pendingStart = null;
/** 主进程 --dev 下开的远程调试端口（src/main/index.ts 里的 remote-debugging-port）。 */
const CDP_PORT = 9222;
/** 端口没人 listen 了就 resolve(true)；到时间还被占着就 resolve(false)。 */
function waitPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const probe = () => {
      const sock = net.connect({ port, host: '127.0.0.1' });
      sock.once('connect', () => { sock.destroy(); if (Date.now() > deadline) resolve(false); else setTimeout(probe, 300); });
      sock.once('error', () => resolve(true));
    };
    probe();
  });
}

function scheduleStart(wait) {
  if (pendingStart) clearTimeout(pendingStart);
  pendingStart = setTimeout(() => { pendingStart = null; if (!shuttingDown) startElectron(); }, wait);
}

/**
 * 杀掉不是我们 child 的那些 KiroLex Electron（主进程，命令行里有这个仓库路径 + `--dev`、没有 `--type=`）。
 * `taskkill /T` 连它的子进程（GPU / 网络服务 / 渲染）一起 —— 单实例锁在主进程手里，只有它死了锁才放。
 */
function killStrayElectrons() {
  if (process.platform !== 'win32') return;
  const mine = electron?.pid;
  const ps = `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | `
    + `? { $_.CommandLine -like '*${root.replace(/'/g, "''")}*' -and $_.CommandLine -like '*--dev*' -and $_.CommandLine -notlike '*--type=*' } | `
    + `% { $_.ProcessId }`;
  let pids = [];
  try {
    pids = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true })
      .split(/\s+/).map(Number).filter((p) => p && p !== mine);
  } catch (err) { log('electron', `could not list stray Electron processes (${err.message})`); return; }
  for (const pid of pids) {
    log('electron', `killing stray KiroLex Electron ${pid} (it holds the single-instance lock)`);
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  }
}

function startElectron() {
  if (electron) return;   // 已经有一个在跑（或刚起）—— 第二个只会撞单实例锁
  // `--dev` (not NODE_ENV) so the renderer is loaded from Vite: the env-var form
  // this project used before was Windows-only syntax and silently no-op'd here.
  //
  /**
   * `detached: true` 只为一件事：让这个启动器成为**进程组组长**，这样强杀时能连它下面真正的
   * Electron 一起杀（`process.kill(-pid)`）。
   *
   * 不这么做就会漏进程，实测过：`electron` 这个 child 是 `node .bin/electron` 启动器，
   * `child.kill('SIGKILL')` 只杀得掉它；SIGKILL 又不可能被转发，于是它下面真正的 Electron 被 init
   * 收养（`ppid=1`）继续跑着。一次「did not exit in 6s, forcing」漏一个窗口 —— 连改几个 main 侧
   * 文件之后桌面上就同时躺着三个 KiroLex，其中两个跑的是旧代码，而调试端口被最早那个占着。
   *
   * 优雅路径不受影响：SIGTERM 照旧发给启动器，由它转发，main 走 app.quit() 正常释放
   * kiro-cli 的会话锁。detached 只改变「组」的归属，不改变信号往哪送。
   */
  electron = runTool('electron', ['.', '--dev'], { detached: true });
  const started = Date.now();
  electron.on('exit', (code, signal) => {
    electron = null;
    if (shuttingDown) return;
    if (restarting) {
      restarting = false;
      // Windows: the old instance's network-service process outlives the main one by
      // a moment and still holds the --dev CDP port (9222), so an immediate relaunch
      // came up with no debug port at all. A short pause lets it go.
      /*
        **固定 1.5 秒不够** —— 实测（10-06 两次）：重启之后新实例照样没有调试端口，旧实例的网络进程
        占着 9222 比 1.5 秒久。改成等它真的放开（最多 15 秒），放开了再起；等不到也照样起（端口没了
        只影响调试，不影响用）。
      */
      if (process.platform === 'win32') {
        void waitPortFree(CDP_PORT, 15_000).then((free) => {
          if (!free) log('electron', `port ${CDP_PORT} still busy after 15s -- starting anyway (no remote debugging this run)`);
          scheduleStart(300);
        });
      } else {
        scheduleStart(0);
      }
      return;
    }
    // 42 = another instance owns the single-instance lock. Retrying can never
    // succeed, and doing so silently is how a stale instance turned into "the app
    // will not start". Name it and stop.
    /*
      **刚重启完撞上 42 不是"另一个实例"，是旧的那个还没把锁放掉** —— 实测（Windows）：旧 main 退出了、
      1.5 秒后新的起来，单实例锁还在旧进程手里没释放完，于是新的退出 42、监管进程跟着 shutdown ——
      结果是 KiroLex **整个没了**，直到有人手动再起一次。重启之后的这一段时间里退避重试；
      过了这段时间还 42，才是真的有别的实例。
    */
    if (code === EXIT_ALREADY_RUNNING && Date.now() - lastRestartAt < RESTART_LOCK_GRACE_MS) {
      lockRetries += 1;
      const wait = Math.min(5000, 1000 * lockRetries);
      log('electron', `previous instance still holds the single-instance lock (retry ${lockRetries}, in ${wait}ms)`);
      /*
        **占着锁的多半是个孤儿**（不是我们的 child 了 —— 实测它一直不放，60 秒退避白等）。
        先再写一次退出请求让它体面地走（它会关掉 kiro-cli 的 stdin、放掉会话锁）；
        过了 10 秒还在，就按进程树强杀 —— 不然 KiroLex 永远起不来。
      */
      if (lockRetries === 1) { try { fs.writeFileSync(DEV_QUIT_REQUEST, String(Date.now())); } catch {} }
      if (lockRetries >= 4) killStrayElectrons();
      scheduleStart(wait);
      return;
    }
    if (code === EXIT_ALREADY_RUNNING) {
      log('electron', 'another KiroLex instance is already running, so this one exited.');
      log('electron', 'Quit it first (Cmd-Q), or: pkill -f "kirolex/node_modules/electron"');
      shutdown(1);
      return;
    }
    // A quick exit right after launch means the new main code is broken. Back off
    // instead of spin-looping, and keep watching: the next save can fix it.
    if (Date.now() - started < 4000 && code !== 0) {
      crashStreak += 1;
      const wait = Math.min(15000, 1000 * crashStreak);
      log('electron', `exited fast (code=${code} signal=${signal}) -- main code likely broken. Waiting ${wait}ms; save a fix to retry.`);
      scheduleStart(wait);
      return;
    }
    crashStreak = 0;
    // A clean exit is the user closing the app: stop the whole supervisor rather
    // than resurrecting a window they just closed.
    log('electron', `exited (code=${code} signal=${signal}) -- shutting down supervisor`);
    shutdown(0);
  });
}

function restartElectron(reason) {
  if (shuttingDown || restarting) return;
  if (!electron) { startElectron(); return; }
  restarting = true;
  lastRestartAt = Date.now();
  lockRetries = 0;
  log('electron', `restarting: ${reason}`);
  // SIGTERM, not SIGKILL: main turns it into app.quit(), which closes each
  // kiro-cli's stdin so it exits 0 and RELEASES its session. A hard kill leaves a
  // stale session lock behind and the next session/load fails with
  // "Session is active in another process (PID n)".
  //
  // Windows has no POSIX signals: Node implements kill() as an immediate
  // TerminateProcess, so main would never run app.quit() and the kiro-cli children
  // would be orphaned with their session locks held -- every local chat then fails
  // `session/load` after the relaunch. So there the request goes through a FILE that
  // main polls under --dev (DEV_QUIT_REQUEST in src/main/index.ts); the escalation
  // below is still the backstop if main does not exit.
  if (process.platform === 'win32') {
    try { fs.writeFileSync(DEV_QUIT_REQUEST, String(Date.now())); }
    catch (err) { log('electron', `could not write quit request (${err.message}) -- killing instead`); electron.kill('SIGTERM'); }
  } else {
    electron.kill('SIGTERM');
  }
  const child = electron;
  const pid = child.pid;
  // Escalation must test whether the process is STILL ALIVE, not `child.killed`:
  // Node sets `killed` as soon as a signal was delivered successfully, regardless
  // of whether the process died. So the old `!child.killed` test was always false
  // and the SIGKILL fallback could never fire. When main then failed to quit (it
  // closes each kiro-cli's stdin first, which can hang), `restarting` stayed true
  // forever -- and `if (shuttingDown || restarting) return` silently swallowed
  // EVERY later restart. Observed live: a main-process fix compiled at 12:56 was
  // still not loaded at 13:50, with the app running from 12:48.
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  setTimeout(() => {
    if (!alive()) return;
    log('electron', 'did not exit in 6s, forcing');
    /**
     * 杀**整组**，不是只杀这个 child。
     *
     * `child` 是 `node .bin/electron` 启动器；真正的 Electron 是它的子进程。只 SIGKILL 启动器的话
     * Electron 会被 init 收养并继续跑，于是每一次强杀漏一个孤儿窗口（跑着旧代码，还占着调试端口）。
     * 启动时给了 `detached: true`，所以它是组长，负号 pid 能覆盖它和它的后代。
     *
     * 组杀失败才退回单杀（比如平台不支持负号 pid），至少行为不比原来差。
     */
    let groupKilled = false;
    try { process.kill(-pid, 'SIGKILL'); groupKilled = true; } catch {}
    if (!groupKilled) { try { child.kill('SIGKILL'); } catch {} }
    setTimeout(() => {
      if (!alive()) return;
      // Unkillable (stuck in a syscall, or not ours any more). Clear the flag so
      // the next rebuild is still allowed to try instead of being dropped silently.
      log('electron', `pid ${pid} survived SIGKILL -- clearing restart lock; quit it manually (Cmd-Q) if the app is stuck`);
      restarting = false;
    }, 4000);
  }, 6000);
}

// -------------------------------------------------------- watch compiled main JS
let debounce = null;
/** Content hash of dist/main, so an IDENTICAL recompile never restarts anything.
 *
 *  `tsc` rewrites its output whenever it runs, even when the emitted bytes are the
 *  same -- so a renderer-only change verified with `npm run build` (which runs tsc
 *  first) looked exactly like a main-process change and killed the running app,
 *  mid-turn, for nothing. */
function mainOutputHash() {
  try {
    const h = crypto.createHash('sha1');
    for (const name of fs.readdirSync(MAIN_OUT).sort()) {
      if (!name.endsWith('.js')) continue;
      h.update(name);
      h.update(fs.readFileSync(path.join(MAIN_OUT, name)));
    }
    return h.digest('hex');
  } catch { return null; }
}
let lastMainHash = null;

/** Is a turn in flight? Read from the app's own log: the supervisor must never
 *  interrupt a running answer. A restart mid-turn loses that turn -- it already
 *  happened, and the reply never came back. */
function turnInFlight() {
  try {
    // A turn ends with done, failed, OR error -- main logs a rejected turn as
    // `[prompt] error`, which this used to ignore. Those sessions then counted as
    // "running" forever (396 received vs 219 done in a real log), so EVERY
    // main-process rebuild was deferred the full 10 minutes for turns that had
    // already failed minutes or hours earlier.
    // main writes ONE FILE PER LAUNCH now (`main-<YYYYMMDD-HHMMSS>.log`, see
    // src/main/logger.ts); this still read the old `main.log`, which no longer
    // exists -- so the catch below answered "nothing running" every time and a
    // main-process rebuild restarted Electron in the middle of a turn. The running
    // Electron's file is the newest one (by mtime: a same-second `-1` suffix sorts
    // BEFORE the plain name).
    const dir = path.join(os.homedir(), '.kirolex', 'logs');
    const log = fs.readdirSync(dir)
      .filter((f) => /^main-\d{8}-\d{6}(-\d+)?\.log$/.test(f))
      .map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (!log) return null;
    const size = fs.statSync(log).size;
    const start = Math.max(0, size - 200_000);
    const fd = fs.openSync(log, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const open = new Set();
    for (const line of buf.toString('utf-8').split('\n')) {
      const recv = line.match(/\[prompt\] received sessionId=(\S+)/);
      if (recv) { open.add(recv[1]); continue; }
      const done = line.match(/\[prompt\] (?:done|failed|error) sessionId=(\S+)/);
      if (done) open.delete(done[1]);
      if (/\[app\] main process starting/.test(line)) open.clear();
    }
    return open.size > 0 ? [...open] : null;
  } catch { return null; }
}

/** A restart already waiting for the turn to end. Every recompile used to start its
 *  OWN waiting loop: a turn that ran 8 minutes while main was edited three times
 *  had three loops polling side by side, and each would fire its own restart once
 *  the turn ended -- the second one killing the freshly started Electron. Later
 *  changes just ride the pending one (the restart loads whatever is on disk then). */
let pendingRestart = null;
function restartWhenIdle(reason) {
  if (pendingRestart) { log('electron', `also changed: ${reason} -- folded into the pending restart`); return pendingRestart; }
  pendingRestart = waitIdleThenRestart(reason).finally(() => { pendingRestart = null; });
  return pendingRestart;
}

/** No time cap any more. It used to restart anyway after 10 minutes -- which is exactly
 *  the case this supervisor exists for: a chat editing KiroLex itself runs long turns,
 *  and the forced restart cut two of them off mid-task (the resend then started the
 *  task over). A turn that never ends is caught by main's own WEDGED detection; a
 *  rebuild can wait for it. */
async function waitIdleThenRestart(reason) {
  for (let waited = 0; ; waited += 5) {
    const busy = turnInFlight();
    if (!busy) { restartElectron(reason); return; }
    if (waited === 0) log('electron', `main changed but a turn is running (${busy.join(', ')}) -- deferring restart until it finishes`);
    if (waited && waited % 60 === 0) log('electron', `still waiting for ${busy.join(', ')} (${waited}s)`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

function watchMainOutput() {
  fs.mkdirSync(MAIN_OUT, { recursive: true });
  lastMainHash = mainOutputHash();
  fs.watch(MAIN_OUT, (_event, filename) => {
    if (!filename || !filename.endsWith('.js')) return;
    clearTimeout(debounce);
    // tsc writes several files per compile; wait for the burst to settle.
    debounce = setTimeout(() => {
      const hash = mainOutputHash();
      if (hash && hash === lastMainHash) {
        log('watch', 'dist/main recompiled with identical output -- not restarting');
        return;
      }
      lastMainHash = hash;
      void restartWhenIdle(`dist/main/${filename} changed`);
    }, 400);
  });
  log('watch', `watching ${MAIN_OUT} -> relaunch Electron on change (skips no-op rebuilds, waits for idle)`);
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  /* Windows：kill 就是 TerminateProcess，Electron 来不及释放 kiro-cli 的会话锁 —— 先走退出请求文件，
     给它几秒正常退出（见 restartElectron），下面那层兜底仍然在。 */
  const win = process.platform === 'win32' && !!electron;
  if (win) { try { fs.writeFileSync(DEV_QUIT_REQUEST, String(Date.now())); } catch {} }
  for (const child of owned) { if (win && child === electron) continue; try { child.kill('SIGTERM'); } catch {} }
  /**
   * Electron 那个是 detached 的（为了强杀时能整组杀），所以它**不会**因为 dev-hot 退出而自己死。
   * 上面的 SIGTERM 已经发给启动器、由它转发让 main 走 app.quit()；这里再兜一层：500ms 后如果它还
   * 活着，整组杀掉。少了这一层，Ctrl-C 之后窗口会留在桌面上，而它的监管进程已经没了 —— 又是一个孤儿，
   * 只是这次由退出路径产生。
   */
  const stray = electron?.pid;
  setTimeout(() => {
    if (stray) {
      try { process.kill(stray, 0); } catch { process.exit(code); return; }
      log('electron', `still alive after SIGTERM, killing process group ${stray}`);
      try { process.kill(-stray, 'SIGKILL'); } catch { try { process.kill(stray, 'SIGKILL'); } catch {} }
    }
    process.exit(code);
  }, win ? 6000 : 500);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/** Wait until Vite is actually serving before launching Electron.
 *
 *  Without this the window opens against a dead port and just sits blank -- which
 *  is exactly what happened once already: the log filled with
 *  "dev server not up yet, retry n/30" and the user saw an app that looked broken.
 *  Reporting the wait is the point; a blank window explains nothing. */
async function waitForVite(timeoutMs = 30000) {
  const started = Date.now();
  let announced = false;
  for (;;) {
    try {
      // `localhost`, NOT 127.0.0.1: Vite binds the IPv6 loopback (`[::1]:5173`,
      // confirmed with lsof), so an IPv4 probe can never succeed and this loop burned
      // the full 30s on EVERY start, then printed a bogus "Is the port taken?". The
      // port was never taken -- Electron loads `http://localhost:5173`, which resolves
      // to ::1, and connected on the first try while this said "not reachable".
      const res = await fetch(`http://localhost:${DEV_PORT}/@vite/client`, { method: 'GET' });
      if (res.ok) {
        log('vite', `ready on :${DEV_PORT} after ${Date.now() - started}ms`);
        return true;
      }
    } catch {}
    if (Date.now() - started > timeoutMs) {
      log('vite', `NOT reachable on :${DEV_PORT} after ${Math.round(timeoutMs / 1000)}s -- starting Electron anyway (it will retry the load).`);
      log('vite', `Is the port taken? Check with: lsof -nP -iTCP:${DEV_PORT}`);
      return false;
    }
    if (!announced && Date.now() - started > 3000) { announced = true; log('vite', `waiting for :${DEV_PORT}…`); }
    await new Promise((r) => setTimeout(r, 300));
  }
}

// Electron and Vite boot IN PARALLEL, gated only on tsc having produced dist/main.
//
// Waiting for Vite first put it squarely on the startup critical path: 1.5s fixed
// sleep + however long Vite took to bind + only THEN ~3s of Electron boot, all
// serial, which is what "startup is slow, it just keeps waiting for :5173" was.
// Nothing required that order -- main retries loadURL up to 30 times (500ms apart)
// precisely because the supervisor may win the race, and the window is not revealed
// until the renderer says so, so there is no blank-window risk either. Vite's boot
// now overlaps Electron's instead of preceding it.
void (async () => {
  await waitForMainOutput();
  watchMainOutput();
  startElectron();
  const ready = await waitForVite();
  if (!ready) log('vite', 'Electron is up and retrying the load; fix the port and it will connect.');
})();

/** Electron must never start against a half-written (or absent) dist/main. Polls
 *  instead of sleeping a fixed 1.5s, so a warm tsc cache costs milliseconds. */
async function waitForMainOutput(timeoutMs = 30000) {
  const started = Date.now();
  const entry = path.join(MAIN_OUT, 'index.js');
  for (;;) {
    try { if (fs.statSync(entry).size > 0) { log('tsc', `dist/main ready after ${Date.now() - started}ms`); return true; } } catch {}
    if (Date.now() - started > timeoutMs) { log('tsc', `dist/main still missing after ${Math.round(timeoutMs / 1000)}s -- starting anyway`); return false; }
    await new Promise((r) => setTimeout(r, 100));
  }
}
