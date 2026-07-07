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
  // Cross-session context sync: the current session's linked sources (0..n).
  // Persistent per-session; each send injects only each source's NEW messages.
  const [contextLinks, setContextLinks] = useState<{ sourceId: string; sourceTitle: string }[]>([]);
  // Single-command loop: sessionIds that currently have an active prompt loop.
  const [loopingIds, setLoopingIds] = useState<string[]>([]);

  const currentMessageRef = useRef<string>('');
  const toolCallsRef = useRef<Map<string, ToolCall>>(new Map());
  const currentSessionRef = useRef<string | null>(null);
  const messagesCacheRef = useRef<Map<string, Message[]>>(new Map());
  const streamingIdsRef = useRef<Set<string>>(new Set());
  // Per-session usage (credits/context), keyed by sessionId
  const usageMapRef = useRef<Map<string, { contextPercent: number; credits: number; turnMs?: number }>>(new Map());
  // Maps sessionId -> model, so every call can route to the right kiro-cli process
  const sessionModelRef = useRef<Map<string, string>>(new Map());
  // Per-target-session context links: targetId -> array of { sourceId, sourceTitle, syncedCount }.
  // Each source keeps its own high-water mark so every send only forwards that
  // source's delta (new messages). A target can sync from multiple sources.
  const contextLinksRef = useRef<Map<string, { sourceId: string; sourceTitle: string; syncedCount: number }[]>>(new Map());
  // Active single-command loops keyed by sessionId
  const loopsRef = useRef<Map<string, { text: string; intervalSec: number; stopped: boolean; timer: ReturnType<typeof setTimeout> | null }>>(new Map());
  // Duplicated sessions awaiting backend context injection on their first send.
  // Keyed by the duplicate's pending id -> the source session's message history.
  // On the first real send, this history is injected as a <hidden> priming block
  // so the freshly-created kiro-cli session inherits the full conversation context.
  const duplicateHistoryRef = useRef<Map<string, Message[]>>(new Map());
  const DEFAULT_MODEL = 'claude-opus-4.6';

  const persistContextLinks = () => {
    try {
      localStorage.setItem(
        'kirolex-context-links',
        JSON.stringify(Array.from(contextLinksRef.current.entries()))
      );
    } catch {}
  };

  const refreshContextLinks = (sid: string | null) => {
    const arr = contextLinksRef.current.get(sid || '') || [];
    setContextLinks(arr.map((l) => ({ sourceId: l.sourceId, sourceTitle: l.sourceTitle })));
  };

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
    // Load persisted context links and reflect the current session's links
    try {
      const savedLinks = localStorage.getItem('kirolex-context-links');
      if (savedLinks) {
        const entries: [string, any][] = JSON.parse(savedLinks);
        // Normalize: earlier versions stored a single object per target
        const normalized: [string, { sourceId: string; sourceTitle: string; syncedCount: number }[]][] =
          entries.map(([k, v]) => [k, Array.isArray(v) ? v : [v]]);
        contextLinksRef.current = new Map(normalized);
        const lastSid = localStorage.getItem('kirolex-last-session');
        const arr = lastSid ? contextLinksRef.current.get(lastSid) : undefined;
        if (arr) setContextLinks(arr.map((l) => ({ sourceId: l.sourceId, sourceTitle: l.sourceTitle })));
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

  // Cache messages for current session whenever they change.
  // Debounce localStorage writes to avoid blocking main thread during streaming.
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (currentSessionId && messages.length > 0) {
      messagesCacheRef.current.set(currentSessionId, messages);
      // Debounce: only write to localStorage after 2s of inactivity
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      persistTimerRef.current = setTimeout(() => {
        try {
          const entries = Array.from(messagesCacheRef.current.entries()).slice(-20);
          localStorage.setItem('kirolex-messages-cache', JSON.stringify(entries));
        } catch {}
      }, 2000);
    }
  }, [messages, currentSessionId]);

  // Flush pending persist on unmount
  useEffect(() => {
    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        try {
          const entries = Array.from(messagesCacheRef.current.entries()).slice(-20);
          localStorage.setItem('kirolex-messages-cache', JSON.stringify(entries));
        } catch {}
      }
    };
  }, []);

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
    setContextLinks([]);

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

  // Duplicate a session: create a full copy at the same folder level, preserving
  // all messages and context. The backend kiro-cli session is NOT created yet;
  // the copied history is injected as a <hidden> priming block on the first send
  // (reusing the same context-rebuild pattern used for stale sessions), so the
  // model treats the duplicate as a seamless continuation with full context.
  const duplicateSession = useCallback((sessionId: string): string | undefined => {
    const src = sessions.find((s) => s.id === sessionId);
    if (!src) return undefined;

    const srcMsgs = messagesCacheRef.current.get(sessionId) || [];
    const newId = `pending_dup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const copied = srcMsgs.map((m) => ({ ...m }));

    // Copy messages into the duplicate's display cache and persist
    messagesCacheRef.current.set(newId, copied);
    try {
      const entries = Array.from(messagesCacheRef.current.entries()).slice(-20);
      localStorage.setItem('kirolex-messages-cache', JSON.stringify(entries));
    } catch {}

    // Stash the history for backend context injection on the first send
    if (copied.length > 0) {
      duplicateHistoryRef.current.set(newId, copied);
    }

    // Copy the per-session model routing
    const model = sessionModelRef.current.get(sessionId) || DEFAULT_MODEL;
    sessionModelRef.current.set(newId, model);

    // Copy this session's own usage snapshot for display continuity
    const srcUsage = usageMapRef.current.get(sessionId);
    if (srcUsage) usageMapRef.current.set(newId, { ...srcUsage });

    // Copy context-sync links (each restarts its high-water mark at 0 so the
    // duplicate re-forwards the linked sources' history on its first send)
    const links = contextLinksRef.current.get(sessionId);
    if (links && links.length > 0) {
      contextLinksRef.current.set(newId, links.map((l) => ({ ...l, syncedCount: 0 })));
      persistContextLinks();
    }

    // Insert the duplicate right after the source, in the same folder
    setSessions((prev) => {
      const dup: Session = {
        id: newId,
        title: `dup:${src.title}`,
        model,
        folderId: src.folderId ?? null,
        timestamp: Date.now(),
      };
      const idx = prev.findIndex((s) => s.id === sessionId);
      if (idx === -1) return [dup, ...prev];
      const next = [...prev];
      next.splice(idx + 1, 0, dup);
      return next;
    });

    return newId;
  }, [sessions]);

  const switchSession = useCallback(async (sessionId: string) => {
    currentSessionRef.current = sessionId; // sync immediately to avoid leaked updates
    setCurrentSessionId(sessionId);
    currentMessageRef.current = '';
    toolCallsRef.current.clear();
    // Reflect this session's persistent context-sync links (if any)
    refreshContextLinks(sessionId);
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
      // Capture the pending id first: a duplicated session stashes its source
      // history under this id and needs it injected once the real session exists.
      const pendingId = sid;
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

      // Duplicated session: inject the copied conversation history into the new
      // backend session as a single <hidden> priming block so the model has the
      // full prior context on this very first message.
      const dupHistory = pendingId ? duplicateHistoryRef.current.get(pendingId) : undefined;
      if (dupHistory) {
        duplicateHistoryRef.current.delete(pendingId!);
        if (dupHistory.length > 0) {
          const body = dupHistory
            .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
            .join('\n\n');
          prompt = [
            {
              type: 'text',
              text: `<hidden>这是一个复制出来的会话，下面是它此前的完整对话历史。请把这些内容当作我们当前对话的已有上下文，在此基础上无缝继续，不要重复或复述这些历史：\n\n${body}</hidden>`,
            },
            ...prompt,
          ];
        }
      }
    }

    // Cross-session context sync: if this session is linked to one or more
    // sources, inject each source's NEW messages (delta since last sync) as a
    // single <hidden> block. Migrate link key if the id changed (pending -> real).
    if (currentSessionId && currentSessionId !== sid && contextLinksRef.current.has(currentSessionId)) {
      const moved = contextLinksRef.current.get(currentSessionId)!;
      contextLinksRef.current.delete(currentSessionId);
      contextLinksRef.current.set(sid!, moved);
      persistContextLinks();
    }
    const links = sid ? (contextLinksRef.current.get(sid) || []) : [];
    if (links.length > 0) {
      const sections: string[] = [];
      let changed = false;
      const updated = links.map((link) => {
        const srcMsgs = messagesCacheRef.current.get(link.sourceId) || [];
        const delta = srcMsgs.slice(link.syncedCount);
        if (delta.length > 0) {
          const body = delta
            .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
            .join('\n\n');
          sections.push(`【${link.sourceTitle}】\n${body}`);
          changed = true;
          return { ...link, syncedCount: srcMsgs.length };
        }
        return link;
      });
      if (sections.length > 0) {
        prompt = [
          {
            type: 'text',
            text: `<hidden>下面是我提供给你参考的背景对话记录（来自我之前的几段对话），请把它们当作我们当前对话的已知信息，在回答我接下来的问题时加以利用：\n\n${sections.join('\n\n')}</hidden>`,
          },
          ...prompt,
        ];
      }
      if (changed) {
        contextLinksRef.current.set(sid!, updated);
        persistContextLinks();
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

  // Always-latest ref to sendMessage so the background loop can reuse the exact
  // same (stale-retry + context-injection) send path as a manual send.
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;

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
    // Drop any pending duplicate-history awaiting injection for this session
    duplicateHistoryRef.current.delete(sessionId);
    // Stop any active loop on this session
    const loop = loopsRef.current.get(sessionId);
    if (loop) {
      loop.stopped = true;
      if (loop.timer) clearTimeout(loop.timer);
      loopsRef.current.delete(sessionId);
      setLoopingIds(Array.from(loopsRef.current.keys()));
    }
    // Clear local message cache
    messagesCacheRef.current.delete(sessionId);
    try {
      const entries = Array.from(messagesCacheRef.current.entries()).slice(-20);
      localStorage.setItem('kirolex-messages-cache', JSON.stringify(entries));
    } catch {}
    // Clean up context links: drop this session's own links and remove it as a
    // source from any other session (its message cache is now gone).
    let linksChanged = contextLinksRef.current.delete(sessionId);
    for (const [target, arr] of contextLinksRef.current) {
      const filtered = arr.filter((l) => l.sourceId !== sessionId);
      if (filtered.length !== arr.length) {
        if (filtered.length > 0) contextLinksRef.current.set(target, filtered);
        else contextLinksRef.current.delete(target);
        linksChanged = true;
      }
    }
    if (linksChanged) persistContextLinks();
    // Refresh the current session's link indicator (a source may have been removed)
    refreshContextLinks(currentSessionRef.current);
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

  // Toggle a source session in the current session's context-sync set. Adding a
  // source starts it at syncedCount 0 (first send includes its existing history);
  // toggling it off removes it. Links are persistent and per-session.
  const toggleContextSource = useCallback((sourceSessionId: string) => {
    const target = currentSessionRef.current;
    if (!target || !sourceSessionId || sourceSessionId === target) return;
    const arr = contextLinksRef.current.get(target) || [];
    const exists = arr.some((l) => l.sourceId === sourceSessionId);
    let next: { sourceId: string; sourceTitle: string; syncedCount: number }[];
    if (exists) {
      next = arr.filter((l) => l.sourceId !== sourceSessionId);
    } else {
      const sourceTitle =
        sessions.find((s) => s.id === sourceSessionId)?.title || 'another session';
      next = [...arr, { sourceId: sourceSessionId, sourceTitle, syncedCount: 0 }];
    }
    if (next.length > 0) contextLinksRef.current.set(target, next);
    else contextLinksRef.current.delete(target);
    persistContextLinks();
    setContextLinks(next.map((l) => ({ sourceId: l.sourceId, sourceTitle: l.sourceTitle })));
  }, [sessions]);

  // --- Single-command loop -------------------------------------------------
  // Background send for a loop iteration on a NON-current session. Such a
  // session was current (and thus warmed up) when the loop started, so a plain
  // prompt succeeds. The user bubble is buffered into the session cache and the
  // response streams into it via onUpdate. Returns false on failure.
  const sendLoopBackground = useCallback(async (sessionId: string, text: string): Promise<boolean> => {
    const activeModel = modelForSession(sessionId);
    const userMsg: Message = {
      id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    const cached = messagesCacheRef.current.get(sessionId) || [];
    messagesCacheRef.current.set(sessionId, [...cached, userMsg]);
    addStreaming(sessionId);
    try {
      await window.kiroApi.prompt(sessionId, [{ type: 'text', text }], activeModel);
      return true;
    } catch (err: any) {
      const c = messagesCacheRef.current.get(sessionId) || [];
      messagesCacheRef.current.set(sessionId, [...c, {
        id: `err_${Date.now()}`,
        role: 'assistant',
        content: `⚠️ Loop stopped: ${err?.message || 'send failed'}`,
        timestamp: Date.now(),
      }]);
      return false;
    } finally {
      removeStreaming(sessionId);
    }
  }, []);

  // Start looping a prompt on a session: send, wait until the turn ends, then
  // wait intervalSec, then repeat — until stopped. Runs in the background so it
  // continues even if the user switches away. When looping the CURRENT session
  // it reuses the exact manual-send path (sendMessage) for identical behavior
  // (stale-retry + context injection); otherwise it uses a plain background send.
  const startLoop = useCallback((sessionId: string, text: string, intervalSec: number) => {
    if (!sessionId || !text.trim()) return;
    const existing = loopsRef.current.get(sessionId);
    if (existing) {
      existing.stopped = true;
      if (existing.timer) clearTimeout(existing.timer);
    }
    const state = { text, intervalSec: Math.max(0, intervalSec || 0), stopped: false, timer: null as ReturnType<typeof setTimeout> | null };
    loopsRef.current.set(sessionId, state);
    let currentLoopSid = sessionId;
    setLoopingIds(Array.from(loopsRef.current.keys()));

    const migrateKey = (newSid: string) => {
      if (newSid === currentLoopSid) return;
      loopsRef.current.delete(currentLoopSid);
      currentLoopSid = newSid;
      if (!state.stopped) loopsRef.current.set(currentLoopSid, state);
      setLoopingIds(Array.from(loopsRef.current.keys()));
    };

    const iterate = async () => {
      if (state.stopped) return;
      if (currentSessionRef.current === currentLoopSid) {
        // Identical to a manual send in the current session
        await sendMessageRef.current([{ type: 'text', text: state.text }], undefined, undefined, modelForSession(currentLoopSid));
        // sendMessage may recreate a stale session and update currentSessionId
        const eff = currentSessionRef.current;
        if (eff) migrateKey(eff);
      } else {
        const ok = await sendLoopBackground(currentLoopSid, state.text);
        if (!ok) {
          loopsRef.current.delete(currentLoopSid);
          setLoopingIds(Array.from(loopsRef.current.keys()));
          return;
        }
      }
      if (state.stopped) return;
      state.timer = setTimeout(() => { iterate(); }, state.intervalSec * 1000);
    };
    iterate();
  }, [sendLoopBackground]);

  // Stop a session's loop: halt scheduling AND interrupt the in-flight turn.
  const stopLoop = useCallback(async (sessionId: string) => {
    const state = loopsRef.current.get(sessionId);
    if (!state) return;
    state.stopped = true;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    loopsRef.current.delete(sessionId);
    setLoopingIds(Array.from(loopsRef.current.keys()));
    try { await window.kiroApi.cancel(sessionId, modelForSession(sessionId)); } catch {}
    removeStreaming(sessionId);
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
    duplicateSession,
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
    contextLinks,
    toggleContextSource,
    loopingIds,
    startLoop,
    stopLoop,
  };
}
