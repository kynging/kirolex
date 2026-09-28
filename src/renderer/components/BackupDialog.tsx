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
  /** 正连着执行器 —— 恢复会被拒，所以不给勾。 */
  attached?: boolean;
}

interface SessionRow {
  id: string;
  title: string;
  updatedAt: number;
  bytes: number;
  /** 最后一次**真的传上去**是什么时候（0 = 从没传过）。 */
  syncedAt: number;
  state: 'never' | 'pending' | 'synced';
}

interface ProjectRow {
  project: string;
  sessions: SessionRow[];
  bytes: number;
  updatedAt: number;
  excluded: boolean;
}

const api = (): any => (window as any).kiroApi;

const when = (ms?: number): string => (ms ? new Date(ms).toLocaleString() : '—');
const kb = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
/** 未分组的那一摊在界面上要有个名字，否则它是一行空白。 */
const projectLabel = (p?: string): string => (p && p.trim() ? p : '未分组');

export const BackupDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [tab, setTab] = useState<'sync' | 'restore'>('sync');
  const [where, setWhere] = useState<{ bucket?: string; region?: string; last?: any } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);

  /* --- 同步 tab --- */
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [excluded, setExcluded] = useState<string[]>([]);
  /* 默认收起：一上来看的是"哪些项目在备份"，展开才是"这个项目里每条会话什么时候同步的" */
  const [openProjects, setOpenProjects] = useState<Set<string>>(new Set());

  /* --- 恢复 tab --- */
  const [entries, setEntries] = useState<Backup[] | null>(null);
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
    } catch { setProjects([]); }
  }, []);

  const loadBackups = useCallback(async () => {
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

  useEffect(() => { void loadConfig(); void loadProjects(); }, [loadConfig, loadProjects]);
  /* 切到恢复那个 tab 才去拉列表 —— 它是一次网络请求，只开同步 tab 的人不该付这个钱 */
  useEffect(() => { if (tab === 'restore' && !entries) void loadBackups(); }, [tab, entries, loadBackups]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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

  /**
   * **删掉一个项目在桶里的备份** ——「同步这里没有删除按钮」。
   *
   * 这是不可逆的（S3 删了就没了，我们不知道桶有没有开版本控制），所以确认框里
   * 把三件事都说出来：删几条、删的是**云上**的、本地一个字都不动。
   * 最后那句最重要 —— "删除备份"和"删除会话"只差两个字。
   */
  const deleteProject = async (project: string): Promise<void> => {
    const row = (projects || []).find((p) => p.project === project);
    const n = row?.sessions.length || 0;
    const name = projectLabel(project);
    if (!window.confirm([
      `把「${name}」在桶里的备份删掉？`,
      '',
      `涉及 ${n} 条会话（${kb(row?.bytes || 0)}）。`,
      '删的是**云上那份**，本地会话一个字都不动。',
      'S3 上删掉就找不回来了（除非这个桶开了版本控制）。',
      '',
      '继续？',
    ].join('\n'))) return;
    setBusy(`del:${project}`); setMsg(null);
    try {
      const r = await api()?.s3DeleteProject?.(project, project);
      if (r?.ok) {
        setMsg({
          kind: r.failed?.length ? 'bad' : 'ok',
          text: `已删掉「${name}」的备份：${r.sessions} 条会话 / ${r.deleted} 个对象。`
            + (r.failed?.length ? `\n有 ${r.failed.length} 个没删掉：\n${r.failed.join('\n')}` : ''),
        });
      } else setMsg({ kind: 'bad', text: String(r?.error || '删除失败') });
      await loadProjects();
      /* 桶里的东西变了，恢复那张表要重新拉 */
      setEntries(null);
    } finally { setBusy(null); }
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

  /* ---------- 恢复：按项目分组 ---------- */
  const groups = useMemo(() => {
    const map = new Map<string, Backup[]>();
    for (const e of entries || []) {
      const key = projectLabel(e.project);
      const list = map.get(key) || [];
      list.push(e);
      map.set(key, list);
    }
    /* 组内按最近更新排；「未分组」整组排最后 */
    for (const list of map.values()) list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return [...map.entries()].sort((a, b) => {
      if ((a[0] === '未分组') !== (b[0] === '未分组')) return a[0] === '未分组' ? 1 : -1;
      return (b[1][0]?.updatedAt || 0) - (a[1][0]?.updatedAt || 0);
    });
  }, [entries]);

  const selectable = useMemo(() => (entries || []).filter((e) => !e.attached), [entries]);
  const chosen = useMemo(() => selectable.filter((e) => picked.has(e.id)), [selectable, picked]);
  const merging = useMemo(() => chosen.filter((e) => e.existsLocally), [chosen]);

  const toggle = (id: string): void => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const restore = async (): Promise<void> => {
    if (!chosen.length) return;
    const lines = [
      `要恢复 ${chosen.length} 条会话。`,
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
    let files = 0;
    /* 一条一条来：并发恢复会同时写 trash 和 sessions，而失败要能说清是**哪一条** */
    for (const e of chosen) {
      try {
        const r = await api()?.restoreS3Session?.(e.id);
        if (r?.ok) {
          ok.push(`${e.title || e.id}${r.merged ? `（并进 ${r.merged.added} 条${r.merged.clashed ? `，${r.merged.clashed} 条同 id 保留本地` : ''}）` : ''}`);
          files += Number(r.restored) || 0;
        } else bad.push(`${e.title || e.id}：${r?.error || '失败'}`);
      } catch (x: any) {
        bad.push(`${e.title || e.id}：${x?.message || x}`);
      }
    }
    setBusy(null);
    setPicked(new Set());
    await loadBackups();
    setMsg({
      kind: bad.length ? 'bad' : 'ok',
      text: [
        ok.length ? `已处理 ${ok.length} 条（${files} 个文件）：\n${ok.map((x) => `  · ${x}`).join('\n')}\n重启 KiroLex 后它们会出现在列表里。` : '',
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
                          <ToggleButton
                            on={!p.excluded}
                            labels={['同步', '不同步']}
                            ariaLabel={`${projectLabel(p.project)} 是否同步`}
                            disabled={!!busy}
                            onChange={(next) => void toggleProject(p.project, next)}
                          />
                          {/* 删云上的备份，不动本地 —— 和「不同步」是两件事 */}
                          <button className="remote-btn backup-del" disabled={!!busy}
                                  title="删掉这个项目在桶里的备份（不动本地会话）"
                                  onClick={() => void deleteProject(p.project)}>
                            {busy === `del:${p.project}` ? '删除中…' : '删除备份'}
                          </button>
                        </div>
                        {!shut && p.sessions.map((x) => (
                          <div key={x.id} className="backup-restore-row" title={x.id}>
                            <span className="backup-restore-title">{x.title}</span>
                            {x.state === 'never'
                              ? <span className="backup-tag warn">没备份过</span>
                              : x.state === 'pending'
                                ? <span className="backup-tag over">有改动待同步</span>
                                : <span className="backup-tag new">已同步</span>}
                            <span className="backup-restore-meta">
                              {x.syncedAt ? `同步于 ${when(x.syncedAt)}` : '—'}
                            </span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="settings-hint backup-note">
                关掉一个项目是<b>停止继续备份</b>，不是删掉已有备份 —— 之前传上去的还在桶里，
                恢复那一页照旧能看到、能捞回来。
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
                {!!merging.length && (
                  <span className="settings-hint">其中 {merging.length} 条会和本地合并</span>
                )}
              </div>

              {err && <div className="settings-warn backup-note" style={{ whiteSpace: 'pre-wrap' }}>{err}</div>}

              {entries && !entries.length && !err && (
                <div className="settings-hint backup-note">桶里还没有备份 —— 先在「同步」那个 tab 点一次「立即同步」。</div>
              )}

              {!!groups.length && (
                <div className="backup-restore-list">
                  {groups.map(([name, rows]) => {
                    const shut = collapsed.has(name);
                    return (
                      <div key={name} className="backup-group">
                        {/*
                          组头只做两件事：说清这是哪一摊、能收起来。
                          原来这里还有一颗「选整组」——「选整组那个按钮是干毛线，删掉吧」：
                          恢复整个项目不是常见动作（你通常是在找某一条），而那颗按钮占的位置
                          刚好在"要不要点它"最容易犹豫的地方。要多选，逐行勾就够了。
                        */}
                        <div className="backup-group-head">
                          <button className="backup-group-toggle" onClick={() => setCollapsed((prev) => {
                            const next = new Set(prev);
                            if (next.has(name)) next.delete(name); else next.add(name);
                            return next;
                          })}>{shut ? '▸' : '▾'} {name}</button>
                          <span className="backup-restore-meta">{rows.length} 条</span>
                        </div>
                        {!shut && rows.map((e) => (
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
                            {e.attached
                              ? <span className="backup-tag warn">正连着</span>
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
