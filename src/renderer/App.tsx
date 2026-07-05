import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { PermissionDialog } from './components/PermissionDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { useAcp } from './hooks/useAcp';

declare global {
  interface Window {
    kiroApi: {
      connect: (options: { model?: string }) => Promise<any>;
      disconnect: () => Promise<void>;
      newSession: (cwd: string, model: string) => Promise<{ sessionId: string }>;
      loadSession: (sessionId: string, cwd: string, model: string) => Promise<any>;
      listSessions: () => Promise<any>;
      deleteSession: (sessionId: string) => Promise<void>;
      prompt: (sessionId: string, prompt: any[], model: string) => Promise<any>;
      cancel: (sessionId: string, model: string) => Promise<void>;
      respondPermission: (requestId: number, granted: boolean, model: string) => Promise<void>;
      listModels: () => Promise<any>;
      getUsage: () => Promise<{ text: string }>;
      getHomeDir: () => Promise<string>;
      onUpdate: (callback: (data: any) => void) => () => void;
      onError: (callback: (error: any) => void) => () => void;
      onDisconnected: (callback: (data?: any) => void) => () => void;
    };
  }
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: AttachedFile[];
  toolCalls?: ToolCall[];
  timestamp: number;
}

export interface ToolCall {
  toolCallId: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  content?: string;
}

export interface AttachedFile {
  id: string;
  name: string;
  path: string;
}

export interface Session {
  id: string;
  title: string;
  model: string;
  folderId?: string | null; // null or undefined = root level
  lastMessage?: string;
  timestamp: number;
}

export interface SessionFolder {
  id: string;
  name: string;
  collapsed: boolean;
}

export interface Settings {
  fontSize: number;
}

const DEFAULT_SETTINGS: Settings = { fontSize: 14 };

function loadSettings(): Settings {
  try {
    const saved = localStorage.getItem('kirolex-settings');
    if (saved) return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
  } catch {}
  return DEFAULT_SETTINGS;
}

function saveSettings(settings: Settings) {
  try {
    localStorage.setItem('kirolex-settings', JSON.stringify(settings));
  } catch {}
}

const isMac =
  typeof navigator !== 'undefined' &&
  navigator.platform.toUpperCase().includes('MAC');

const App: React.FC = () => {
  const {
    status,
    connectionError,
    sessions,
    currentSessionId,
    messages,
    isStreaming,
    streamingIds,
    activeToolCall,
    usage,
    permissionRequest,
    connect,
    disconnect,
    forceStop,
    newSession,
    switchSession,
    deleteSession,
    renameSession,
    reorderSessions,
    folders,
    createFolder,
    deleteFolder,
    renameFolder,
    toggleFolder,
    moveSessionToFolder,
    changeSessionModel,
    sendMessage,
    cancelStream,
    respondPermission,
  } = useAcp();

  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [selectedModel, setSelectedModel] = useState('claude-opus-4.6');
  const [models, setModels] = useState<any[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [homeDir, setHomeDir] = useState('~');
  const [deleteConfirm, setDeleteConfirm] = useState<{ sessionId: string; title: string } | null>(null);
  const [unreadSessionIds, setUnreadSessionIds] = useState<string[]>([]);

  // Mark sessions as unread when they finish streaming and the user isn't viewing them
  const prevStreamingIdsRef = useRef<string[]>([]);
  useEffect(() => {
    const prev = prevStreamingIdsRef.current;
    // Sessions that were streaming before but aren't now = just finished
    const finished = prev.filter((id) => !streamingIds.includes(id));
    for (const fid of finished) {
      if (fid !== currentSessionId) {
        setUnreadSessionIds((u) => (u.includes(fid) ? u : [...u, fid]));
      }
    }
    prevStreamingIdsRef.current = streamingIds;
  }, [streamingIds, currentSessionId]);

  // Clear unread when user switches to a session
  const handleSwitchSession = useCallback((sessionId: string) => {
    setUnreadSessionIds((prev) => prev.filter((id) => id !== sessionId));
    switchSession(sessionId);
  }, [switchSession]);

  const handleDeleteSession = useCallback((sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    setDeleteConfirm({ sessionId, title: session?.title || 'this session' });
  }, [sessions]);

  const confirmDelete = useCallback(() => {
    if (deleteConfirm) {
      deleteSession(deleteConfirm.sessionId);
      setDeleteConfirm(null);
    }
  }, [deleteConfirm, deleteSession]);

  useEffect(() => {
    if (window.kiroApi) {
      window.kiroApi.getHomeDir().then(setHomeDir).catch(() => {});
      
      window.kiroApi.listModels().then((data) => {
        setModels(data.models || []);
        try {
          localStorage.setItem('kirolex-models', JSON.stringify(data.models || []));
        } catch {}
      }).catch(() => {
        try {
          const cached = localStorage.getItem('kirolex-models');
          if (cached) setModels(JSON.parse(cached));
        } catch {}
      });

      // Auto-connect
      setTimeout(() => {
        connect(selectedModel);
      }, 300);
    }
  }, []);

  // Apply font size to document
  useEffect(() => {
    document.documentElement.style.setProperty('--chat-font-size', `${settings.fontSize}px`);
  }, [settings.fontSize]);

  const handleSettingsChange = useCallback((newSettings: Settings) => {
    setSettings(newSettings);
    saveSettings(newSettings);
  }, []);

  const handleModelChange = useCallback((model: string) => {
    setSelectedModel(model);
    // Per-session model: update the current session's model (routes to that
    // model's kiro-cli process). No global reconnect needed.
    if (currentSessionId) {
      changeSessionModel(currentSessionId, model);
    }
  }, [currentSessionId, changeSessionModel]);

  // Keep the model dropdown in sync with the current session's model.
  // Always reflect the current session's effective model so different sessions
  // show their own model (older 'auto' sessions fall back to the default).
  useEffect(() => {
    if (!currentSessionId) return;
    const s = sessions.find((x) => x.id === currentSessionId);
    const effective = (s?.model && s.model !== 'auto') ? s.model : 'claude-opus-4.6';
    setSelectedModel(effective);
  }, [currentSessionId]);

  const handleDropFiles = useCallback((files: AttachedFile[]) => {
    setAttachedFiles((prev) => [...prev, ...files]);
  }, []);

  const handleRemoveFile = useCallback((id: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const handleSendMessage = useCallback(async (text: string) => {
    // Clear unread status when user interacts
    if (currentSessionId) {
      setUnreadSessionIds((prev) => prev.filter((id) => id !== currentSessionId));
    }

    // Handle /stop locally - force interrupt and reconnect
    if (text.trim() === '/stop') {
      await forceStop(selectedModel);
      sendMessage([{ type: 'text', text: '/stop' }], '🔄 Force interrupted and reconnected.');
      return;
    }

    // Handle /usage locally
    if (text.trim() === '/usage') {
      try {
        const result = await window.kiroApi.getUsage();
        // Add as a fake assistant message
        sendMessage([{ type: 'text', text: '/usage' }], result.text);
      } catch (err) {
        sendMessage([{ type: 'text', text: '/usage' }], 'Failed to fetch usage info');
      }
      return;
    }

    const prompt: any[] = [];
    const currentAttachments = [...attachedFiles];

    if (currentAttachments.length > 0) {
      const fileRefs = currentAttachments
        .map((f) => `file:${f.path}`)
        .join('\n');
      prompt.push({
        type: 'text',
        text: `<hidden>${fileRefs}\n请读取这些文件内容</hidden>`,
      });
    }

    prompt.push({ type: 'text', text });
    setAttachedFiles([]);
    await sendMessage(prompt, undefined, currentAttachments.length > 0 ? currentAttachments : undefined, selectedModel);
  }, [attachedFiles, sendMessage, currentSessionId, forceStop, selectedModel]);

  // Command queue: commands entered with Ctrl+Enter during streaming
  const [commandQueue, setCommandQueue] = useState<string[]>([]);
  const queueSendingRef = useRef(false);

  const handleQueueCommand = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    setCommandQueue((prev) => [...prev, t]);
  }, []);

  const handleRemoveQueuedCommand = useCallback((index: number) => {
    setCommandQueue((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Process the queue: when idle (not streaming) and queue non-empty, send next command
  useEffect(() => {
    if (isStreaming) return;
    if (queueSendingRef.current) return;
    if (commandQueue.length === 0) return;

    queueSendingRef.current = true;
    const next = commandQueue[0];
    setCommandQueue((prev) => prev.slice(1));
    Promise.resolve(handleSendMessage(next)).finally(() => {
      queueSendingRef.current = false;
    });
  }, [isStreaming, commandQueue, handleSendMessage]);

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = localStorage.getItem('kirolex-sidebar-width');
      if (saved) return parseInt(saved, 10);
    } catch {}
    return 240;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const isResizingRef = useRef(false);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingRef.current) return;
      const newWidth = Math.max(160, Math.min(500, startWidth + ev.clientX - startX));
      setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      isResizingRef.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        localStorage.setItem('kirolex-sidebar-width', String(sidebarWidth));
      } catch {}
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [sidebarWidth]);

  // Save sidebar width when it changes
  useEffect(() => {
    try {
      localStorage.setItem('kirolex-sidebar-width', String(sidebarWidth));
    } catch {}
  }, [sidebarWidth]);

  return (
    <>
      <div className={`app-layout no-toolbar${isMac ? ' mac' : ''}`}>
        {isMac && <div className="mac-titlebar" />}
        {!sidebarCollapsed && (
          <div style={{ width: sidebarWidth, flexShrink: 0 }}>
            <Sidebar
              sessions={sessions}
              folders={folders}
              currentSessionId={currentSessionId}
              status={status}
              streamingSessionIds={streamingIds}
              unreadSessionIds={unreadSessionIds}
              onNewSession={() => newSession(homeDir, selectedModel)}
              onSwitchSession={handleSwitchSession}
              onDeleteSession={handleDeleteSession}
              onRenameSession={renameSession}
              onReorderSessions={reorderSessions}
              onCreateFolder={createFolder}
              onDeleteFolder={deleteFolder}
              onRenameFolder={renameFolder}
              onToggleFolder={toggleFolder}
              onMoveSessionToFolder={moveSessionToFolder}
              onSettings={() => setShowSettings(true)}
            />
          </div>
        )}
        <div className="sidebar-resize-area">
          {!sidebarCollapsed && (
            <div className="sidebar-resize-handle" onMouseDown={handleResizeStart} />
          )}
          <button
            className="sidebar-collapse-btn"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
          >
            {sidebarCollapsed ? '▶' : '◀'}
          </button>
        </div>
        <ChatArea
          messages={messages}
          isStreaming={isStreaming}
          status={status}
          connectionError={connectionError}
          attachedFiles={attachedFiles}
          models={models}
          selectedModel={selectedModel}
          activeToolCall={activeToolCall}
          usage={usage}
          onModelChange={handleModelChange}
          onSend={handleSendMessage}
          onCancel={cancelStream}
          onDropFiles={handleDropFiles}
          onRemoveFile={handleRemoveFile}
          currentSessionId={currentSessionId}
          commandQueue={commandQueue}
          onQueueCommand={handleQueueCommand}
          onRemoveQueuedCommand={handleRemoveQueuedCommand}
        />
      </div>
      {permissionRequest && (
        <PermissionDialog
          request={permissionRequest}
          onRespond={respondPermission}
        />
      )}
      {showSettings && (
        <SettingsDialog
          settings={settings}
          onChange={handleSettingsChange}
          onClose={() => setShowSettings(false)}
        />
      )}
      {deleteConfirm && (
        <>
          <div className="overlay" onClick={() => setDeleteConfirm(null)} />
          <div className="permission-dialog">
            <h3>🗑️ Delete Session</h3>
            <p>
              Are you sure you want to delete <strong>"{deleteConfirm.title}"</strong>?
              This will permanently remove the session and its history.
            </p>
            <div className="actions">
              <button className="btn deny" onClick={() => setDeleteConfirm(null)}>
                Cancel
              </button>
              <button className="btn allow" onClick={confirmDelete} style={{ background: '#ef5350' }}>
                Delete
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
};

export default App;
