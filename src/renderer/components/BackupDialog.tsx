/**
 * **☁️ 备份** —— 三个 tab：同步 / 恢复 / 云端回收站。
 *
 * 「云那里分同步和恢复两个tab好了」「你得按 project 整理，有些project可以选择不同步」。
 *
 * 这里**没有凭据配置**（桶、区、AK、定时间隔都在 设置 → ☁️ 备份）。这一页管的是两件
 * 平时要回来看的事：
 *
 * · **同步**：哪些项目在备份、哪些不备份、现在同步一次；
 * · **恢复**：桶里有哪些会话（按项目分组），捞哪几条回来。
 *
 * ## 为什么按项目分组
 *
 * 33 条会话平铺成一张表时，"这条是哪摊活的"要靠标题去猜。而"要不要备份"这个决定
 * 本来就是按摊做的 —— 一个项目要么整摊备份，要么整摊不备份，很少有"这个项目里
 * 只备份三条会话"的需求。所以分组不只是排版，它和"不同步"那个开关是同一个粒度。
 *
 * ## 排除是"停止继续备份"，不是"删掉备份"
 *
 * 关掉一个项目之后，它已经传上去的那些**还在桶里、照旧能恢复** —— catalog 描述的是
 * 桶里有什么，不是策略。所以恢复那个 tab 里仍然会看到它们，这是对的：
 * 你当初备份过，现在只是不再往上传。界面上要把这句说出来，
 * 否则"关了它怎么还在列表里"看起来像开关没生效。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ToggleButton } from './ToggleButton.tsx';
import { ConfirmDialog, type ConfirmRequest } from './ConfirmDialog';
import { cleanupSentence } from '../backupGroups.ts';
import { groupBackups, groupSyncProjects, compareFreshness, freshnessLabel, groupPickState, toggleGroupPick, isPickable } from '../backupGroups.ts';
import { useLang, useT } from '../hooks/useLang';

interface Backup {
  id: string;
  title: string;
  updatedAt: number;
  bytes: number;
  from?: string;
  syncedAt: number;
  /** 属于哪个项目（老 catalog 没有这个字段 → 未分组）。 */
  project?: string;
  existsLocally?: boolean;
  /** 正在跑一轮 —— 恢复会被拒（那一轮还没落盘），所以不给勾。连着但空闲的会自动先断开。 */
  busy?: boolean;
  /** 云上这份是不是归档的（catalog 的 archived）—— 放进「已归档」组。 */
  archived?: boolean;
  /** 本机这条记录的 updatedAt（本机没有是 0）—— 新旧对比用。 */
  localUpdatedAt?: number;
  /** 恢复后会按云上的位置改到别的项目 / 改变归档状态（谁后挪用谁，主进程算的）。 */
  placementWillChange?: boolean;
  /** 桶里已经没有这条的文件（catalog 没清干净）—— 恢复不了，不给勾，给「从目录里移除」。 */
  missing?: boolean;
  /** 文件是什么时候被删的（桶开了版本控制才知道）。 */
  deletedAt?: number;
}

/** 云端回收站里的一份（主进程 `listCloudTrash`，见 cloudTrash.ts）。 */
interface TrashRow {
  dir: string;
  id: string;
  title: string;
  project?: string;
  archived?: boolean;
  /** 0 = 时间未知（说明文件读不到）—— 不会自动到期，只能手动删。 */
  trashedAt: number;
  daysLeft: number;
  by?: string;
  deletedBy: string[];
  reason?: string;
  objects: number;
  bytes: number;
}

interface SessionRow {
  id: string;
  title: string;
  updatedAt: number;
  bytes: number;
  /** 最后一次**真的传上去**是什么时候（0 = 从没传过）。 */
  syncedAt: number;
  state: 'never' | 'pending' | 'synced';
  /** 这条会话单独设成了不同步。 */
  excluded?: boolean;
  /** 本机归档了 —— 同步页放进「已归档」组。 */
  archived?: boolean;
}

interface ProjectRow {
  project: string;
  sessions: SessionRow[];
  bytes: number;
  updatedAt: number;
  excluded: boolean;
  /** 这个项目的记忆文件（未分组没有）。状态判据和会话同一套。 */
  memory?: { exists: boolean; bytes: number; updatedAt: number; syncedAt: number; state: 'never' | 'pending' | 'synced' };
}

/**
 * 记忆的大小：字节级，因为空壳（二十几字节，只有标题那一行）和真内容的差别
 * 正是这里要让人一眼看出来的东西 —— `kb()` 会把 23 B 和 900 B 都写成 1 KB。
 */
const memSize = (n: number): string => (n < 1024 ? `${n} B` : kb(n));
/** 小于这个就当它是空壳：只有一行标题、一条记忆都没有。 */
const EMPTY_MEMORY_BYTES = 64;

/** 未分组的那一摊在界面上要有个名字，否则它是一行空白。 */
const projectLabel = (p: string | undefined, t: (k: string) => string): string => (p && p.trim() ? p : t('Unassigned'));

const api = (): any => (window as any).kiroApi;

const when = (ms?: number): string => (ms ? new Date(ms).toLocaleString() : '—');
const kb = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export const BackupDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const lang = useLang();
  const t = useT();
  const [tab, setTab] = useState<'sync' | 'restore' | 'trash'>('sync');
  const [where, setWhere] = useState<{ bucket?: string; region?: string; last?: any } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);

  /* --- 同步 tab --- */
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [excluded, setExcluded] = useState<string[]>([]);
  /** 单独设成不同步的会话 id。 */
  const [excludedSessions, setExcludedSessions] = useState<string[]>([]);
  /* 默认收起：一上来看的是"哪些项目在备份"，展开才是"这个项目里每条会话什么时候同步的" */
  const [openProjects, setOpenProjects] = useState<Set<string>>(new Set());

  /* --- 恢复 tab --- */
  const [entries, setEntries] = useState<Backup[] | null>(null);
  /** 桶里每个项目的记忆（大小 + 最后修改）—— 恢复页组头显示 */
  const [bucketMemory, setBucketMemory] = useState<Record<string, { bytes: number; lastModified: string }>>({});
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  /* --- 云端回收站 tab --- */
  const [trash, setTrash] = useState<TrashRow[] | null>(null);
  const [trashDays, setTrashDays] = useState(30);
  const [trashEnabled, setTrashEnabled] = useState(true);
  const [trashErr, setTrashErr] = useState('');
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await api()?.getS3Config?.();
      setWhere({ bucket: cfg?.bucket, region: cfg?.region, last: cfg?.last });
    } catch { /* 拿不到就只显示标题 */ }
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const r = await api()?.s3Projects?.();
      setProjects(r?.projects || []);
      setExcluded(r?.excludeProjects || []);
      setExcludedSessions(r?.excludeSessions || []);
    } catch { setProjects([]); }
  }, []);

  const loadBackups = useCallback(async () => {
    setBusy('list'); setErr(''); setMsg(null);
    try {
      const r = await api()?.listS3Backups?.();
      const list: Backup[] = r?.entries || [];
      setEntries(list);
      setBucketMemory(r?.memoryByProject || {});
      if (r?.error) setErr(String(r.error));
      /* 列表换了就把勾掉的收一收 —— 留着一个已经不在表里的 id，到恢复时才发现它没了 */
      setPicked((prev) => new Set([...prev].filter((id) => list.some((e) => e.id === id && isPickable(e)))));
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally { setBusy(null); }
  }, []);

  const loadTrash = useCallback(async () => {
    setBusy('trash'); setTrashErr('');
    try {
      const r = await api()?.listS3CloudTrash?.();
      setTrash(r?.items || []);
      if (r?.trashDays) setTrashDays(r.trashDays);
      if (r?.enabled !== undefined) setTrashEnabled(!!r.enabled);
      if (r?.error) setTrashErr(String(r.error));
    } catch (e: any) {
      setTrash([]);
      setTrashErr(String(e?.message || e));
    } finally { setBusy(null); }
  }, []);

  useEffect(() => { void loadConfig(); void loadProjects(); }, [loadConfig, loadProjects]);
  /* 切到恢复那个 tab 才去拉列表 —— 它是一次网络请求，只开同步 tab 的人不该付这个钱 */
  useEffect(() => { if (tab === 'restore' && !entries) void loadBackups(); }, [tab, entries, loadBackups]);
  useEffect(() => { if (tab === 'trash' && !trash) void loadTrash(); }, [tab, trash, loadTrash]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * 改**一条会话**的"要不要同步" ——「我现在还是不能选择是否备份会话」。和项目那个开关同一套：
   * 立刻存盘、存的是排除表、关掉不删已有备份。
   */
  const toggleSession = async (id: string, sync: boolean): Promise<void> => {
    const next = sync ? excludedSessions.filter((x) => x !== id) : [...excludedSessions, id];
    setExcludedSessions(next);
    setProjects((prev) => (prev || []).map((p) => ({
      ...p, sessions: p.sessions.map((x) => (x.id === id ? { ...x, excluded: !sync } : x)),
    })));
    try {
      await api()?.saveS3Config?.({ excludeSessions: next });
    } catch (e: any) {
      setMsg({ kind: 'bad', text: String(e?.message || e) });
      await loadProjects();
    }
  };

  /** 改一个项目的"要不要同步"。立刻存盘 —— 这一页没有"保存"按钮。 */
  const toggleProject = async (project: string, sync: boolean): Promise<void> => {
    const next = sync ? excluded.filter((p) => p !== project) : [...excluded, project];
    setExcluded(next);
    setProjects((prev) => (prev || []).map((p) => (p.project === project ? { ...p, excluded: !sync } : p)));
    try {
      await api()?.saveS3Config?.({ excludeProjects: next });
    } catch (e: any) {
      setMsg({ kind: 'bad', text: String(e?.message || e) });
      await loadProjects();       // 存不上就把界面拉回真相
    }
  };

  const syncNow = async (): Promise<void> => {
    setBusy('sync'); setMsg(null);
    try {
      const r = await api()?.syncS3Now?.();
      if (r?.ok) setMsg({ kind: 'ok', text: [t('Uploaded {uploaded} files, {skipped} unchanged.', { uploaded: r.uploaded, skipped: r.skipped }), cleanupSentence(r, lang)].filter(Boolean).join(' ') });
      else setMsg({ kind: 'bad', text: String(r?.error || t('Failed')) });
      await loadConfig();
      /* 同步时间变了，项目那张表也要重新算 */
      await loadProjects();
      /* 同步过后桶里的东西变了，恢复那张表（和云端回收站）要重新拉 */
      setEntries(null);
      setTrash(null);
    } finally { setBusy(null); }
  };

  /* ---------- 同步：按本机分组（本机归档的单独一组，放最后 —— 见 backupGroups.ts） ---------- */
  const syncGroups = useMemo(() => groupSyncProjects<SessionRow, ProjectRow>(projects || [], () => ({
    project: '', sessions: [], bytes: 0, updatedAt: 0, excluded: excluded.includes(''),
  }), lang), [projects, excluded, lang]);
  const syncRowByProject = useMemo(
    () => new Map(syncGroups.filter((g) => g.row).map((g) => [g.project as string, g.row as ProjectRow])),
    [syncGroups],
  );

  /* ---------- 恢复：按云上分组（云上归档的单独一组，放最后 —— 见 backupGroups.ts） ---------- */
  const groups = useMemo(() => groupBackups(entries || [], lang), [entries, lang]);

  const selectable = useMemo(() => (entries || []).filter(isPickable), [entries]);
  const chosen = useMemo(() => selectable.filter((e) => picked.has(e.id)), [selectable, picked]);
  const merging = useMemo(() => chosen.filter((e) => e.existsLocally), [chosen]);

  const toggle = (id: string): void => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  /*
    **删除所选的备份** ——「恢复中需要有一个删除按钮，现在这里面有好多 New Chat 之类没用的会话」。
    两次点击确认（第一次变成「确认删除 N 条」）：桶里删了就回不来，而 app 里的系统确认框
    会卡住渲染线程。只删桶里那份，本地一个字不动。
  */
  const [armDelete, setArmDelete] = useState(false);
  /* 组头的「删除选中的 N 条」同一套两次点击 —— 记着是哪一组点了第一下 */
  const [armGroup, setArmGroup] = useState<string | null>(null);
  useEffect(() => { setArmDelete(false); setArmGroup(null); }, [picked]);
  const stillLocal = useMemo(() => chosen.filter((e) => e.existsLocally), [chosen]);
  const removeBackups = async (): Promise<void> => {
    if (!chosen.length) return;
    if (!armDelete) { setArmDelete(true); return; }
    setArmDelete(false);
    await deleteBackups(chosen.map((e) => e.id), 'delete');
  };
  /* 组头的删除：只删这一组里勾选的那几条（以前是一键删整个项目的备份，跟勾了什么无关，经常误点） */
  const removeGroupBackups = async (key: string, ids: string[]): Promise<void> => {
    if (!ids.length) return;
    if (armGroup !== key) { setArmGroup(key); return; }
    setArmGroup(null);
    await deleteBackups(ids, `del:${key}`);
  };
  /* 「从目录里移除」：只对桶里已经没有文件的条目（主进程会再核对一遍，有文件的不动） */
  const forgetBackups = async (ids: string[]): Promise<void> => {
    setBusy(`forget:${ids.join(',')}`); setMsg(null);
    try {
      const r = await api()?.forgetS3Backups?.(ids);
      if (!r?.ok) { setMsg({ kind: 'bad', text: r?.error || t('Failed') }); return; }
      setMsg({
        kind: r.kept?.length ? 'bad' : 'ok',
        text: t('Removed {n} entries with no backup files from the catalog.', { n: r.removed?.length || 0 })
          + (r.kept?.length ? ' ' + t('{n} still have files in the bucket and were kept.', { n: r.kept.length }) : ''),
      });
      await loadBackups();
    } catch (x: any) {
      setMsg({ kind: 'bad', text: String(x?.message || x) });
    } finally { setBusy(null); }
  };
  const deleteBackups = async (ids: string[], busyKey: string): Promise<void> => {
    setBusy(busyKey); setMsg(null);
    try {
      const r = await api()?.deleteS3Sessions?.(ids);
      if (!r?.ok) { setMsg({ kind: 'bad', text: r?.error || t('Could not delete') }); return; }
      const back = Array.isArray(r.willReturn) ? r.willReturn.length : 0;
      setMsg({
        kind: r.failed?.length ? 'bad' : 'ok',
        text: t('Deleted the backups of {n} sessions.', { n: r.sessions })
          + (back ? ' ' + t('{back} of them still exist locally and will be uploaded again on the next sync. To get rid of one for good, delete the local copy in the sidebar too.', { back }) : '')
          + (r.failed?.length ? '\n' + t('{n} objects could not be deleted: {list}', { n: r.failed.length, list: r.failed.slice(0, 3).join(t('; ')) }) : ''),
      });
      /* 只清掉删了的那几条的勾 —— 别的组还勾着的留着 */
      setPicked((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
      await loadBackups();
    } catch (x: any) {
      setMsg({ kind: 'bad', text: String(x?.message || x) });
    } finally { setBusy(null); }
  };

  const restore = async (): Promise<void> => {
    if (!chosen.length) return;
    const moving = chosen.filter((e) => e.existsLocally && e.placementWillChange);
    const lines = [
      t('About to restore {n} sessions.', { n: chosen.length }),
      ...(moving.length
        ? ['', t('{n} of them will move to another project or change archive state to match the cloud (it was moved there more recently).', { n: moving.length })]
        : []),
      ...(merging.length
        ? ['', t('{n} of them already exist locally and will be merged with the local copy (deduplicated by message id, sorted by time):', { n: merging.length }),
          ...merging.map((e) => `  · ${e.title || e.id}`),
          '', t('(The pre-merge copies are moved to ~/.kirolex/trash/, so nothing is really lost.)'),
          t('Note: only the chat history is merged. The model context lives on the machine that ran it and is not merged.')]
        : ['', t('None of these exist locally, so they will simply be added.')]),
      '', t('Continue?'),
    ];
    if (!window.confirm(lines.join('\n'))) return;

    setBusy('restore'); setMsg(null);
    const ok: string[] = [];
    const bad: string[] = [];
    const restoredIds: string[] = [];
    const unarchivedIds: string[] = [];
    let files = 0;
    /* 一条一条来：并发恢复会同时写 trash 和 sessions，而失败要能说清是**哪一条** */
    for (const e of chosen) {
      try {
        const r = await api()?.restoreS3Session?.(e.id);
        if (r?.ok) {
          restoredIds.push(e.id);
          /* 位置变成"不归档"的：侧栏水化要等它的 archived 落定再预热（见 useAcp 的 onRestored） */
          if (r.placement && !r.placement.archived) unarchivedIds.push(e.id);
          ok.push(`${e.title || e.id}${!r.merged ? '' : r.merged.clashed
              ? t(' (merged {added} messages, kept the local copy of {clashed} with the same id)', { added: r.merged.added, clashed: r.merged.clashed })
              : t(' (merged {added} messages)', { added: r.merged.added })}`
            + (r.placement
              ? t(', moved to "{to}"{toArchived} to match the cloud', { to: projectLabel(r.placement.projectId, t), toArchived: r.placement.archived ? t(' (archived)') : '' })
                + t(' (was in "{from}"{fromArchived})', { from: projectLabel(r.placement.fromProjectId, t), fromArchived: r.placement.fromArchived ? t(', archived') : '' })
              : ''));
          files += Number(r.restored) || 0;
        } else bad.push(`${e.title || e.id}${t(': ')}${r?.error || t('Failed')}`);
      } catch (x: any) {
        bad.push(`${e.title || e.id}${t(': ')}${x?.message || x}`);
      }
    }
    setBusy(null);
    setPicked(new Set());
    /* 侧栏立刻对一遍磁盘 + 把这几条连上（不用重启） */
    if (restoredIds.length) window.dispatchEvent(new CustomEvent('kirolex:sessions-restored', { detail: { ids: restoredIds, unarchived: unarchivedIds } }));
    await loadBackups();
    setMsg({
      kind: bad.length ? 'bad' : 'ok',
      text: [
        ok.length ? t('Processed {n} sessions ({files} files):', { n: ok.length, files }) + `\n${ok.map((x) => `  · ${x}`).join('\n')}\n` + t('They are back in the sidebar and connecting (running on this machine; to run remotely, right-click and pick a machine under "Run on").') : '',
        bad.length ? t('{n} failed:', { n: bad.length }) + `\n${bad.join('\n')}` : '',
      ].filter(Boolean).join('\n'),
    });
  };

  /** 「恢复到云端备份」：移回原位置，恢复页又能看到它。本地不动。 */
  const restoreTrash = async (x: TrashRow): Promise<void> => {
    setBusy(`trash:${x.dir}`); setMsg(null);
    try {
      const r = await api()?.restoreS3CloudTrash?.(x.dir);
      if (r?.ok) setMsg({ kind: 'ok', text: t('"{title}" is back in the cloud backup (see the Recover tab).', { title: x.title }) });
      else setMsg({ kind: 'bad', text: String(r?.error || t('Failed')) });
      setEntries(null);
      await loadTrash();
    } catch (e: any) {
      setMsg({ kind: 'bad', text: String(e?.message || e) });
    } finally { setBusy(null); }
  };

  /** 「立即彻底删除」：先弹确认框（不可恢复），确认后才发；主进程还要求把目录名原样传回去。 */
  const askPurge = (x: TrashRow): void => setConfirm({
    title: t('Delete permanently'),
    message: t('Permanently delete the cloud backup of "{title}"? This cannot be undone.', { title: x.title }),
    confirmLabel: t('Delete permanently'),
    destructive: true,
    onConfirm: () => { void (async () => {
      setBusy(`trash:${x.dir}`); setMsg(null);
      try {
        const r = await api()?.purgeS3CloudTrash?.(x.dir, x.dir);
        if (r?.ok) setMsg({ kind: 'ok', text: t('Permanently deleted "{title}" from the cloud.', { title: x.title }) });
        else setMsg({ kind: 'bad', text: String(r?.error || t('Failed')) });
        await loadTrash();
      } catch (e: any) {
        setMsg({ kind: 'bad', text: String(e?.message || e) });
      } finally { setBusy(null); }
    })(); },
  });

  const syncingCount = (projects || []).filter((p) => !p.excluded).length;

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className="settings-dialog backup-dialog" style={{ width: 'min(700px, 94vw)', height: 'min(80vh, 800px)' }}>
        <div className="settings-header">
          <h3>
            {t('☁️ Backup')}
            {where?.bucket
              ? <span className="backup-where"> · {where.bucket}{where.region ? ` / ${where.region}` : ''}</span>
              : where && <span className="backup-where"> · {t('No bucket configured yet (Settings → ☁️ Backup)')}</span>}
          </h3>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>

        <div className="backup-tabs">
          <button className={`memory-tab ${tab === 'sync' ? 'active' : ''}`} onClick={() => setTab('sync')}>
            {t('Sync')}{projects ? ` (${syncingCount}/${projects.length})` : ''}
          </button>
          <button className={`memory-tab ${tab === 'restore' ? 'active' : ''}`} onClick={() => setTab('restore')}>
            {t('Recover')}{entries ? ` (${entries.length})` : ''}
          </button>
          <button className={`memory-tab ${tab === 'trash' ? 'active' : ''}`} onClick={() => setTab('trash')}>
            {t('Cloud trash')}{trash ? ` (${trash.length})` : ''}
          </button>
        </div>

        <div className="backup-body">
          {msg && (
            <div className={`backup-note ${msg.kind === 'bad' ? 'settings-warn' : 'backup-ok'}`}
                 style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</div>
          )}

          {tab === 'sync' && (
            <>
              <div className="backup-actions">
                <button className="remote-btn remote-btn-primary" disabled={!!busy} onClick={() => void syncNow()}>
                  {busy === 'sync' ? t('Syncing…') : t('Sync now')}
                </button>
                {where?.last && (
                  <span className="settings-hint">
                    {t('Last run {at} · uploaded {n}', { at: when(where.last.at), n: where.last.uploaded })}
                    {where.last.error ? ` · ${t('failed')}` : ''}
                    {cleanupSentence(where.last, lang) ? ` · ${cleanupSentence(where.last, lang)}` : ''}
                  </span>
                )}
              </div>
              {where?.last?.error && (
                <div className="settings-warn backup-note" style={{ whiteSpace: 'pre-wrap' }}>{where.last.error}</div>
              )}

              {!projects ? <div className="settings-hint backup-note">{t('Loading projects…')}</div> : (
                <div className="backup-restore-list">
                  {syncGroups.map((g) => {
                    const shut = !openProjects.has(g.key);
                    /* 这一组里有几条还没备份 —— 收起来的时候也要看得见 */
                    const behind = g.sessions.filter((x) => x.state !== 'synced').length;
                    const row = g.row;
                    return (
                      <div key={g.archived ? g.key : (g.project || '__none__')} className="backup-group">
                        <div className="backup-proj-row">
                          <button className="backup-group-toggle" onClick={() => setOpenProjects((prev) => {
                            const next = new Set(prev);
                            if (next.has(g.key)) next.delete(g.key); else next.add(g.key);
                            return next;
                          })}>{shut ? '▸' : '▾'} {g.name}</button>
                          <span className="backup-restore-meta">
                            {t('{n} sessions', { n: g.sessions.length })}{g.bytes ? ` · ${kb(g.bytes)}` : ''}
                            {behind ? ` · ${t('{behind} waiting to sync', { behind })}` : ''}
                            {g.archivedCount ? ` · ${t('{n} more in "Archived"', { n: g.archivedCount })}` : ''}
                          </span>
                          {g.archived && (
                            <span className="settings-hint">{t('Archived on this machine · syncing follows the original project and per-session settings')}</span>
                          )}
                          {/* 项目记忆 ——「project 上面也得显示到底 project memory 是否同步了、最新时间是什么时候」 */}
                          {row?.memory && (() => {
                            const p = row as ProjectRow & { memory: NonNullable<ProjectRow['memory']> };
                            return !p.memory.exists
                              ? <span className="backup-mem muted" title={t('This project has no memory file yet')}>{t('Memory: none yet')}</span>
                              : <span
                                  className={`backup-mem ${p.memory.state}`}
                                  title={`~/.kirolex/memory/projects/${p.project}/memory.md\n${t('Last modified locally {at}', { at: when(p.memory.updatedAt) })}`}
                                >
                                  {t('Memory {size}', { size: memSize(p.memory.bytes) })} · {p.memory.state === 'synced'
                                    ? (p.memory.syncedAt ? t('Synced {at}', { at: when(p.memory.syncedAt) }) : t('Synced (time unknown)'))
                                    : p.memory.state === 'pending' ? t('Changes waiting to sync') : t('Never backed up')}
                                </span>;
                          })()}
                          {row && (
                            <ToggleButton
                              on={!row.excluded}
                              labels={[t('Sync'), t("Don't sync")]}
                              ariaLabel={t('Sync {name}?', { name: g.name })}
                              disabled={!!busy}
                              onChange={(next) => void toggleProject(row.project, next)}
                            />
                          )}
                          {/* 「删除备份」在「恢复」那一页 ——「这个删除备份的按钮不应该在备份这个界面，而是恢复界面」：
                              这一页管"以后传不传"，删桶里已有的是另一件事，挨着开关放太容易点错 */}
                        </div>
                        {!shut && g.sessions.map((x) => {
                          /* 这条会话在本机所属的项目 —— 「已归档」组里的也按原项目的开关算 */
                          const p = syncRowByProject.get(x.project) || { excluded: excluded.includes(x.project) };
                          return (
                          <div key={x.id} className="backup-restore-row" title={x.id}>
                            <span className="backup-restore-title">{x.title}</span>
                            {g.archived && <span className="backup-restore-meta">{t('From "{project}"', { project: projectLabel(x.project, t) })}</span>}
                            {x.state === 'never'
                              ? <span className="backup-tag warn">{t('Never backed up')}</span>
                              : x.state === 'pending'
                                ? <span className="backup-tag over">{t('Changes waiting to sync')}</span>
                                : <span className="backup-tag new">{t('Synced')}</span>}
                            {/* 单条会话也能关 ——「我现在还是不能选择是否备份会话」。项目关着时整组都不传，这里就不给按 */}
                            <ToggleButton
                              on={!p.excluded && !x.excluded}
                              labels={[t('Sync'), t("Don't sync")]}
                              ariaLabel={t('Sync {name}?', { name: x.title })}
                              disabled={!!busy || p.excluded}
                              onChange={(next) => void toggleSession(x.id, next)}
                            />
                            <span className="backup-restore-meta">
                              {/*
                                `synced` 但没有时间 = 传过、但那次上传发生在这张表存在之前
                                （或者之后每轮都因为"没变"被跳过）。说"时间未知"而不是编一个 ——
                                假时间会被拿去判断备份新不新。
                              */}
                              {x.syncedAt
                                ? t('Synced at {at}', { at: when(x.syncedAt) })
                                : x.state === 'synced' ? t('Synced (time unknown)') : '—'}
                            </span>
                          </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="settings-hint backup-note">
                {t('Turning off a project or session ')}<b>{t('stops further backups')}</b>{t(', it does not delete existing backups. What was uploaded before stays in the bucket and can still be seen and restored on the Recover tab (deleting is done there too).')}
              </div>
            </>
          )}

          {tab === 'restore' && (
            <>
              <div className="backup-actions">
                <button className="remote-btn" disabled={!!busy} onClick={() => void loadBackups()}>
                  {busy === 'list' ? t('Reading…') : t('Refresh')}
                </button>
                <button className="remote-btn remote-btn-primary" disabled={!!busy || !chosen.length}
                        onClick={() => void restore()}>
                  {busy === 'restore' ? t('Restoring…') : chosen.length ? t('Restore {n} selected', { n: chosen.length }) : t('Restore selected')}
                </button>
                <button
                  className={`remote-btn${armDelete ? ' remote-btn-danger' : ''}`}
                  disabled={!!busy || !chosen.length}
                  onClick={() => void removeBackups()}
                  onBlur={() => setArmDelete(false)}
                  title={t('Only deletes the backups in the bucket; local copies are untouched')}
                >
                  {busy === 'delete' ? t('Deleting…')
                    : armDelete ? t('Confirm deleting {n} backups', { n: chosen.length })
                    : chosen.length ? t('Delete {n} selected', { n: chosen.length }) : t('Delete selected')}
                </button>
                {armDelete && !!stillLocal.length && (
                  <span className="settings-hint">{t('{n} of them still exist locally and will be uploaded again on the next sync', { n: stillLocal.length })}</span>
                )}
                {!armDelete && !!merging.length && (
                  <span className="settings-hint">{t('{n} of them will be merged with the local copy', { n: merging.length })}</span>
                )}
              </div>

              {err && <div className="settings-warn backup-note" style={{ whiteSpace: 'pre-wrap' }}>{err}</div>}

              {entries && !entries.length && !err && (
                <div className="settings-hint backup-note">{t('No backups in the bucket yet. Click "Sync now" on the Sync tab first.')}</div>
              )}

              {!!entries && (entries.length > 0 || !err) && (
                <div className="backup-restore-list">
                  {groups.map(({ key, name, archived, project: proj = '', rows }) => {
                    const shut = collapsed.has(key);
                    const gp = groupPickState(rows, picked);
                    const armed = armGroup === key;
                    return (
                      <div key={key} className="backup-group">
                        {/*
                          组头：说清这是哪一摊、能收起来、能全选、能删这一组里勾了的。
                          以前删掉过一颗「选整组」（「选整组那个按钮是干毛线，删掉吧」），后来用户又明确要了回来：
                          组头的「删除备份」原来一键删整个项目的备份、跟勾了什么无关，经常误点 ——
                          现在它只删这一组里勾选的，所以要有个全选框方便一次勾一整组。
                          全选跳过正在跑的行，只动这一组，别的组勾着的不动；勾了一部分显示半选。
                        */}
                        <div className="backup-group-head">
                          <button className="backup-group-toggle" onClick={() => setCollapsed((prev) => {
                            const next = new Set(prev);
                            if (next.has(key)) next.delete(key); else next.add(key);
                            return next;
                          })}>{shut ? '▸' : '▾'} {name}</button>
                          <span className="backup-restore-meta">{t('{n} sessions', { n: rows.length })}</span>
                          {archived && <span className="settings-hint">{t('Archived in the cloud')}</span>}
                          {!archived && (() => {
                            if (!proj) return null;             // 未分组没有项目记忆
                            const m = bucketMemory[proj];
                            if (!m) return <span className="backup-mem never" title={t('The bucket has no memory for this project')}>{t('Memory: not in bucket')}</span>;
                            const empty = m.bytes < EMPTY_MEMORY_BYTES;
                            return (
                              <span
                                className={`backup-mem ${empty ? 'never' : 'synced'}`}
                                title={empty ? t('The bucket copy is almost empty (title only). Restoring merges it with the local one and never overwrites it') : t('Restoring sessions merges this with the local memory of the project')}
                              >
                                {t('Memory {size}', { size: memSize(m.bytes) })}{empty ? t(' (empty)') : ''} · {new Date(m.lastModified).toLocaleString()}
                              </span>
                            );
                          })()}
                          <label className="backup-group-all" title={t('Select / deselect every selectable session in this group (except running ones)')}>
                            <input type="checkbox"
                                   checked={gp.state === 'all'}
                                   ref={(el) => { if (el) el.indeterminate = gp.state === 'some'; }}
                                   disabled={!!busy || !gp.selectable}
                                   onChange={() => setPicked((prev) => toggleGroupPick(prev, rows))} />
                            {t('Select all')}
                          </label>
                          {/*
                            只删这一组里勾选的云上备份（不动本地）。两次点击确认，和顶上「删除选中的」同一套：
                            第一次变成「确认删除 N 条备份」，失去焦点或勾选变了就退回去。
                          */}
                          <button className={`remote-btn backup-del${armed ? ' remote-btn-danger' : ''}`}
                                  disabled={!!busy || !gp.pickedIds.length}
                                  title={t('Only deletes the bucket backups of the checked sessions in this group; local copies are untouched')}
                                  onClick={() => void removeGroupBackups(key, gp.pickedIds)}
                                  onBlur={() => { if (armed) setArmGroup(null); }}>
                            {busy === `del:${key}` ? t('Deleting…')
                              : !gp.pickedIds.length ? t('Delete backups')
                              : armed ? t('Confirm deleting {n} backups', { n: gp.pickedIds.length })
                              : t('Delete {n} selected', { n: gp.pickedIds.length })}
                          </button>
                        </div>
                        {!shut && rows.map((e) => {
                          const fresh = compareFreshness(e);
                          return (
                          <label
                            key={e.id}
                            className={`backup-restore-row${e.busy || e.missing ? ' disabled' : ''}${picked.has(e.id) ? ' picked' : ''}`}
                            title={e.missing
                              ? t('This catalog entry has no files left in the bucket (deleted earlier, but the catalog was not cleaned up). It cannot be restored.')
                              : e.busy
                              ? t('This session is in the middle of a turn. Wait for it to finish before restoring, or whatever has not been written to disk yet will be lost')
                              : `${e.id}\n${e.from ? t('Backed up {at} (from {from})', { at: when(e.syncedAt), from: e.from }) : t('Backed up {at}', { at: when(e.syncedAt) })}`}
                          >
                            <input type="checkbox" checked={picked.has(e.id)} disabled={!isPickable(e) || !!busy}
                                   onChange={() => toggle(e.id)} />
                            <span className="backup-restore-title">{e.title || e.id}</span>
                            {archived && (
                              <span className="backup-restore-meta">{t('From "{project}"', { project: projectLabel(e.project, t) })}</span>
                            )}
                            {e.busy && <span className="backup-tag warn">{t('Running now')}</span>}
                            {/*
                              桶里已经没有文件的条目（老版本删除时 catalog 没清干净）：不显示成可恢复，
                              说清「备份文件已删除」，给一颗「从目录里移除」。新旧对比对它没意义，不显示。
                            */}
                            {e.missing && (
                              <span className="backup-tag warn">
                                {e.deletedAt ? t('Backup files deleted ({at})', { at: when(e.deletedAt) }) : t('Backup files deleted')}
                              </span>
                            )}
                            {e.missing && (
                              <button className="remote-btn backup-forget" disabled={!!busy}
                                      onClick={(ev) => { ev.preventDefault(); void forgetBackups([e.id]); }}>
                                {busy === `forget:${e.id}` ? t('Removing…') : t('Remove from list')}
                              </button>
                            )}
                            {/* 新旧对比：本机记录的 updatedAt 和云上那份比 */}
                            {!e.missing && <span
                              className={`backup-tag ${fresh === 'cloud-newer' ? 'over' : 'new'}`}
                              title={fresh === 'missing'
                                ? t('Not on this machine; restoring simply adds it')
                                : t('This machine {local} · cloud {cloud}', { local: when(e.localUpdatedAt), cloud: when(e.updatedAt) }) + '\n' + t('Restoring merges it with the local copy (deduplicated by message id, sorted by time)')}
                            >{freshnessLabel(fresh, lang)}</span>}
                            <span className="backup-restore-meta">{kb(e.bytes)} · {when(e.updatedAt)}</span>
                          </label>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}

              {!!entries?.length && (
                <div className="settings-hint backup-note">
                  {t('Sessions that already exist locally are merged; the pre-merge copy is moved to ')}<code>~/.kirolex/trash/</code>{t('. Restart KiroLex after restoring.')}
                </div>
              )}
            </>
          )}

          {/*
            **云端回收站** ——「所有设备上都已不存在的会话，自动移进云端回收站，保留一段时间后彻底删除」。
            同步时自动移进来（判据见 cloudTrash.ts），保留 M 天；这里可以移回原位置，或者确认后立即彻底删除。
          */}
          {tab === 'trash' && (
            <>
              <div className="backup-actions">
                <button className="remote-btn" disabled={!!busy} onClick={() => void loadTrash()}>
                  {busy === 'trash' ? t('Reading…') : t('Refresh')}
                </button>
                <span className="settings-hint">
                  {trashEnabled
                    ? t('Cloud sessions that no active device has any more (every device deleted them) are moved here when syncing, and deleted for good after {n} days.', { n: trashDays })
                    : t('Auto-clean is off (Settings → ☁️ Backup): nothing new is moved here and nothing expires.')}
                </span>
              </div>
              {trashErr && <div className="settings-warn backup-note" style={{ whiteSpace: 'pre-wrap' }}>{trashErr}</div>}
              {!trash && !trashErr && <div className="settings-hint backup-note">{t('Reading…')}</div>}
              {trash && !trash.length && !trashErr && (
                <div className="settings-hint backup-note">{t('The cloud trash is empty.')}</div>
              )}
              {!!trash?.length && (
                <div className="backup-restore-list">
                  {trash.map((x) => (
                    <div key={x.dir} className="backup-restore-row backup-trash-row"
                         title={[x.id, x.deletedBy.length ? t('Deleted on: {machines}', { machines: x.deletedBy.join(', ') }) : '', x.by ? t('Moved by: {machine}', { machine: x.by }) : ''].filter(Boolean).join('\n')}>
                      <span className="backup-restore-title">{x.title}</span>
                      <span className="backup-restore-meta">{projectLabel(x.project, t)}{x.archived ? ` · ${t('Archived')}` : ''}</span>
                      <span className="backup-restore-meta">{t('Moved to trash {at}', { at: when(x.trashedAt) })}</span>
                      <span className={`backup-tag ${!x.trashedAt || x.daysLeft <= 3 ? 'warn' : 'over'}`}
                            title={x.trashedAt ? '' : t('The time is unknown, so it never expires on its own; delete it by hand')}>
                        {x.trashedAt ? t('{n} days left', { n: x.daysLeft }) : t('Time unknown')}
                      </span>
                      <span className="backup-restore-meta">{kb(x.bytes)}</span>
                      <button className="remote-btn" disabled={!!busy} onClick={() => void restoreTrash(x)}
                              title={t('Move it back to where it was in the cloud backup; local sessions are untouched')}>
                        {busy === `trash:${x.dir}` ? t('Working…') : t('Restore to cloud backup')}
                      </button>
                      <button className="remote-btn remote-btn-danger" disabled={!!busy} onClick={() => askPurge(x)}>
                        {t('Delete permanently')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="settings-hint backup-note">
                {t('Only sessions are moved here automatically, and only when every active device has deleted them; anything uncertain stays. Restoring puts it back into the cloud backup (it shows up on the Recover tab again) and does not touch local sessions.')}
              </div>
            </>
          )}
        </div>
      </div>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </>
  );
};
