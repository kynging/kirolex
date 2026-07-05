import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: any;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: any;
}

export class AcpClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private nextId = 0;
  private pendingRequests: Map<number, { resolve: Function; reject: Function; timer: ReturnType<typeof setTimeout>; idleMs: number }> = new Map();
  private model: string;
  private buffer = '';
  private env: Record<string, string>;

  constructor(model: string, env?: Record<string, string>) {
    super();
    this.model = model;
    this.env = env || (process.env as Record<string, string>);
  }

  async connect(): Promise<any> {
    return new Promise((resolve, reject) => {
      const fs = require('fs');
      
      // Search for kiro-cli binary
      const possiblePaths = [
        process.env.KIRO_CLI_PATH,
        // Windows
        `${process.env.LOCALAPPDATA}\\Kiro-Cli\\kiro-cli.exe`,
        `${process.env.LOCALAPPDATA}\\Programs\\kiro-cli\\kiro-cli.exe`,
        `${process.env.APPDATA}\\kiro-cli\\kiro-cli.exe`,
        // macOS/Linux
        `${process.env.HOME}/.local/bin/kiro-cli`,
        '/usr/local/bin/kiro-cli',
        '/opt/homebrew/bin/kiro-cli',
      ].filter(Boolean) as string[];

      let cliPath: string | null = null;
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          cliPath = p;
          break;
        }
      }

      if (!cliPath) {
        reject(new Error(
          `kiro-cli not found. Searched:\n${possiblePaths.join('\n')}\n\nPlease install kiro-cli or set KIRO_CLI_PATH environment variable.`
        ));
        return;
      }

      this.process = spawn(cliPath, ['acp', '--model', this.model, '--trust-all-tools'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.env,
      });

      this.process.stdout!.on('data', (data: Buffer) => {
        this.buffer += data.toString('utf-8');
        this.processBuffer();
      });

      this.process.stderr!.on('data', (data: Buffer) => {
        const msg = data.toString('utf-8').trim();
        if (msg) {
          this.emit('error', { type: 'stderr', message: msg });
        }
      });

      this.process.on('close', (code) => {
        this.emit('disconnected', { code });
        this.rejectAllPending(new Error(`Process exited with code ${code}`));
      });

      this.process.on('error', (err) => {
        reject(err);
      });

      // Send initialize
      setTimeout(async () => {
        try {
          const result = await this.sendRequest('initialize', {
            protocolVersion: 1,
            clientInfo: { name: 'KiroLex', version: '0.1.0' },
            capabilities: {},
          });
          resolve(result);
        } catch (err) {
          reject(err);
        }
      }, 500);
    });
  }

  async disconnect() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.rejectAllPending(new Error('Disconnected'));
  }

  async newSession(cwd: string): Promise<{ sessionId: string }> {
    return this.sendRequest('session/new', {
      cwd,
      mcpServers: [],
    });
  }

  async loadSession(sessionId: string, cwd: string): Promise<any> {
    return this.sendRequest('session/load', {
      sessionId,
      cwd,
      mcpServers: [],
    });
  }

  async sendPrompt(sessionId: string, prompt: any[]): Promise<any> {
    // Prompts can run for a long time (big responses, tool loops). Use an
    // idle-based timeout that resets on every incoming message, so an active
    // turn never times out; only genuine inactivity (5 min) aborts.
    return this.sendRequest('session/prompt', {
      sessionId,
      prompt,
    }, 300000);
  }

  async cancelPrompt(sessionId: string) {
    this.sendNotification('session/cancel', { sessionId });
  }

  async respondToPermission(requestId: number, granted: boolean) {
    // Respond to a pending session/request_permission
    const response = {
      jsonrpc: '2.0' as const,
      id: requestId,
      result: { outcome: granted ? 'granted' : 'denied' },
    };
    this.send(response);
  }

  // Reset the idle timers of all pending requests (called on any inbound data,
  // so long-running requests stay alive as long as the agent is producing output)
  private resetPendingTimers() {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          pending.reject(new Error(`Request timed out (no activity)`));
        }
      }, pending.idleMs);
    }
  }

  private sendRequest(method: string, params: any, idleMs: number = 120000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;

      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, idleMs);

      this.pendingRequests.set(id, { resolve, reject, timer, idleMs });

      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      this.send(request);
    });
  }

  private sendNotification(method: string, params: any) {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.send(notification);
  }

  private send(msg: any) {
    if (!this.process?.stdin?.writable) {
      throw new Error('Process not connected');
    }
    const line = JSON.stringify(msg) + '\n';
    this.process.stdin.write(line);
  }

  private processBuffer() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      try {
        const msg = JSON.parse(trimmed);
        this.handleMessage(msg);
      } catch {
        // Skip non-JSON lines (e.g., log output)
      }
    }
  }

  private handleMessage(msg: any) {
    // Any inbound data means the agent is alive - keep pending requests from timing out
    this.resetPendingTimers();

    // Response to a request we made
    if ('id' in msg && ('result' in msg || 'error' in msg)) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);
        if ('error' in msg) {
          pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Notification from agent
    if ('method' in msg && !('id' in msg)) {
      this.handleNotification(msg);
      return;
    }

    // Request from agent (e.g., session/request_permission)
    if ('method' in msg && 'id' in msg) {
      this.handleAgentRequest(msg);
      return;
    }
  }

  private handleNotification(msg: any) {
    const { method, params } = msg;
    
    if (method === 'session/update') {
      this.emit('update', params);
    } else if (method.startsWith('_kiro.dev/')) {
      // Kiro-specific notifications (mcp init, commands, etc.)
      this.emit('update', { 
        sessionId: params?.sessionId, 
        update: { sessionUpdate: '_kiro_internal', method, ...params }
      });
    } else {
      this.emit('update', { method, params });
    }
  }

  private handleAgentRequest(msg: any) {
    const { method, id, params } = msg;
    
    if (method === 'session/request_permission') {
      // Forward permission request to renderer
      this.emit('update', {
        sessionId: params?.sessionId,
        update: {
          sessionUpdate: 'permission_request',
          requestId: id,
          ...params,
        },
      });
    } else {
      // Auto-approve unknown requests
      this.send({ jsonrpc: '2.0', id, result: {} });
    }
  }

  private rejectAllPending(error: Error) {
    for (const [, { reject, timer }] of this.pendingRequests) {
      clearTimeout(timer);
      reject(error);
    }
    this.pendingRequests.clear();
  }
}
