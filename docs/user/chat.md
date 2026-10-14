# Chat

[← Back to contents](README.md)

## The composer

Type in the box at the bottom of a chat (**Type a message...**).

| Key | When idle | While the agent is working |
|---|---|---|
| **Enter** | Send | Steer the running turn, or add to the last queued message (see [below](#the-message-queue-and-steering)) |
| **Shift+Enter** | New line | New line |
| **Ctrl+Enter** (⌘+Enter on macOS) | Add to the queue | Add a new queued message |

Enter is ignored while an input method (IME) is composing text. A hint under the box always shows
the current meaning of the keys.

Buttons in and around the composer (hover over an icon to see its name):

- **Paperclip** (*Attach files*): picks files to attach.
- **Auto / Ask** (Kiro chats): tool-approval mode. See [Tool approval](#tool-approval).
  Claude Code and Codex chats show their own permission-mode picker in the same place.
- **Queue icon** (*Queue message (Ctrl+Enter)*): puts the message in the queue instead of sending it.
- **Send button**: its tooltip tells you what it will do right now: *Send (Enter)*,
  *Steer the running turn (Enter)* or *Append to the last queued message (Enter)*.
- **Stop** (square): shown while a reply is running and the composer is empty. Stops the turn.

### Starter prompts

When a chat is empty, the composer can show **Starter prompts**, such as **Explain what this project
does and how it is structured** or **Find and fix bugs in the current directory**. Click one to add
it to the box. You can pick several, and clicking one again removes it. You can still type
around them. Turn this off with **Show starter prompts when the composer is empty** in
[Settings](settings.md#-开关-switches).

If the agent's last reply offered options, they appear as small chips above the box. Clicking one
copies it into the box but does not send it.

## Attachments and images

You can attach files in three ways:

- click the paperclip (**Attach files**);
- drag files onto the chat (*📎 Drop files to attach*);
- paste a copied file, or paste an image from the clipboard (it is attached as `Screenshot N`).

Click the ✕ on an attachment to remove it (**Remove attachment**). You can send attachments with no
text. Attachments are sent to the agent as file paths, together with a request to read them.

### Images are reduced to 1500 px

Every image is scaled down so that its **longer side is at most 1500 pixels** before the agent sees
it. This covers pasted screenshots, attached images and image paths you type into a message.
**Your original file is never changed.** KiroLex writes a reduced copy instead:

| Image source | Where the reduced copy goes |
|---|---|
| Pasted from the clipboard | `~/.kirolex/pasted/` |
| Attached or dropped file | `~/.kirolex/attachments/` |
| Image path written in a message | `~/.kirolex/capped/` |

**Why:** some model backends (Amazon Bedrock) reject the *entire request* if any image anywhere in
the conversation is larger than 2000 pixels on a side. Earlier images are re-sent with every turn,
so one oversized screenshot would break the chat for good. Reducing images before they enter the
conversation prevents that, and also saves tokens.

### Large pastes are folded

If you paste a large block of text, KiroLex saves it to `~/.kirolex/pastes/` and puts a
placeholder such as `[ 粘贴 #1 · 120 行 ]` (*Paste #1 · 120 lines*) in the box. A paste is folded
when it has 6 or more lines, when it has 2–5 lines and at least 1,200 characters, or when it is a
single line of at least 4,000 characters. The agent receives the full text. In the chat, the paste
appears as a collapsible 粘贴 #N (*Paste #N*) block. Click it to expand (*Click to expand the pasted content*). Turn this off with **Fold large pastes to disk**
in [Settings](settings.md#-开关-switches).

## The message queue and steering

You don't have to wait for a reply to finish before writing the next message.

### Queued messages

Messages waiting to be sent appear as cards above the composer under **Queued follow-ups**. Each card
has:

- **↑ / ↓**: move it earlier or later;
- **✎**: edit it (Enter saves, Esc cancels);
- **✕**: take it back. Its text and attachments return to the composer.

When the current turn ends, the queue is sent in order. Each chat has its own queue and drains it on
its own, even in the background. Queues survive a restart. After a restart, a restored queue
starts sending once you open that chat.

The badge on the queue shows the mode:

- **One by one**: *One by one: only the first is sent, the rest keep queueing*. This is the default.
- **Merged**: *Merged: the whole queue goes out as one message (10 per batch at most)*. With two or
  more items it reads **Send as one message**.

Turn merging on with **Merge queued messages into one** in [Settings](settings.md#-开关-switches).

### What Enter does while the agent is working

KiroLex checks these rules in order:

1. **If the queue is not empty,** your text is appended to the **last** queued card, so it can't
   jump ahead of messages already waiting.
2. **If you attached files,** the message is queued, because steering can only carry text.
3. **Otherwise the message steers the running turn.** It goes into the turn that is already running
   without stopping it, and appears in the chat with a **Steer** tag (*Steered into the running turn*).

Ctrl+Enter (⌘+Enter) always adds a new, separate card to the queue.

Steering only works with **Kiro**. On Claude Code and Codex, or if a steer can't be delivered, the
message goes to the **front** of the queue and is sent as soon as the turn ends. Messages are never
dropped. If the agent did not pick up a steer before the turn ended, it goes back to the front of
the queue.

**Stop** discards steers the agent has not yet picked up, but keeps the normal queue.

## Tool approval

The **Auto / Ask** toggle in a Kiro chat decides what happens when the agent wants to use a tool.
You can't change it while a reply is running.

- **Auto** (the default): *Auto-approve all tools (click to require approval)*. Each request is
  approved once, automatically.
- **Ask**: *Ask before each tool (click to auto-approve)*. A **Tool permission required** bar appears
  above the composer with the buttons the agent offers:
  - **✓ Allow once**
  - **⟲ Always allow**: how long "always" lasts is up to `kiro-cli`, not KiroLex
  - **⊘ Reject**

The approval bar also appears in split panes that you are not focused on.

## Commands

Type `/` at the start of the box in a connected Kiro chat to open the **Kiro CLI commands** menu.
It shows the commands that this chat's `kiro-cli` reports, with their descriptions. Use ↑/↓ to
choose, Enter or Tab to accept, and Esc to close. The exact list depends on your `kiro-cli` version.

KiroLex handles a few commands itself:

| Command | What it does |
|---|---|
| `/stop` | Force-interrupts **all** running agents and reconnects them. It works even while a reply is streaming, and is the way out when a chat seems stuck. The chat shows *🔄 Force interrupted and reconnected.* |
| `/clear` | Clears the chat view and also sends `/clear` to `kiro-cli` so the agent forgets the conversation. The messages stay in the saved history on disk |
| `/usage` | Runs `kiro-cli` `/usage` and shows your Kiro usage as a reply |
| `/model`, `/model <name>` | Opens the model picker, or switches to the model whose name matches (a unique prefix is enough) |
| `/agent`, `/agent <name>` | The same, for the Kiro agent |

Any other `/command` is passed to `kiro-cli` unchanged, for example `/compact`.

## Messages

### Actions on your messages

- **Copy**
- **⏰** (*Send this message again on a schedule*): turns the message into a
  [scheduled job](automation.md).
- **Pencil** (**Edit and rerun**): edit the message in place. Enter reruns and Esc cancels. If there are later
  messages, KiroLex asks first: rerunning **deletes everything after this message** from the chat
  and resends the edited text (**Confirm and rerun**).

### Actions on replies

- **Copy**
- **Fork** (*Fork conversation from here*): see [Sessions → Forking a chat](sessions.md#forking-a-chat).
- An estimated token count (`≈ N tokens`).

### Thinking, tools and turn panels

- The agent's reasoning and tool calls are shown in **💭 Thinking** and **🔧 Tools** blocks. These
  fold automatically when they finish, which you can change in
  [Settings](settings.md#-开关-switches). Click a block to expand or fold it.
- Output from subagents is shown under **🤖 Subagents**. While subagents are running, a bar at the top
  of the chat lists them.
- Each turn can show three panels:
  - **📋 Task list**: the agent's plan, with a done/total count.
  - **⚡ Commands run**: commands the agent ran. Open while the turn runs, folded afterwards.
  - **📝 Changed files**: see [Workspace and files](workspace-and-files.md#changed-files).

### Finding text in a chat

Press **Ctrl+F** (⌘+F) to open **Find in this chat…** in the focused pane. Enter goes to the next
match, Shift+Enter to the previous one, and Esc closes the search bar.

### Long chats

Long chats load in batches. Scroll to the top, or click the "load earlier messages" button, to see
older messages. **↓ Latest** jumps back to the end.

## When a turn stalls or is interrupted

**Stalled turns.** If a turn produces no output and no tool activity for a while, KiroLex shows a
countdown notice in the chat (*This turn has produced no output and no tool activity.*). It then
interrupts the turn. If the turn had already produced output, KiroLex automatically asks the agent to
continue from where it stopped. If it had produced nothing, KiroLex resends it. Both are retried at
most **自动重试次数** (*Auto-retry count*) times, 10 by default. The limits are set in
[Settings → 💬 会话](settings.md#-会话-chats). Setting the silence limit to 0 means KiroLex never
interrupts (*The timeout interrupt is off, so it will wait indefinitely.*).

**Interrupted turns.** If a turn is cut off, for example by **Stop**, a crash or a stall, the chat shows
**The previous turn was interrupted**. *The original text is back in the composer. Enter replaces and
reruns this turn; it does not send a new message.*

**Automatic retries after a connection error.** If sending fails with a short-lived transport error,
KiroLex retries the turn automatically, but only if the turn had not yet produced any text or run
any tool.

**After a restart.** With **Resend an unanswered prompt after a restart** turned on (the default),
KiroLex resends a question that never got a complete answer, for chats you have open, up to the
auto-retry limit. A reply is only saved once it is complete. So if KiroLex or the agent process was
cut off mid-reply, the question counts as unanswered **even if the agent had already run tools or
changed files**, and resending it may repeat those actions. If that is a risk for your work, for
example commands that deploy or delete things, turn **Resend an unanswered prompt after a restart**
off in [Settings](settings.md#-开关-switches). You can then decide yourself whether to resend.

## Notifications

For **pinned** chats, KiroLex shows a desktop notification, with a sound, when the chat finishes and
goes quiet: **Finished**, or **Stopped with an error: {error}**. Clicking the notification opens that
chat. You won't get one while the KiroLex window is active, or after you pressed Stop yourself.
