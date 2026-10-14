# Engines and models

[← Back to contents](README.md)

Each chat is driven by one **engine**, the coding agent that actually does the work. KiroLex starts
a separate engine process for every connected chat, so changing the engine or model in one chat
never affects another.

## The three engines

| Engine | What runs | Sign-in and model |
|---|---|---|
| **Kiro** (default) | `kiro-cli acp`, using the launch command saved in Settings (see [Getting started](getting-started.md#tell-kirolex-where-kiro-cli-is)) | Your `kiro-cli` sign-in. You pick the model and Kiro agent per chat |
| **Claude Code** | The Claude Code ACP adapter `@agentclientprotocol/claude-agent-acp` | Claude Code's own sign-in and default model |
| **Codex** | The Codex ACP adapter `@agentclientprotocol/codex-acp` | Codex's own sign-in and default model |

### What only Kiro chats have

- A model picker that shows each model's context window and credit multiplier, plus automatic fallback
  when a model is unavailable.
- Kiro agents and the **Kiro Agent configurations** editor.
- **Steering**: sending a message into a turn while it is still running (see
  [Chat → The message queue and steering](chat.md#the-message-queue-and-steering)). On Claude Code
  and Codex, a message you send during a turn waits at the front of the queue and goes out when the
  turn ends.
- The slash-command menu supplied by `kiro-cli` (see [Chat → Commands](chat.md#commands)).

### Setting up Claude Code and Codex on this computer

1. Install and sign in to Claude Code or Codex the way you normally would.
2. Install the ACP adapter globally with npm:

   ```bash
   npm i -g @agentclientprotocol/claude-agent-acp   # for Claude Code
   npm i -g @agentclientprotocol/codex-acp          # for Codex
   ```

   KiroLex looks for the adapter in npm's global module folder. There is no need to restart KiroLex
   afterwards, because each new chat looks again. On Windows, if the adapter is missing, the chat
   says 没找到 … 的 ACP 适配器 (*ACP adapter not found*) and shows the exact `npm i -g` command.

**Advanced:** to use a specific adapter build, set the environment variable `KIROLEX_CLAUDE_ACP` or
`KIROLEX_CODEX_ACP` before starting KiroLex. A path ending in `.js`, `.cjs` or `.mjs` is run with
KiroLex's built-in Node. Anything else is run as a command.

The **claude 启动命令** and **codex 启动命令** fields on the **🖥 机器** (*Machines*) settings tab are
not used for chats on this computer. KiroLex finds the adapters as described above.

## Choosing the engine

- **For a new chat:** pick it under **用哪个 AI** (*Which AI*) in the **💬 New Chat** dialog.
- **For an existing chat:** right-click the chat in the sidebar → **🤖 运行引擎：…**
  (*Run engine*) → choose **Kiro**, **Claude Code** or **Codex**.

Switching the engine starts a fresh backend session but keeps the whole conversation. KiroLex posts a
note in the chat, and the earlier conversation is sent along as context with your next message.
You cannot switch while a turn is running.

## Choosing a model

The model picker is in the bar at the bottom of each chat.

### Kiro chats

- The list comes from `kiro-cli chat --list-models` on the machine where the chat runs. KiroLex keeps
  the last good list, so a temporary failure never leaves you with an empty picker.
- Each entry reads like `claude-opus-5 · 1M · 2.2×`: the model, its context window and its
  credit multiplier. If the numbers come from KiroLex's cache or built-in table instead of a live
  answer, the tooltip says so.
- If the chat's model is not in the current list, it appears as `<model> · unavailable`.
- The picker is disabled while a reply is in progress (tooltip:
  *Wait for the current response to finish before switching models*).
- Switching restarts that chat's Kiro process with the new model and reloads the same Kiro session.
  The conversation is kept. If the switch fails, KiroLex goes back to the previous model.
- A model you pick by hand becomes the chat's preferred model, and new Kiro chats start with it too.

**Automatic fallback.** If the chat's model is not available on that machine, KiroLex picks another
model and says so in the chat. On this computer the message begins with ⚠️ 本机 kiro-cli 的模型清单里没有…
(*This computer's kiro-cli model list does not include …*). For a remote machine it says the model is
not available on that host and which model is used instead. Your preferred model is not changed, so
it is tried again next time. If the list on this computer has no Claude models at all, the note adds
that this is usually caused by region filtering based on your network's outgoing IP address, and
suggests running the chat on a remote machine instead.

### Claude Code and Codex chats

- The model list comes from the adapter itself. Until the chat connects, the picker shows
  **默认模型** (*Default model*) or **连接中…** (*Connecting…*).
- Changing it takes effect immediately in the same process and is remembered for that chat. The chat
  must be connected.
- Next to it is a **组合 · …** (*Combo*) picker. A combo is a named set of MCP servers plus an
  effort level, defined in `~/.kirolex/mcp-combos.json`. The built-in **组合 · 通用** (*General*) has
  no MCP servers. Changing the combo restarts that chat's engine, so it is disabled while a reply is
  in progress.
- To edit the combos, click the engine icon at the bottom-left of the composer. That opens the
  engine's configuration dialog. Use its **🧩 组合** (*Combos*) tab, which edits the JSON file and
  validates it before saving. The other tabs edit the engine's own files on the machine where the
  chat runs: `.claude` (settings, CLAUDE.md, agents, commands, skills, plugins) or `.codex`
  (config.toml, AGENTS.md, prompts, skills).

## Kiro agents

In a Kiro chat, the composer bar also has an **agent** picker. It lists the built-in agents
(`kiro_default`, `kiro_help`, `kiro_planner`) and your own global and project agents, as reported by
`kiro-cli agent list` on the machine where the chat runs. The default agent is marked **(default)**.

- Switching agent restarts that chat's Kiro process with the selected agent and rebuilds the context
  from KiroLex's saved conversation. You cannot switch while a reply is in progress.
- The robot icon next to the picker (**Edit agent config (global)**) opens
  **Kiro Agent configurations**. It has tabs for **Agents**, **MCP**, **Steering**, **Prompts**,
  **Skills**, **Powers** and **Settings**, and edits the files under `~/.kiro` on the machine where
  the chat runs. Changes there apply to every chat that uses that agent.

## The helper model

KiroLex uses a small "helper" model, through `kiro-cli`, for background tasks: chat titles,
starter-prompt suggestions and tidying up per-chat memory. It never answers your messages. You can
change it, and its fallback, under **Settings → 💬 会话** (*Chats*). See [Settings](settings.md).

## Context usage and credits

When the engine reports usage (Kiro does), the composer bar shows:

- **A context percentage.** It is highlighted from 50% and again from 80%. Click it to open
  **Manage context**, which offers **Compact** (sends `/compact`) or **Clear** (sends `/clear`).
- **A credits counter**, for example `1.25 credits`. Clicking it resets this chat's local counter
  only.

Each assistant reply also shows an estimated token count (`≈ N tokens`). It is only an estimate,
because Kiro CLI does not report exact per-turn token counts.
