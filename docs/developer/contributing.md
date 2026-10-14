# Contributing

This page collects the rules for changing KiroLex: how to scope a change, and the invariants that
must not break. Each invariant exists because breaking it once caused real damage. When you touch the
related code, **read the comments next to it and the tests that guard it first**.

## Change discipline

- **Change only what the task needs.** Do not refactor, rename, move code, unify style, or fix
  unrelated comments or things that "look wrong" along the way. Many odd-looking constructs in this
  codebase are deliberate fixes for problems that were measured in practice — the comment next to
  them usually says so. If you find another problem, report it instead of fixing it in the same change.
- **Keep edits to the big files small and local** (`src/main/index.ts`, `src/renderer/App.tsx`,
  `src/renderer/hooks/useAcp.ts`, `src/renderer/components/ChatArea.tsx`):
  - find the exact function or handler first and keep the diff to those spots;
  - never reorder or reformat large regions (the diff hides the real change, and parallel changes to
    the same file will conflict);
  - extract new logic into a standalone pure module where possible (which also makes it testable) and
    leave only the call in the big file.
  - These files are too big to read whole; search by function name, IPC channel or storage key, then
    read the surrounding section.
- **Be especially careful with concurrency and state**: queues, steering, executor attach/reclaim, turn
  recovery and pending-quit all depend on each other. Re-read the relevant invariants below and their
  tests before changing them. Where code reads the latest state through a ref (`queuesBySessionRef`,
  `pendingSteersRef`, …), do not switch it back to reading state captured in a closure.
- **Do not "fix" unrelated failing tests.** They are likely flaky or environment-dependent; mention
  them in your summary instead.
- Before handing over: `npm run build` and `npm test` pass (plus `npx tsc -p tsconfig.json` for
  renderer changes). See [building-and-testing.md](./building-and-testing.md).
- New UI strings go through `t()` and get a Chinese translation (`tests/i18n.test.ts` scans call
  sites). New UI state goes through `uiStore` / `uiRestore`. New persistent files go under
  `~/.kirolex/` and are written with tmp + rename.
- If you cannot confirm something from the code, do not guess it into code or docs — say so.
- Code comments and conflicting docs: **the code wins**. There are many stale comments (for example
  "1x1 … 3x3" in `App.tsx`, "overwrite same id" at the top of `s3Sync.ts`, the rsync mirror in
  `config.ts`, `eventLog.ts` mentioning a `renderer/runTimeline.ts` that no longer exists). Do not fix
  them as a side effect of an unrelated change.
- Commit messages in this repository are one Chinese sentence describing what changed (see `git log`).

## Invariants

### 1. kiro-cli releases its session lock only on a clean exit

- kiro-cli holds an **exclusive single-process lock** per session. Closing stdin makes it exit 0 and
  release the lock; **killing it leaves a stale lock**, after which `session/load` fails with
  `Session is active in another process (PID n)` even though that PID is long gone.
- Therefore `AcpClient.disconnect()` (`src/main/acp-client.ts`) closes stdin, waits up to 5 s for a
  clean exit, and only then kills. **Do not change it to kill immediately**, and never bypass
  `disconnect()` to kill an executor elsewhere.
- Every quit path must go through `before-quit`, which calls `disconnect()` on every executor:
  - `SIGTERM` / `SIGINT` are converted to `app.quit()` (end of `index.ts`);
  - Windows has no signals (`kill('SIGTERM')` is `TerminateProcess`), so under `--dev`
    `scripts/dev-hot.mjs` writes `~/.kirolex/dev-quit-request` and main polls it every 500 ms
    (`DEV_QUIT_REQUEST`; both sides must use the same path);
  - the control server's `onQuit` is the tray Quit path (`isQuitting = true; app.quit()`) — **never
    `process.exit`**, which skips `before-quit`.
- Remote sessions: killing the local ssh does **not** take the remote kiro-cli with it. See the
  orphan-process section of [remote-sessions.md](./remote-sessions.md#orphan-processes).
- Switching model or agent is "start the new executor, and close the old one only after the new one
  succeeded".

### 2. Steering and queue ordering

The authoritative description is the comment on `handleSteerMessage` in `App.tsx`. The rules:

- Plain **Enter** while a turn is running, in priority order:
  1. **Queue not empty** → append the text to the **last queued card** (no steer, no interruption);
     otherwise the steer would overtake already-queued messages.
  2. **Has attachments** → queue it (steer carries text only; files are never dropped).
  3. Otherwise → steer: inject into the **current** turn via `_session/steer`. A steer does **not**
     cancel the turn and does not start a new one (`scripts/steer-smoke.mjs` asserts
     `stopReason !== 'cancelled'`).
- **Ctrl/⌘ + Enter** always adds a new, separate FIFO item (`handleQueueMessage`).
- If a steer fails (unsupported, already idle, write error) it goes to the **front** of the queue and is
  sent first next turn. Messages are never lost.
- `steer_consumed` acknowledgements map FIFO to the **oldest** pending steer, so `pendingSteersRef` must
  be registered **before** the IPC is sent (kiro may acknowledge as soon as it reads stdin).
- Steers still unconsumed when the turn ends go back to the **front** of the queue in their original
  order. If the user presses **Stop**, unconsumed steers are discarded (`discardUnconsumedSteers`) but
  the regular queue is kept.
- Each session's queue is an independent FIFO drained in the background (`sendQueuedMessage` targets a
  session, not the focused pane). In split view each pane must read **its own** queue
  (`queuesBySessionRef.current[sessionId]`), not the focus-following `currentQueue` — that once made
  typed text silently disappear (`tests/queuePaneScope.test.ts`).
- Draining skips a session while it is streaming, the backend is occupied (including re-priming
  history), a loop holds it, a send is in progress, auto-recovery is running, a model/agent switch is in
  progress, or a quit is pending.
- Only kiro supports steer (`AcpClient.supportsSteer`); on claude / codex a running-turn Enter takes the
  "failed → front of queue" path.
- Queues persist in ui-state under `kirolex-queues`, unconsumed steers under `kirolex-pending-steers`,
  and are restored after a restart (restored items carry `restored: true`; `takeOrphanSteers` puts
  last run's steers back). That is why the control server reports `queued` as busy but **does not**
  block quitting.

### 3. All data lives in `~/.kirolex/`, never in `localStorage`

See [state-and-storage.md](./state-and-storage.md). In short: no environment variable relocates the
data; new UI state goes through `uiGet` / `uiSet` (or `restoreGet` / `restoreSet`); session and message
bodies come only from the durable records; `ui-state.json` is owned by main; JSON files are written with
tmp + `renameSync`.

### 4. Durability: user messages immediately, assistant messages when complete

- User messages are appended to `transcript.jsonl` immediately.
- Assistant replies are written **only when complete**; partial replies are discarded. Do not add
  write-while-streaming logic.
- The transcript is append-only; only edit-and-rerun truncates it.
- All sessions start as `detached` (`markAllExecutorsDetached`).
- `projectId` is write-once (`null → project` only); archiving does not clear it.

### 5. One session ↔ one executor process

- Executors are per session (`sessionClients` keyed by session id), **never shared by model**
  ([`DESIGN_session_architecture.md`](../DESIGN_session_architecture.md) §3).
- The executor cap limits **live executors**, not sessions; when full, idle executors are reclaimed and
  **busy ones never are**.
- Switching model or machine = tear down, start a new executor, replay context; the session id and
  transcript stay the same.

### 6. Remote sessions: execution remote, files local

- KiroLex's data and the project files are always local. The remote host gets only the executor and a
  disposable cache cwd (`sessionCwd`). No mirror, no rsync.
- Remote access to local files goes through the `local_*` tools over the reverse tunnel. The remote
  agent's `tools` field is a whitelist; leaving it out means no tools at all.
- Security boundary: loopback + URL token + announcing every write/command. **No path jails or other
  security theatre.**
- No configured kiro launch command on a machine → refuse to start and say where to configure it. Do not
  guess a default path.
- Every silent model/agent fallback by kiro-cli must be announced in the session (`pickRemoteModel` etc.).

### 7. Images: long edge capped at 1500 px

- Bedrock rejects the **whole request** if **any** image in the conversation exceeds 2000 px, and old
  images are re-sent from the transcript every turn — one large screenshot can break a session
  permanently. So images are downscaled **before** they enter the conversation (1500 for margin and
  tokens).
- Implemented in `index.ts`: `MAX_IMAGE_EDGE = 1500`, `capImageSize`, `safeImageRef` (writes to
  `~/.kirolex/capped/`, never modifies the original, cached by path + mtime + size),
  `capImagePathsInText` / `capImageRefsInText` (using `rewriteImagePaths` from `imagePaths.ts`). Applied to
  prompt text blocks, steers, history lines, pasted images (`app:save-clipboard-image`) and attachments
  (`app:prepare-image-attachment`).
- **Any new path that hands an image to the model must go through this layer.**

### 8. Automatic retries must not repeat side effects

- `planRetry` (`promptRetry.ts`) never auto-resends a turn that has already produced text or run any tool.
- Scheduled jobs and loop rounds are **recorded before they are sent** (`runScheduledJob`,
  `loopStore.beginRound`), so a crash cannot cause endless re-runs.
- After a reload, turn recovery first **adopts** a turn that is still alive and resends only once it is
  confirmed dead (`turnRecovery.ts`).

### 9. Other deliberate restrictions

- `loop:verify` only runs commands registered through `loop:register-verifier` (it is an
  arbitrary-command entry point). `localAction.ts` only accepts `open` with http(s) URLs. Both are
  intentionally tight.
- New confirmation prompts use `components/ConfirmDialog.tsx`, not `window.confirm` (which blocks the
  renderer's main thread; only `BackupDialog.tsx` still uses it).
- React hooks must not come after an early `return` (`tests/hookOrder.test.ts` scans the source).
- `scripts/remote-bootstrap.sh` must stay LF (`.gitattributes` enforces LF for `*.sh` and `*.mjs`).
- The control server (`controlServer.ts`) listens only on `127.0.0.1`; `/quit` needs the bearer token from
  `~/.kirolex/control.json`. While a quit is pending (`quitPending`), queued messages and scheduled/loop
  rounds do not start.

## Windows

Details in [`WINDOWS_GAPS.md`](../WINDOWS_GAPS.md). Common traps:

- **No POSIX signals**: `process.kill(pid, 'SIGTERM')` terminates immediately and
  `process.on('SIGTERM')` never fires → the file-based quit request above.
- **No SSH connection multiplexing** in Win32-OpenSSH → `muxSupported()` is false on win32.
- **Do not probe with bash / POSIX shells locally**: `binDetect.ts` uses `detectWindows` (PATH × PATHEXT,
  `.exe` and `.cmd`, verified by running `--version`); `localMcp.ts` has native `globNative` /
  `grepNative` and uses `%ComSpec% /d /s /c` for commands; `loopVerify.ts` likewise.
- **`.cmd` shims**: since Node 18.20.2 / 20.12.2, `spawn()` of a `.cmd` without `shell: true` throws
  `spawn EINVAL`. Run the tool's entry script with Node instead (`tool()` in `dev-hot.mjs`,
  `resolveAdapter` in `engines.ts`), or use `shell: true` with quoted paths (`localMcp.ts`).
- **Paths**: accept both separators; do not take a file name with `split('/').pop()` or build
  `${dir}/${name}` by hand (use `path` or `renderer/pathBits.ts`); `file:///C:/…` strips to `/C:/…`, so
  use `stripFileUrl` in `index.ts`; path regexes need a `[A-Za-z]:\\` branch and UNC (`\\server\share`)
  support (`forwardMcp.isLocalPathCommand`); expand `~` with `remoteTargets.expandHome` (`~` must be
  followed by a separator or the end).
- **Quoting**: POSIX single-quote `shellQuote` does not work in cmd.exe — prefer `execFile` /
  `execFileSync` (no shell) for local commands.
- **Process lists**: use `powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process …"`
  (`dev-hot.mjs`, `sweepStrayLocalSshWindows`, `procTree.ts`). If you cannot get a complete pid set,
  **kill nothing**.
- **`rename` fails with `EPERM` / `EBUSY` occasionally** (antivirus, indexer). Not a code bug, but the
  first suspect when "settings sometimes don't save".
- **Line endings**: the repository is LF (`.gitattributes`), but parsers must tolerate `\r\n`
  (`skillDoc.ts` and `localMcp.ts` framing do).
- `fs.watch` on Windows misses files created right at startup → `DEV_QUIT_REQUEST` is polled.
