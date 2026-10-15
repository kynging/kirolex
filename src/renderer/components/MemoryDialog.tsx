import React, { useEffect, useState } from 'react';
import { useT } from '../hooks/useLang';

interface MemoryDialogProps {
  projectId?: string; // current session's project (undefined = unassigned)
  sessionId?: string; // current session (undefined = none open)
  /** 打开就落在哪一层 —— 记忆太大横幅的「编辑」用它直接打开那一层（不给就按原来：有项目开项目层，否则全局） */
  initialTab?: 'global' | 'project' | 'session';
  onClose: () => void;
}

type Scope = 'global' | 'project' | 'session';
/** The editable scopes plus a read-only view of what the last send really carried. */
type Tab = Scope | 'snapshot';

export const MemoryDialog: React.FC<MemoryDialogProps> = ({ projectId, sessionId, initialTab, onClose }) => {
  const t = useT();
  const defaultTab = (): Tab => initialTab || (projectId ? 'project' : 'global');
  const [tab, setTab] = useState<Tab>(defaultTab);
  const [text, setText] = useState<Record<Scope, string>>({ global: '', project: '', session: '' });
  const [paths, setPaths] = useState<Record<Scope, string | null>>({ global: '', project: null, session: null });
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState<Scope | null>(null);
  const [snapshot, setSnapshot] = useState<{
    text: string; at: number | null; path: string | null;
    override?: boolean; overridePath?: string | null; sentText?: string;
  } | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  /** The editor's own copy, so typing does not fight the loader. `null` = untouched. */
  const [snapshotDraft, setSnapshotDraft] = useState<string | null>(null);
  const [snapshotSaved, setSnapshotSaved] = useState<string | null>(null);

  // The selected chat determines the default scope each time the dialog opens
  // or the active session changes while it is open.
  useEffect(() => {
    setTab(defaultTab());
  }, [projectId, sessionId, initialTab]);

  useEffect(() => {
    let alive = true;
    window.kiroApi.readMemory(projectId, sessionId).then((m) => {
      if (!alive) return;
      setText({ global: m.global, project: m.project, session: m.session });
      setPaths({ global: m.globalPath, project: m.projectPath, session: m.sessionPath });
      setLoading(false);
    }).catch(() => setLoading(false));
    return () => { alive = false; };
  }, [projectId, sessionId]);

  // Re-read on every switch to the tab: the archive is rewritten by each send, so a
  // cached copy would go stale the moment another message goes out.
  useEffect(() => {
    if (tab !== 'snapshot') return;
    let alive = true;
    setSnapshotLoading(true);
    window.kiroApi.readLastInjection?.(sessionId)
      .then((r) => { if (alive) { setSnapshot(r); setSnapshotDraft(null); setSnapshotLoading(false); } })
      .catch(() => { if (alive) setSnapshotLoading(false); });
    return () => { alive = false; };
  }, [tab, sessionId]);

  /** Reload the tab from disk, discarding the local draft. */
  const reloadSnapshot = async () => {
    const r = await window.kiroApi.readLastInjection?.(sessionId);
    setSnapshot(r);
    setSnapshotDraft(null);
  };

  /** Pin what is in the editor as this chat's context block. */
  const saveSnapshot = async () => {
    if (!sessionId) return;
    await window.kiroApi.writeContextOverride?.(sessionId, snapshotDraft ?? snapshot?.text ?? '');
    await reloadSnapshot();
    setSnapshotSaved('saved');
    setTimeout(() => setSnapshotSaved((s) => (s === 'saved' ? null : s)), 1800);
  };

  /** Throw the hand-edited block away and go back to the generated snapshot. */
  const revertSnapshot = async () => {
    if (!sessionId) return;
    await window.kiroApi.clearContextOverride?.(sessionId);
    await reloadSnapshot();
    setSnapshotSaved('reverted');
    setTimeout(() => setSnapshotSaved((s) => (s === 'reverted' ? null : s)), 1800);
  };

  const save = async (scope: Scope) => {
    await window.kiroApi.writeMemory(scope, projectId, sessionId, text[scope]);
    setSaved(scope);
    setTimeout(() => setSaved((s) => (s === scope ? null : s)), 1500);
  };

  const tabs: { scope: Tab; label: string; enabled: boolean; hint: string }[] = [
    { scope: 'global', label: t('Global'), enabled: true, hint: t('Applies to all chats everywhere') },
    { scope: 'project', label: projectId ? t('Project: {name}', { name: projectId }) : t('Project (none)'), enabled: !!projectId, hint: t('Applies to all chats in project "{name}"', { name: String(projectId) }) },
    /*
      会话这一层原来**没有 tab** —— 「我让你加一个 session 级别的 memory，这个加了吗，主界面看不了啊」。
      文件、分层注入（全局 ⊕ project ⊕ 会话）和 readMemory 里的 session 字段一直都在，只有这一行漏了：
      于是它是一份写得进、读不出的记忆。现在它可编辑，而且说清了它会被自动维护（每攒够 12 条消息压一次），
      所以你手写的东西可能被下一次压缩合并 —— 不说这句，人会以为自己写的被吞了。
    */
    { scope: 'session', label: t('This chat'), enabled: !!sessionId, hint: t('Applies only to this chat and is injected every turn. KiroLex maintains it automatically (compacted every 12 messages), so whatever you write by hand gets merged in by the next compaction') },
    { scope: 'snapshot', label: t('📦 Snapshot'), enabled: !!sessionId, hint: t('The context the next message in this chat will carry to the model; you can edit and save it here') },
  ];

  const active = tabs.find((t) => t.scope === tab)!;

  return (
    <>
      <div className="overlay" onClick={onClose} />
      {/* Wider and taller than Settings: this dialog is a TEXT EDITOR with one
          full-width field, not a grid of small controls. `.settings-body` is a
          2-column grid, so every item here also spans both columns — otherwise the
          editor sat in the left half with the right half empty. */}
      <div className="settings-dialog memory-dialog" style={{ width: 'min(960px, 94vw)', height: 'min(78vh, 860px)' }}>
        <div className="settings-header">
          <h3>{`🧠 ${t('Memory')}`}</h3>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>

        <div style={{ display: 'flex', gap: 6, padding: '8px 16px 0' }}>
          {tabs.map((tb) => (
            <button
              key={tb.scope}
              className={`memory-tab ${tab === tb.scope ? 'active' : ''}`}
              onClick={() => setTab(tb.scope)}
              disabled={!tb.enabled}
              title={tb.enabled ? tb.hint : t('Not available for this chat')}
            >{tb.label}</button>
          ))}
        </div>

        <div className="settings-body">
          {tab === 'snapshot' ? (
            snapshotLoading ? (
              <p className="settings-preview settings-item-wide">{t('Loading…')}</p>
            ) : (
              <div className="settings-item settings-item-wide" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                {/* Which of the two blocks is in force has to be the first thing on
                    screen: the tab shows an ARCHIVE of what already went out until it
                    is saved, at which point the same text becomes an INPUT for the next
                    send. Reading the same characters with the wrong one of those two
                    meanings is the only way to be badly misled here. */}
                <label className="settings-label" style={{ marginBottom: 6 }}>
                  {snapshot?.override
                    ? t('⚙︎ Hand-edited context (pinned) · the next message sends this verbatim instead of the auto snapshot')
                    : snapshot?.at
                      ? t('Auto-generated snapshot · last sent {time} (the next send regenerates it from the conversation at that point)', { time: new Date(snapshot.at).toLocaleString() })
                      : t('No context has been injected into this chat yet')}
                </label>
                <textarea
                  className="memory-textarea"
                  value={snapshotDraft ?? snapshot?.text ?? ''}
                  placeholder={t('(Nothing recorded yet: context is written when it is actually injected, so it appears after you send a message. You can also write one here — save it and the next message uses it.)')}
                  onChange={(e) => setSnapshotDraft(e.target.value)}
                  spellCheck={false}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                  <button
                    className="rename-popup-btn confirm"
                    onClick={() => void saveSnapshot()}
                    disabled={!sessionId}
                    title={t('Once saved, this text is sent verbatim as the context block along with your next message.\nIt is fixed: it does not update as the conversation grows, so it gets staler the longer you chat. To go back to the auto-generated snapshot, click the button on the right.\nIf you delete the closing line that tells the model to answer the new user message normally, it is added back when sending; otherwise the model would answer the history itself.')}
                  >{t('Save and pin')}</button>
                  {snapshot?.override && (
                    <button
                      className="rename-popup-btn"
                      onClick={() => void revertSnapshot()}
                      title={t('Drop the hand-edited copy and go back to the snapshot generated from the current conversation.')}
                    >{t('Restore auto-generated')}</button>
                  )}
                  {snapshotDraft !== null && snapshotDraft !== (snapshot?.text ?? '') && (
                    <button className="rename-popup-btn" onClick={() => setSnapshotDraft(null)}>{t('Discard changes')}</button>
                  )}
                  {snapshotSaved === 'saved' && <span style={{ color: '#3fb950', fontSize: 12 }}>{`${t('Pinned')} ✓`}</span>}
                  {snapshotSaved === 'reverted' && <span style={{ color: '#3fb950', fontSize: 12 }}>{`${t('Back to auto-generated')} ✓`}</span>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                  <span>{t('{n} chars', { n: (snapshotDraft ?? snapshot?.text ?? '').length })}</span>
                  <span style={{ marginLeft: 'auto' }}>{snapshot?.override ? snapshot?.overridePath : snapshot?.path}</span>
                </div>
              </div>
            )
          ) : loading ? (
            <p className="settings-preview settings-item-wide">{t('Loading…')}</p>
          ) : !active.enabled ? (
            <p className="settings-preview settings-item-wide">
              {tab === 'project'
                ? t("This chat isn't assigned to a project.")
                : t('No chat is open.')}
            </p>
          ) : (
            <div className="settings-item settings-item-wide" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <label className="settings-label" style={{ marginBottom: 6 }}>{active.hint}</label>
              <textarea
                className="memory-textarea"
                value={text[tab]}
                onChange={(e) => setText((prev) => ({ ...prev, [tab]: e.target.value }))}
                spellCheck={false}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                <button className="rename-popup-btn confirm" onClick={() => save(tab)}>{t('Save')}</button>
                {saved === tab && <span style={{ color: '#3fb950', fontSize: 12 }}>{`${t('Saved')} ✓`}</span>}
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>{paths[tab]}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
};
