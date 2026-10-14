# KiroLex user guide

KiroLex is a desktop harness around coding agents. It gives
[Kiro CLI](https://github.com/aws/kiro-cli), Claude Code and Codex a chat window with many
parallel sessions, projects, split panes, a file viewer, memory, scheduled jobs and
optional remote execution over ssh.

It is built for **one developer on their own work computer**. Your chats, memory and settings are
plain files under `~/.kirolex/` on that machine. KiroLex does not run a server of its own. The only
outside services involved are the agent backends you choose and, if you turn it on, your own S3
bucket for backups.

You do not need to know anything about KiroLex's source code to use it.

## Contents

| Page | What it covers |
|---|---|
| [Getting started](getting-started.md) | Installing, telling KiroLex where `kiro-cli` is, first launch, signing in, your first chat |
| [Engines and models](engines-and-models.md) | Kiro vs. Claude Code vs. Codex, choosing a model per chat, Kiro agents |
| [Sessions](sessions.md) | Chats and projects, pinning, archiving, forking, sharing context between chats, the trash |
| [Chat](chat.md) | The composer, attachments and images, the message queue, steering, tool approval, commands |
| [Workspace and files](workspace-and-files.md) | Split panes, the workspace browser, the file viewer, changed files, commenting on files |
| [Remote sessions](remote-sessions.md) | Running a chat on another machine over ssh while your files stay local |
| [Automation](automation.md) | Scheduled jobs |
| [Memory](memory.md) | Global, project and per-chat memory: what it is, where to see it, how to turn it off |
| [Settings](settings.md) | Every setting and feature switch, fonts, zoom, language, proxy |
| [Data and privacy](data-and-privacy.md) | What is stored in `~/.kirolex/`, backups, S3 sync, what deleting a chat does |
| [Troubleshooting](troubleshooting.md) | Common problems and where the logs are |

## A note on interface language

The interface starts in **Chinese**. To switch to English, see
[Getting started → Switch the interface to English](getting-started.md#switch-the-interface-to-english).

Not every label has an English translation yet. Even with English selected, some menus, settings
tabs and dialogs still show Chinese text. In this guide:

- Labels that have an English version are written exactly as they appear, for example **New Session**.
- Labels that are only shown in Chinese are written as they appear, followed by a translation in
  italics, for example **🖥 机器** (*Machines*).
