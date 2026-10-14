# Troubleshooting

[← Back to contents](README.md)

## Logs

**In the app:** click **Logs** at the bottom of the sidebar. The **日志** (*Logs*) viewer shows the
last 500 lines of the current log. Scroll up to load older lines. **刷新** (*Refresh*) reloads it,
and **打开日志文件** (*Open log file*) shows the file in Finder or Explorer.

**On disk:** `~/.kirolex/logs/`

- KiroLex writes **one log file per launch**, named `main-YYYYMMDD-HHMMSS.log` (local time). There is
  no single `main.log` any more. Older `main.log` files from earlier versions are removed
  automatically.
- When a launch's log passes 2 MB, it is renamed to `….log.1` and a fresh file is started.
- The 10 most recent launch logs are kept.

**Diagnostic bundles:** when sending a message fails, KiroLex writes a folder under
`~/.kirolex/failures/` with the prompt that was sent, Kiro's own log excerpt and some metadata. It
keeps the 5 most recent per chat. These contain your full prompt and memory, so review them before
sharing.

**Kiro trace logging (very verbose):** start KiroLex with the environment variable
`KIROLEX_KIRO_TRACE=1`, or create an empty file `~/.kirolex/kiro-trace`. Kiro processes started
after that log at trace level. A red ⚑ button appears in the sidebar while trace is on. Click it to
turn trace off for processes started from then on. Trace logs can grow by more than 10 GB a day, so
only leave it on while you are reproducing a problem.

## Common problems

### A new chat says "⚠️ 这条会话没连上" and asks for a kiro launch command

*This chat failed to connect… No local kiro launch command is set yet.* KiroLex never guesses which
`kiro-cli` to run. Go to **Settings → 🖥 机器 → 💻 本机（这台电脑）** and click
**自动检测这台机器上的三个工具** (*Auto-detect the three tools on this machine*), or type the command.
See [Getting started](getting-started.md#tell-kirolex-where-kiro-cli-is).

### "kiro-cli 找不到" (*kiro-cli not found*)

The saved launch command doesn't point to an existing file. The message lists what was tried.
Correct the path on the same settings tab. A bare command name that is on your `PATH` is fine too.

### Kiro works in a terminal, but the model list or `/usage` is wrong or empty

Check that the saved launch command is the same `kiro-cli` you use in the terminal. The Kiro IDE's
`kiro` binary is a different program. Also make sure `kiro-cli` is signed in (`kiro-cli login`).

### "⚠️ 本机 kiro-cli 的模型清单里没有…" (*This computer's model list does not include …*)

The chat's model isn't offered on this computer, so KiroLex used another one. If the note says that
no Claude models are listed at all, the Kiro service is filtering models by the region of your
network's outgoing IP address. Running the chat on a [remote machine](remote-sessions.md) in another
region is the usual way around this.

### Claude Code / Codex: "没找到 … 的 ACP 适配器" (*ACP adapter not found*)

Install the adapter globally with the `npm i -g …` command the message shows. You don't need to
restart KiroLex; just create a new chat. See [Engines and models](engines-and-models.md#setting-up-claude-code-and-codex-on-this-computer).

### "All live sessions are busy; cannot start another right now."

Every agent slot is busy with a running reply. Wait for one to finish, or raise **Concurrent
connection limit (most chats connected at once)** in [Settings → 💬 会话](settings.md#-会话-chats).

### A reply seems stuck

- If a countdown notice is shown (*This turn has produced no output and no tool activity.*), KiroLex
  will interrupt the turn and continue or resend it automatically.
- Click **Stop** to end the turn yourself.
- Type `/stop` and press Enter to force-interrupt **all** agents and reconnect them. This works even
  while a reply is streaming.
- The limits are **静默多久判定卡死** (*silence limit*) and **工具无进度多久判定卡死** (*tool stall limit*) in
  [Settings → 💬 会话](settings.md#-会话-chats). Long builds or test runs may need a higher tool limit.

### I sent a message while the agent was working and it didn't arrive

It's in the queue above the composer, or it was steered into the running turn (marked **Steer**).
On Claude Code and Codex it waits at the front of the queue until the turn ends. See
[Chat → The message queue and steering](chat.md#the-message-queue-and-steering).

### KiroLex doesn't open when I start it again

KiroLex runs only once. If it is already running, perhaps hidden in the tray, the new launch exits
and the existing window is brought to the front. Look for the ⚡ icon in the tray or menu bar and
choose **Show KiroLex**.

### Closing the window doesn't quit KiroLex

That is by design. KiroLex stays in the tray so that replies and scheduled jobs keep running. Use the
tray menu → **Quit**.

Always quit this way rather than killing the process. When KiroLex quits normally, it lets each
`kiro-cli` exit cleanly. A killed `kiro-cli` can leave its session locked, and the chat then fails
with "Session is active in another process".

### The project's "📁 Working directory" menu item does nothing

This is a known issue. See [Getting started → Where the agent works](getting-started.md#where-the-agent-works)
for the workaround.

### A file the remote agent made isn't on my computer

The agent wrote it on the remote machine with its own tools. Use the **⇩ Copy to this machine**
button that KiroLex shows for it. See [Remote sessions](remote-sessions.md).

### A remote machine won't connect

Use **测试连接** (*Test connection*) under **Settings → 🖥 机器**. The result says whether the machine
is unreachable, is missing tools, or isn't signed in to kiro-cli. See
[Remote sessions → Add a machine](remote-sessions.md#add-a-machine).

### Office files don't preview

Install LibreOffice. The viewer shows the install command, with a **复制命令** (*Copy command*)
button. See [Workspace and files](workspace-and-files.md#pdf-and-office-documents).

### A chat I deleted

There is no restore button. For 30 days the chat's folder is in `~/.kirolex/trash/`, where you can
copy files out of it. If you use S3 backup, a backed-up copy may also still be in your bucket. See
[Data and privacy](data-and-privacy.md#what-deleting-a-chat-does).
