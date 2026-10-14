# Data and privacy

[← Back to contents](README.md)

## Everything is in `~/.kirolex/`

Everything KiroLex keeps is stored in plain files in one folder in your home directory: `~/.kirolex/`
(on Windows `C:\Users\<you>\.kirolex\`). The location is fixed and can't be changed.

| Path | Contents |
|---|---|
| `sessions/<id>/` | One folder per chat: `record.json` (title, engine, model, project, pinned / archived), `transcript.jsonl` (every message), `history.md` (the whole conversation as one readable file) and `files/` (the chat's working folder, see [Getting started](getting-started.md#where-the-agent-works)) |
| `memory/` | Your [memory](memory.md) files and their `.bak` backups |
| `trash/` | Deleted chats, kept for 30 days, and local copies replaced by an S3 restore |
| `config.json` | Feature switches, connection limit, helper model, launch commands, remote machines, forwarded MCPs, S3 settings |
| `ui-state.json` | Window and UI state: projects and their order, split layout and sizes, panel widths, appearance settings, drafts, queued messages, open file tabs |
| `projects/<name>/project.json` | A project's working directory |
| `schedules/` | [Scheduled jobs](automation.md) |
| `attachments/`, `pasted/`, `capped/` | Size-reduced copies of attached, pasted and referenced images (see [Chat](chat.md#images-are-reduced-to-1500-px)) |
| `pastes/` | Large text pastes folded out of the composer |
| `backups/review-files/` | Copies of files taken before an applied [comment](workspace-and-files.md#commenting-on-a-file-and-letting-the-agent-apply-it) changed them |
| `previews/`, `loffice-profile/` | PDF previews of Office documents and LibreOffice's working profile |
| `mcp-combos.json` | Claude Code / Codex [combos](engines-and-models.md#claude-code-and-codex-chats) |
| `logs/` | Application logs (see [Troubleshooting](troubleshooting.md#logs)) |
| `failures/` | Diagnostic bundles written when sending a message fails |
| `deleted-sessions.json` | The list of deleted chats, so they never reappear |
| `s3-sync-state.json`, `s3-session-sync.json` | What has already been uploaded to S3 |
| `control.json` | Port and access token of KiroLex's local control endpoint (127.0.0.1 only) while KiroLex is running |

KiroLex itself does not keep your data anywhere else. The agent engines have their own folders, for
example `~/.kiro`, `~/.claude` and `~/.codex`, which are managed by those tools.

## Making a backup

- **Simplest:** quit KiroLex (tray → **Quit**) and copy the whole `~/.kirolex/` folder.
- **Automatic:** S3 backup, below.

KiroLex has no other export function.

## S3 backup and sync

KiroLex can back up your chats to an S3 bucket that you own, and restore them on the same machine or
on another one.

### Set it up

**Settings → ☁️ 备份** (*Backup*):

| Field | Meaning |
|---|---|
| **Bucket**, **Region** | Your S3 bucket |
| **Access Key ID**, **Secret** | Credentials. **清掉** (*Clear*) removes the saved secret |
| **Key 前缀（可选）** (*Key prefix, optional*) | Store everything under a prefix in the bucket |

- **测连通** (*Test connection*) writes a small test object and deletes it again.
- **立即同步** (*Sync now*) uploads right away.
- **定时同步** (*Scheduled sync*) turns on automatic sync every 5, 15, 30 (default), 60, 360 or 1440
  minutes. An extra sync runs one minute after KiroLex starts.

The secret is encrypted with your operating system's keychain or keyring before it is written to
`config.json`. It is never stored in plain text and never shown in the window again. If your system
has no keychain or keyring available, the secret can't be saved.

On the **同步** (*Sync*) tab of the dialog behind the sidebar's ☁️ button (see [Restore](#restore)),
you can exclude individual projects and chats from the backup and start a sync. Excluding something
stops future uploads, but it does not delete what is already in the bucket.

### What is synced

| Synced | Not synced |
|---|---|
| Each chat's `record.json`, `transcript.jsonl`, `history.md` | `config.json` (settings, machines, credentials) |
| Each chat's `files/` folder, skipping dependency folders, git repositories and archives | `ui-state.json`, `projects/`, `schedules/` |
| `memory/` | `logs/`, `previews/`, `loffice-profile/` |
| `attachments/`, `pasted/` | `pastes/` (folded text pastes), and everything else |

Files larger than 200 MB are skipped. KiroLex uploads only files whose size or modification time
changed.

If the bucket has a newer version of a chat from another machine, KiroLex merges the two: messages
are combined without duplicates and ordered by time. The old local copy is first moved to
`~/.kirolex/trash/`. For memory files, whichever side changed wins. If both changed, the newer one
wins.

### Restore

The ☁️ button at the bottom of the sidebar opens **☁️ 备份** (*Backup*). Its tooltip shows when the
last backup ran and whether it failed. On the **恢复** (*Restore*) tab:

- **刷新** (*Refresh*) lists what is in the bucket;
- **恢复选中的 N 条** (*Restore the N selected*) restores the selected chats;
- the delete button removes backups **from the bucket only**. Your local chats are not touched.

Restoring **merges** with any local copy instead of overwriting it, and the local copy is first
moved to the trash. A chat that is in the middle of a reply can't be restored. Restart KiroLex after
restoring.

## What deleting a chat does

See [Sessions → Deleting a chat](sessions.md#deleting-a-chat). In short:

- the chat's folder, including messages and `files/`, moves to `~/.kirolex/trash/<id>__<time>` and is
  deleted automatically after 30 days;
- the chat's own memory is deleted **immediately and permanently**;
- the chat is listed in `deleted-sessions.json` so it never comes back;
- there is no restore button. Within the 30 days you can copy files out of the trash folder yourself;
- a copy that S3 sync already uploaded stays in your bucket until you delete it there.

Deleting a **project** does this for every chat in it, and also permanently deletes the project memory.

## What leaves your computer

| Destination | What is sent | When |
|---|---|---|
| The agent engine you chose (Kiro, Claude Code or Codex) and its model service | Your messages, attachments, memory, linked context, and whatever files the agent reads | Every turn |
| Kiro, through `kiro-cli` | The first message and latest reply (to make a title), recent messages (to summarise "This chat" memory) | Helper-model tasks. Turn off **Generate chat titles automatically** / **Show starter prompts when the composer is empty** to reduce them |
| Your S3 bucket | The synced files listed above | Only if you set up S3 backup |
| Your remote machines, over ssh | The agent process and the traffic of its `local_*` tools | Only for [remote chats](remote-sessions.md) |
| Forwarded MCP servers' upstreams | MCP requests, sent from your computer | Only for forwarded MCPs in remote chats |

KiroLex does not send telemetry or analytics.

The local tool server for remote chats and the control endpoint listen only on `127.0.0.1` and need
a token.

**Diagnostic bundles** in `~/.kirolex/failures/` contain the full text of the failed prompt, including
memory, so check them before sharing them with anyone. KiroLex keeps the 5 most recent per chat.
