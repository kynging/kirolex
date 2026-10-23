# Memory

[← Back to contents](README.md)

**Memory** is a set of plain Markdown notes that KiroLex adds to the start of **every turn**, so
the agent remembers your preferences and project facts across chats and restarts.

## The three layers

| Layer | Applies to | File |
|---|---|---|
| **Global** | Every chat | `~/.kirolex/memory/global.md` |
| **Project** | Every chat in one project | `~/.kirolex/memory/projects/<project>/memory.md` |
| **This chat** | One chat only | `~/.kirolex/memory/sessions/<chat id>/memory.md` |

The layers are sent in the order global → project → this chat. When they disagree, the more specific
layer wins. Typical contents:

- **Global**: your preferences, for example "answer in English" or "prefer pnpm over npm".
- **Project**: facts about one project, such as where the repository is, how to run the tests, or
  decisions already made.
- **This chat**: what this conversation is about and how far it got.

All memory files stay on **your computer**, also for [remote chats](remote-sessions.md). In a remote
chat, the agent is told to read and write them with its `local_*` tools.

## Who writes memory

- **You**, in the memory dialog (see below), or with any text editor.
- **The agent, when you ask it to.** Say "remember that…" and it appends a short note to the right
  file and tells you. If the chat is not in a project, it may add the note to a matching existing
  project, but it won't create new project folders.
- **KiroLex itself**, for the **This chat** layer only. After every 12 new messages, KiroLex asks the
  [helper model](engines-and-models.md#the-helper-model) to boil the chat down into a short summary,
  at most 12 lines or 1,200 characters. Anything you write in that layer by hand is merged in at
  the next summary.

## The memory dialog

Open it with the 🧠 button (**Memory**) at the bottom of the sidebar. It has four tabs:

| Tab | What it shows |
|---|---|
| **Global** | *Applies to all chats everywhere* |
| **Project: <name>** | The current chat's project. Shown as **Project (none)** and disabled when the chat has no project |
| **This chat** | The current chat's own memory |
| **📦 Snapshot** | The context block that the **next** message will send |

On the first three tabs you edit the file directly and click **Save** (it then shows **Saved** ✓). The full file
path is shown next to the editor. Saving replaces the whole file.

The **📦 Snapshot** tab lets you change exactly what the next message sends. Edit it and click
**Save and pin**. The tab then shows *⚙︎ Hand-edited context (pinned) · the next message sends this
verbatim instead of the auto snapshot*. **Restore auto-generated** goes back to the automatic
snapshot, and **放弃修改** (*Discard changes*) throws away unsaved edits.

## Size warnings and Compact

Because memory is sent with **every** turn, a large memory costs tokens on every message. When a
layer grows past its limit (global 1 KB, project 16 KB, this chat 32 KB), a banner appears above the
chat: ⚠ … 每轮对话都会完整发送 (*… is sent in full with every turn*). It offers three buttons:

- **Compact**: first backs the file up, then sends a visible message to the current chat asking it to
  merge and de-duplicate the memory file. It only merges; facts that still hold are kept.
  While this runs the button shows **Compacting…**.
- **编辑** (*Edit*) or **View**: opens the memory dialog on that layer so you can tidy it yourself.

Compact keeps the **3** most recent backups of each layer, as `<name>.<timestamp>.bak` next to the
memory file. A normal **Save** does not make a backup.

The banner goes away once the layer is back under its limit.

## Turning memory off

Open **Settings → 🧪 开关** (*Switches*) and turn off **Inject memory (global / project / this
chat)**. The change applies immediately: the agent no longer receives any memory. Your memory files
are kept, and you can still open and edit them.

The automatic summaries of the **This chat** layer have no switch in Settings. They can only be
turned off by setting `"sessionMemory": false` under `features` in `~/.kirolex/config.json`.

## What happens to memory when you delete

- Deleting a **chat** permanently deletes its **This chat** memory. That memory does not go to
  the trash.
- Deleting a **project** permanently deletes its project memory.
- Global memory is only changed by you or the agent.
