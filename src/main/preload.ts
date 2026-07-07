import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('kiroApi', {
  // Connection
  connect: (options: { model?: string }) => ipcRenderer.invoke('acp:connect', options),
  disconnect: () => ipcRenderer.invoke('acp:disconnect'),
  
  // Sessions (model routes to the per-model kiro-cli process)
  newSession: (cwd: string, model: string) => ipcRenderer.invoke('acp:new-session', cwd, model),
  loadSession: (sessionId: string, cwd: string, model: string) => ipcRenderer.invoke('acp:load-session', sessionId, cwd, model),
  listSessions: () => ipcRenderer.invoke('acp:list-sessions'),
  deleteSession: (sessionId: string) => ipcRenderer.invoke('acp:delete-session', sessionId),
  
  // Chat
  prompt: (sessionId: string, prompt: any[], model: string) => ipcRenderer.invoke('acp:prompt', sessionId, prompt, model),
  cancel: (sessionId: string, model: string) => ipcRenderer.invoke('acp:cancel', sessionId, model),
  respondPermission: (requestId: number, granted: boolean, model: string) => ipcRenderer.invoke('acp:request-permission-response', requestId, granted, model),
  
  // Models
  listModels: () => ipcRenderer.invoke('acp:list-models'),
  getUsage: () => ipcRenderer.invoke('acp:get-usage'),
  getHomeDir: () => ipcRenderer.invoke('app:get-home-dir'),
  saveClipboardImage: () => ipcRenderer.invoke('app:save-clipboard-image'),
  
  // Events
  onUpdate: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:update', handler);
    return () => ipcRenderer.removeListener('acp:update', handler);
  },
  onError: (callback: (error: any) => void) => {
    const handler = (_event: any, error: any) => callback(error);
    ipcRenderer.on('acp:error', handler);
    return () => ipcRenderer.removeListener('acp:error', handler);
  },
  onDisconnected: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('acp:disconnected', handler);
    return () => ipcRenderer.removeListener('acp:disconnected', handler);
  },
});
