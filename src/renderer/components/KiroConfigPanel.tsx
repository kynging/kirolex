import React, { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * **机器人按钮里 Agent 之外的那几个 tab** —— 每个 tab 都是"文件列表 + 编辑器"，
 * 后端见 `src/main/kiroConfig.ts`。
 *
 * 跟着会话所在的机器走：远程会话改的是那台机器上的 `~/.kiro`（顶上会写出来是哪台），
 * 因为它的执行器读的就是那一份。
 *
 * 关闭 = 丢弃未保存的改动（和 Agents 那个 tab 同一条规则）：草稿只在这个组件的 state 里，
 * 卸载就没了，不会碰到任何已存的配置。
 */

export interface KiroConfigCategory {
  id: string;
  label: string;
  kind: 'single' | 'list';
  file?: string;
  json?: boolean;
  readOnly?: boolean;
  creatable?: boolean;
  ext?: string;
  hint: string;
}

interface Entry { name: string; size: number }

const api = () => (window as any).kiroApi;

/** JSON 校验：给出行号，和 Agents tab 那边的体验一致。 */
function jsonError(text: string): string | null {
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return '必须是一个 JSON 对象';
    return null;
  } catch (e: any) {
    const msg = String(e?.message || e);
    const pos = /position (\d+)/.exec(msg);
    if (pos) {
      const line = text.slice(0, Number(pos[1])).split('\n').length;
      return `第 ${line} 行：${msg}`;
    }
    return msg;
  }
}

export const KiroConfigPanel: React.FC<{
  sessionId?: string;
  category: KiroConfigCategory;
  onClose: () => void;
}> = ({ sessionId, category, onClose }) => {
  const [where, setWhere] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [path, setPath] = useState('');
  const [content, setContent] = useState('');
  const [initial, setInitial] = useState('');
  const [exists, setExists] = useState(true);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);
  const [newName, setNewName] = useState<string | null>(null);

  const open = useCallback(async (name?: string) => {
    setLoading(true); setStatus(null);
    try {
      const r = await api().kiroConfigRead(sessionId, category.id, name);
      if (!r?.ok) { setStatus({ text: r?.error || '读不到', ok: false }); return; }
      setSelected(name); setPath(r.path || ''); setContent(r.content || ''); setInitial(r.content || '');
      setExists(r.exists !== false);
    } finally { setLoading(false); }
  }, [sessionId, category.id]);

  const refresh = useCallback(async (pick?: string) => {
    setListError(null);
    const r = await api().kiroConfigList(sessionId, category.id);
    setWhere(r?.where || '');
    if (!r?.ok) { setListError(r?.error || '列不出来'); setEntries([]); return; }
    const list: Entry[] = r.entries || [];
    setEntries(list);
    /* single 类直接打开那一个；list 类打开刚建的那个，或者第一个 */
    if (category.kind === 'single') void open(undefined);
    else if (pick) void open(pick);
    else if (list.length) void open(list[0].name);
    else { setSelected(undefined); setContent(''); setInitial(''); setPath(''); }
  }, [sessionId, category.id, category.kind, open]);

  /* 换 tab 就是换一个组件实例（key=category.id），所以这里只在挂载时拉一次 */
  useEffect(() => { void refresh(); }, [refresh]);

  const invalid = useMemo(
    () => (category.json && content.trim() ? jsonError(content) : null),
    [category.json, content],
  );
  const dirty = content !== initial;
  const canEdit = !category.readOnly && (category.kind === 'single' || !!selected);

  const save = useCallback(async () => {
    if (!canEdit || invalid || saving || (!dirty && exists)) return;
    setSaving(true); setStatus(null);
    try {
      const r = await api().kiroConfigWrite(sessionId, category.id, selected, content);
      if (!r?.ok) { setStatus({ text: r?.error || '没存上', ok: false }); return; }
      setInitial(content); setExists(true); setPath(r.path || path);
      setStatus({ text: `已保存${where ? `（${where}）` : ''}`, ok: true });
      if (category.kind === 'list') void api().kiroConfigList(sessionId, category.id).then((x: any) => x?.ok && setEntries(x.entries || []));
    } finally { setSaving(false); }
  }, [canEdit, invalid, saving, dirty, exists, sessionId, category.id, category.kind, selected, content, path, where]);

  const create = useCallback(async () => {
    let n = String(newName || '').trim();
    if (!n) return;
    if (category.ext && !n.toLowerCase().endsWith(category.ext)) n += category.ext;
    if (entries.some((e) => e.name === n)) { setStatus({ text: `${n} 已经有了`, ok: false }); return; }
    const r = await api().kiroConfigWrite(sessionId, category.id, n, `# ${n.replace(/\.[^.]+$/, '')}\n\n`);
    if (!r?.ok) { setStatus({ text: r?.error || '建不了', ok: false }); return; }
    setNewName(null);
    await refresh(n);
  }, [newName, category.ext, category.id, entries, sessionId, refresh]);

  const format = () => {
    try { setContent(`${JSON.stringify(JSON.parse(content), null, 2)}\n`); } catch { /* 有错就不动 */ }
  };

  return (
    <>
      <div className="agent-config-editor-workspace kiro-config-workspace">
        <aside className="agent-config-agent-list" aria-label={category.label}>
          <div className="agent-config-group-head">
            <span title="这台机器上的 kiro-cli 读的就是这一份">{where || '…'}</span>
            {category.kind === 'list' && <span>{entries.length}</span>}
          </div>
          {listError && <div className="agent-config-readonly-note"><span>{listError}</span></div>}
          {entries.map((e) => {
            /* 只显示文件名；所在子目录放成灰色小字 —— 否则 steering 那一排全是同一个前缀，被截得只剩前缀 */
            const slash = e.name.lastIndexOf('/');
            const dir = slash >= 0 ? e.name.slice(0, slash) : '';
            const base = slash >= 0 ? e.name.slice(slash + 1) : e.name;
            const shown = category.id === 'skills' ? dir || base : base;
            return (
              <button
                key={e.name}
                className={`agent-config-row ${(category.kind === 'single' || selected === e.name) ? 'active' : ''} ${category.readOnly ? 'readonly' : ''}`}
                onClick={() => category.kind === 'list' && void open(e.name)}
                disabled={loading}
                title={e.name}
              >
                <span className="agent-config-row-name">
                  {shown}
                  {dir && category.id !== 'skills' && <span className="kiro-config-row-dir"> {dir}</span>}
                </span>
                {selected === e.name && dirty && <span className="agent-config-row-dirty" title="有未保存的改动" />}
                <span className="kiro-config-row-size">{e.size < 0 ? '还没有' : e.size < 1024 ? `${e.size} B` : `${(e.size / 1024).toFixed(1)} KB`}</span>
              </button>
            );
          })}
          {category.creatable && (newName === null ? (
            <button className="agent-config-row kiro-config-new" onClick={() => setNewName('')}>＋ 新建</button>
          ) : (
            <div className="kiro-config-new-row">
              <input
                className="settings-input"
                autoFocus
                placeholder={`名字${category.ext ? `（${category.ext} 可省）` : ''}`}
                value={newName}
                onChange={(ev) => setNewName(ev.target.value)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter') { ev.preventDefault(); void create(); }
                  else if (ev.key === 'Escape') { ev.preventDefault(); setNewName(null); }
                }}
              />
            </div>
          ))}
        </aside>

        <div className="agent-config-editor-body">
          <div className="agent-config-editor-selection">
            <strong>{category.kind === 'single' ? category.file : (selected || '（选一个）')}</strong>
            {path && <span className="agent-config-editor-path" title={path}>{path}</span>}
          </div>
          <div className="kiro-config-hint">{category.hint}{!exists && ' · 这个文件还不存在，保存就会建出来。'}</div>
          {loading ? (
            <div className="agent-config-editor-message">Loading…</div>
          ) : category.kind === 'list' && !selected ? (
            <div className="agent-config-editor-message"><span>这里还没有{category.label}。{category.creatable ? '点左边「＋ 新建」。' : ''}</span></div>
          ) : (
            <>
              <div className={`agent-config-editor-shell ${invalid ? 'invalid' : 'valid'}`}>
                <textarea
                  className={`agent-config-editor-textarea${category.json ? '' : ' kiro-config-prose'}`}
                  value={content}
                  readOnly={!canEdit}
                  onChange={(ev) => setContent(ev.target.value)}
                  onKeyDown={(ev) => {
                    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); void save(); }
                    else if (ev.key === 'Escape') { ev.preventDefault(); onClose(); }
                  }}
                  spellCheck={false}
                />
              </div>
              {category.json && (invalid
                ? <div className="agent-config-validation invalid"><span>{invalid}</span></div>
                : <div className="agent-config-validation valid">✓ Valid JSON</div>)}
            </>
          )}
        </div>
      </div>
      <div className="agent-config-editor-actions">
        {status && <span className={status.ok ? 'saved' : 'error'}>{status.text}</span>}
        {category.json && (
          <button className="btn deny" onClick={format} disabled={!canEdit || !!invalid}>Format JSON</button>
        )}
        <button className="btn deny" onClick={onClose}>Close</button>
        {!category.readOnly && (
          <button
            className="btn allow"
            onClick={() => void save()}
            disabled={!canEdit || !!invalid || saving || (!dirty && exists)}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>
    </>
  );
};
