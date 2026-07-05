import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import { AcpClient } from './acp-client';

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

// One kiro-cli process per model (per-session model support)
const clients: Map<string, AcpClient> = new Map();
const connectingClients: Map<string, Promise<AcpClient>> = new Map();
const DEFAULT_MODEL = 'claude-opus-4.6';

// Enforce single instance to prevent localStorage/leveldb corruption from
// multiple processes (the tray keeps the app alive after closing the window)
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to launch a second instance - focus our window instead
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// Load full shell environment (proxy, PATH, etc.) for subprocess spawning
function getShellEnv(): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PATH: process.platform === 'win32'
      ? process.env.PATH || ''
      : `${os.homedir()}/.local/bin:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || ''}`,
  };

  if (process.platform === 'win32') {
    // Read Windows system proxy from registry
    try {
      const regOutput = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
        { encoding: 'utf-8', timeout: 3000 }
      );
      const proxyEnabled = regOutput.includes('0x1');

      if (proxyEnabled) {
        const serverOutput = execSync(
          'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
          { encoding: 'utf-8', timeout: 3000 }
        );
        const match = serverOutput.match(/ProxyServer\s+REG_SZ\s+(.+)/);
        if (match) {
          const proxyServer = match[1].trim();
          const proxyUrl = proxyServer.startsWith('http') ? proxyServer : `http://${proxyServer}`;
          env.HTTP_PROXY = proxyUrl;
          env.HTTPS_PROXY = proxyUrl;
          env.http_proxy = proxyUrl;
          env.https_proxy = proxyUrl;

          // Read NO_PROXY / ProxyOverride
          try {
            const overrideOutput = execSync(
              'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyOverride',
              { encoding: 'utf-8', timeout: 3000 }
            );
            const overrideMatch = overrideOutput.match(/ProxyOverride\s+REG_SZ\s+(.+)/);
            if (overrideMatch) {
              const noProxy = overrideMatch[1].trim().replace(/;/g, ',');
              env.NO_PROXY = noProxy;
              env.no_proxy = noProxy;
            }
          } catch {}
        }
      }
    } catch {}
  } else {
    // macOS/Linux: try sourcing shell profile to get proxy and other vars
    try {
      const shellOutput = execSync(
        'source ~/.zshrc 2>/dev/null || source ~/.bashrc 2>/dev/null; echo "HTTP_PROXY=$HTTP_PROXY"; echo "HTTPS_PROXY=$HTTPS_PROXY"; echo "ALL_PROXY=$ALL_PROXY"; echo "NO_PROXY=$NO_PROXY"',
        { encoding: 'utf-8', shell: '/bin/zsh', timeout: 3000 }
      ).trim();

      for (const line of shellOutput.split('\n')) {
        const [key, ...rest] = line.split('=');
        const value = rest.join('=');
        if (key && value) {
          env[key] = value;
        }
      }
    } catch {}
  }

  return env;
}

const shellEnv = getShellEnv();

// Apply proxy to Electron's own network stack
if (shellEnv.HTTP_PROXY || shellEnv.HTTPS_PROXY) {
  const proxyUrl = shellEnv.HTTPS_PROXY || shellEnv.HTTP_PROXY;
  app.commandLine.appendSwitch('proxy-server', proxyUrl!);
  if (shellEnv.NO_PROXY) {
    app.commandLine.appendSwitch('proxy-bypass-list', shellEnv.NO_PROXY);
  }
}

// Each session gets its own directory to avoid cwd collision
const sessionsBaseDir = path.join(os.homedir(), '.kirolex', 'sessions');

function getSessionDir(sessionId?: string): string {
  const id = sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(sessionsBaseDir, id);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// Get or create a connected kiro-cli client for the given model
async function getClient(model: string): Promise<AcpClient> {
  const m = model || DEFAULT_MODEL;
  const existing = clients.get(m);
  if (existing) return existing;

  // Dedupe concurrent creation for the same model
  const pending = connectingClients.get(m);
  if (pending) return pending;

  const createPromise = (async () => {
    const client = new AcpClient(m, shellEnv);
    // Tag all forwarded events with the model so the renderer can route
    client.on('update', (data) => {
      mainWindow?.webContents.send('acp:update', { ...data, model: m });
    });
    client.on('error', (error) => {
      mainWindow?.webContents.send('acp:error', { ...error, model: m });
    });
    client.on('disconnected', () => {
      clients.delete(m);
      connectingClients.delete(m);
      mainWindow?.webContents.send('acp:disconnected', { model: m });
    });

    await client.connect();
    clients.set(m, client);
    connectingClients.delete(m);
    return client;
  })();

  connectingClients.set(m, createPromise);
  try {
    return await createPromise;
  } catch (err) {
    connectingClients.delete(m);
    throw err;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#1a1a1a',
    autoHideMenuBar: true,
    show: false, // Hidden until connected
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Remove menu bar entirely on Windows/Linux
  if (process.platform !== 'darwin') {
    mainWindow.setMenuBarVisibility(false);
    mainWindow.setMenu(null);
  }

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Minimize to tray on close instead of quitting
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  // Create tray icon - write a temporary ico file with lightning bolt
  const iconPath = path.join(app.getPath('temp'), 'kirolex-tray.png');
  
  // 16x16 PNG lightning bolt icon (⚡)
  // Generate it programmatically using a canvas-like approach via nativeImage
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4); // RGBA

  // Draw a simple lightning bolt shape
  const setPixel = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const idx = (y * size + x) * 4;
    canvas[idx] = r;
    canvas[idx + 1] = g;
    canvas[idx + 2] = b;
    canvas[idx + 3] = a;
  };

  // Lightning bolt pixels (hand-crafted 16x16)
  const boltPixels = [
    [8,0],[9,0],[10,0],
    [7,1],[8,1],[9,1],
    [6,2],[7,2],[8,2],
    [5,3],[6,3],[7,3],
    [4,4],[5,4],[6,4],[7,4],[8,4],[9,4],[10,4],[11,4],
    [4,5],[5,5],[6,5],[7,5],[8,5],[9,5],[10,5],
    [7,6],[8,6],[9,6],[10,6],
    [8,7],[9,7],[10,7],
    [7,8],[8,8],[9,8],
    [6,9],[7,9],[8,9],
    [5,10],[6,10],[7,10],
    [4,11],[5,11],[6,11],
    [5,12],[6,12],
    [6,13],[7,13],
    [7,14],
    [8,15],
  ];

  for (const [x, y] of boltPixels) {
    setPixel(x, y, 255, 184, 0, 255); // Golden yellow
  }

  const icon = nativeImage.createFromBuffer(canvas, { width: size, height: size });

  tray = new Tray(icon);
  tray.setToolTip('KiroLex');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show KiroLex',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 320,
    height: 200,
    frame: false,
    resizable: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const splashHtml = `
    <html>
    <body style="margin:0; display:flex; align-items:center; justify-content:center; height:100vh; background:#1a1a1a; border-radius:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color:#e8e8e8; user-select:none;">
      <div style="text-align:center;">
        <div style="font-size:40px; margin-bottom:12px;">⚡</div>
        <div style="font-size:16px; font-weight:600; margin-bottom:16px;">KiroLex</div>
        <div style="font-size:12px; color:#a0a0a0; margin-bottom:12px;">Connecting...</div>
        <div style="width:120px; height:3px; background:#333; border-radius:2px; margin:0 auto; overflow:hidden;">
          <div style="width:40px; height:100%; background:#7c6fe0; border-radius:2px; animation:loading 1.2s ease-in-out infinite;"></div>
        </div>
      </div>
      <style>
        @keyframes loading {
          0% { transform: translateX(-40px); }
          100% { transform: translateX(120px); }
        }
      </style>
    </body>
    </html>
  `;

  splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml)}`);
  splashWindow.center();
  splashWindow.show();
}

function showMainWindow() {
  if (splashWindow) {
    splashWindow.close();
    splashWindow = null;
  }
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
}

app.whenReady().then(() => {
  createTray();
  createSplashWindow();
  createWindow();

  // Fallback: if connect takes too long, show main window anyway
  const splashTimeout = setTimeout(() => {
    showMainWindow();
  }, 15000);

  // IPC handlers
  ipcMain.handle('acp:connect', async (_event, options: { model?: string }) => {
    try {
      const client = await getClient(options.model || DEFAULT_MODEL);
      clearTimeout(splashTimeout);
      showMainWindow();
      // Return a synthetic init result (client is connected)
      return { connected: true };
    } catch (err) {
      clearTimeout(splashTimeout);
      showMainWindow();
      throw err;
    }
  });

  ipcMain.handle('acp:disconnect', async () => {
    for (const [, client] of clients) {
      try { await client.disconnect(); } catch {}
    }
    clients.clear();
    connectingClients.clear();
  });

  ipcMain.handle('acp:new-session', async (_event, cwd: string, model: string) => {
    const client = await getClient(model);
    // Use unique directory per session to isolate from other sessions
    const sessionDir = getSessionDir();
    return client.newSession(sessionDir);
  });

  ipcMain.handle('acp:prompt', async (_event, sessionId: string, prompt: any[], model: string) => {
    const client = await getClient(model);
    return client.sendPrompt(sessionId, prompt);
  });

  ipcMain.handle('acp:cancel', async (_event, sessionId: string, model: string) => {
    const client = clients.get(model || DEFAULT_MODEL);
    if (!client) return;
    return client.cancelPrompt(sessionId);
  });

  ipcMain.handle('acp:delete-session', async (_event, sessionId: string) => {
    // Delete session directory from disk
    const sessionDir = path.join(sessionsBaseDir, sessionId);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    // Also check if any directory in sessionsBaseDir contains this sessionId
    if (fs.existsSync(sessionsBaseDir)) {
      const dirs = fs.readdirSync(sessionsBaseDir);
      for (const dir of dirs) {
        if (dir === sessionId || dir.includes(sessionId)) {
          const fullPath = path.join(sessionsBaseDir, dir);
          fs.rmSync(fullPath, { recursive: true, force: true });
        }
      }
    }
  });

  ipcMain.handle('app:get-home-dir', () => {
    return os.homedir();
  });

  ipcMain.handle('acp:list-models', async () => {
    const { execSync } = require('child_process');
    const result = execSync('kiro-cli chat --list-models --format json', { encoding: 'utf-8', env: shellEnv, shell: true });
    return JSON.parse(result);
  });

  ipcMain.handle('acp:get-usage', async () => {
    const { execSync } = require('child_process');
    try {
      const result = execSync('kiro-cli chat --no-interactive "/usage" 2>&1', {
        encoding: 'utf-8',
        timeout: 20000,
        shell: true,
        env: shellEnv,
      });
      const clean = result.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\[\?[0-9;]*[a-zA-Z]/g, '').trim();
      return { text: clean };
    } catch (err: any) {
      const output = (err.stdout || '') + (err.stderr || '');
      const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\[\?[0-9;]*[a-zA-Z]/g, '').trim();
      return { text: clean || 'Failed to get usage' };
    }
  });

  ipcMain.handle('acp:list-sessions', async () => {
    const { execSync } = require('child_process');
    try {
      const result = execSync('kiro-cli chat --list-sessions --format json', { encoding: 'utf-8', env: shellEnv, shell: true });
      return JSON.parse(result);
    } catch {
      return { sessions: [] };
    }
  });

  ipcMain.handle('acp:load-session', async (_event, sessionId: string, cwd: string, model: string) => {
    const client = await getClient(model);
    const resolvedCwd = cwd === '~' ? os.homedir() : cwd;
    return client.loadSession(sessionId, resolvedCwd);
  });

  ipcMain.handle('acp:request-permission-response', async (_event, requestId: number, granted: boolean, model: string) => {
    const client = clients.get(model || DEFAULT_MODEL);
    if (!client) throw new Error('Not connected');
    return client.respondToPermission(requestId, granted);
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  // Kill all kiro-cli child processes so none are orphaned
  for (const [, client] of clients) {
    try { client.disconnect(); } catch {}
  }
  clients.clear();
  connectingClients.clear();
});

app.on('window-all-closed', () => {
  // Don't quit on Windows/Linux when window is hidden to tray
  if (process.platform === 'darwin') {
    // macOS: keep app running
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});
