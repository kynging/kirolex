# State and storage

All of KiroLex's persistent state lives under **`~/.kirolex/`**. The paths are hard-coded as
`path.join(os.homedir(), '.kirolex', …)`; **no environment variable relocates them**
(`KIROLEX_HOME` is just a constant name inside `index.ts`). That means every KiroLex build and every
git worktree on a machine shares the same data — see
[building-and-testing.md](./building-and-testing.md#running-the-app-safely).

## Directory reference

### Sessions

| Path | Owner (reads / writes) | Notes |
|---|---|---|
| `sessions/<id>/record.json` | `sessionStore.ts` (`createSession`, `readRecord`, `writeRecord`, `patchRecord`) | `SessionRecord` metadata, versioned by `SESSION_SCHEMA_VERSION`; the only file that migrates. Written with tmp + rename. |
| `sessions/<id>/transcript.jsonl` | `sessionStore.ts` (`appendMessage`, `readTranscript`, `truncateTranscriptBefore`, `rewriteTranscript`) | One JSON object per **complete** message, append-only. Readers ignore unknown fields, so new per-message fields are additive. |
| `sessions/<id>/history.md` | `sessionStore.ts` (`writeHistoryFile`), rebuilt by `index.ts` | Whole-conversation rendering of the transcript, used to re-prime a new executor. Derived — can always be rebuilt. |
| `sessions/<id>/events.jsonl` | `eventLog.ts` (`appendEvent`, `readEvents`) | Timestamped run events (no message bodies), 4 MB cap. Exposed as `acp:read-events`. |
| `sessions/<id>/last-injection.md` | `sessionStore.ts` (`writeLastInjection`, `readLastInjection`) | What the last send actually injected (memory etc.), shown in the memory dialog. |
| `sessions/<id>/context-override.md` | `sessionStore.ts` (`writeContextOverride`, `clearContextOverride`) | User-supplied replacement context for the session. |
| `sessions/<id>/files/` | `index.ts` (`SESSION_FILES_DIR` from `s3Sync.ts`) | Per-session working files; also where remote deliverables are copied back. |
| `trash/<id>__<time>` | `index.ts` (`purgeSession` via `sessionPurge.ts`), aged by `pruneSessionTrash` | Deleted sessions are *moved* here, kept 30 days (`SESSION_TRASH_KEEP_DAYS`). S3 merges put replaced local copies in `trash/restore-<stamp>/<id>` (`trashDirFor`). |
| `deleted-sessions.json` | `index.ts` (`TOMBSTONES_PATH`) | Tombstones so a session whose directory could not be removed does not reappear after a restart. |
| `projects/<name>/project.json` | `projectStore.ts` | A project's working directory. |

### Memory

| Path | Owner | Notes |
|---|---|---|
| `memory/global.md` | `memory.ts` | Global layer, injected into every chat. |
| `memory/projects/<id>/memory.md` | `memory.ts` | Project layer. |
| `memory/sessions/<id>/memory.md` | `memory.ts`, auto-maintained via `sessionMemory.ts` | Session layer. |
| `memory/**/<stem>.<stamp>.bak` | `memory.ts` (`backupMemoryLayer`) | Backups next to the layer file, count bounded by `MEMORY_BACKUPS` (`memoryPolicy.ts`). |

### UI state and configuration

| Path | Owner | Notes |
|---|---|---|
| `ui-state.json` | `index.ts` (`UI_STATE_PATH`, `setUiStateKey`); renderer via `uiStore.ts` / `uiRestore.ts` | Shared UI state (project groups, split layout, settings, widths, queues `kirolex-queues`, pending steers `kirolex-pending-steers`, review marks `kirolex-review-marks`, task lists `kirolex-task-lists-v1`…). Main owns it: in-memory cache, writes coalesced for 400 ms then tmp + rename. |
| `config.json` | `index.ts` (`KIROLEX_CONFIG_PATH`), `remoteTargets.ts` | Agent profiles, `remotes[]`, `executorCap`, `features`, `s3Sync`, per-machine launch commands, and other settings. Secrets (S3 secret, SSH passwords) are stored encrypted with `safeStorage` (`encryptSecret`). |
| `mcp-combos.json` | `mcpCombos.ts` | MCP server sets for Claude Code / Codex sessions. |
| `model-meta.json` | `modelMeta.ts` via `index.ts` (`MODEL_META_PATH`) | Cached rate multiplier / context window per model id. |
| `control.json` | `controlServer.ts` (`CONTROL_FILE`) | `{port, token, pid}` of the local control server, mode 0600, deleted on exit. |
| `auto-resent.json` | `index.ts` (`AUTO_RESENT_PATH`) | Which interrupted prompt each session was already auto-resent for, so restarts do not bill repeated resends. |
| `draft-pastes.json` | `index.ts` (`DRAFT_PASTES_PATH`) | Paste blobs referenced by unsent drafts (protects them from paste GC). |

### Attachments, images and previews

| Path | Owner | Notes |
|---|---|---|
| `attachments/` | `index.ts` (`app:prepare-image-attachment`) | Attached images. |
| `pasted/` | `index.ts` (`app:save-clipboard-image`) | Pasted images. |
| `pastes/` | `index.ts` (`app:save-paste-text`, `app:read-paste`) | Large pasted text blobs; unreferenced ones are garbage-collected. |
| `capped/` | `index.ts` (`CAPPED_IMAGE_DIR`, `safeImageRef`) | Downscaled copies (long edge ≤ `MAX_IMAGE_EDGE` = 1500 px); originals are never modified. |
| `previews/` | `index.ts` (`preview:deck`) | PDFs converted from `.pptx` / `.docx`. |
| `loffice-profile/` | `convertOnce.ts` (`LO_PROFILE_DIR`) | Isolated LibreOffice user profile. |
| `backups/review-files/` | `index.ts` (`review:backup-file`, `review:write-file`) | Backups taken before the side-panel review writes a file. |

### Loops, schedules, sync

| Path | Owner | Notes |
|---|---|---|
| `schedules/<id>.json` | `scheduleStore.ts` | One file per scheduled job. |
| `loop-runs/<sid>.json` | `loopStore.ts` | Main-owned loop round counter. |
| `s3-sync-state.json` | `index.ts` (`S3_STATE_PATH`) / `s3Sync.ts` | Size + mtime per uploaded file, for change detection. |
| `s3-session-sync.json` | `index.ts` (`S3_MARKS_PATH`) | Per-session sync marks (`readSessionMarks`, `writeSessionMarks`). |

### Diagnostics and process plumbing

| Path | Owner | Notes |
|---|---|---|
| `logs/main-<YYYYMMDD-HHMMSS>.log` | `logger.ts` | One file per launch, 2 MB rotation, last 10 launches kept. `app:get-logs` / `app:open-logs`. |
| `failures/` | `failureBundle.ts` | Diagnostic bundle per failed send. |
| `kiro-trace` | `acp-client.ts`, `index.ts` (`app:set-kiro-trace`) | Presence turns on kiro-cli trace logging (very large logs), as does `KIROLEX_KIRO_TRACE=1`. |
| `askpass/` | `sshAuth.ts` | `SSH_ASKPASS` helper for password logins. |
| `dev-quit-request` | `index.ts` (`DEV_QUIT_REQUEST`) and `scripts/dev-hot.mjs` | Polled under `--dev` so a dev supervisor can request a graceful quit on Windows. Both sides must use the same path. |

Outside `~/.kirolex/`: the SSH multiplex sockets live in the OS temp dir (`kirolex-mux`, `sshMux.ts`),
and on remote hosts KiroLex only uses a disposable cache dir `~/.cache/kirolex/<session>` plus the
per-session agent files `kirolex-local-*` (see [remote-sessions.md](./remote-sessions.md)).

## Rules

### Durability: user messages now, assistant messages when complete

From the header of `sessionStore.ts` and [`DESIGN_session_architecture.md`](../DESIGN_session_architecture.md) §7:

- A user message is appended to `transcript.jsonl` the moment it is sent.
- An assistant message is written **only when the turn completes**. Partial output (crash, disconnect,
  quit) is discarded, never written. The in-flight text lives in `SessionEntry.assistantBuf`.
- Consequently the transcript contains only complete messages and there is nothing to reconcile.
  **Do not add streaming writes.**
- The transcript is append-only. The one exception is explicit edit-and-rerun, which truncates it
  before an earlier user message (`truncateTranscriptBefore` / `rewriteTranscript`).
- On startup every session is assumed detached (`markAllExecutorsDetached`).
- `projectId` is **write-once**: only `null → project` is allowed, never project → another project
  (context already injected cannot be taken back). Archiving does not clear it.

### Writes: temp file + rename

Never overwrite a JSON file in place — a crash leaves half a file. Write `<file>.tmp` then
`fs.renameSync` onto the target (see `writeRecord`, `setUiStateKey`, `saveAutoResent`). On Windows,
`rename` can fail intermittently with `EPERM` / `EBUSY` because antivirus or the indexer holds the file;
that is environmental, not a logic bug.

### UI state does not go in `localStorage`

`localStorage` is scoped by origin, and the renderer has two origins: `file://` (`npm start`) and
`http://localhost:5173` (dev). Every switch between them used to swap the entire UI state (project
groups gone, split layout collapsed), and once made a whole batch of sessions disappear. So:

- new UI state uses `uiGet` / `uiSet` (or `restoreGet` / `restoreSet`), **never `localStorage`**;
- session and message bodies come only from the durable records on disk (they used to be cached in
  `localStorage`, up to 12.7 MB, and that cache was removed).

### Main owns the files

Only the main process writes under `~/.kirolex/`. The renderer reaches state through IPC; the
synchronous `window.kiroUiState.initial` snapshot exists only so `useState` initializers can read UI
state without waiting.

### New persistent files

Put them under `~/.kirolex/`, write them with tmp + rename, and take the base directory (`home`) as
a parameter in the module that owns them (as `scheduleStore.ts`, `loopStore.ts`, `mcpCombos.ts` do),
so tests can point it at a temp directory.

### What S3 sync includes

`s3Sync.ts` uses a **whitelist**: `sessions/<id>/{record.json, transcript.jsonl, history.md}`,
`sessions/<id>/files/` (skipping dependency directories, repositories and archives), `memory/**`,
`attachments/**`, `pasted/**`. It does **not** sync `config.json`, `logs/` or `previews/`. Conflicts are
merged with `transcriptMerge.ts`; `s3:restore` merges too (the "overwrite same id" wording at the top of
`s3Sync.ts` is out of date).
