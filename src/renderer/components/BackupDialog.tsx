/**
 * **☁️ 从备份恢复** —— 侧栏那颗云按钮点开的就是这一页。
 *
 * 「这个云按钮只保留恢复，这个界面应该展示所有已经备份的会话，然后留一个多选/恢复按钮即可」。
 *
 * 所以这里**没有任何配置**（桶、凭据、定时都在 设置 → ☁️ 备份，见 `BackupSettings.tsx`）。
 * 这一页只回答一个问题：**桶里有哪些会话，我要把哪几条捞回来**。
 *
 * ## 打开就列，不用先点一下
 *
 * 上一版要先点「列出桶里的会话」。既然这一页存在的唯一目的就是看这张表，
 * 那一下点击是纯粹的多余动作 —— 打开即加载，旁边留一个「刷新」。
 *
 * ## 多选
 *
 * 一次要恢复的往往不止一条（换机器、重装之后）。逐条点"恢复"意味着每条都要单独确认一次，
 * 而每一次确认长得一模一样 —— 点到第五次就不看了，而这里面**可能有一条是覆盖本地**。
 * 所以：勾选 + 一颗按钮 + **一次**说清"其中哪几条会覆盖"（点名，不只报个数）。
 *
 * ## 三种行不能长得一样
 *
 * · **本地没有** → 纯新增，没有风险；
 * · **本地已有** → 恢复会**覆盖**（覆盖前挪进 `~/.kirolex/trash/`，但那是"能找回"，不是"没发生"）；
 * · **正连着** → 主进程会直接拒（内存里那份会把恢复的内容盖回去）。这种**不给勾** ——
 *   让人勾上、点了、再收到一句拒绝是最差的：多选恢复时那一条会夹在一堆成功里被漏掉。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';

interface Backup {
  id: string;
  title: string;
  updatedAt: number;
  bytes: number;
  from?: string;
  syncedAt: number;
  existsLocally?: boolean;
  /** 正连着执行器 —— 恢复会被拒，所以不给勾。 */
  attached?: boolean;
}

const api = (): any => (window as any).kiroApi;

const when = (ms?: number): string => (ms ? new Date(ms).toLocaleString() : '—');
const kb = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export const BackupDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [entries, setEntries] = useState<Backup[] | null>(null);
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);

  const load = useCallback(async () => {
    setBusy('list'); setErr(''); setMsg(null);
    try {
      const r = await api()?.listS3Backups?.();
      const list: Backup[] = r?.entries || [];
      setEntries(list);
      if (r?.error) setErr(String(r.error));
      /* 列表换了就把勾掉的收一收 —— 留着一个已经不在表里的 id，到恢复时才发现它没了 */
      setPicked((prev) => new Set([...prev].filter((id) => list.some((e) => e.id === id && !e.attached))));
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally { setBusy(null); }
  }, []);

  /* 打开就列 —— 这一页存在的唯一目的就是看这张表 */
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** 能勾的那些（正连着的不算）。 */
  const selectable = useMemo(() => (entries || []).filter((e) => !e.attached), [entries]);
  const chosen = useMemo(() => selectable.filter((e) => picked.has(e.id)), [selectable, picked]);
  const overwriting = useMemo(() => chosen.filter((e) => e.existsLocally), [chosen]);

  const toggle = (id: string): void => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allPicked = selectable.length > 0 && chosen.length === selectable.length;
  const toggleAll = (): void => setPicked(allPicked ? new Set() : new Set(selectable.map((e) => e.id)));

  /**
   * 恢复勾上的那些。
   *
   * **一次确认，把覆盖那几条点名**。逐条确认的问题不是慢，是"每次长得一样"——
   * 点到第五次就不看了，而这里面可能有一条是覆盖。
   */
  const restore = async (): Promise<void> => {
    if (!chosen.length) return;
    const lines = [
      `要恢复 ${chosen.length} 条会话。`,
      ...(overwriting.length
        ? ['', `其中 ${overwriting.length} 条本地已经有了，会被覆盖：`,
          ...overwriting.map((e) => `  · ${e.title || e.id}`),
          '', '（覆盖前那几份会挪到 ~/.kirolex/trash/，不会真的丢。）']
        : ['', '本地都没有这几条，纯新增。']),
      '', '继续？',
    ];
    if (!window.confirm(lines.join('\n'))) return;

    setBusy('restore'); setMsg(null);
    const ok: string[] = [];
    const bad: string[] = [];
    let files = 0;
    /* 一条一条来：并发恢复会同时写 trash 和 sessions，而失败要能说清是**哪一条** */
    for (const e of chosen) {
      try {
        const r = await api()?.restoreS3Session?.(e.id);
        if (r?.ok) { ok.push(e.title || e.id); files += Number(r.restored) || 0; }
        else bad.push(`${e.title || e.id}：${r?.error || '失败'}`);
      } catch (x: any) {
        bad.push(`${e.title || e.id}：${x?.message || x}`);
      }
    }
    setBusy(null);
    setPicked(new Set());
    await load();
    setMsg({
      kind: bad.length ? 'bad' : 'ok',
      text: [
        ok.length ? `已恢复 ${ok.length} 条（${files} 个文件）。重启 KiroLex 后它们会出现在列表里。` : '',
        bad.length ? `有 ${bad.length} 条没成：\n${bad.join('\n')}` : '',
      ].filter(Boolean).join('\n'),
    });
  };

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className="settings-dialog backup-dialog" style={{ width: 'min(680px, 94vw)', height: 'min(78vh, 760px)' }}>
        <div className="settings-header">
          <h3>☁️ 从备份恢复</h3>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>

        <div className="backup-body">
          <div className="backup-actions">
            <button className="remote-btn" disabled={!!busy} onClick={() => void load()}>
              {busy === 'list' ? '读取中…' : '刷新'}
            </button>
            <button className="remote-btn" disabled={!!busy || !selectable.length} onClick={toggleAll}>
              {allPicked ? '全不选' : '全选'}
            </button>
            <button className="remote-btn remote-btn-primary" disabled={!!busy || !chosen.length}
                    onClick={() => void restore()}>
              {busy === 'restore' ? '恢复中…' : `恢复选中的${chosen.length ? ` ${chosen.length} 条` : ''}`}
            </button>
            {!!overwriting.length && (
              <span className="settings-hint">其中 {overwriting.length} 条会覆盖本地</span>
            )}
          </div>

          {err && <div className="settings-warn backup-note" style={{ whiteSpace: 'pre-wrap' }}>{err}</div>}
          {msg && (
            <div className={`backup-note ${msg.kind === 'bad' ? 'settings-warn' : 'settings-hint'}`}
                 style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</div>
          )}

          {entries && !entries.length && !err && (
            <div className="settings-hint backup-note">
              桶里还没有备份。去 设置 → ☁️ 备份 里点一次「立即同步」。
            </div>
          )}

          {!!entries?.length && (
            <div className="backup-restore-list">
              {entries.map((e) => (
                <label
                  key={e.id}
                  className={`backup-restore-row${e.attached ? ' disabled' : ''}${picked.has(e.id) ? ' picked' : ''}`}
                  title={e.attached
                    ? '这条会话正连着 —— 先断开它（侧栏右键 → 断开）才能恢复，否则内存里那份会把恢复的内容盖回去'
                    : `${e.id}\n备份于 ${when(e.syncedAt)}${e.from ? `（来自 ${e.from}）` : ''}`}
                >
                  <input type="checkbox" checked={picked.has(e.id)} disabled={!!e.attached || !!busy}
                         onChange={() => toggle(e.id)} />
                  <span className="backup-restore-title">{e.title || e.id}</span>
                  {/* 三种状态各给一个标，不靠人去猜哪条会覆盖 */}
                  {e.attached
                    ? <span className="backup-tag warn">正连着</span>
                    : e.existsLocally
                      ? <span className="backup-tag over">会覆盖本地</span>
                      : <span className="backup-tag new">本地没有</span>}
                  <span className="backup-restore-meta">{kb(e.bytes)} · {when(e.updatedAt)}</span>
                </label>
              ))}
            </div>
          )}

          {!!entries?.length && (
            <div className="settings-hint backup-note">
              覆盖前本地那份会挪到 <code>~/.kirolex/trash/</code>，不会真的丢。
              恢复完重启 KiroLex 才会出现在会话列表里。
            </div>
          )}
        </div>
      </div>
    </>
  );
};
