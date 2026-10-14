# Building and testing

## Commands

```bash
npm install
npm run build              # tsc -p tsconfig.main.json (main → dist/main) + vite build (renderer → dist/renderer)
npm test                   # node --test "tests/**/*.test.ts"
node --test tests/schedule.test.ts   # a single test file
npx tsc -p tsconfig.json   # type-check the renderer
npm start                  # electron .  — runs what is in dist/ (file:// origin)
```

Packaging (electron-builder, output in `release/`):

| Script | Result |
|---|---|
| `npm run package` | Windows unpacked directory (`--win --dir`) |
| `npm run package:installer` | Windows portable `KiroLex.exe` |
| `npm run package:mac` | macOS arm64 `dmg` + `zip` |
| `npm run package:mac:dir` | macOS unpacked directory |

All packaging scripts run `npm run build` first. Only `dist/**/*` is packaged.

Other scripts: `npm run skill:validate` (`scripts/skill-validate.mjs`) and `npm run test:watch`.

## Verification means `build` + `test`

To decide whether a change is good, run:

1. `npm run build` — this is also the **type check for the main process** (`tsc -p tsconfig.main.json`).
2. `npm test`.
3. If you touched the renderer: `npx tsc -p tsconfig.json`. The renderer `tsconfig.json` is `noEmit`,
   and **`vite build` does not type-check**, so renderer type errors pass the build silently. The
   renderer currently type-checks with zero errors; keep it that way.
4. Only when you need to see the UI: `npm start`.

There is no lint script.

### Why not `npm run dev:hot`

`dev:hot` (`scripts/dev-hot.mjs`) is a supervisor for people developing KiroLex *from inside KiroLex*:
Vite HMR + `tsc --watch` + automatic Electron restarts. It never exits, runs the renderer from
`http://localhost:5173` (a different origin from `npm start`), passes `--dev` (which opens the 9222
remote-debugging port), and keeps restarting. It cannot produce a pass/fail answer, so it is not a
verification tool. The same applies to `npm run dev`.

### Running the app safely

`npm start` uses your **real** `~/.kirolex/` — every worktree and every build on the machine shares
the same sessions, `ui-state.json` and `config.json`.

- A single-instance lock (`app.requestSingleInstanceLock()`) makes a second instance exit with code
  42 while another KiroLex is running.
- Do not run two different builds against the same data at once: they rewrite each other's session
  records, which looks like sessions "crossing over" (recorded at the top of
  [`DESIGN_remote_sessions.md`](../DESIGN_remote_sessions.md)).
- Do not delete or edit user session data while verifying.

## The test setup

- Runner: Node's built-in `node:test` with `node:assert/strict`. No Jest, Vitest, ts-node or loader —
  Node strips the TypeScript types itself. This needs a Node with type stripping on by default
  (≥ 22.18 / 23.6); the repository does not pin a version.
- Tests live in `tests/*.test.ts` (about 145 files, roughly 2,200 test cases at the time of writing,
  a handful skipped). Test names and comments are usually in Chinese and say what property is being
  guarded and why.

### `node:test` only imports pure modules

A module that a test imports (directly or transitively) must satisfy all of these:

1. **No `electron` import.** This is why logic is extracted from `index.ts` / `.tsx` files into
   standalone `.ts` modules that receive state as parameters (examples: `busySessions.ts`,
   `controlServer.ts`, `transientError.ts`, `staleSession.ts`).
2. **Not `.tsx`.** Node does not load it (`ERR_UNKNOWN_FILE_EXTENSION`). Testable renderer logic goes
   in `src/renderer/*.ts` (examples: `backupIntervals.ts`, `pathBits.ts`, `splitLayout.ts`, `aiChanges.ts`).
3. **Erasable TypeScript only.** No `enum`, no `namespace`, no constructor parameter properties
   (`constructor(private x)`), which fail with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` (see the note in
   `reachability.ts`). `erasableSyntaxOnly` is not enabled, so the compiler will not stop you.
4. **Relative imports carry the `.ts` extension** (`from './sshProxy.ts'`).
   `tsconfig.main.json` enables `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`, so
   the emitted JS imports `.js`. Use `import type` / `import { type X }` for type-only imports.
   (`index.ts` itself imports siblings without an extension, because no test imports it.)
5. **File-system roots are parameters.** For example every `scheduleStore.ts` function takes `home`.
   Tests use `fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-…'))` and remove it in `afterEach`.
   **Tests must never read or write the real `~/.kirolex/`.** Tests that must change environment
   variables (e.g. `tests/kiroCli.test.ts` changes `HOME`, `LOCALAPPDATA`, `KIRO_CLI_PATH`) save and
   restore them.

### Three kinds of test

- **Pure-function tests** — import a small module and assert. Examples: `tests/schedule.test.ts`,
  `tests/staleSession.test.ts`, `tests/splitLayout.test.ts`, `tests/imagePaths.test.ts`.
- **Source-scanning tests** — `index.ts`, `App.tsx` and `ChatArea.tsx` cannot be imported, so the
  test reads the source as text and asserts that the wiring exists, typically by anchoring on a string
  and slicing a window after it (e.g. `M.indexOf("ipcMain.handle('bins:detect'")` in
  `tests/windows.test.ts`). Others: `tests/contextInvariants.test.ts`, `tests/hookOrder.test.ts`,
  `tests/scheduleWiring.test.ts`, `tests/paneIndependence.test.ts`. Read files with
  `path.join(import.meta.dirname, '..', 'src', …)`.
  These break when you rename a variable or reword code. If the failing assertion guards code you
  intentionally changed, update it to the new code — but never delete the property it protects.
- **Temp-dir / real I/O tests** — `tests/scheduleStore.test.ts`, `tests/memoryBackup.test.ts`,
  `tests/localMcp.test.ts` (starts a real local HTTP server), `tests/controlServer.test.ts`.

### Writing a test for new logic

1. Put the decision in a pure function in a module without `electron` (new or existing); let
   `index.ts` or the component gather state and call it.
2. Test the function in `tests/<feature>.test.ts`; add a source-scanning test if the wiring
   ("this handler calls it") matters.
3. Inject time: take `now` as a parameter (`reachability.ts` takes it in its constructor, `schedule.ts`
   functions take the time).

### No fixed sleeps

The CI machine (Windows Server) is busy and timers fire late. `tests/controlServer.test.ts` used to
fail intermittently on `sleep(5/30/40)`; it now polls with `waitFor(cond, what, timeoutMs)` (checks
every 5 ms and `assert.fail`s with what it was waiting for) and `waitPolls` (wait until the code under
test has actually polled N times before asserting that something did *not* happen).

- To wait for something to happen: poll with a generous timeout.
- To assert that something did not happen: first confirm the code under test actually ran, then add a
  short sleep.

`src/main/sshMux.ts` exports its own `waitFor`, used by `tests/sshMux.test.ts`.

## Smoke scripts that use a real kiro-cli

These are not part of `npm test` or CI. They talk to a real `kiro-cli acp` and **spend real model
credits**:

| Script | What it checks |
|---|---|
| `scripts/acp-probe.mjs` | Logs every ACP frame kiro-cli sends verbatim (`initialize` → `session/new` → `session/prompt`); used to learn wire facts that the source cannot tell you (e.g. subagent notifications) |
| `scripts/steer-smoke.mjs` | Mid-turn `_session/steer` end to end; asserts the turn is not cancelled (`stopReason !== 'cancelled'`) |

Run them only when you actually need to confirm protocol behaviour, and say so when you do.

## Platform notes

Most contributors' agents run on Windows while much of the code was first written on macOS. Before
writing platform-sensitive code, read [`WINDOWS_GAPS.md`](../WINDOWS_GAPS.md) and the Windows section
of [contributing.md](./contributing.md#windows).
