# IPC: preload bridge and channels

The renderer never touches Node or Electron directly. Everything goes through two objects that
`src/main/preload.ts` exposes with `contextBridge.exposeInMainWorld`, and through IPC handlers
registered in `src/main/index.ts`.

## What preload exposes

### `window.kiroUiState`

```ts
window.kiroUiState.initial   // snapshot of ~/.kirolex/ui-state.json, fetched with sendSync('app:ui-state-all')
window.kiroUiState.set(key, value | null)   // send('app:ui-state-set', key, value) — fire-and-forget
```

It is synchronous on purpose: renderer code reads UI state inside `useState(() => …)` initializers,
where an async IPC would arrive too late. Do not use it directly — use `uiGet` / `uiSet` /
`uiRemove` from `src/renderer/uiStore.ts` (or `restoreGet` / `restoreSet` from `uiRestore.ts` for
state that should only survive restarts when the user opted in). On the main side
`ipcMain.on('app:ui-state-all')` returns the in-memory cache and `ipcMain.on('app:ui-state-set')`
calls `setUiStateKey`, which coalesces writes for 400 ms and writes with tmp + rename.

### `window.kiroApi`

A flat object of methods. Two shapes:

- **Requests** — `name: (...args) => ipcRenderer.invoke('<ns>:<name>', ...args)`. For example
  `prompt` → `acp:prompt`, `steer` → `acp:steer`, `readTranscript` → `acp:read-transcript`,
  `respondPermission` → `acp:request-permission-response`, `reviseInSession` →
  `review:revise-in-session`, `scheduleCreate` → `schedule:create`, `binsDetect` → `bins:detect`.
- **Subscriptions** — `onX: (cb) => { ipcRenderer.on('<channel>', …); return unsubscribe }`. For
  example `onUpdate` ← `acp:update`, `onAssistantFinal` ← `acp:assistant-final`, `onTurnWedged` ←
  `acp:turn-wedged`, `onPendingQuit` ← `control:pending-quit`, `onSessionReady` ←
  `session:ready-for-first-prompt`.

A few methods are not IPC at all: `setUiZoom` calls `webFrame.setZoomFactor` in the preload itself.

The TypeScript type of `window.kiroApi` is declared by hand in the `declare global { interface Window … }`
block at the top of `src/renderer/App.tsx`; it is not generated from `preload.ts`.

There is no `window.api`.

## Channel naming

Handlers are registered inline in `index.ts` as `ipcMain.handle('<namespace>:<kebab-name>', …)`.
Events pushed from main use `mainWindow.webContents.send('<namespace>:<kebab-name>', payload)`.
Handlers for a feature are usually defined next to each other; some live inside `whenReady` or
after the single-instance check, so search by channel name rather than by position.

## Request channels, by namespace

All names below are registered with `ipcMain.handle` in `src/main/index.ts` unless noted.

### `acp:` — sessions and executors (the largest group)

| Area | Channels |
|---|---|
| Lifecycle | `acp:new-session`, `acp:load-session` (→ `loadSessionImpl`), `acp:connect`, `acp:disconnect`, `acp:reveal`, `acp:splash-status` |
| Durable records | `acp:list-durable-sessions`, `acp:read-transcript`, `acp:truncate-transcript-before`, `acp:rewrite-transcript`, `acp:delete-session` (→ `purgeSession`), `acp:archive-session`, `acp:rename-session`, `acp:mark-session-purpose`, `acp:set-session-pinned`, `acp:read-events` |
| Projects | `acp:assign-project`, `acp:set-project`, `acp:move-session` |
| Turns | `acp:prompt` (→ `sendPromptOnce`), `acp:cancel`, `acp:steer`, `acp:persist-steer`, `acp:persist-note`, `acp:request-permission-response`, `acp:peek-turn`, `acp:get-busy-map`, `acp:get-usage` |
| Context | `acp:prime-history`, `acp:ensure-context`, `acp:set-prime-mode`, `acp:clear-context`, `acp:mark-cleared`, `acp:write-context-override`, `acp:clear-context-override`, `acp:read-last-injection` |
| Memory | `acp:read-memory`, `acp:write-memory`, `acp:backup-memory`, `acp:memory-bytes`, `acp:delete-project-memory` |
| Models, agents, engines | `acp:list-models`, `acp:switch-model`, `acp:switch-kiro-agent`, `acp:switch-permission-mode`, `acp:switch-engine`, `acp:engine-models`, `acp:set-engine-model`, `acp:set-engine-option`, `acp:session-commands` |
| MCP combos | `acp:mcp-combos`, `acp:mcp-combos-file`, `acp:save-mcp-combos`, `acp:switch-mcp-combo` |
| Placement | `acp:set-remote-target`, `acp:get-executor-cap` |
| kiro-cli's own sessions | `acp:list-sessions` — lists **kiro-cli's** sessions, not KiroLex's |

### `app:` — application services

| Area | Channels |
|---|---|
| UI state (`ipcMain.on`) | `app:ui-state-all` (sync), `app:ui-state-set` |
| Settings | `app:get-features`, `app:set-feature`, `app:get-executor-cap-info`, `app:set-executor-cap`, `app:get-wedge-timeout`, `app:set-wedge-timeout`, `app:get-tool-stall-timeout`, `app:set-tool-stall-timeout`, `app:get-helper-models`, `app:set-helper-models`, `app:get-forward-mcp`, `app:set-forward-mcp`, `app:get-workspace-dir`, `app:set-workspace-dir`, `app:set-kiro-trace`, `app:remote-targets` |
| Files and images | `app:pick-files`, `app:save-clipboard-image`, `app:prepare-image-attachment`, `app:image-data-url`, `app:save-paste-text`, `app:read-paste`, `app:get-draft-pastes`, `app:set-draft-pastes`, `app:path-exists`, `app:show-in-folder`, `app:open-external`, `app:get-home-dir` |
| Helpers | `app:generate-title`, `app:generate-suggestions`, `app:notify-session-idle`, `app:get-auto-resent`, `app:set-auto-resent` |
| Logs | `app:get-logs`, `app:open-logs` |

### Other namespaces

| Namespace | Channels | Notes |
|---|---|---|
| `kiro:` | `kiro:list-agents`, `kiro:open-agent-config`, `kiro:save-agent-config`, `kiro:config-categories`, `kiro:config-list`, `kiro:config-read`, `kiro:config-write`, `kiro:versions`, `kiro:update` | kiro-cli configuration, per machine |
| `loop:` | `loop:persist`, `loop:begin-round`, `loop:read`, `loop:list-live`, `loop:clear`, `loop:register-verifier`, `loop:verify` | `loop:verify` only runs commands registered first via `loop:register-verifier` |
| `schedule:` | `schedule:create`, `schedule:list`, `schedule:pause`, `schedule:remove` | changes broadcast as `schedule:changed` |
| `remote:` | `remote:save`, `remote:delete`, `remote:test`, `remote:bootstrap`, `remote:pick-dir`, `remote:pick-key` | bootstrap output streamed as `remote:bootstrap-output` |
| `local:` | `local:save-workdir`, `local:save-bins` | the local machine's workdir and launch commands |
| `bins:` | `bins:detect`, `bins:test` | detect / verify CLI launch commands (`binDetect.ts`) |
| `ai-login:` | `ai-login:status`, `ai-login:apply`, `ai-login:local-config`, `ai-login:run`, `ai-login:input`, `ai-login:cancel` | output streamed as `ai-login:output` / `ai-login:exit` |
| `review:` | `review:revise-in-session`, `review:write-file`, `review:backup-file`, `review:cancel`, `review:tickets-done` | revisions queue (not reject) when the session is busy; patch writes happen in main |
| `workspace:` | `workspace:list`, `workspace:read`, `workspace:download`, `workspace:copy-remote-to-local`, `workspace:watch-files` | changes pushed as `workspace:file-changed` |
| `preview:` / `deck:` | `preview:deck`, `preview:pdf-bytes`, `deck:write-note`, `deck:read-slide-text`, `deck:write-slide-text`, `deck:revise-slide-text` | LibreOffice / python-pptx backed (`deckPreview.ts`) |
| `s3:` | `s3:get-config`, `s3:save-config`, `s3:test`, `s3:sync-now`, `s3:list-backups`, `s3:restore`, `s3:projects`, `s3:delete-sessions`, `s3:delete-project`, `s3:keep-local` | `s3:restore` merges; secrets never return to the renderer |
| `project:` | `project:get-workspace`, `project:set-workspace` | `projectStore.ts` |
| `session:` | `session:note` | |
| `window:` | `window:control`, `window:focus-session`, `window:open-run` | |
| `control:` | `control:pending-quit` | also pushed as an event |

## Events pushed from main

| Channel | Meaning |
|---|---|
| `acp:update` | Streaming `session/update` content for a session (chunks, tool calls, plans, usage) |
| `acp:assistant-final` | A turn finished; the complete assistant message has been persisted |
| `acp:user-message` | Main appended a message to the transcript on its own — e.g. a KiroLex note via `noteInSession` (stored as `role: 'user'` with `kirolex: true`, shown in the UI but never sent to the model) |
| `acp:error`, `acp:notice` | Errors and user-visible notices (including classified stderr) |
| `acp:session-busy`, `acp:session-model` | Busy state and the effective model of a session |
| `acp:turn-wedged`, `acp:turn-quiet`, `acp:turn-restart` | Wedge-watchdog outcomes |
| `acp:disconnected`, `acp:reattached` | Executor went away / came back |
| `acp:subagents` | kiro native subagent roster |
| `acp:memory-bytes` | Size of the memory block actually injected |
| `acp:sessions-purged`, `acp:mcp-combos-changed` | Bulk changes the renderer must reflect |
| `session:notice`, `session:history-changed`, `session:placement-changed`, `session:engine-changed`, `session:engine-models`, `session:targets-changed`, `session:focus-request`, `session:ready-for-first-prompt`, `session:detached-for-restore` | Per-session state changes |
| `schedule:changed`, `control:pending-quit`, `s3:conflicts`, `s3:sync-done` | Feature-level broadcasts |
| `workspace:file-changed`, `window:maximized`, `app:ui-zoom-key` | UI plumbing |
| `remote:bootstrap-output`, `ai-login:output`, `ai-login:exit` | Streaming output of long-running helper processes |

`flowreg:changed`, `run:changed` and the `window:open-run` handler (plus preload bindings such as
`onFlowRegChanged`, `onRunAdvance`) belong to an older "flow" feature; check the code before building
on them.

## Adding an IPC channel

Three places, every time:

1. **`src/main/index.ts`** — `ipcMain.handle('<ns>:<name>', async (_event, …) => { … })`, next to
   the handlers of the same feature. Keep the decision logic in a pure module and call it from here.
2. **`src/main/preload.ts`** — a wrapper on `kiroApi`
   (`myThing: (a: string) => ipcRenderer.invoke('<ns>:<name>', a)`), or an `onX` subscription that
   returns an unsubscribe function.
3. **Renderer** — add the method to the `Window['kiroApi']` type in `App.tsx`'s `declare global`, then
   call it.

If the handler's wiring matters (for example "this handler must call that guard"), add a
source-scanning test as described in [building-and-testing.md](./building-and-testing.md).
