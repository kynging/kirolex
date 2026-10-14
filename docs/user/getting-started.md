# Getting started

[← Back to contents](README.md)

## Prerequisites

- **Kiro CLI** (`kiro-cli`), installed and **already signed in** on your computer. KiroLex has no
  Kiro sign-in screen of its own. It uses whatever account `kiro-cli` is signed in with. Run
  `kiro-cli login` in a terminal once if you have not done so.
- **Node.js and npm**, to build KiroLex from source (the project README asks for Node.js 18 or newer).
- **Git**, to fetch the source.
- Optional: **Claude Code** and/or **Codex**, if you want to use those engines. See
  [Engines and models](engines-and-models.md).

KiroLex runs on macOS and Windows. Linux is untested.

## Install

KiroLex is built from source:

```bash
git clone https://github.com/xenobe/kirolex.git
cd kirolex
npm install
npm run build
npm start
```

If you prefer a standalone app, you can package one:

| Command | Result |
|---|---|
| `npm run package:mac` | macOS `.dmg` and `.zip` (Apple silicon), in `release/` |
| `npm run package:mac:dir` | macOS `.app` only, in `release/` |
| `npm run package:installer` | Windows portable `release/KiroLex.exe` |
| `npm run package` | Windows unpacked folder `release/win-unpacked/` |

macOS builds are unsigned, so the first time you open one you may have to allow it in
System Settings → Privacy & Security.

## First launch

1. A small splash window shows **Starting…** and then **Loading session history…**. The main
   window appears once your saved chats have been loaded.
2. A ⚡ **KiroLex** icon appears in the system tray (menu bar on macOS).

**Closing the window does not quit KiroLex.** It hides to the tray, and running chats and
[scheduled jobs](automation.md) keep going. To bring the window back, double-click the tray icon or
choose **Show KiroLex** from its menu. To really exit, choose **Quit** from the tray menu.

Only one copy of KiroLex runs at a time. Launching it again just brings the existing window to the front.

## Switch the interface to English

1. Click the ⚙️ button (**Settings**) at the bottom of the sidebar.
2. On the **🎨 外观** (*Appearance*) tab, find **Interface language** (shown as 界面语言 while the
   interface is in Chinese).
3. Choose **English**. The change applies immediately.

Some labels are only available in Chinese. See [the note in the contents page](README.md#a-note-on-interface-language).

## Tell KiroLex where `kiro-cli` is

KiroLex **does not guess** which `kiro-cli` to run. Some machines have more than one Kiro binary,
for example `kiro-cli` and the Kiro IDE's `kiro`. Picking the wrong one silently gives you a
different model or agent list, so KiroLex refuses to start a Kiro chat until you have saved a
launch command. If you skip this step, a new chat shows a message starting with
⚠️ 这条会话没连上 (*This chat failed to connect*) that points you here.

1. Open **Settings** → the **🖥 机器** (*Machines*) tab.
2. In the machine picker, choose **💻 本机（这台电脑）** (*This computer*).
3. Click **自动检测这台机器上的三个工具** (*Auto-detect the three tools on this machine*). KiroLex
   checks your `PATH` and the usual install folders, and runs each candidate with `--version` to
   confirm it is really Kiro CLI. Then it fills in **kiro 启动命令** (*kiro launch command*).
   Auto-detect only fills fields that are empty.
4. If detection finds nothing, or picks the wrong binary, type the command yourself. This can be a full
   path or a bare command name that is on your `PATH`.

The places auto-detect looks:

| OS | Locations |
|---|---|
| Windows | `%LOCALAPPDATA%\Kiro-Cli\kiro-cli.exe`, `%LOCALAPPDATA%\Programs\kiro-cli\kiro-cli.exe`, `%APPDATA%\kiro-cli\kiro-cli.exe`, and `kiro-cli` / `kiro` on `PATH` |
| macOS / Linux | `~/.local/bin/kiro-cli`, `/usr/local/bin/kiro-cli`, `/opt/homebrew/bin/kiro-cli`, `~/.toolbox/bin/kiro-cli`, and `kiro-cli` / `kiro` on `PATH` |

Changes on this tab save automatically. The same saved command is used for chats and for KiroLex's
helper commands: the model list, the agent list, `/usage`, and automatic chat titles.

> **About `KIRO_CLI_PATH`.** Older versions found `kiro-cli` through the `KIRO_CLI_PATH`
> environment variable. Now the saved **kiro 启动命令** (*kiro launch command*) setting is the only thing that decides
> which binary runs. If you used to rely on `KIRO_CLI_PATH`, put the same path into that field.

## Sign in

- **Kiro:** sign in with `kiro-cli login` in a terminal. KiroLex uses that sign-in for every
  local Kiro chat.
- **Claude Code / Codex on this computer:** set them up the way you normally would on this computer.
  KiroLex uses their existing sign-in and default model and does not change it.
- **Claude Code / Codex on a remote machine:** KiroLex has a sign-in page for those. See
  [Remote sessions → Signing in to Claude Code / Codex on a remote machine](remote-sessions.md#signing-in-to-claude-code--codex-on-a-remote-machine).

## Create your first chat

1. Click **＋ New Session** at the top of the sidebar. The **💬 New Chat** dialog opens.
2. **Project** (optional): leave it on **No project (unassigned)**, pick an existing project, or
   choose **+ New project…** and type a name. A project groups chats and gives them a shared
   memory (see [Sessions](sessions.md) and [Memory](memory.md)).
3. **用哪个 AI** (*Which AI*): **Kiro**, **Claude Code** or **Codex**. KiroLex remembers your choice
   for next time.
4. **在哪台机器上跑** (*Which machine to run on*): only shown once you have added a remote machine.
   **本地** (*Local*) runs the agent on this computer.
5. Click **Create**.

The new chat is called **New Chat** until you send your first message. After the first reply,
KiroLex gives it a short title automatically.

The dialog does not ask for a model. A new Kiro chat uses the model you last picked by hand, and you
can change it in the composer at any time (see [Engines and models](engines-and-models.md)).

### Where the agent works

Each chat has its own folder, `~/.kirolex/sessions/<id>/files/`, and the agent starts there. Files
it creates without a full path end up in that folder. They are backed up, restored and deleted
together with the chat.

To have the agent work on a repository, give it the repository's full path in your message, for
example "In `/Users/me/code/blog`, find and fix the failing test". If the chat belongs to a
project that has a working directory set, KiroLex tells the agent that path at the start of every
turn.

> **Known issue:** a project's ⋮ menu has a **📁 Working directory** item for setting this
> directory, but clicking it currently does nothing. Until that is fixed, put the path in
> `~/.kirolex/projects/<project name>/project.json` as `{ "workspace": "/absolute/path" }`, or
> give the path in your message.

Next: [Engines and models](engines-and-models.md) · [Chat](chat.md)
