# Sessions

[← Back to contents](README.md)

A **session** (or chat) is one conversation with an agent. KiroLex keeps every chat as a permanent
record on disk: its messages, model, engine, project and flags. The agent process behind a chat is
temporary. KiroLex starts it when the chat is needed and stops it when it is idle and the slot is
needed for another chat. Your conversation is never lost when that happens. See
[Settings → Concurrent connection limit](settings.md#-会话-chats).

## The sidebar

From top to bottom:

- **＋ New Session**: opens the **💬 New Chat** dialog (see [Getting started](getting-started.md#create-your-first-chat)).
- **＋ New Project**: type a name in the field that appears and press Enter. Esc cancels.
- **Your projects**: one collapsible group per project. Drag a project by its ⋮⋮ handle to
  reorder (**Drag to reorder projects**).
- **Unassigned**: chats that are not in a project.
- **Archived**: archived chats. This group is collapsed by default.

The bottom bar of the sidebar has buttons for the workspace browser (**Open workspace files**),
🧠 **Memory**, ⚙️ **Settings**, ☁️ (restore from backup, see [Data and privacy](data-and-privacy.md#s3-backup-and-sync))
and **Logs**. Drag the sidebar's edge to resize it.

### What the marks on a chat mean

The dot next to each chat shows its state. Hover over it to see a tooltip:

| Tooltip | Meaning |
|---|---|
| **Working…** / **Busy: turn in progress…** | The agent is answering |
| **Connecting…** / **Busy: connecting / reconnecting the backend…** | Starting or restarting the agent process |
| **Busy: switching model / agent…** | A model or agent change is in progress |
| **Busy: rebuilding history context (retries until done; Stop to abandon)** | KiroLex is giving a new agent process the earlier conversation |
| **Busy: history context missing, rebuild imminent; new messages queue** | Same, about to start; messages you send now wait in the queue |
| **Unread reply** | A reply finished while you were looking at another chat |
| **Live — idle** / **Live — ready (background)** | The agent process is running and free |
| **Not connected — select to activate** | A connection was tried and failed; click the chat to retry |
| **Archived — inactive** | No agent process is running for this chat right now |

Other marks on a chat:

| Mark | Meaning |
|---|---|
| 📌 | Pinned |
| 🤖 n | n subagents are running |
| ⏰ / ⏸️ | A [scheduled job](automation.md) is set / paused |
| 🌐 host | The chat runs on a [remote machine](remote-sessions.md) |
| ⏳ | The chat is moving to another machine |

Unread marks are cleared when you open the chat. They are not kept across restarts.

A collapsed group still shows any chat in it that is currently running.

## The chat menu

Right-click a chat to see:

| Item | What it does |
|---|---|
| **♻️ Restore to Unassigned** | Archived chats only. Un-archives the chat and puts it in **Unassigned** |
| **✏️ Rename** | Gives the chat a new title. Enter saves, Esc cancels. A title you set is never overwritten by the automatic title |
| **📌 Pin** / **📌 Unpin** | Pinned chats stay at the top of their group. You also get a desktop notification when a pinned chat finishes (see [Chat → Notifications](chat.md#notifications)) |
| **⇆ Add to split** / **⇆ Remove from split** | Shows the chat in a split pane (see [Workspace and files](workspace-and-files.md#split-panes)) |
| **🏷️ 移动项目** (*Move project*) | Moves the chat into another project |
| **🤖 运行引擎：…** (*Run engine*) | Switches the engine (see [Engines and models](engines-and-models.md#choosing-the-engine)) |
| **💻 / 🌐 运行位置：…** (*Run location*) | Runs the chat on this computer or on a remote machine (see [Remote sessions](remote-sessions.md)) |
| **＋ New project…** | Creates a project and moves this chat into it (**Move to new project** → **Move**) |
| **🗄️ Archive** | Archives the chat |
| **🗑️ Delete** | Deletes the chat (see [Deleting a chat](#deleting-a-chat)) |

Each chat row also has a ✕ button (**Delete**).

## Projects

A project is a named group of chats. Chats in the same project share a
[project memory](memory.md), and a project can have a working directory that is passed to the agent
(see [Getting started → Where the agent works](getting-started.md#where-the-agent-works)).

There are several ways to put a chat in a project:

- Choose the project in the **💬 New Chat** dialog.
- Use **＋ New chat in project** in the project group, or in its ⋮ menu.
- Drag the chat onto the project's header or onto a chat inside it.
- Right-click → **🏷️ 移动项目** (*Move project*), or **＋ New project…**.

You can move a chat between projects at any time. To take a chat out of all projects, drag it onto
**Unassigned**. When a chat moves, KiroLex restarts its agent so that the new project's memory
applies. If a reply is in progress, the restart waits until it ends.

The project's ⋮ button (**Project options**) has:

- **＋ New chat in project**
- **✏️ Rename project**: *Renames the project and relabels all its sessions.*
- **📁 Working directory**: its tooltip shows the current directory (**Now at: {dir}**). Clicking it
  currently does nothing; see the known issue in
  [Getting started](getting-started.md#where-the-agent-works).
- **🗑️ Delete project**: always asks first. It deletes **every chat in the project** and the project's
  memory. The chats go to the trash like any deleted chat, but the project memory is deleted
  permanently.

## Pinning and archiving

- **Pin** keeps a chat at the top of its group and turns on "finished" notifications for it.
- **Archive** stops the chat's agent and moves the chat to **Archived**. An archived chat cannot
  receive messages. To use it again, right-click it → **♻️ Restore to Unassigned**. It comes back
  under **Unassigned**, not under its old project. Archived chats cannot be dragged.

## Reordering

Drag a chat onto another chat in the same group to reorder. Drag it into a different group to move
it there.

## Forking a chat

To copy a conversation, click the fork icon on an **assistant reply**
(*Fork conversation from here*). KiroLex:

1. creates a new chat named `fork:<original title>` right below the original, in the same project,
   with the same model;
2. copies every message up to and including that reply;
3. switches you to the new chat.

The new chat has no agent session until you send your first message. That message carries the copied
history to the agent as context, so the agent continues where the original left off. The original
chat is not changed.

## Sharing context between chats

To give one chat the knowledge from other chats, use the **🛠️ Context Engineering** button in the
composer bar (*Sync context from other sessions*):

1. Click it. The **Select context to sync** list shows every other chat that is not archived.
2. Tick the chats you want to draw from. The button shows how many are linked.
3. Send a message as usual.

With each message, KiroLex adds whatever the linked chats have said since the last sync. The first
time, it adds their full history. This is sent as hidden context, labelled with each source chat's
title. Untick a chat to stop. Deleting a source chat removes it from every link.

The button is disabled when there are no other chats.

## Automatic titles

A new chat is called **New Chat**. After a reply, KiroLex asks the [helper model](engines-and-models.md#the-helper-model)
for a short 3–6 word title based on your first message and the latest reply. If that fails three
times, it uses the first 40 characters of your first message. Only titles that still start with
"New Chat" are replaced. You can turn this off with **Generate chat titles automatically** in
[Settings](settings.md#-开关-switches).

## Deleting a chat

1. Right-click → **🗑️ Delete**, or click the row's ✕.
2. The **🗑️ Delete Session** dialog asks you to confirm. Tick **Don't ask again** to skip the
   dialog from now on. You can turn it back on with **Confirm before deleting chats** in Settings.

The dialog says the chat will be removed permanently. In fact KiroLex:

- stops the chat's agent;
- moves the chat's folder, including its messages and `files/`, to `~/.kirolex/trash/<id>__<time>`;
- remembers the chat as deleted, so it never reappears in the list;
- **permanently deletes the chat's own memory** ("This chat" memory). That memory is not moved to
  the trash.

If some files are still in use, for example on Windows, the chat disappears from the list straight
away. KiroLex shows the message **Chat deleted. Some files are in use and will be cleaned up
automatically later.** and finishes the cleanup in the background or at the next start.

**The trash.** Folders in `~/.kirolex/trash/` are deleted automatically 30 days after they were
moved there. This check runs each time KiroLex starts. **KiroLex has no button for restoring a
deleted chat.** Within those 30 days you can still open the folder and copy out its files, for
example `transcript.jsonl`, `history.md` or anything in `files/`.

If you delete the chat you are looking at, KiroLex switches to your most recent remaining chat.
