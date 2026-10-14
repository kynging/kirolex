# Settings

[← Back to contents](README.md)

Open **⚙️ Settings** with the ⚙️ button at the bottom of the sidebar. The dialog has five tabs. Their
names are shown in Chinese only. Settings save as soon as you change them.

## 🎨 外观 (Appearance)

| Setting | Default | Notes |
|---|---|---|
| **Preview** | | Sample text in the selected fonts |
| **Font (text)** | **System default** | Presets: PingFang SC, Hiragino Sans GB, Songti SC, Helvetica Neue, Segoe UI, Microsoft YaHei |
| **Font (code)** | **Default mono** | Presets: SF Mono, Menlo, Monaco, JetBrains Mono, Fira Code, Consolas |
| **Interface language** | 中文 | **中文** or **English**. Applies immediately. Some labels exist only in Chinese (see the [contents page](README.md#a-note-on-interface-language)) |
| **Chat font size** | 12 px | − / + buttons, from 10 to 22 px |
| **Interface zoom** | 100% | 80% to 200% in steps of 10. **Reset** (*Back to 100% (Ctrl + 0)*) |

**Zoom shortcuts:** *Ctrl + plus / minus / 0 also work (⌘ on macOS)*. They work even while you are
typing in the composer.

## 💬 会话 (Chats)

| Setting | Default | What it does |
|---|---|---|
| **自动重试次数（非人为中断）** (*Auto-retry count, for interruptions you didn't cause*) | 10 | 0–50. How many times KiroLex automatically resends or continues a turn after the agent process dropped, KiroLex restarted, or a stalled turn was interrupted. 0 turns automatic resending off. Turns you stopped yourself are never resent |
| **Split grid (click a chat in the sidebar to add it; every pane has its own composer)** | 1 row × 2 cols | See [Workspace and files → Split panes](workspace-and-files.md#split-panes) |
| **Concurrent connection limit (most chats connected at once)** | 10 | 1–64. How many chats can have a live agent process at the same time. It does not limit how many chats you have. When the limit is reached, KiroLex stops an **idle** process to make room, never a busy one |
| **静默多久判定卡死（秒，0 = 不中断）** (*Seconds of silence before a turn counts as stuck; 0 = never interrupt*) | 600 | 30–3600, or 0. See [Chat → When a turn stalls](chat.md#when-a-turn-stalls-or-is-interrupted) |
| **工具无进度多久判定卡死（秒）** (*Seconds a tool may run without progress before it counts as stuck*) | 1800 | 60–86400. Disabled when the previous setting is 0 |
| **Helper model (titles and prompt suggestions; does not affect the chat)** | `claude-sonnet-5` | The model used for background tasks (see [Engines and models](engines-and-models.md#the-helper-model)) |
| **Helper-model fallback (used when the main one is unavailable)** | `gpt-5.6-terra` | Or **No fallback** |

## 🧪 开关 (Switches)

**Feature switches (take effect immediately, no restart)**. Each switch shows **On** / **Off**. All of
them are on by default, except **Merge queued messages into one**.

**上下文与历史** (*Context and history*)

| Switch | When on |
|---|---|
| **Send history context along with the message (no extra turn)** | When a chat gets a new agent process, for example after a restart or a model change, the earlier conversation travels with your next message instead of costing a separate rebuild turn |
| **Refresh history.md every turn** | Keeps the chat's `history.md` (the full conversation as one file) up to date after every turn |
| **Inject memory (global / project / this chat)** | Sends your [memory](memory.md) with every turn |
| **Resend an unanswered prompt after a restart** | Resends a question that never got a complete answer. This can repeat tool actions the agent had already taken before the interruption (see [Chat](chat.md#when-a-turn-stalls-or-is-interrupted)) |

**对话与输入** (*Conversation and input*)

| Switch | When on |
|---|---|
| **Fold large pastes to disk** | Large pastes become a placeholder (see [Chat](chat.md#large-pastes-are-folded)) |
| **Merge queued messages into one** | The queue is sent as one message, up to 10 items per batch (see [Chat](chat.md#queued-messages)) |
| **Show starter prompts when the composer is empty** | Shows suggestion chips in an empty chat |
| **Generate chat titles automatically** | Titles new chats with the helper model |

**界面** (*Interface*)

| Switch | When on |
|---|---|
| **Draggable pane dividers** | Split-pane dividers can be dragged |
| **Restore the window layout after a restart** | Brings back the sidebar, folded sections and unsent comment marks after a restart |
| **Auto-fold thinking when it finishes (💭 thinking)** | Folds reasoning blocks when they finish |
| **Auto-fold tool calls when they finish (🔧 tool)** | Folds tool-call blocks when they finish |

**安全** (*Safety*)

| Switch | When on |
|---|---|
| **Confirm before deleting chats** | Asks before a chat is deleted. When off, a chat is deleted on click (it still goes to the trash for 30 days) |

## 🖥 机器 (Machines)

- **机器与启动命令** (*Machines and launch commands*): the launch command for kiro-cli on this
  computer (see [Getting started](getting-started.md#tell-kirolex-where-kiro-cli-is)), plus your remote
  machines (see [Remote sessions](remote-sessions.md#add-a-machine)).
- **MCPs forwarded from this machine to remote sessions**: see
  [Remote sessions](remote-sessions.md#forwarding-mcp-servers-from-your-computer).

## ☁️ 备份 (Backup)

S3 backup settings. See [Data and privacy → S3 backup and sync](data-and-privacy.md#s3-backup-and-sync).

## Settings that live elsewhere

- **Model, agent, combo and Auto / Ask**: per chat, in the composer bar. See
  [Engines and models](engines-and-models.md) and [Chat](chat.md#tool-approval).
- **Kiro agent files** (`~/.kiro`): the robot icon next to the agent picker (**Edit agent config (global)**).
- **Claude Code / Codex files and combos**: the engine icon at the bottom-left of the composer.

## Proxy

KiroLex has **no proxy setting**. At startup it picks up your system proxy:

- **Windows:** the system proxy from Internet Settings in the registry, including its bypass list.
- **macOS / Linux:** `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY` as set in your
  `~/.zshrc`, or `~/.bashrc` if that fails.
- Proxy variables that are already set in the environment KiroLex starts from are used too.

The proxy applies to KiroLex itself and to the agent processes it starts. It is only read at startup,
so restart KiroLex (tray → **Quit**, then start it again) after changing your proxy.

## Where settings are stored

- Appearance, split grid, merge mode and other window preferences are stored in `~/.kirolex/ui-state.json`.
- Feature switches, the concurrent connection limit, the stall timeouts, the helper model, machines, launch commands
  and backup settings are stored in `~/.kirolex/config.json`.

See [Data and privacy](data-and-privacy.md).
