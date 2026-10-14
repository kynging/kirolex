# Architecture

KiroLex is a standard three-part Electron app — main process, preload script, renderer — wrapped
around a fleet of **ACP executor processes**, one per live session. This page explains the
boundaries between those parts and how an executor is born, used and torn down.

```
┌──────────────────────── renderer (React, Vite) ────────────────────────┐
│ main.tsx → <ErrorBoundary><App/>                                        │
│ App.tsx (cross-session orchestration) · hooks/useAcp.ts (session engine)│
│ components/ChatArea.tsx (one chat pane) · components/*.tsx · *.ts (pure)│
└──────────────▲───────────────────────────────────────┬─────────────────┘
               │ window.kiroApi / window.kiroUiState    │ ipcRenderer.invoke / send
┌──────────────┴──────────── preload.ts (contextBridge) ▼─────────────────┐
└──────────────▲───────────────────────────────────────┬─────────────────┘
               │ webContents.send('acp:…')             │ ipcMain.handle('<ns>:<name>')
┌──────────────┴──────────── main process (Node, CommonJS) ▼──────────────┐
│ index.ts: IPC handlers, executor lifecycle, tray, ui-state, scheduler,  │
│           S3, remote sessions …                                         │
│ *.ts: pure modules extracted from index.ts (no electron import)         │
└───────┬───────────────────────────┬───────────────────────────┬────────┘
        │ stdio JSON-RPC (ACP)      │ ssh … (stdio JSON-RPC)    │ HTTP 127.0.0.1
   kiro-cli acp / claude-agent-acp  remote kiro-cli acp         controlServer,
   / codex-acp (local)              (see remote-sessions.md)    localMcp
```

## Process boundaries

### Main process — `src/main/`

- Compiled by `tsc -p tsconfig.main.json` to CommonJS in `dist/main/`; `package.json` `main` points
  at `dist/main/index.js`.
- `src/main/index.ts` (~12,500 lines) is the hub. It registers **every** IPC handler inline, owns
  the live executors (`sessionClients`), the tray, the shared UI state, the schedule ticker, S3
  sync, the remote-session plumbing and the local control server.
- Every other `src/main/*.ts` file is a module extracted from `index.ts`. Most are **pure**: they
  take state and paths as parameters and return decisions, so `node:test` can import them directly
  (see [building-and-testing.md](./building-and-testing.md)). `index.ts` collects state and calls them.

### Who may import `electron`

Exactly two files: **`src/main/index.ts`** and **`src/main/preload.ts`**. Nothing else in
`src/main` imports `electron`, directly or transitively — that is what makes those modules
testable under plain Node. Keep it that way: if new logic needs an Electron API, put the pure
decision in a module and do the Electron call in `index.ts`.

A few modules are shared with the renderer (for example `memoryPolicy.ts`, `reviewApply.ts`,
`schedule.ts`). Those must not import Node built-ins either, or Vite would have to bundle them.

### Preload — `src/main/preload.ts`

Uses `contextBridge.exposeInMainWorld` to expose two objects and nothing else:

- `window.kiroApi` — almost entirely thin wrappers over `ipcRenderer.invoke(...)`, plus `on…`
  subscriptions for events pushed by main.
- `window.kiroUiState` — `initial` (a snapshot fetched **synchronously** at preload time with
  `sendSync('app:ui-state-all')`) and `set` (`send('app:ui-state-set')`).

There is no `window.api`. Details in [ipc.md](./ipc.md).

### Renderer — `src/renderer/`

- Vite with `src/renderer` as root, output `dist/renderer/`. Loaded from `file://` by `npm start`,
  from `http://localhost:5173` in dev.
- `main.tsx` is the entry: `createRoot` → `<ErrorBoundary><App/>`.
- `App.tsx` (~4,700 lines) is the root component and orchestrates across sessions: per-session
  queues, steering, the split layout (up to 2×2 panes), the shared file viewer and side-panel preview.
- `hooks/useAcp.ts` (~4,900 lines) is the renderer's session engine: connecting/attaching, streaming
  updates, hydrating the session list from the durable records, steer bookkeeping, turn recovery after
  a reload, and mirroring a session into multiple panes.
- `components/ChatArea.tsx` (~4,800 lines) is one chat pane: message list, composer
  (`ChatInputBox`), queued-message cards (`QueueStack`).
- Logic that needs tests is pulled out of `.tsx` into plain `src/renderer/*.ts` modules.
- The type of `window.kiroApi` is declared in the `declare global { interface Window … }` block at the
  top of `App.tsx`.

## Startup and shutdown (main)

1. `app.requestSingleInstanceLock()`. If another KiroLex already holds the lock, main prints how to
   stop the old process and calls `app.exit(42)`.
2. First `app.whenReady()`: `migrateUiStateFromFileOrigin` → ui-state cleanup
   (`clearRunScopedUiState`, `pruneDeadUiStateKeys`) → `pruneSessionTrash` (30-day trash) →
   `createTray()` / `createSplashWindow()` / `createWindow()`. The main window becomes visible when
   the renderer has hydrated its sessions and calls `acp:reveal` (with a timeout fallback).
3. A second `app.whenReady()` starts the local control server (`createControlServer`, in
   `controlServer.ts`).
4. On startup every session is treated as detached (`markAllExecutorsDetached` in
   `sessionStore.ts`): KiroLex never assumes a previous run's executor is still alive.
5. Quit: `before-quit` disconnects every executor and closes SSH multiplex masters
   (`sshMux.closeAll()`). `SIGTERM` / `SIGINT` are turned into `app.quit()`. Under `--dev` on Windows
   (no POSIX signals) main also polls the file `~/.kirolex/dev-quit-request` (`DEV_QUIT_REQUEST`).
   `window-all-closed` does nothing — the app stays in the tray.

Every exit path must go through `before-quit`; see the executor-lock invariant in
[contributing.md](./contributing.md#1-kiro-cli-releases-its-session-lock-only-on-a-clean-exit).

## Sessions vs. executors

| | Session (durable) | Executor (disposable) |
|---|---|---|
| Where | `~/.kirolex/sessions/<id>/` — `record.json`, `transcript.jsonl`, `history.md`, … | A child process (`kiro-cli acp`, or an adapter), locally or over `ssh` |
| Owner | `sessionStore.ts` | `AcpClient` in `acp-client.ts`, tracked by `sessionClients` in `index.ts` |
| Lifetime | Until the user deletes it (then trash for 30 days) | From attach until idle reclaim, model/agent/machine switch, disconnect or quit |
| Identity | KiroLex session id (`safeId`: `^[A-Za-z0-9_-]{1,120}$`) | The backend's own `cliSessionId`, stored in the record and replaceable |

The rule is **one session ↔ one executor process**. Executors are keyed by session id, never shared
between sessions with the same model ([`DESIGN_session_architecture.md`](../DESIGN_session_architecture.md)
§3 explains why).

### Executor lifecycle (in `index.ts`)

- **Live table.** `sessionClients: Map<string, SessionEntry>` maps a KiroLex session id to its live
  executor. A `SessionEntry` holds the `AcpClient`, the backend `cliSessionId`, the `AgentProfile`,
  the working directory, and the in-flight assistant buffer (`assistantBuf`) that is flushed to the
  transcript only when the turn completes.
- **Attach.** `acp:new-session` creates the record; `acp:load-session` → `loadSessionImpl` attaches an
  executor to an existing record. `loadSessionImpl` is the **only** attach implementation: it refuses
  to resurrect deleted sessions, waits for an in-progress model/agent switch, and coalesces
  concurrent attaches of the same session through `attachInFlight` (kiro-cli allows exactly one owner
  per session).
- **Spawn.** `connectWithModelFallback` starts the process and, if the chosen model is unavailable on
  that machine, walks the fallback order — and says so in the session, because a silent swap is
  indistinguishable from the user's choice.
- **Capacity.** `ensureExecutorCapacity` enforces a cap on *simultaneously live executors* (not on
  sessions): `DEFAULT_EXECUTOR_CAP = 10`, overridable by `executorCap` in `config.json` (1–64; the
  effective value is `MAX_CONCURRENT_SESSIONS`). When full it reclaims the cheapest **idle** executor;
  it never reclaims a busy one. Reclaimed sessions re-attach on demand.
- **Send.** `acp:prompt` → `sendPromptOnce`: prepends the memory block and (for remote sessions) the
  remote-context block, caps image sizes, writes the user message to the transcript immediately, then
  calls `AcpClient.sendPrompt` and runs the wedge watchdog. Automatic resends are decided by
  `planRetry` (`promptRetry.ts`).
- **Wedge detection.** `WEDGE_CONFIRM_MS` (maximum silence, default 600 s, configurable, 0 = never
  interrupt) and `TOOL_STALL_MS` (maximum time an open tool call may go without updates). A wedged
  turn is cancelled (`session/cancel`), main emits `acp:turn-wedged`, and `useAcp.ts` continues with
  `WEDGE_CONTINUE_PROMPT`.
- **Detach.** `detachExecutor` removes the entry and calls `AcpClient.disconnect()`. Model, agent or
  machine switches are "start the new executor, then close the old one": session id and transcript
  stay the same, and the new executor is re-primed from history (`acp:prime-history`,
  `historyBudget.ts`, `primeRetry.ts`).

What counts as "busy" (for capacity, quit and the control server) is decided by
`collectBusySessions` in `busySessions.ts`: reasons `turn`, `schedule`, `revise`, `queued`; only
`queued` does not block quitting, because queues are already persisted.

## ACP and the engine abstraction

ACP (Agent Client Protocol) is JSON-RPC 2.0 over stdio, newline-delimited. All three engines speak it,
so "adding an engine" in KiroLex means "a different command to spawn" — sessions, records and context
rebuilding do not change.

### `src/main/engines.ts`

- `type Engine = 'kiro' | 'claude' | 'codex'`, `ENGINES`, `ENGINE_LABEL`.
- `engineOf(profile)` — which engine a session profile uses (default `kiro`).
- `ADAPTER_PACKAGE` / `REMOTE_ADAPTER_BIN` — the npm adapters `@agentclientprotocol/claude-agent-acp`
  and `@agentclientprotocol/codex-acp` and their binary names on remote hosts.
- `resolveAdapter(...)` — runs an npm adapter with Electron's bundled Node (`ELECTRON_RUN_AS_NODE=1`)
  instead of through a `.cmd` shim, which avoids `spawn EINVAL` on Windows. Override with
  `KIROLEX_<ENGINE>_ACP` (e.g. `KIROLEX_CLAUDE_ACP`).

The comment at the top of `src/main/config.ts` still says "kiro-cli only"; that is out of date.

### `src/main/acp-client.ts` — `class AcpClient`

- `connect()` spawns the executor:
  - local kiro: `kiro-cli acp [--agent …] --model …`, with the binary located by `resolveKiroCli()` /
    `kiroCliCandidates()` (order: `KIRO_CLI_PATH` → known install locations → `PATH`);
  - remote: `ssh … <buildRemoteKiroCommand(...)>` (the remote command first prints
    `KIROLEX_REMOTE_PID $$`, then `exec`s, so the remote PID is known);
  - claude / codex: the launch from `resolveAdapter`.
  Then `initialize` (45 s timeout, `INITIALIZE_TIMEOUT_MS`).
- `newSession`, `loadSession` — `session/new`, `session/load`.
- `sendPrompt` — `session/prompt`, **no** timeout (turns can be long). Other requests go through the
  private `sendRequest`, which has a 120 s *idle* timeout.
- `cancelPrompt` — the `session/cancel` notification.
- `steer` — fire-and-forget `_session/steer` (kiro-cli extension), body wrapped in `<user_message>`;
  lifecycle notifications `steer_queued` / `steer_consumed` / `steer_cleared` arrive on
  `session/update`. Only kiro supports it (`supportsSteer`).
- `handleAgentRequest` — answers agent-to-client requests, chiefly `session/request_permission`
  (auto-approve or ask the user; for remote sessions also the remote-write guard from
  `remoteWriteGuard.ts`). `respondToPermission` sends the user's decision.
- `setModelOption` / `setSelectOption` — engine-side model and option selects (Claude Code / Codex).
- `disconnect()` — close stdin, wait up to 5 s for a clean exit, only then kill. For remote sessions,
  kill the remote process tree by PID over ssh (`remoteKillTree`). **Do not shortcut this** — see
  [contributing.md](./contributing.md).

Streaming output arrives as `session/update` notifications (`agent_message_chunk`, tool calls,
`usage_update`, plan entries…). Main forwards them to the renderer as `acp:update` and, at the end of
a turn, persists the complete assistant message and emits `acp:assistant-final`.

kiro-specific extras handled around the client: native subagents (`_kiro.dev/subagent/list_update`,
parsed in `subagents.ts` and pushed as `acp:subagents`), stderr turned into user-visible notices
(`stderrNotice.ts`), and kiro-cli's own log for the real cause of an `Internal error`
(`kiroCliLog.ts`).

## Renderer-side orchestration in one paragraph

`useAcp.ts` rebuilds the session list from `acp:list-durable-sessions` and each transcript from
`acp:read-transcript` (message bodies are not cached in `localStorage`). `App.tsx` owns one FIFO queue
per session (`queuesBySession`) and drains it in the background with `sendQueuedMessage`, so a session
need not be focused to make progress. Running-turn input is steered (`handleSteerMessage`) or queued
(`handleQueueMessage`) according to the ordering rules in
[contributing.md](./contributing.md#2-steering-and-queue-ordering). After a reload, `turnRecovery.ts`
(`decideTurnRecovery`) first re-attaches to a turn that is still running in main and only resends if
it really died.
