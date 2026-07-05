# ⚡ KiroLex

A desktop chat client powered by [kiro-cli](https://github.com/kirolabs/kiro-cli) ACP (Agent Communication Protocol).

Built with Electron + React + TypeScript.

## Features

- Multi-model support (claude-opus-4.6, claude-sonnet-4, etc.)
- Per-session model switching
- System tray with minimize-to-tray
- Auto-detect system proxy (Windows registry / macOS shell env)
- Permission request dialog for agent tool use
- Drag & drop session reordering
- Markdown rendering with syntax highlighting

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [kiro-cli](https://github.com/kirolabs/kiro-cli) installed and authenticated

## Getting Started

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Package (Windows)
npm run package

# Package (macOS)
npm run package:mac
```

## Project Structure

```
src/
├── main/           # Electron main process
│   ├── index.ts        # App lifecycle, IPC handlers, tray
│   ├── acp-client.ts   # JSON-RPC client wrapping kiro-cli ACP
│   └── preload.ts      # Context bridge API
└── renderer/       # React frontend
    ├── App.tsx
    ├── components/
    ├── hooks/
    └── styles/
```

## How It Works

KiroLex spawns `kiro-cli acp` as a child process and communicates via JSON-RPC over stdin/stdout. Each model gets its own kiro-cli process, and each chat session gets an isolated working directory under `~/.kirolex/sessions/`.

## License

MIT
