/**
 * **☁️ 备份** —— 两个 tab：同步 / 恢复。
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
import { groupBackups, groupPickState, toggleGroupPick } from '../backupGroups.ts';

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
  /** 本机已经把它归档了 —— 放进「已归档」组；恢复时会取消归档、回到原项目。 */
  archivedLocally?: boolean;
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
const projectLabel = (p?: string): string => (p && p.trim() ? p : '未分组');

const api = (): any => (window as any).kiroApi;

const when = (ms?: number): string => (ms ? new Date(ms).toLocaleString() : '—');
const kb = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export const BackupDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [tab, setTab] = useState<'sync' | 'restore'>('sync');
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
      setPicked((prev) => new Set([...prev].filter((id) => list.some((e) => e.id === id && !e.busy))));
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally { setBusy(null); }
  }, []);

  useEffect(() => { void loadConfig(); void loadProjects(); }, [loadConfig, loadProjects]);
  /* 切到恢复那个 tab 才去拉列表 —— 它是一次网络请求，只开同步 tab 的人不该付这个钱 */
  useEffect(() => { if (tab === 'restore' && !entries) void loadBackups(); }, [tab, entries, loadBackups]);

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
      if (r?.ok) setMsg({ kind: 'ok', text: `传了 ${r.uploaded} 个文件，${r.skipped} 个没变。` });
      else setMsg({ kind: 'bad', text: String(r?.error || '失败') });
      await loadConfig();
      /* 同步时间变了，项目那张表也要重新算 */
      await loadProjects();
      /* 同步过后桶里的东西变了，恢复那张表要重新拉 */
      setEntries(null);
    } finally { setBusy(null); }
  };

  /* ---------- 恢复：按项目分组（本机已归档的单独一组，放最后 —— 见 backupGroups.ts） ---------- */
  const groups = useMemo(() => groupBackups(entries || []), [entries]);

  const selectable = useMemo(() => (entries || []).filter((e) => !e.busy), [entries]);
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
  const deleteBackups = async (ids: string[], busyKey: string): Promise<void> => {
    setBusy(busyKey); setMsg(null);
    try {
      const r = await api()?.deleteS3Sessions?.(ids);
      if (!r?.ok) { setMsg({ kind: 'bad', text: r?.error || '没删掉' }); return; }
      const back = Array.isArray(r.willReturn) ? r.willReturn.length : 0;
      setMsg({
        kind: r.failed?.length ? 'bad' : 'ok',
        text: `删掉了 ${r.sessions} 条会话的备份。`
          + (back ? ` 其中 ${back} 条本地还在，下次同步会再传上去 —— 要它彻底消失，在侧栏把本地那条也删掉。` : '')
          + (r.failed?.length ? `\n${r.failed.length} 个对象没删掉：${r.failed.slice(0, 3).join('；')}` : ''),
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
    const unarchiving = chosen.filter((e) => e.archivedLocally);
    const lines = [
      `要恢复 ${chosen.length} 条会话。`,
      ...(unarchiving.length
        ? ['', `其中 ${unarchiving.length} 条本机已归档，恢复后会取消归档、回到原来的项目。`]
        : []),
      ...(merging.length
        ? ['', `其中 ${merging.length} 条本地已经有了，会和本地那份「合并」（按消息 id 去重、按时间排序）：`,
          ...merging.map((e) => `  · ${e.title || e.id}`),
          '', '（合并前那几份会挪到 ~/.kirolex/trash/，不会真的丢。）',
          '注意：合并的是聊天记录本身；模型自己那套上下文在跑过它的那台机器上，不会一起合并。']
        : ['', '本地都没有这几条，纯新增。']),
      '', '继续？',
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
          if (r.unarchived) unarchivedIds.push(e.id);
          ok.push(`${e.title || e.id}${r.merged ? `（并进 ${r.merged.added} 条${r.merged.clashed ? `，${r.merged.clashed} 条同 id 保留本地` : ''}）` : ''}`
            + (r.unarchived ? `，已取消归档，回到「${projectLabel(r.unarchived.projectId)}」` : ''));
          files += Number(r.restored) || 0;
        } else bad.push(`${e.title || e.id}：${r?.error || '失败'}`);
      } catch (x: any) {
        bad.push(`${e.title || e.id}：${x?.message || x}`);
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
        ok.length ? `已处理 ${ok.length} 条（${files} 个文件）：\n${ok.map((x) => `  · ${x}`).join('\n')}\n已经放回侧栏、正在连接（在本机跑 —— 要跑远端，右键「运行位置」选一台）。` : '',
        bad.length ? `有 ${bad.length} 条没成：\n${bad.join('\n')}` : '',
      ].filter(Boolean).join('\n'),
    });
  };

  const syncingCount = (projects || []).filter((p) => !p.excluded).length;

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className="settings-dialog backup-dialog" style={{ width: 'min(700px, 94vw)', height: 'min(80vh, 800px)' }}>
        <div className="settings-header">
          <h3>
            ☁️ 备份
            {where?.bucket
              ? <span className="backup-where"> · {where.bucket}{where.region ? ` / ${where.region}` : ''}</span>
              : where && <span className="backup-where"> · 还没配桶（设置 → ☁️ 备份）</span>}
          </h3>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>

        <div className="backup-tabs">
          <button className={`memory-tab ${tab === 'sync' ? 'active' : ''}`} onClick={() => setTab('sync')}>
            同步{projects ? ` (${syncingCount}/${projects.length})` : ''}
          </button>
          <button className={`memory-tab ${tab === 'restore' ? 'active' : ''}`} onClick={() => setTab('restore')}>
            恢复{entries ? ` (${entries.length})` : ''}
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
                  {busy === 'sync' ? '同步中…' : '立即同步'}
                </button>
                {where?.last && (
                  <span className="settings-hint">
                    上一次 {when(where.last.at)} · 传了 {where.last.uploaded} 个
                    {where.last.error ? ' · 失败' : ''}
                  </span>
                )}
              </div>
              {where?.last?.error && (
                <div className="settings-warn backup-note" style={{ whiteSpace: 'pre-wrap' }}>{where.last.error}</div>
              )}

              {!projects ? <div className="settings-hint backup-note">读项目…</div> : !projects.length ? (
                <div className="settings-hint backup-note">还没有会话。</div>
              ) : (
                <div className="backup-restore-list">
                  {projects.map((p) => {
                    const shut = !openProjects.has(p.project);
                    /* 这个项目里有几条还没备份 —— 收起来的时候也要看得见 */
                    const behind = p.sessions.filter((x) => x.state !== 'synced').length;
                    return (
                      <div key={p.project || '__none__'} className="backup-group">
                        <div className="backup-proj-row">
                          <button className="backup-group-toggle" onClick={() => setOpenProjects((prev) => {
                            const next = new Set(prev);
                            if (next.has(p.project)) next.delete(p.project); else next.add(p.project);
                            return next;
                          })}>{shut ? '▸' : '▾'} {projectLabel(p.project)}</button>
                          <span className="backup-restore-meta">
                            {p.sessions.length} 条 · {kb(p.bytes)}
                            {behind ? ` · ${behind} 条待同步` : ''}
                          </span>
                          {/* 项目记忆 ——「project 上面也得显示到底 project memory 是否同步了、最新时间是什么时候」 */}
                          {p.memory && (
                            !p.memory.exists
                              ? <span className="backup-mem muted" title="这个项目还没有记忆文件">记忆：还没有</span>
                              : <span
                                  className={`backup-mem ${p.memory.state}`}
                                  title={`~/.kirolex/memory/projects/${p.project}/memory.md\n本地最后修改 ${when(p.memory.updatedAt)}`}
                                >
                                  记忆 {memSize(p.memory.bytes)} · {p.memory.state === 'synced'
                                    ? (p.memory.syncedAt ? `已同步 ${when(p.memory.syncedAt)}` : '已同步（时间未知）')
                                    : p.memory.state === 'pending' ? '有改动待同步' : '没备份过'}
                                </span>
                          )}
                          <ToggleButton
                            on={!p.excluded}
                            labels={['同步', '不同步']}
                            ariaLabel={`${projectLabel(p.project)} 是否同步`}
                            disabled={!!busy}
                            onChange={(next) => void toggleProject(p.project, next)}
                          />
                          {/* 「删除备份」在「恢复」那一页 ——「这个删除备份的按钮不应该在备份这个界面，而是恢复界面」：
                              这一页管"以后传不传"，删桶里已有的是另一件事，挨着开关放太容易点错 */}
                        </div>
                        {!shut && p.sessions.map((x) => (
                          <div key={x.id} className="backup-restore-row" title={x.id}>
                            <span className="backup-restore-title">{x.title}</span>
                            {x.state === 'never'
                              ? <span className="backup-tag warn">没备份过</span>
                              : x.state === 'pending'
                                ? <span className="backup-tag over">有改动待同步</span>
                                : <span className="backup-tag new">已同步</span>}
                            {/* 单条会话也能关 ——「我现在还是不能选择是否备份会话」。项目关着时整组都不传，这里就不给按 */}
                            <ToggleButton
                              on={!p.excluded && !x.excluded}
                              labels={['同步', '不同步']}
                              ariaLabel={`${x.title} 是否同步`}
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
                                ? `同步于 ${when(x.syncedAt)}`
                                : x.state === 'synced' ? '已同步（时间未知）' : '—'}
                            </span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="settings-hint backup-note">
                关掉一个项目或一条会话是<b>停止继续备份</b>，不是删掉已有备份 —— 之前传上去的还在桶里，
                恢复那一页照旧能看到、能捞回来（要删也在那一页）。
              </div>
            </>
          )}

          {tab === 'restore' && (
            <>
              <div className="backup-actions">
                <button className="remote-btn" disabled={!!busy} onClick={() => void loadBackups()}>
                  {busy === 'list' ? '读取中…' : '刷新'}
                </button>
                <button className="remote-btn remote-btn-primary" disabled={!!busy || !chosen.length}
                        onClick={() => void restore()}>
                  {busy === 'restore' ? '恢复中…' : `恢复选中的${chosen.length ? ` ${chosen.length} 条` : ''}`}
                </button>
                <button
                  className={`remote-btn${armDelete ? ' remote-btn-danger' : ''}`}
                  disabled={!!busy || !chosen.length}
                  onClick={() => void removeBackups()}
                  onBlur={() => setArmDelete(false)}
                  title="只删桶里的备份，本地不动"
                >
                  {busy === 'delete' ? '删除中…'
                    : armDelete ? `确认删除 ${chosen.length} 条备份`
                    : `删除选中的${chosen.length ? ` ${chosen.length} 条` : ''}`}
                </button>
                {armDelete && !!stillLocal.length && (
                  <span className="settings-hint">其中 {stillLocal.length} 条本地还在，下次同步会再传上去</span>
                )}
                {!armDelete && !!merging.length && (
                  <span className="settings-hint">其中 {merging.length} 条会和本地合并</span>
                )}
              </div>

              {err && <div className="settings-warn backup-note" style={{ whiteSpace: 'pre-wrap' }}>{err}</div>}

              {entries && !entries.length && !err && (
                <div className="settings-hint backup-note">桶里还没有备份 —— 先在「同步」那个 tab 点一次「立即同步」。</div>
              )}

              {!!groups.length && (
                <div className="backup-restore-list">
                  {groups.map(({ key, name, archived, rows }) => {
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
                          <span className="backup-restore-meta">{rows.length} 条</span>
                          {archived && <span className="settings-hint">本机已归档 · 恢复后会取消归档、回到原来的项目</span>}
                          {!archived && (() => {
                            const proj = rows[0]?.project || '';
                            if (!proj) return null;             // 未分组没有项目记忆
                            const m = bucketMemory[proj];
                            if (!m) return <span className="backup-mem never" title="桶里没有这个项目的记忆">记忆：桶里没有</span>;
                            const empty = m.bytes < EMPTY_MEMORY_BYTES;
                            return (
                              <span
                                className={`backup-mem ${empty ? 'never' : 'synced'}`}
                                title={empty ? '桶里这份几乎是空的（只有标题）—— 恢复时会和本地合并，不会盖掉本地' : '恢复会话时会和本地这个项目的记忆合并'}
                              >
                                记忆 {memSize(m.bytes)}{empty ? '（空）' : ''} · {new Date(m.lastModified).toLocaleString()}
                              </span>
                            );
                          })()}
                          <label className="backup-group-all" title="选中 / 取消这一组里所有能选的会话（正在跑的除外）">
                            <input type="checkbox"
                                   checked={gp.state === 'all'}
                                   ref={(el) => { if (el) el.indeterminate = gp.state === 'some'; }}
                                   disabled={!!busy || !gp.selectable}
                                   onChange={() => setPicked((prev) => toggleGroupPick(prev, rows))} />
                            全选
                          </label>
                          {/*
                            只删这一组里勾选的云上备份（不动本地）。两次点击确认，和顶上「删除选中的」同一套：
                            第一次变成「确认删除 N 条备份」，失去焦点或勾选变了就退回去。
                          */}
                          <button className={`remote-btn backup-del${armed ? ' remote-btn-danger' : ''}`}
                                  disabled={!!busy || !gp.pickedIds.length}
                                  title="只删这一组里勾选的会话在桶里的备份，本地不动"
                                  onClick={() => void removeGroupBackups(key, gp.pickedIds)}
                                  onBlur={() => { if (armed) setArmGroup(null); }}>
                            {busy === `del:${key}` ? '删除中…'
                              : !gp.pickedIds.length ? '删除备份'
                              : armed ? `确认删除 ${gp.pickedIds.length} 条备份`
                              : `删除选中的 ${gp.pickedIds.length} 条`}
                          </button>
                        </div>
                        {!shut && rows.map((e) => (
                          <label
                            key={e.id}
                            className={`backup-restore-row${e.busy ? ' disabled' : ''}${picked.has(e.id) ? ' picked' : ''}`}
                            title={e.busy
                              ? '这条会话正在跑一轮 —— 等它跑完再恢复，不然这一轮还没落盘的内容会丢'
                              : `${e.id}\n备份于 ${when(e.syncedAt)}${e.from ? `（来自 ${e.from}）` : ''}`}
                          >
                            <input type="checkbox" checked={picked.has(e.id)} disabled={!!e.busy || !!busy}
                                   onChange={() => toggle(e.id)} />
                            <span className="backup-restore-title">{e.title || e.id}</span>
                            {e.archivedLocally && (
                              <span className="backup-tag warn" title="本机已归档 —— 恢复后会取消归档，回到原来的项目">本机已归档</span>
                            )}
                            {e.archivedLocally && (
                              <span className="backup-restore-meta">原属「{projectLabel(e.project)}」</span>
                            )}
                            {e.busy
                              ? <span className="backup-tag warn">正在跑</span>
                              : e.existsLocally
                                ? <span className="backup-tag over">会合并</span>
                                : <span className="backup-tag new">本地没有</span>}
                            <span className="backup-restore-meta">{kb(e.bytes)} · {when(e.updatedAt)}</span>
                          </label>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}

              {!!entries?.length && (
                <div className="settings-hint backup-note">
                  本地已有的会合并，合并前那份挪进 <code>~/.kirolex/trash/</code>。恢复完要重启 KiroLex。
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
};
