# KiroLex developer documentation

This folder is for contributors: people who want to read, change or extend KiroLex.
For the feature list and end-user setup, see the top-level [`README.md`](../../README.md).

> These pages were written against the code. Line numbers drift, so they mostly give **names**
> (files, functions, IPC channels, storage keys) — locate them with `grep -n '<name>' <file>`.
> When a page and the code disagree, **the code wins**.

## What KiroLex is

KiroLex is an Electron + React + TypeScript desktop client that sits **in front of coding agents**.
It is a *harness*, not an agent: the model, the tools and the agent loop belong to an ACP
executor process (`kiro-cli acp`, the Claude Code ACP adapter, or the Codex ACP adapter), and
KiroLex owns everything around that loop.

The single most important idea in the codebase:

- **A session is a durable record.** It lives on disk under `~/.kirolex/sessions/<id>/`
  (metadata, an append-only transcript, a rendered history), survives restarts, crashes and
  model switches, and is the only source of truth for what was said.
- **An executor is a disposable process.** One ACP child process per *live* session, spawned on
  demand, torn down when idle or when the model/agent/machine changes, and re-primed from the
  durable record. Executors can die at any time; sessions must not care.

Everything else — memory injection, queues and steering, schedules, remote sessions over SSH,
S3 backup, the side-panel file review — is built on that split. The long-form rationale is in
[`DESIGN_session_architecture.md`](../DESIGN_session_architecture.md).

## Contents

| Page | What it covers |
|---|---|
| [architecture.md](./architecture.md) | Process boundaries (main / preload / renderer), who may import `electron`, startup and shutdown, the executor lifecycle, ACP and the engine abstraction (`engines.ts`, `acp-client.ts`) |
| [module-map.md](./module-map.md) | One line per module in `src/main` and the main modules in `src/renderer`, grouped by feature |
| [ipc.md](./ipc.md) | What `preload.ts` exposes (`window.kiroApi`, `window.kiroUiState`), the IPC channels grouped by namespace, and how to add one |
| [state-and-storage.md](./state-and-storage.md) | Every file and directory under `~/.kirolex/`, which module reads/writes it, and the durability rules |
| [remote-sessions.md](./remote-sessions.md) | Remote sessions in brief: SSH, the reverse tunnel, the local MCP tools, orphan-process handling |
| [building-and-testing.md](./building-and-testing.md) | Build, test, package; why `dev:hot` is not a verification tool; what `node:test` can and cannot import; the renderer type check; smoke scripts that cost credits |
| [contributing.md](./contributing.md) | Change discipline and the invariants you must not break |

## Design documents

These live in `docs/` and are the deeper background for the pages above. Read the relevant
one before changing that area.

| Document | Topic |
|---|---|
| [DESIGN_session_architecture.md](../DESIGN_session_architecture.md) | Session = durable record, executor = disposable process; durability rules; layered memory |
| [DESIGN_remote_sessions.md](../DESIGN_remote_sessions.md) | Remote sessions: "execution remote, files local"; reverse tunnel + local MCP tools; orphan executors |
| [WINDOWS_GAPS.md](../WINDOWS_GAPS.md) | Platform differences on Windows that were fixed, and the ones that were not |
| [loop-engineering-notes.md](../loop-engineering-notes.md) | Research notes and current state of the loop / scheduling features |

Note that the design documents are written mostly in Chinese, as are most code comments. The
code comments are long and often record *what was measured* — read the comment next to a line
before deleting it.

## Quick start for contributors

```bash
npm install
npm run build              # type-checks and builds main, bundles the renderer
npm test                   # node:test over tests/**/*.test.ts
npx tsc -p tsconfig.json   # type-check the renderer (vite build does not)
npm start                  # run the built app (uses your real ~/.kirolex/)
```

See [building-and-testing.md](./building-and-testing.md) before running the app: `npm start`
shares `~/.kirolex/` with every other KiroLex build on the machine.
