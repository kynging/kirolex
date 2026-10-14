# Remote sessions

A remote session runs its executor (`kiro-cli acp`, or a Claude Code / Codex adapter) on another
machine over SSH, while **everything that belongs to the user stays on the local machine**: the session
record, transcript, memory and the project files. This page is a map of the implementation; the
reasoning, measurements and history are in [`DESIGN_remote_sessions.md`](../DESIGN_remote_sessions.md),
and Windows-specific differences in [`WINDOWS_GAPS.md`](../WINDOWS_GAPS.md).

## The model: execution remote, files local

- The remote host only runs the executor process and gets a disposable working directory —
  `sessionCwd` in `config.ts` returns `~/.cache/kirolex/<basename>-<hash>` (`REMOTE_CACHE_SUBDIR` in
  `remoteWriteGuard.ts`). It is **not** the project directory. (Comments in `config.ts` that mention
  an rsync mirror or `<remoteWorkdir>/scratch` describe the removed mirror design; `sessionCwd` is
  authoritative.)
- There is no mirroring and no rsync. The remote agent reads and writes the user's files through
  **local MCP tools** reached over a **reverse SSH tunnel**.
- The choice of machine is **per session**, made when the session is created (`remoteTargets.ts`,
  `hooks/useRemoteTargets.ts`); session A can run locally while session B runs remotely.

## Pieces

```
local machine                                              remote host
─────────────                                              ───────────
localMcp.ts  HTTP MCP on 127.0.0.1:<local port>
   ▲   per-session URL token /mcp/<token>
   │
sshMux.ts    ssh -N master  ── -R 127.0.0.1:0:127.0.0.1:<local port> ──▶ 127.0.0.1:<allocated port>
             (one per host)                                               ▲
acp-client   ssh … <buildRemoteKiroCommand>  ──── stdio JSON-RPC ───────▶ kiro-cli acp --agent kirolex-local-<id>
                                                                          agent JSON: { type: "http",
                                                                            url: http://127.0.0.1:<port>/mcp/<token> }
```

| Concern | Where |
|---|---|
| Machine list, validation, per-machine launch commands | `remoteTargets.ts` (`listRemoteTargets`, `findRemoteTarget`, `saveRemoteTarget`, `validateTarget`, `localBins`, `rememberBinSuccess`); UI in `components/RemoteSettings.tsx` |
| Detecting / verifying the CLI on a machine | `binDetect.ts`; IPC `bins:detect`, `bins:test`; installing via `remote:bootstrap`, which pipes `scripts/remote-bootstrap.sh` to the remote `bash -s` |
| Pre-connection checks | `remotePreflight.ts` — one ssh round-trip: `ok` / `unreachable` / `missing-tools` / `not-logged-in`, machine specs, model list, `remoteExecutorCap` |
| SSH options | `sshProxy.ts` (jump hosts via `ProxyCommand`, `assertSafeSshHost`), `sshAuth.ts` (passwords via `SSH_ASKPASS`, `BatchMode`) |
| Connection sharing and the tunnel | `sshMux.ts` `SshMux`: one explicit `ssh -N` master per host, with `ExitOnForwardFailure=yes`; the remote port is allocated by sshd (`-R 127.0.0.1:0:…`, parsed by `parseAllocatedPort`) so a rebuild never collides with a port held by someone else |
| Local tools | `localMcp.ts` `startLocalMcp`: `local_read`, `local_write`, `local_glob`, `local_grep`, `local_git` (read-only subcommands, `GIT_READONLY`), `local_bash`; loopback only, token in the URL |
| Per-session agent on the remote | `remoteLocalTools.ts`: `sessionAgentName` → `kirolex-local-<id>`, `remoteAgentScript` writes it (the agent's `tools` field is a whitelist — omitting it means *no* tools) |
| Wiring per attach | `index.ts` `ensureLocalTools` (register the session with the MCP server, ensure the mux master/tunnel, write the agent) and `releaseLocalTools` |
| Forwarding other local MCP servers | `forwardMcp.ts` (servers whose command is a local path, browser-style tools, or the user's list from `components/ForwardMcpSettings.tsx`) proxied by `localMcp.ts` |
| Telling the model where it is | `remoteContext.ts` `remoteContextBlock`, prepended every turn by `sendPromptOnce`; memory injection for remote sessions says to write memory with `local_write` |
| Keeping deliverables local | `remoteWriteGuard.ts`: in `AcpClient.handleAgentRequest`, built-in remote writes outside the cache dir / `/tmp` / `/var/tmp` are refused; stray remote files are copied back into `sessions/<id>/files/` |
| Asking the local machine to do something | `localAction.ts`: a reply line `KIROLEX-LOCAL: open <url>` (only `open`, only http(s)) |
| Host-agnostic file / log access | `hostOps.ts` `LocalHost` / `SshHost` (`hostFor`) so diagnostics such as `kiroCliLog.ts` read the right machine |
| Reconnecting | `reachability.ts` (per-host breaker), `remoteRecovery.ts` `RemoteRecovery` (keeps retrying broken remote sessions with backoff), `SshMux` self-heal (`HEAL_BACKOFF_MS`) |
| Models and agents on that machine | `modelAvailability.ts`, `modelMeta.ts`, `kiroAgentList.ts`; `pickRemoteModel` in `index.ts` |

## Orphan processes

Killing the local `ssh` does **not** stop the remote kiro-cli: without a PTY it does not exit on stdin
EOF and keeps holding its session lock. Orphans once accumulated to 85 processes and pinned a
t3.medium (documented in the design doc). The defences:

1. **Know the remote PID.** The remote command prints `KIROLEX_REMOTE_PID $$` (`REMOTE_PID_MARKER`)
   before `exec`, and `AcpClient.disconnect()` kills that process tree over ssh with `remoteKillTree(pid)`.
2. **Sweep the remote.** `sweepRemoteExecutors` runs `orphanSweepScript` (executors whose parent is
   gone) and `staleExecutorSweepScript` (executors tagged with this machine's owner but not held by this
   KiroLex) at startup, periodically for hosts with sessions, and 30 s after a mux connection recovers.
   Agents left behind are cleaned with `sweepAgentsScript`. Sweeps are scoped by an owner tag
   (`ownerTag`) so they never touch another laptop's processes.
3. **Sweep the local side.** `sweepStrayLocalSsh` kills local `ssh` processes whose parent died
   (PPID 1). On Windows there is no `ps` and no PPID-1 convention, so the POSIX sweep is a no-op and
   `sweepStrayLocalSshWindows` uses `Get-CimInstance Win32_Process`; if it cannot get a complete pid
   set it kills nothing.
4. **Close the tunnel on quit.** `before-quit` calls `sshMux.closeAll()`.

Switching model or agent starts the new executor before closing the old one, so the two briefly
coexist on the same host.

## Rules specific to remote sessions

- The security boundary is: loopback-only listener + per-session URL token + every write / command
  announced in the status line. **Do not add path jails or similar "security theatre"** — with
  `local_bash` available they mean nothing, and the design doc explicitly rejects them.
- If a machine has no configured kiro launch command, the executor **refuses to start** and says where
  to configure it. Do not guess a default path — a machine can have two kiro-cli installs.
- kiro-cli silently falls back when a model or agent does not exist. Wherever KiroLex lets that happen
  (e.g. `pickRemoteModel`), it must say so in the session.
- `scripts/remote-bootstrap.sh` is piped to a remote Linux `bash`; it **must** have LF line endings
  (enforced by `.gitattributes`).
- On Windows, Win32-OpenSSH has no `ControlMaster`, so `muxSupported()` returns false and each
  session uses its own ssh connection and its own `-R` port (`allocateRemotePort`).
