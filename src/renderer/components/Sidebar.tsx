import React, { useState, useRef, useEffect } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragOverEvent,
  useDroppable,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Session, SessionFolder } from '../App';

interface SidebarProps {
  sessions: Session[];
  folders: SessionFolder[];
  currentSessionId: string | null;
  status: 'disconnected' | 'connecting' | 'connected';
  streamingSessionIds: string[];
  unreadSessionIds: string[];
  onNewSession: () => void;
  onSwitchSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  onReorderSessions: (sessions: Session[]) => void;
  onCreateFolder: (name: string) => void;
  onDeleteFolder: (id: string) => void;
  onRenameFolder: (id: string, name: string) => void;
  onToggleFolder: (id: string) => void;
  onMoveSessionToFolder: (sessionId: string, folderId: string | null) => void;
  onSettings: () => void;
}

// Droppable folder (acts as a drop target for sessions)
const DroppableFolder: React.FC<{
  folder: SessionFolder;
  folderSessions: Session[];
  currentSessionId: string | null;
  streamingSessionIds: string[];
  unreadSessionIds: string[];
  onToggleFolder: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string, type: 'session' | 'folder') => void;
  onSwitchSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
}> = ({ folder, folderSessions, currentSessionId, streamingSessionIds, unreadSessionIds, onToggleFolder, onContextMenu, onSwitchSession, onDeleteSession }) => {
  const { setNodeRef, isOver } = useDroppable({ id: folder.id });

  return (
    <div ref={setNodeRef} className="folder-group">
      <div
        className={`folder-header ${isOver ? 'folder-drop-target' : ''}`}
        onClick={() => onToggleFolder(folder.id)}
        onContextMenu={(e) => onContextMenu(e, folder.id, 'folder')}
      >
        <span className="folder-arrow">{folder.collapsed ? '▶' : '▼'}</span>
        <span className="folder-name">{folder.name}</span>
        <span className="folder-count">{folderSessions.length}</span>
      </div>
      {!folder.collapsed && (
        <div className="folder-children">
          {folderSessions.map((session) => (
            <SortableSessionItem
              key={session.id}
              session={session}
              isActive={session.id === currentSessionId}
              sessionStatus={
                streamingSessionIds.includes(session.id) ? 'streaming' :
                unreadSessionIds.includes(session.id) ? 'unread' : 'idle'
              }
              onSwitch={onSwitchSession}
              onContextMenu={onContextMenu}
              onDelete={(e, id) => { e.stopPropagation(); onDeleteSession(id); }}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// Sortable session item
const SortableSessionItem: React.FC<{
  session: Session;
  isActive: boolean;
  sessionStatus?: 'idle' | 'streaming' | 'unread';
  onSwitch: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string, type: 'session') => void;
  onDelete: (e: React.MouseEvent, id: string) => void;
}> = ({ session, isActive, sessionStatus = 'idle', onSwitch, onContextMenu, onDelete }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: session.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`session-item ${isActive ? 'active' : ''}`}
      onClick={() => onSwitch(session.id)}
      onContextMenu={(e) => onContextMenu(e, session.id, 'session')}
      {...attributes}
      {...listeners}
    >
      <span className={`session-dot ${sessionStatus}`}>
        {sessionStatus === 'streaming' && <><span /><span /><span /></>}
      </span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {session.title}
      </span>
      <button className="session-delete-btn" onClick={(e) => onDelete(e, session.id)} title="Delete">
        ✕
      </button>
    </div>
  );
};

export const Sidebar: React.FC<SidebarProps> = ({
  sessions,
  folders,
  currentSessionId,
  status,
  onNewSession,
  onSwitchSession,
  onDeleteSession,
  onRenameSession,
  onReorderSessions,
  onCreateFolder,
  onDeleteFolder,
  onRenameFolder,
  onToggleFolder,
  onMoveSessionToFolder,
  onSettings,
  streamingSessionIds,
  unreadSessionIds,
}) => {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; targetId: string; type: 'session' | 'folder' } | null>(null);
  const [renamePopup, setRenamePopup] = useState<{ id: string; type: 'session' | 'folder'; value: string } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  useEffect(() => {
    const handler = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener('click', handler);
      return () => document.removeEventListener('click', handler);
    }
  }, [contextMenu]);

  const handleContextMenu = (e: React.MouseEvent, targetId: string, type: 'session' | 'folder') => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, targetId, type });
  };

  const handleRenameStart = () => {
    if (!contextMenu) return;
    const { targetId, type } = contextMenu;
    let currentName = '';
    if (type === 'session') {
      const session = sessions.find((s) => s.id === targetId);
      currentName = session?.title || '';
    } else {
      const folder = folders.find((f) => f.id === targetId);
      currentName = folder?.name || '';
    }
    setRenamePopup({ id: targetId, type, value: currentName });
    setContextMenu(null);
  };

  const handleRenameConfirm = () => {
    if (renamePopup && renamePopup.value.trim()) {
      if (renamePopup.type === 'session') {
        onRenameSession(renamePopup.id, renamePopup.value.trim());
      } else {
        onRenameFolder(renamePopup.id, renamePopup.value.trim());
      }
    }
    setRenamePopup(null);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleRenameConfirm();
    else if (e.key === 'Escape') setRenamePopup(null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;
    if (activeId === overId) return;

    // Don't allow dragging folders
    const activeIsFolder = folders.some((f) => f.id === activeId);
    if (activeIsFolder) return;

    // Check if dropping on a folder
    const targetFolder = folders.find((f) => f.id === overId);
    if (targetFolder) {
      // Move session into folder
      onMoveSessionToFolder(activeId, targetFolder.id);
      return;
    }

    // Check if dropping on another session at root level → move to root
    const overSession = sessions.find((s) => s.id === overId);
    if (overSession && !overSession.folderId) {
      const activeSession = sessions.find((s) => s.id === activeId);
      if (activeSession?.folderId) {
        onMoveSessionToFolder(activeId, null);
      }
    }
  };

  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const newFolderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creatingFolder && newFolderInputRef.current) {
      newFolderInputRef.current.focus();
    }
  }, [creatingFolder]);

  const handleCreateFolder = () => {
    setContextMenu(null);
    setCreatingFolder(true);
    setNewFolderName('');
  };

  const handleCreateFolderConfirm = () => {
    if (newFolderName.trim()) {
      onCreateFolder(newFolderName.trim());
    }
    setCreatingFolder(false);
    setNewFolderName('');
  };

  const handleCreateFolderKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleCreateFolderConfirm();
    else if (e.key === 'Escape') { setCreatingFolder(false); setNewFolderName(''); }
  };

  // Separate sessions by folder
  const rootSessions = sessions.filter((s) => !s.folderId);
  const allDraggableIds = [
    ...sessions.map((s) => s.id),
  ];

  return (
    <div className="sidebar">
      <div className="sidebar-top-btns">
        <button className="new-session-btn no-drag" onClick={onNewSession}>
          + New Session
        </button>
      </div>

      <div
        className="session-list"
        onContextMenu={(e) => {
          // Only show sidebar context menu if clicking on blank area
          if ((e.target as HTMLElement).classList.contains('session-list')) {
            e.preventDefault();
            setContextMenu({ x: e.clientX, y: e.clientY, targetId: '__sidebar__', type: 'folder' });
          }
        }}
      >
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            {/* New folder input */}
            {creatingFolder && (
              <div className="folder-header" style={{ background: 'var(--bg-tertiary)' }}>
                <span className="folder-arrow">📁</span>
                <input
                  ref={newFolderInputRef}
                  className="session-rename-input"
                  value={newFolderName}
                  placeholder="Folder name..."
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={handleCreateFolderKeyDown}
                  onBlur={handleCreateFolderConfirm}
                />
              </div>
            )}

            {/* Folders (drop targets, not sortable) */}
            {folders.map((folder) => {
              const folderSessions = sessions.filter((s) => s.folderId === folder.id);
              return (
                <DroppableFolder
                  key={folder.id}
                  folder={folder}
                  folderSessions={folderSessions}
                  currentSessionId={currentSessionId}
                  streamingSessionIds={streamingSessionIds}
                  unreadSessionIds={unreadSessionIds}
                  onToggleFolder={onToggleFolder}
                  onContextMenu={handleContextMenu}
                  onSwitchSession={onSwitchSession}
                  onDeleteSession={onDeleteSession}
                />
              );
            })}

          <SortableContext items={allDraggableIds} strategy={verticalListSortingStrategy}>
            {/* Root sessions (no folder) */}
            {rootSessions.map((session) => (
              <SortableSessionItem
                key={session.id}
                session={session}
                isActive={session.id === currentSessionId}
                sessionStatus={
                  streamingSessionIds.includes(session.id) ? 'streaming' :
                  unreadSessionIds.includes(session.id) ? 'unread' : 'idle'
                }
                onSwitch={onSwitchSession}
                onContextMenu={handleContextMenu}
                onDelete={(e, id) => { e.stopPropagation(); onDeleteSession(id); }}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      {contextMenu && (
        <div className="context-menu" style={{ top: contextMenu.y, left: contextMenu.x }}>
          {contextMenu.targetId === '__sidebar__' ? (
            // Sidebar blank area context menu
            <div className="context-menu-item" onClick={handleCreateFolder}>
              📁 New Folder
            </div>
          ) : (
            <>
              <div className="context-menu-item" onClick={handleRenameStart}>
                ✏️ Rename
              </div>
              {contextMenu.type === 'session' && folders.length > 0 && (
                <>
                  <div className="context-menu-divider" />
                  {folders.map((f) => (
                    <div
                      key={f.id}
                      className="context-menu-item"
                      onClick={() => {
                        onMoveSessionToFolder(contextMenu.targetId, f.id);
                        setContextMenu(null);
                      }}
                    >
                      📁 Move to {f.name}
                    </div>
                  ))}
                  <div
                    className="context-menu-item"
                    onClick={() => {
                      onMoveSessionToFolder(contextMenu.targetId, null);
                      setContextMenu(null);
                    }}
                  >
                    📄 Move to root
                  </div>
                </>
              )}
              <div className="context-menu-divider" />
              <div
                className="context-menu-item danger"
                onClick={() => {
                  if (contextMenu.type === 'session') onDeleteSession(contextMenu.targetId);
                  else onDeleteFolder(contextMenu.targetId);
                  setContextMenu(null);
                }}
              >
                🗑️ Delete
              </div>
            </>
          )}
        </div>
      )}

      <div className="sidebar-status-bar">
        <span className={`status-dot ${status}`} />
        <span>{status}</span>
        <button
          className="sidebar-settings-btn"
          onClick={onSettings}
          title="Settings"
        >
          ⚙️
        </button>
      </div>

      {/* Rename popup */}
      {renamePopup && (
        <>
          <div className="overlay" onClick={() => setRenamePopup(null)} />
          <div className="rename-popup">
            <h4>Rename</h4>
            <input
              key={renamePopup.id}
              autoFocus
              className="rename-popup-input"
              defaultValue={renamePopup.value}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const val = (e.target as HTMLInputElement).value.trim();
                  if (val) {
                    if (renamePopup.type === 'session') onRenameSession(renamePopup.id, val);
                    else onRenameFolder(renamePopup.id, val);
                  }
                  setRenamePopup(null);
                } else if (e.key === 'Escape') {
                  setRenamePopup(null);
                }
              }}
            />
            <div className="rename-popup-actions">
              <button className="rename-popup-btn cancel" onClick={() => setRenamePopup(null)}>Cancel</button>
              <button className="rename-popup-btn confirm" onClick={() => {
                const input = document.querySelector('.rename-popup-input') as HTMLInputElement;
                const val = input?.value.trim();
                if (val) {
                  if (renamePopup.type === 'session') onRenameSession(renamePopup.id, val);
                  else onRenameFolder(renamePopup.id, val);
                }
                setRenamePopup(null);
              }}>OK</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
