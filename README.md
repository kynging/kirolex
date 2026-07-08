# ⚡ KiroLex

A desktop chat client for [Kiro CLI](https://github.com/aws/kiro-cli), built with Electron + React + TypeScript.

KiroLex provides a native GUI for interacting with Kiro CLI's Agent Communication Protocol (ACP), offering multi-session management, per-session model routing, and a rich chat experience.

![License](https://img.shields.io/badge/license-MIT-blue.svg)

## Features

### Chat
- **Streaming responses** with real-time markdown rendering (GFM + syntax highlighting)
- **File attachments** — drag & drop or paste images from clipboard
- **Tool call visualization** — see agent actions with approve/deny permission dialogs
- **Command queue** — queue messages with `Ctrl+Enter` while the agent is still responding
- **Loop mode** — repeatedly re-send a prompt at configurable intervals
- **Usage tracking** — view context window usage and credit consumption per session

### Sessions
- **Multi-session** — run multiple conversations in parallel, each with independent context
- **Per-session model selection** — switch models (e.g. `claude-opus-4.6`, `claude-sonnet-4.6`) per session; each model spawns its own kiro-cli process
- **Session folders** — organize sessions into collapsible folders
- **Drag & drop reordering** — rearrange sessions and move them between folders
- **Duplicate session** — fork a conversation with full history injected as context
- **Cross-session context** — link sessions to share context from one conversation into another
- **Rename / Delete** with confirmation dialogs
- **Unread indicators** — see which background sessions received new responses

### Desktop
- **System tray** — minimize to tray, restore on double-click
- **Single instance** — prevents multiple processes and localStorage conflicts
- **Splash screen** — shown during initial connection
- **Proxy support** — auto-detects system proxy settings (Windows registry / macOS shell profile)
- **Resizable sidebar** with collapse toggle
- **Customizable font size** via settings dialog

## Prerequisites

- [Kiro CLI](https://github.com/aws/kiro-cli) installed and available in PATH (or set `KIRO_CLI_PATH` environment variable)
- Node.js >= 18

## Installation

```bash
git clone https://github.com/xenobe/kirolex.git
cd kirolex
npm install
```

## Development

```bash
npm run dev
```

This starts Vite dev server (renderer) and Electron (main process) concurrently.

## Build

```bash
npm run build
```

Compiles TypeScript and bundles the renderer with Vite. Output goes to `dist/`.

## Package

```bash
# Portable .exe (no installer)
npm run package

# Windows installer
npm run package:installer
```

Uses electron-builder to produce a distributable binary.

## Built-in Commands

Type these in the chat input:

| Command | Description |
|---------|-------------|
| `/usage` | Show current token usage and credit consumption |
| `/stop` | Force interrupt the agent and reconnect |

## Tech Stack

- **Electron** — desktop shell, IPC, tray, clipboard
- **React 18** — UI components
- **Vite** — bundler and dev server
- **TypeScript** — full type safety across main and renderer
- **react-markdown** + remark-gfm + rehype-highlight — rich message rendering
- **@dnd-kit** — drag and drop for session management
- **kiro-cli ACP** — JSON-RPC communication with the AI agent

## Architecture

```
src/
├── main/
│   ├── index.ts          # Electron main process, IPC handlers, tray, proxy
│   ├── acp-client.ts     # JSON-RPC client wrapping kiro-cli subprocess
│   └── preload.ts        # Context bridge exposing kiroApi to renderer
└── renderer/
    ├── App.tsx           # Root component, state orchestration
    ├── hooks/
    │   └── useAcp.ts     # Core hook: sessions, streaming, context sync, loops
    ├── components/
    │   ├── ChatArea.tsx       # Message list, input, model selector
    │   ├── Sidebar.tsx        # Session list, folders, drag & drop
    │   ├── SettingsDialog.tsx  # Font size settings
    │   ├── PermissionDialog.tsx # Tool permission approve/deny
    │   └── ContextPanel.tsx    # File/text context attachments
    └── styles/
        └── global.css    # Full UI styling
```

## License

[MIT](./LICENSE)
