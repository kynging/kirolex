# Module map

One line per module, grouped by feature. **Every** `src/main/*.ts` file is listed (67 files); for
`src/renderer` the main modules are listed. "Pure" means no `electron` import and no hidden I/O, so
the module can be imported from `node:test` directly.

If you add a module, add it here.

## `src/main/` — main process

### Core and entry points

| Module | What it does |
|---|---|
| `index.ts` | The hub (~12,500 lines): app startup/shutdown, every `ipcMain.handle`, the live executor table `sessionClients`, attach (`loadSessionImpl`), send (`sendPromptOnce`), tray and windows, ui-state, schedule ticker, S3, remote plumbing. One of only two files that import `electron`. |
| `preload.ts` | `contextBridge` bridge exposing `window.kiroApi` (IPC wrappers) and `window.kiroUiState` (synchronous ui-state snapshot). The other `electron` importer. |
| `config.ts` | Types for a session's execution profile (`AgentProfile`, `RemoteTarget`, `PermissionMode`), `DEFAULT_MODEL`, `MODEL_FALLBACK_ORDER`, write-once project rules (`canAssignProjectId`) and the per-session cwd (`sessionCwd`, a cache dir on remote hosts). |
| `logger.ts` | `logger.info/warn/error(scope, msg)`; one log file per launch in `~/.kirolex/logs/`, 2 MB rotation, last 10 launches kept (`LAUNCH_LOGS_KEPT`). |
| `zoomKeys.ts` | Pure: maps Ctrl/⌘ + `+` / `-` / `0` in `before-input-event` to a UI-zoom action (`zoomKeyAction`). |
| `idleNotice.ts` | Pure: the main-process half of "notify when a pinned session goes idle" — only when the window is not actively being looked at (`windowIsActive`). |
| `controlServer.ts` | Pure HTTP control endpoint on `127.0.0.1` (`/ping`, `/quit`, `/quit/cancel`), port/token in `~/.kirolex/control.json`; used by external tooling to request a graceful quit. |
| `busySessions.ts` | Pure: `collectBusySessions` (reasons `turn` / `schedule` / `revise` / `queued`) and `blocksQuit` (everything except `queued`). |

### Sessions and transcripts (durable record)

| Module | What it does |
|---|---|
| `sessionStore.ts` | The durable session store: `record.json` (versioned by `SESSION_SCHEMA_VERSION`), append-only `transcript.jsonl`, rendered `history.md`; `createSession`, `readRecord`, `writeRecord`, `patchRecord`, `appendMessage`, `readTranscript`, `truncateTranscriptBefore`, `rewriteTranscript`, `markAllExecutorsDetached`, `safeId`. |
| `eventLog.ts` | Per-session `events.jsonl` with timestamped run events (no message bodies), capped at `MAX_EVENT_LOG_BYTES` (4 MB); `appendEvent` never throws. |
| `projectStore.ts` | A project's own config (currently just its working directory) in `~/.kirolex/projects/<name>/project.json`; `readProject`, `writeProject`, `projectCwd`. |
| `sessionPurge.ts` | Moving a deleted session's directory into the trash with real waiting retries (`LOCK_RETRY_DELAYS_MS`) for Windows `EBUSY`/`EPERM`, plus background retries (`scheduleBackgroundRetries`). |
| `transcriptMerge.ts` | Pure merge of two copies of a session (S3 conflict): `mergeTranscripts` (dedupe by `id`, stable sort by `ts`, local wins on conflict) and `mergeRecords` (`cliSessionId` / `executorState` always local). |
| `kirolexNote.ts` | Pure: tells KiroLex's own notes (stored as `role: 'user'` with a `kirolex` flag) apart from real user messages so they never reach the model (`isKirolexNote`, `modelFacing`, `stripKirolexNotes`). |
| `historyBudget.ts` | Pure: how much history to replay when re-priming a new executor (`fitHistory`, `historyTrimNote`) — oversized history makes the backend fail with a bare `Internal error`. |
| `primeRetry.ts` | Pure: what to do after a history-priming chunk fails — `retry`, `split` or `give-up` (`primeVerdict`). |
| `restoreArchive.ts` | Pure: where a session restored from backup should land (project + archived) using "most recently moved wins" (`restorePlacement`). |

### ACP executors and engines

| Module | What it does |
|---|---|
| `acp-client.ts` | `class AcpClient`: spawns and talks to one executor over stdio JSON-RPC — `connect`, `initialize`, `newSession`, `loadSession`, `sendPrompt`, `cancelPrompt`, `steer`, permission handling (`handleAgentRequest`), graceful `disconnect`; also `resolveKiroCli`, `kiroCliCandidates`, `buildRemoteKiroCommand`, `remoteKillTree`. |
| `engines.ts` | The `Engine` type (`kiro` / `claude` / `codex`), `ENGINE_LABEL`, `engineOf(profile)`, and `resolveAdapter` (runs the npm ACP adapters with Electron's Node; overridable via `KIROLEX_<ENGINE>_ACP`). |
| `attachGate.ts` | Pure: `settleInFlightAttach` waits for a session's in-flight attach to settle before its run location is switched. |
| `staleSession.ts` | Pure: after a bare `Internal error`, decide whether the backend session id is stale and the executor should be rebuilt (`staleVerdict`). |
| `promptRetry.ts` | Pure: `planRetry` — auto-resend only transient transport failures, and never once the turn has produced text or run any tool. |
| `transientError.ts` | Pure classification of transport-level errors (`isTransientTransportError`, `isSshTransportExit`, `sshDropMessage`). |
| `reachability.ts` | Pure per-host circuit breaker (`Breaker`, `backoffMs`, `worthRetrying`) so twenty sessions do not all hammer an unreachable machine. Takes `now` as a constructor parameter. |
| `stderrNotice.ts` | Pure: classifies executor stderr into user-visible notices (e.g. an MCP server failed to start) versus noise (`noticesFromStderr`). |
| `subagents.ts` | Pure: parses kiro's native subagent roster (`_kiro.dev/subagent/list_update`) — `parseSubagentList`, `activeSubagents`, `subagentTag`. |
| `failureBundle.ts` | On a failed send, writes a diagnostic bundle (prompt, injection, backend session files…) to `~/.kirolex/failures/` (`writeFailureBundle`). |
| `kiroCliLog.ts` | Reads kiro-cli's own log (`$TMPDIR/kiro-log/kiro-chat.log`) to explain a generic `Internal error` (`parseTailErrors`, `explainCliError`) and trims huge logs (`logsToTrim`). Trace via `KIROLEX_KIRO_TRACE=1` or `~/.kirolex/kiro-trace`. |
| `procTree.ts` | Windows process-tree kill: lists processes via PowerShell, kills only descendants of one root pid, guarded by creation time against pid reuse (`descendantsOf`, `taskkillTree`). |

### Models, agents and CLI configuration

| Module | What it does |
|---|---|
| `modelAvailability.ts` | Which models this machine's kiro-cli actually has (`parseModelList`, `pickAvailableModel`, `remoteFallbackModel`) and pinning the chosen model into the agent (`pinAgentModel`). |
| `modelMeta.ts` | Cache of model metadata (rate multiplier, context window) in `~/.kirolex/model-meta.json`, merged across machines (`mergeMeta`, `enrichModels`). |
| `kiroAgentList.ts` | Pure parser for `kiro-cli agent list` output (`parseAgentList`), used for local and remote machines. |
| `kiroConfig.ts` | The other `~/.kiro` config categories shown in the agent panel tabs: list / read / write with path validation (`CATEGORIES`, `categoriesFor`, `validateContent`). |
| `skillDoc.ts` | Pure parser for real kiro `SKILL.md` files (`parseSkillDoc`, `describeSkill`) and skill backup pruning. |
| `mcpCombos.ts` | Named MCP server sets for Claude Code / Codex sessions, stored in `~/.kirolex/mcp-combos.json` (`readMcpCombos`, `saveMcpCombos`, `pickCombo`). |
| `binDetect.ts` | Detects and verifies the launch commands for kiro / claude / codex on each machine and remembers ones that worked (`detectScript`, `parseDetect`, `rememberBin`; native `detectWindows` path on Windows). |
| `aiLogin.ts` | Pure text transforms for Claude Code / Codex login config on a target machine (`mergeClaudeSettings`, `applyCodexProvider`, `parseClaudeStatus`, `parseCodexStatus`). |
| `kiroLogin.ts` | Remote kiro login via device flow; reads the hints from the local `kiro-cli whoami` (`parseWhoami`, `loginEnv`). |

### Memory

| Module | What it does |
|---|---|
| `memory.ts` | Three-layer Markdown memory (global / project / session) under `~/.kirolex/memory/`; `buildMemoryInjection`, `readMemory`, `writeMemory`, `backupMemoryLayer`. |
| `memoryPolicy.ts` | Pure, shared with the renderer (no Node built-ins): size-warning thresholds (`MEMORY_WARN_BYTES`), `MEMORY_BACKUPS`, the compaction prompt. |
| `sessionMemory.ts` | Pure: when and how to auto-consolidate a session's memory (`shouldConsolidate`, `buildConsolidationPrompt`, `CONSOLIDATE_EVERY`, `MAX_CHARS`). |

### Remote sessions (SSH)

| Module | What it does |
|---|---|
| `remoteTargets.ts` | The `remotes[]` list in `config.json` and per-machine launch commands: `listRemoteTargets`, `findRemoteTarget`, `saveRemoteTarget`, `validateTarget`, `expandHome`, `localBins`, `rememberBinSuccess`. |
| `sshMux.ts` | `class SshMux`: one `ssh -N` master per host carrying a single reverse tunnel with an sshd-allocated port, self-healing with backoff (`HEAL_BACKOFF_MS`); `muxSupported()` is false on win32. Also exports `waitFor`. |
| `sshProxy.ts` | Jump hosts via `ProxyCommand` (`proxyArgs`) and host-string safety (`assertSafeSshHost`). |
| `sshAuth.ts` | Password login through `SSH_ASKPASS` (helper in `~/.kirolex/askpass/`), `sshEnv`, `batchModeFor`; plaintext only in memory. |
| `remotePreflight.ts` | One ssh round-trip that answers `ok` / `unreachable` / `missing-tools` / `not-logged-in`, plus machine specs and `remoteExecutorCap`. |
| `localMcp.ts` | HTTP MCP server running **locally** on `127.0.0.1` with a per-session URL token: `local_read`, `local_write`, `local_glob`, `local_grep`, `local_git`, `local_bash`; also proxies forwarded MCP servers (`HttpProxy`). |
| `remoteLocalTools.ts` | Wiring for the above: per-session remote agent `kirolex-local-<id>` (`remoteAgentScript`), remote port allocation (`allocateRemotePort`), remote orphan / stale-executor sweep scripts. |
| `forwardMcp.ts` | Which local MCP servers must be forwarded to a remote session (local-path commands, `playwright`-style tools, an explicit list) — `forwardableFrom`, `isLocalPathCommand`, `remoteForwardPlan`. |
| `remoteContext.ts` | Builds the per-turn block telling the model the project is not on that machine and to use `local_*` tools (`remoteContextBlock`). |
| `remoteWriteGuard.ts` | Keeps deliverables local: blocks remote built-in writes outside the remote cache dir (`~/.cache/kirolex/…`, `REMOTE_CACHE_SUBDIR`) and copies stray remote files back (`remoteWriteVerdict`, `saveRemoteCopy`). |
| `remoteRecovery.ts` | `class RemoteRecovery`: keeps reconnecting broken remote sessions with backoff until they attach or are archived/deleted/moved local. |
| `localAction.ts` | Pure: parses `KIROLEX-LOCAL: open <url>` lines in replies (only `open`, only http(s)) — `parseLocalActions`. |
| `hostOps.ts` | Host abstraction for "which machine is this file on": `LocalHost` (fs) and `SshHost` (unix commands), chosen by `hostFor`. |

### Loops and schedules

| Module | What it does |
|---|---|
| `schedule.ts` | Pure, shared with the renderer: `ScheduleKind` (`interval` / `daily` / `weekly` / `once`), mandatory `maxRuns`, `validateSchedule`, `dueAt`, `isDue`, `recordRun`. |
| `scheduleStore.ts` | `~/.kirolex/schedules/<id>.json`, one file per job; every function takes `home`. |
| `loopStore.ts` | Main-owned durable loop round counter in `~/.kirolex/loop-runs/<sid>.json`; `beginRound` checkpoints before a round is sent. |
| `loopVerify.ts` | Runs a user-written verification command and trusts only its exit code, on the same machine the agent runs on (`runVerifier`, `rejectRequest`). |

### S3 backup and sync

| Module | What it does |
|---|---|
| `s3Sync.ts` | What to sync (whitelist: session files, `files/`, `memory/**`, `attachments/**`, `pasted/**`), change detection via size+mtime, catalog layout, memory conflict policy. |
| `s3Client.ts` | Hand-rolled `https` client for PutObject / GetObject / ListObjectsV2 / DeleteObject with typed errors (`S3Error` with `code` and `hint`). |
| `awsSigV4.ts` | Pure AWS Signature V4 signing (`signRequest`), pinned to the AWS documentation test vector. |

### Side-panel review, previews and decks

| Module | What it does |
|---|---|
| `reviseBlock.ts` | Pure: prompts for "revise this in the session that opened the file" and reply parsing (`reviseInSessionPrompt`, `parseRevised`, `parsePatchReply`, `replyUsable`, slide-text variants). |
| `reviewApply.ts` | Pure, shared with the renderer: splices a revision back into the full text (`spliceLines`, `applyPatch`, `applyRevision`). |
| `reviewAccess.ts` | Pure: the write-back gate — only files this session's tab actually read may be written (`ReviewedPaths`, `remoteReviewKey`, `pickReviewTarget`). |
| `deckPreview.ts` | `.pptx` / `.docx` → PDF via LibreOffice for the built-in viewer, and python-pptx helpers for notes / slide text (`pickConverter`, `CONVERTIBLE_EXTS`). |
| `convertOnce.ts` | `class ConvertOnce`: de-duplicates concurrent conversions of the same file (LibreOffice is single-instance) and isolates its profile (`LO_PROFILE_DIR`). |
| `imagePaths.ts` | Pure: finds image paths in outgoing text (POSIX and Windows) so they can be rewritten to downscaled copies (`rewriteImagePaths`). |

## `src/renderer/` — renderer

### Entry and big orchestrators

| Module | What it does |
|---|---|
| `main.tsx` | Entry: `createRoot` → `<ErrorBoundary><App/>`. |
| `App.tsx` | Root component: per-session queues (`queuesBySession`), steering (`handleSteerMessage`, `handleQueueMessage`), split layout, file viewer, settings; declares the `window.kiroApi` type. |
| `hooks/useAcp.ts` | The renderer session engine: attach, streaming, hydration from durable records, steer bookkeeping (`pendingSteersRef`, `takeUnconsumedSteers`), `sendQueuedMessage`, schedules, turn recovery. |
| `components/ChatArea.tsx` | One chat pane: message list, `ChatInputBox` composer, `QueueStack` queued cards, file links, find bar. |

### Hooks

| Module | What it does |
|---|---|
| `hooks/useFeatureFlags.ts` | Live feature flags owned by main (`config.json` `features`, via `app:get-features`). |
| `hooks/useLang.tsx` | Language context; `useT()` returns a bound `t()`. |
| `hooks/useRemoteTargets.ts` | The list of machines a new session can run on. |
| `hooks/useSessionNotice.ts` | KiroLex's own transient notices for a session (not written to the transcript). |

### Components

| Module | What it does |
|---|---|
| `components/Sidebar.tsx` | Session list grouped by project, search, context menus (archive, move, run location). |
| `components/ReviewPane.tsx` | Side-panel file preview with per-line comments; one serialized read→ask→write chain per file (`serializeFor`), calls `kiroApi.reviseInSession`. |
| `components/CommentBox.tsx` | Shared comment input used by `ReviewPane`. |
| `components/PdfView.tsx` | pdf.js page-by-page renderer (lazy per page). |
| `components/PreviewFind.tsx` | Find bar for the preview panel. |
| `components/WorkspacePanel.tsx` | Local file browser, independent of any session. |
| `components/SettingsDialog.tsx` | Settings dialog (machines, appearance, feature switches, backup, login…). |
| `components/RemoteSettings.tsx` | Add / edit / test / bootstrap a remote machine. |
| `components/LoginSettings.tsx` | Claude Code / Codex login on a machine. |
| `components/ForwardMcpSettings.tsx` | The list of MCP servers forwarded from local to remote sessions. |
| `components/BackupSettings.tsx` | S3 backup configuration (secrets never come back to the renderer). |
| `components/BackupDialog.tsx` | Backup sync / restore tabs, grouped by project. |
| `components/MemoryDialog.tsx` | Edit the three memory layers; view what the last send actually injected. |
| `components/KiroConfigPanel.tsx` | Tabs for kiro config categories (backend: `kiroConfig.ts`). |
| `components/McpCombosPane.tsx` | Text editor for `~/.kirolex/mcp-combos.json`. |
| `components/SkillDialog.tsx` | Shows the skills kiro actually has (`~/.kiro/skills/<name>/SKILL.md`). |
| `components/PermissionBar.tsx` | The permission request bar for "ask" mode. |
| `components/ContextPanel.tsx` | Attached-context items panel (files, folders, URLs, text). |
| `components/ConfirmDialog.tsx` | In-app replacement for `window.confirm` (which blocks the renderer). |
| `components/Toasts.tsx` | Non-blocking error toasts instead of `window.alert`. |
| `components/ToggleButton.tsx` | On/off switch rendered as a button. |
| `components/ErrorBoundary.tsx` | Catches render errors and recovers once the code is fixed. |
| `components/Icons.tsx` | Engine icons (robot for kiro, distinct icons for Claude Code and Codex). |

### Pure logic modules (testable)

| Module | What it does |
|---|---|
| `uiStore.ts` | `uiGet` / `uiSet` / `uiRemove`: localStorage-shaped sync API backed by `~/.kirolex/ui-state.json`. |
| `uiRestore.ts` | `restoreGet` / `restoreSet`: persists only when the `restoreUiState` setting is on (else `sessionStorage`). |
| `i18n.ts` | `t(lang, 'English source', vars)`; the English text is the key, Chinese table alongside. |
| `splitLayout.ts` | Split-pane geometry (`1x1`, `1x2`, `2x1`, `2x2`). |
| `turnRecovery.ts` | `decideTurnRecovery`: after a reload, adopt a still-running turn before ever resending. |
| `loopMachine.ts` | Loop spec and state machine; `LoopRun` must stay JSON-serializable. |
| `scheduleView.ts` | Countdown / summary text for schedules. |
| `modelList.ts` | Model-list cache policy (don't let a bad offline list replace a good one). |
| `taskList.ts` | Normalizes ACP plan entries into persisted task lists (`TASK_LISTS_KEY`). |
| `sessionSearch.ts` | Sidebar search by name. |
| `projectActivity.ts` | Which projects are live vs. dormant (auto-collapse after inactivity; no warm-up until opened). |
| `workspaceFilter.ts` | File-browser filter within the current directory. |
| `remotePick.ts` | Default machine shown in Settings → machines. |
| `reviewBlocks.ts` | Block model for review feedback and the submit contract; re-exports `reviewApply.ts`. |
| `reviewQueue.ts` | The side-panel review's own queue (`useSyncExternalStore`), deliberately separate from chat queues. |
| `rewritePatch.ts` | LCS diff turning a large rewrite back into line-level edits. |
| `aiChanges.ts` / `aiMarkStore.ts` | "AI just changed this" highlights and per-hunk undo (`diffChanges`, `revertChange`, `planUndo`, `beginAiRound`), stored per file. |
| `filePaths.ts` / `pathBits.ts` | Path detection in text and path helpers that accept both separators. |
| `paneFind.ts` / `findHighlight.ts` / `previewFind.ts` | Per-pane find (match math), CSS Custom Highlight rendering, preview-panel find ownership. |
| `selectAllScope.ts` | Who owns Ctrl+A (chat vs. preview panel). |
| `clearBoundary.ts` | Where the last "clear context" boundary is in a session. |
| `handoffDraft.ts` | One-shot hand-off of text into the composer. |
| `pasteDecision.ts` | What a paste means (text vs. file vs. large-text blob). |
| `slashCommands.ts` / `slashPicker.ts` | The composer's slash-command table and which commands open KiroLex's own pickers (`/model`, `/agent`). |
| `choiceChips.ts` | Clickable chips when the model offers options in prose. |
| `jsonFromReply.ts` | Robustly extracts JSON from a model reply. |
| `mdText.ts` | Recovers plain text from rendered Markdown children. |
| `connectFailure.ts` | The "this session failed to connect" UI-only notice. |
| `deleteOutcome.ts` | How the result of `acp:delete-session` is shown. |
| `idleNotify.ts` | Renderer half of the idle-notification decision. |
| `backupGroups.ts` / `backupIntervals.ts` | Backup dialog grouping and sync-interval options. |
| `menuPlacement.ts` | Keeps context menus on screen. |
| `panelFit.ts` / `panelResize.ts` | Side panels yielding space when the window is narrow; drag-resize arithmetic. |
| `tabScroll.ts` | Remembers preview-tab scroll positions across reloads. |
| `fontOptions.ts` / `uiZoom.ts` | Font presets and integer-percent UI zoom. |

Other files in `src/renderer`: `index.html` (Vite entry page), `styles/global.css`, `vite-env.d.ts`,
and `probe-wave.html` / `probe-*-data.json` (a standalone probe page and its data; not part of the app
UI — the `probe-wave.tsx` it references is not in the repository).
