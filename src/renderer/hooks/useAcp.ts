import { useState, useCallback, useEffect, useRef } from 'react';
import type { Message, ToolCall, Session, SessionFolder } from '../App';

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

interface PermissionRequest {
  requestId: number;
  sessionId: string;
  tool?: string;
  description?: string;
}

export function useAcp() {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>(() => {
    // Load persisted sessions
    try {
      const saved = localStorage.getItem('kirolex-sessions');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [];
  });
  const [folders, setFolders] = useState<SessionFolder[]>(() => {
    try {
      const saved = localStorage.getItem('kirolex-folders');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [];
  });
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(() => {
    try {
      return localStorage.getItem('kirolex-last-session') || null;
    } catch {}
    return null;
  });
  const [messages, setMessages] = useState<Message[]>([]);
  // Session IDs currently streaming (supports parallel streaming across models)
  const [streamingIds, setStreamingIds] = useState<string[]>([]);
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
  const [activeToolCall, setActiveToolCall] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ contextPercent: number; credits: number; turnMs?: number } | null>(null);
  
  const currentMessageRef = useRef<string>('');
  const toolCallsRef = useRef<Map<string, ToolCall>>(new Map());
  const currentSessionRef = useRef<string | null>(null);
  const messagesCacheRef = useRef<Map<string, Message[]>>(new Map());
  const streamingIdsRef = useRef<Set<string>>(new Set());
  // Per-session usage (credits/context), keyed by sessionId
  const usageMapRef = useRef<Map<string, { contextPercent: number; credits: number; turnMs?: number }>>(new Map());
  // Maps sessionId -> model, so every call can route to the right kiro-cli process
  const sessionModelRef = useRef<Map<string, string>>(new Map());
  const DEFAULT_MODEL = 'claude-opus-4.6';

  const addStreaming = (sid: string) => {
    if (!sid) return;
    if (!streamingIdsRef.current.has(sid)) {
      streamingIdsRef.current.add(sid);
      setStreamingIds(Array.from(streamingIdsRef.current));
    }
  };
  const removeStreaming = (sid: string | null) => {
    if (!sid) return;
    if (streamingIdsRef.current.delete(sid)) {
      setStreamingIds(Array.from(streamingIdsRef.current));
    }
  };

  const modelForSession = (sid: string | null): string => {
    if (!sid) return DEFAULT_MODEL;
    return sessionModelRef.current.get(sid) || DEFAULT_MODEL;
  };

  // Populate sessionModelRef from persisted sessions on init
  useEffect(() => {
    for (const s of sessions) {
      if (s.model && s.model !== 'auto') sessionModelRef.current.set(s.id, s.model);
    }
  }, []);

  // Load messages cache from localStorage on init and restore last session messages
  useEffect(() => {
    try {
      const saved = localStorage.getItem('kirolex-messages-cache');
      if (saved) {
        const entries: [string, Message[]][] = JSON.parse(saved);
        messagesCacheRef.current = new Map(entries);
        // Restore messages for last session
        const lastSid = localStorage.getItem('kirolex-last-session');
        if (lastSid) {
          const cached = messagesCacheRef.current.get(lastSid);
          if (cached && cached.length > 0) {
            setMessages(cached);
          }
        }
      }
    } catch {}
  }, []);

  // Keep ref in sync with state, persist last session
  useEffect(() => {
    currentSessionRef.current = currentSessionId;
    if (currentSessionId) {
      try {
        localStorage.setItem('kirolex-last-session', currentSessionId);
      } catch {}
    }
  }, [currentSessionId]);

  // Cache messages for current session whenever they change
  useEffect(() => {
    if (currentSessionId && messages.length > 0) {
      messagesCacheRef.current.set(currentSessionId, messages);
      // Persist to localStorage (keep last 20 sessions max)
      try {
        const entries = Array.from(messagesCacheRef.current.entries()).slice(-20);
        localStorage.setItem('kirolex-messages-cache', JSON.stringify(entries));
      } catch {}
    }
  }, [messages, currentSessionId]);

  // Persist sessions whenever they change
  useEffect(() => {
    try {
      localStorage.setItem('kirolex-sessions', JSON.stringify(sessions));
    } catch {}
  }, [sessions]);

  // Persist folders whenever they change
  useEffect(() => {
    try {
      localStorage.setItem('kirolex-folders', JSON.stringify(folders));
    } catch {}
  }, [folders]);

  useEffect(() => {
    if (!window.kiroApi) return;

    const removeUpdate = window.kiroApi.onUpdate((data: any) => {
      if (!data?.update) return;
      const { update, sessionId } = data;

      // Only write to the active view if the update's session matches the current one.
      // Everything else is buffered into that session's cache.
      const isActiveSession = !sessionId || sessionId === currentSessionRef.current;

      switch (update.sessionUpdate) {
        case 'agent_message_chunk': {
          const text = update.content?.text || '';

          if (isActiveSession) {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              // Always append to the last assistant message during streaming
              if (last?.role === 'assistant') {
                return [
                  ...prev.slice(0, -1),
                  { ...last, content: last.content + text },
                ];
              } else {
                // Create new assistant message
                return [
                  ...prev,
                  {
                    id: update.messageId || `msg_${Date.now()}`,
                    role: 'assistant',
                    content: text,
                    toolCalls: [],
                    timestamp: Date.now(),
                  },
                ];
              }
            });
          } else if (sessionId) {
            // Buffer message for background session
            const cached = messagesCacheRef.current.get(sessionId) || [];
            const last = cached[cached.length - 1];
            if (last?.role === 'assistant') {
              const updated = [...cached.slice(0, -1), { ...last, content: last.content + text }];
              messagesCacheRef.current.set(sessionId, updated);
            } else {
              messagesCacheRef.current.set(sessionId, [
                ...cached,
                { id: update.messageId || `msg_${Date.now()}`, role: 'assistant' as const, content: text, timestamp: Date.now() },
              ]);
            }
          }
          break;
        }

        case 'tool_call': {
          const tc: ToolCall = {
            toolCallId: update.toolCallId,
            title: update.title || 'Tool call',
            status: update.status || 'pending',
          };
          toolCallsRef.current.set(update.toolCallId, tc);
          // Only surface the active tool for the session being viewed
          if (isActiveSession) setActiveToolCall(tc.title);
          break;
        }

        case 'tool_call_update': {
          const existing = toolCallsRef.current.get(update.toolCallId);
          if (existing) {
            existing.status = update.status;
            if (update.content?.[0]?.content?.text) {
              existing.content = update.content[0].content.text;
            }
            toolCallsRef.current.set(update.toolCallId, existing);

            if (isActiveSession) {
              if (update.status === 'completed' || update.status === 'failed') {
                // Clear after a brief moment
                setTimeout(() => setActiveToolCall(null), 800);
              } else {
                setActiveToolCall(existing.title);
              }
            }
          }
          break;
        }

        case 'permission_request': {
          setPermissionRequest({
            requestId: update.requestId,
            sessionId: sessionId,
            tool: update.tool?.name || update.toolName,
            description: update.description || update.tool?.description,
          });
          break;
        }

        case 'user_message_chunk': {
          // During session replay
          const text = update.content?.text || '';
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === 'user' && last.id === update.messageId) {
              return [...prev.slice(0, -1), { ...last, content: last.content + text }];
            }
            return [...prev, {
              id: update.messageId || `user_${Date.now()}`,
              role: 'user',
              content: text,
              timestamp: Date.now(),
            }];
          });
          break;
        }

        case 'usage_update': {
          // Standard ACP usage update (may not be sent by kiro-cli)
          break;
        }

        case '_kiro_internal': {
          // Handle kiro-specific metadata (per-session usage)
          if (update.method === '_kiro.dev/metadata' && sessionId) {
            const turnCredits = update.meteringUsage?.[0]?.value || 0;
            const prev = usageMapRef.current.get(sessionId);
            const next = {
              contextPercent: update.contextUsagePercentage || 0,
              credits: (prev?.credits || 0) + turnCredits,
              turnMs: update.turnDurationMs,
            };
            usageMapRef.current.set(sessionId, next);
            // Only update the visible usage if this is the session being viewed
            if (isActiveSession) setUsage(next);
          }
          break;
        }

        default:
          break;
      }
    });

    const removeError = window.kiroApi.onError((error: any) => {
      console.error('ACP error:', error);
    });

    const removeDisconnected = window.kiroApi.onDisconnected((data?: any) => {
      // A model's process disconnected. Clear streaming for sessions on that model;
      // the client is recreated lazily on the next message via getClient.
      const model = data?.model;
      if (model) {
        for (const sid of Array.from(streamingIdsRef.current)) {
          if ((sessionModelRef.current.get(sid) || DEFAULT_MODEL) === model) {
            streamingIdsRef.current.delete(sid);
          }
        }
      } else {
        streamingIdsRef.current.clear();
      }
      setStreamingIds(Array.from(streamingIdsRef.current));
    });

    return () => {
      removeUpdate();
      removeError();
      removeDisconnected();
    };
  }, []);

  const connect = useCallback(async (model: string) => {
    setStatus('connecting');
    setConnectionError(null);
    try {
      await window.kiroApi.connect({ model });
      setStatus('connected');
    } catch (err: any) {
      setStatus('disconnected');
      setConnectionError(err?.message || 'Failed to connect');
    }
  }, []);

  const disconnect = useCallback(async () => {
    await window.kiroApi.disconnect();
    setStatus('disconnected');
    setCurrentSessionId(null);
  }, []);

  const newSession = useCallback(async (cwd: string, model: string = DEFAULT_MODEL) => {
    await connect(model);

    // Generate a temporary ID for immediate UI response
    const tempId = `pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    currentSessionRef.current = tempId; // sync immediately to avoid leaked updates
    sessionModelRef.current.set(tempId, model);
    setCurrentSessionId(tempId);
    setMessages([]);
    currentMessageRef.current = '';
    toolCallsRef.current.clear();
    setUsage(null);
    setActiveToolCall(null);

    setSessions((prev) => [
      { id: tempId, title: 'New Chat', model, timestamp: Date.now() },
      ...prev,
    ]);

    // Create real session in background
    try {
      const result = await window.kiroApi.newSession(cwd, model);
      const realId = result.sessionId;
      // Replace temp ID with real ID
      currentSessionRef.current = realId;
      sessionModelRef.current.set(realId, model);
      setCurrentSessionId(realId);
      setSessions((prev) =>
        prev.map((s) => s.id === tempId ? { ...s, id: realId } : s)
      );
      return realId;
    } catch {
      // Keep temp ID, will create on first message
      return tempId;
    }
  }, [connect]);

  const switchSession = useCallback(async (sessionId: string) => {
    currentSessionRef.current = sessionId; // sync immediately to avoid leaked updates
    setCurrentSessionId(sessionId);
    currentMessageRef.current = '';
    toolCallsRef.current.clear();
    // Restore this session's own usage; clear the tool indicator
    setUsage(usageMapRef.current.get(sessionId) || null);
    setActiveToolCall(null);

    // Restore from local cache instantly
    const cached = messagesCacheRef.current.get(sessionId);
    setMessages(cached || []);

    // Load from kiro-cli in background (will replay messages via onUpdate)
    if (!cached || cached.length === 0) {
      try {
        await window.kiroApi.loadSession(sessionId, '~', modelForSession(sessionId));
      } catch {
        // Session might not be loadable
      }
    }
  }, []);

  const sendMessage = useCallback(async (prompt: any[], localResponse?: string, attachments?: any[], model?: string) => {
    let sid = currentSessionId;
    const activeModel = model || modelForSession(sid);

    const textContent = prompt.find(p => p.type === 'text' && !p.text.startsWith('<hidden>'))?.text || '';

    // Show user message immediately in UI
    setMessages((prev) => [
      ...prev,
      { id: `user_${Date.now()}`, role: 'user', content: textContent, attachments, timestamp: Date.now() },
    ]);

    if (localResponse) {
      setMessages((prev) => [
        ...prev,
        { id: `msg_${Date.now()}`, role: 'assistant', content: localResponse, timestamp: Date.now() },
      ]);
      return;
    }

    // If no session or session is pending, create a real one
    if (!sid || sid.startsWith('pending_')) {
      try {
        const result = await window.kiroApi.newSession('~', activeModel);
        sid = result.sessionId;
        currentSessionRef.current = sid; // sync immediately
        sessionModelRef.current.set(sid, activeModel);
        setCurrentSessionId(sid);
        if (currentSessionId?.startsWith('pending_')) {
          setSessions((prev) =>
            prev.map((s) => s.id === currentSessionId ? { ...s, id: sid! } : s)
          );
        } else {
          setSessions((prev) => [
            { id: sid!, title: 'New Chat', model: activeModel, timestamp: Date.now() },
            ...prev,
          ]);
        }
      } catch (err: any) {
        setConnectionError(err?.message || 'Failed to create session');
        return;
      }
    }

    addStreaming(sid!);

    try {
      await window.kiroApi.prompt(sid, prompt, activeModel);
    } catch (err: any) {
      // Session might be stale (from previous app run), try creating a new one and retry
      try {
        const oldSid = sid;
        const result = await window.kiroApi.newSession('~', activeModel);
        sid = result.sessionId;
        // Move streaming marker from the stale id to the new id
        removeStreaming(oldSid);
        addStreaming(sid!);
        currentSessionRef.current = sid; // sync immediately
        sessionModelRef.current.set(sid, activeModel);
        setCurrentSessionId(sid);
        setSessions((prev) =>
          prev.map((s) => s.id === oldSid ? { ...s, id: sid! } : s)
        );

        // Rebuild context: inject previous conversation history into the new session
        const previousMessages = messagesCacheRef.current.get(oldSid!) || [];
        const historyMessages = previousMessages.filter(m => m.id !== `user_${Date.now()}`);
        
        if (historyMessages.length > 0) {
          const recentHistory = historyMessages.slice(-20);
          const contextSummary = recentHistory
            .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
            .join('\n\n');
          
          const contextPrompt = [
            {
              type: 'text',
              text: `<hidden>以下是之前的对话历史，请基于这些上下文继续对话：\n\n${contextSummary}</hidden>`,
            },
            ...prompt,
          ];
          await window.kiroApi.prompt(sid, contextPrompt, activeModel);
        } else {
          await window.kiroApi.prompt(sid, prompt, activeModel);
        }
      } catch (retryErr: any) {
        setMessages((prev) => [
          ...prev,
          { id: `err_${Date.now()}`, role: 'assistant', content: `⚠️ ${retryErr?.message || 'Failed to send message. Please try a new session.'}`, timestamp: Date.now() },
        ]);
      }
    } finally {
      // Prompt resolves at turn end (stopReason) - clear this session's streaming
      removeStreaming(sid);
    }

    // Update session title from first message
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sid && s.title === 'New Chat'
          ? { ...s, title: textContent.slice(0, 40) || 'New Chat' }
          : s
      )
    );
  }, [currentSessionId]);

  const cancelStream = useCallback(async () => {
    if (currentSessionId) {
      await window.kiroApi.cancel(currentSessionId, modelForSession(currentSessionId));
      removeStreaming(currentSessionId);
    }
  }, [currentSessionId]);

  // Force-interrupt everything and reconnect, preserving the current view
  const forceStop = useCallback(async (model: string) => {
    // Clear all streaming state immediately
    streamingIdsRef.current.clear();
    setStreamingIds([]);
    // Try to cancel current turn
    if (currentSessionId) {
      try { await window.kiroApi.cancel(currentSessionId, modelForSession(currentSessionId)); } catch {}
    }
    // Kill all kiro-cli processes (interrupts all in-flight output)
    setStatus('connecting');
    try { await window.kiroApi.disconnect(); } catch {}
    // Reconnect (keeps currentSessionId; it becomes stale and will be
    // transparently recreated with context on the next message)
    try {
      await window.kiroApi.connect({ model });
      setStatus('connected');
    } catch (err: any) {
      setStatus('disconnected');
      setConnectionError(err?.message || 'Failed to reconnect');
    }
  }, [currentSessionId]);

  const deleteSession = useCallback(async (sessionId: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    // Clear local message cache
    messagesCacheRef.current.delete(sessionId);
    try {
      const entries = Array.from(messagesCacheRef.current.entries()).slice(-20);
      localStorage.setItem('kirolex-messages-cache', JSON.stringify(entries));
    } catch {}
    // Delete session files from disk
    try {
      await window.kiroApi.deleteSession(sessionId);
    } catch {}
    if (currentSessionId === sessionId) {
      setCurrentSessionId(null);
      setMessages([]);
    }
  }, [currentSessionId]);

  const renameSession = useCallback((sessionId: string, title: string) => {
    setSessions((prev) =>
      prev.map((s) => s.id === sessionId ? { ...s, title } : s)
    );
  }, []);

  const reorderSessions = useCallback((newSessions: Session[]) => {
    setSessions(newSessions);
  }, []);

  const createFolder = useCallback((name: string) => {
    const folder: SessionFolder = {
      id: `folder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      collapsed: false,
    };
    setFolders((prev) => [...prev, folder]);
    return folder.id;
  }, []);

  const deleteFolder = useCallback((folderId: string) => {
    setFolders((prev) => prev.filter((f) => f.id !== folderId));
    // Move sessions in this folder back to root
    setSessions((prev) =>
      prev.map((s) => s.folderId === folderId ? { ...s, folderId: null } : s)
    );
  }, []);

  const renameFolder = useCallback((folderId: string, name: string) => {
    setFolders((prev) =>
      prev.map((f) => f.id === folderId ? { ...f, name } : f)
    );
  }, []);

  const toggleFolder = useCallback((folderId: string) => {
    setFolders((prev) =>
      prev.map((f) => f.id === folderId ? { ...f, collapsed: !f.collapsed } : f)
    );
  }, []);

  const moveSessionToFolder = useCallback((sessionId: string, folderId: string | null) => {
    setSessions((prev) =>
      prev.map((s) => s.id === sessionId ? { ...s, folderId } : s)
    );
  }, []);

  // Change a session's model. Updates routing; the next message runs on the new
  // model's process (stale-session retry transparently recreates it with context).
  const changeSessionModel = useCallback((sessionId: string, model: string) => {
    sessionModelRef.current.set(sessionId, model);
    setSessions((prev) =>
      prev.map((s) => s.id === sessionId ? { ...s, model } : s)
    );
    // Warm up the client for this model silently (don't touch global status)
    window.kiroApi.connect({ model }).catch(() => {});
  }, []);

  const respondPermission = useCallback(async (granted: boolean) => {
    if (permissionRequest) {
      await window.kiroApi.respondPermission(
        permissionRequest.requestId,
        granted,
        modelForSession(permissionRequest.sessionId)
      );
      setPermissionRequest(null);
    }
  }, [permissionRequest]);

  // Derived: current view is streaming if the current session is in the streaming set
  const isStreaming = currentSessionId !== null && streamingIds.includes(currentSessionId);

  return {
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
  };
}
