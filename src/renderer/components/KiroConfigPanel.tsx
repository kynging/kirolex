import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../hooks/useLang';
import { formatJsonOnOpen, formatJsonText, jsonErrorAt } from '../jsonText.ts';
import { JsonCodeEditor } from './JsonCodeEditor';
import { engineCliName } from '../engineLabel';

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
  /** `instructions`：引擎实际会读的全部指令文件（CLAUDE.md / AGENTS.md tab，main `instructionFiles.ts`） */
  kind: 'single' | 'list' | 'instructions';
  file?: string;
  json?: boolean;
  readOnly?: boolean;
  creatable?: boolean;
  ext?: string;
  hint: string;
  /** 哪个引擎的配置（main `CategorySpec.engine`，不写 = kiro） */
  engine?: 'kiro' | 'claude' | 'codex';
}

/** `label` / `readOnly`：插件带的条目（Claude Code）—— 显示「插件 · 名字」，只读。 */
interface Entry {
  name: string; size: number; label?: string; readOnly?: boolean;
  /* 指令文件 tab 才有：分类、在不在、标准位置可新建、被谁引用、上层目录、被同目录的 override 盖住 */
  kind?: 'user' | 'project' | 'local' | 'subdir' | 'import';
  exists?: boolean; creatable?: boolean; importedBy?: string; ancestor?: boolean; shadowedBy?: string;
  /** 只有空白（引擎不读）；Codex 的备用文件名 */
  empty?: boolean; fallback?: boolean;
}

/** 指令文件的分类标签 */
const INSTRUCTION_KIND_LABEL: Record<NonNullable<Entry['kind']>, string> = {
  user: 'User level', project: 'Project level', local: 'Local', subdir: 'Subdirectory', import: 'Import',
};

/** 路径的最后一段（两种分隔符都认） */
const baseOf = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

const api = () => (window as any).kiroApi;

/** JSON 校验：给出行号，和 Agents tab 那边的体验一致。 */
function jsonError(text: string, t: (k: string, v?: Record<string, string | number>) => string): string | null {
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return t('Must be a JSON object');
    return null;
  } catch (e: any) {
    const at = jsonErrorAt(text);
    if (at) return `${t('Line {line}, column {column}', { line: at.line, column: at.column })}: ${at.message}`;
    return String(e?.message || e);
  }
}

export const KiroConfigPanel: React.FC<{
  sessionId?: string;
  category: KiroConfigCategory;
  onClose: () => void;
  /** 指令文件 tab 顶上那行说明里「KiroLex 记忆」的链接 */
  onOpenMemory?: () => void;
}> = ({ sessionId, category, onClose, onOpenMemory }) => {
  const instructions = category.kind === 'instructions';
  const t = useT();
  const [where, setWhere] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [path, setPath] = useState('');
  const [content, setContent] = useState('');
  const [initial, setInitial] = useState('');
  const [exists, setExists] = useState(true);
  /* 一开始就是"读取中"：远程那边一次 ssh 要好几秒，在这之前显示一个空编辑器 + 「✓ Valid JSON」
     看起来就是「什么都拿不到」 */
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);
  const [newName, setNewName] = useState<string | null>(null);

  const open = useCallback(async (name?: string) => {
    setLoading(true); setStatus(null);
    try {
      const r = await api().kiroConfigRead(sessionId, category.id, name);
      if (!r?.ok) { setStatus({ text: r?.error || t('Could not read'), ok: false }); return; }
      if (r.where) setWhere(r.where);
      /* JSON 打开就展开成 2 空格缩进（不合法的原样显示）；initial 也用展开后的，光打开不算改动 */
      const text = category.json ? formatJsonOnOpen(r.content || '') : (r.content || '');
      setSelected(name); setPath(r.path || ''); setContent(text); setInitial(text);
      setExists(r.exists !== false);
    } finally { setLoading(false); }
  }, [sessionId, category.id, category.json, t]);

  const refresh = useCallback(async (pick?: string) => {
    setListError(null);
    /* 单文件的 tab 不用先列：直接读那一个（远程会话省一次 ssh） */
    if (category.kind === 'single') {
      if (category.file) setEntries([{ name: category.file, size: 0 }]);
      await open(undefined);
      return;
    }
    setLoading(true);
    const r = await api().kiroConfigList(sessionId, category.id).finally(() => setLoading(false));
    setWhere(r?.where || '');
    if (!r?.ok) { setListError(r?.error || t('Could not list')); setEntries([]); return; }
    const list: Entry[] = r.entries || [];
    setEntries(list);
    /* 打开刚建的那个，或者第一个（指令文件 tab：第一个已存在的） */
    const first = instructions ? (list.find((e) => e.exists) || list[0]) : list[0];
    if (pick) void open(pick);
    else if (first) void open(first.name);
    else { setSelected(undefined); setContent(''); setInitial(''); setPath(''); }
  }, [sessionId, category.id, category.kind, instructions, open, t]);

  /* 换 tab 就是换一个组件实例（key=category.id），所以这里只在挂载时拉一次 */
  useEffect(() => { void refresh(); }, [refresh]);

  const invalid = useMemo(
    () => (category.json && content.trim() ? jsonError(content, t) : null),
    [category.json, content, t],
  );
  /** 语法错的位置（行号栏标红那一行）；合法但不是对象时没有位置 */
  const syntaxAt = useMemo(() => (invalid ? jsonErrorAt(content) : null), [invalid, content]);
  const dirty = content !== initial;
  const selectedEntry = entries.find((e) => e.name === selected);
  const canEdit = !category.readOnly && !selectedEntry?.readOnly && (category.kind === 'single' || !!selected);

  const save = useCallback(async () => {
    if (!canEdit || invalid || saving || (!dirty && exists)) return;
    setSaving(true); setStatus(null);
    try {
      /* JSON 按格式化后的样子写盘（只动空白，不改语义） */
      const text = category.json ? (formatJsonText(content).text ?? content) : content;
      const r = await api().kiroConfigWrite(sessionId, category.id, selected, text);
      if (!r?.ok) { setStatus({ text: r?.error || t('Not saved'), ok: false }); return; }
      setContent(text); setInitial(text); setExists(true); setPath(r.path || path);
      setStatus({ text: where ? t('Saved ({where})', { where }) : t('Saved'), ok: true });
      /* 指令文件 tab 也重列：「未创建」变成已存在，新写的 @引用 也要出来 */
      if (category.kind !== 'single') void api().kiroConfigList(sessionId, category.id).then((x: any) => x?.ok && setEntries(x.entries || []));
    } finally { setSaving(false); }
  }, [canEdit, invalid, saving, dirty, exists, sessionId, category.id, category.kind, category.json, selected, content, path, where, t]);

  const create = useCallback(async () => {
    let n = String(newName || '').trim();
    if (!n) return;
    if (category.ext && !n.toLowerCase().endsWith(category.ext)) n += category.ext;
    if (entries.some((e) => e.name === n)) { setStatus({ text: t('{name} already exists', { name: n }), ok: false }); return; }
    const r = await api().kiroConfigWrite(sessionId, category.id, n, `# ${n.replace(/\.[^.]+$/, '')}\n\n`);
    if (!r?.ok) { setStatus({ text: r?.error || t('Could not create'), ok: false }); return; }
    setNewName(null);
    await refresh(n);
  }, [newName, category.ext, category.id, entries, sessionId, refresh, t]);

  /** 「未创建」的标准位置一键新建：写一个只有标题的文件，再重列并打开它 */
  const createInstruction = useCallback(async (name: string) => {
    const r = await api().kiroConfigWrite(sessionId, category.id, name, `# ${baseOf(name).replace(/\.[^.]+$/, '')}\n\n`);
    if (!r?.ok) { setStatus({ text: r?.error || t('Could not create'), ok: false }); return; }
    await refresh(name);
  }, [sessionId, category.id, refresh, t]);

  const format = () => {
    const r = formatJsonText(content);
    if (r.ok) setContent(r.text!); /* 有错就不动 */
  };
  const keyDown = (ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); void save(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); onClose(); }
  };

  return (
    <>
      <div className="agent-config-editor-workspace kiro-config-workspace">
        <aside className="agent-config-agent-list" aria-label={category.label}>
          <div className="agent-config-group-head">
            <span title={t('This is the copy the {engine} on this machine reads', { engine: engineCliName(category.engine) })}>{where || '…'}</span>
            {category.kind === 'list' && <span>{entries.length}</span>}
          </div>
          {listError && <div className="agent-config-readonly-note"><span>{listError}</span></div>}
          {instructions && (
            <div className="kiro-config-instr-note">
              {t('These are long-term instructions the engine reads itself; KiroLex memory (Settings → Memory) is injected separately on every turn, and both take effect.')}
              {onOpenMemory && <> <button className="kiro-config-link" onClick={onOpenMemory}>{t('Open KiroLex memory')}</button></>}
            </div>
          )}
          {instructions && entries.map((e) => (
            <div
              key={e.name}
              className={`agent-config-row kiro-config-instr-row ${selected === e.name ? 'active' : ''} ${e.exists ? '' : 'missing'}`}
              role="button"
              tabIndex={0}
              onClick={() => !loading && void open(e.name)}
              onKeyDown={(ev) => { if (ev.key === 'Enter' && !loading) void open(e.name); }}
              title={e.name}
            >
              <span className="kiro-config-instr-head">
                <span className="agent-config-row-name">{e.label || baseOf(e.name)}</span>
                {e.kind && <span className={`kiro-config-instr-kind ${e.kind}`}>{t(INSTRUCTION_KIND_LABEL[e.kind])}</span>}
                {selected === e.name && dirty && <span className="agent-config-row-dirty" title={t('Unsaved changes')} />}
                <span className="kiro-config-row-size">{e.exists ? (e.size < 1024 ? `${e.size} B` : `${(e.size / 1024).toFixed(1)} KB`) : ''}</span>
              </span>
              <span className="kiro-config-instr-path">{e.name}</span>
              {e.ancestor && <span className="kiro-config-instr-sub">{t('Parent folder')}</span>}
              {e.importedBy && <span className="kiro-config-instr-sub">{t('Imported by {name}', { name: baseOf(e.importedBy) })}</span>}
              {e.shadowedBy && <span className="kiro-config-instr-sub">{t('Not read: {name} in the same folder takes precedence', { name: baseOf(e.shadowedBy) })}</span>}
              {e.fallback && <span className="kiro-config-instr-sub">{t('Fallback file name (project_doc_fallback_filenames)')}</span>}
              {e.empty && <span className="kiro-config-instr-sub">{t('Empty file: not read')}</span>}
              {!e.exists && (
                <span className="kiro-config-instr-sub">
                  {e.creatable ? t('Not created') : t('Not found')}
                  {e.creatable && (
                    <button
                      className="kiro-config-link"
                      onClick={(ev) => { ev.stopPropagation(); void createInstruction(e.name); }}
                      disabled={loading}
                    >{t('Create')}</button>
                  )}
                </span>
              )}
            </div>
          ))}
          {!instructions && entries.map((e) => {
            /* 只显示文件名；所在子目录放成灰色小字 —— 否则 steering 那一排全是同一个前缀，被截得只剩前缀 */
            const slash = e.name.lastIndexOf('/');
            const dir = slash >= 0 ? e.name.slice(0, slash) : '';
            const base = slash >= 0 ? e.name.slice(slash + 1) : e.name;
            const shown = e.label || (/skills$/.test(category.id) ? dir || base : base);
            return (
              <button
                key={e.name}
                className={`agent-config-row ${(category.kind === 'single' || selected === e.name) ? 'active' : ''} ${category.readOnly || e.readOnly ? 'readonly' : ''}`}
                onClick={() => category.kind === 'list' && void open(e.name)}
                disabled={loading}
                title={e.name}
              >
                <span className="agent-config-row-name">
                  {shown}
                  {dir && !e.label && !/skills$/.test(category.id) && <span className="kiro-config-row-dir"> {dir}</span>}
                </span>
                {selected === e.name && dirty && <span className="agent-config-row-dirty" title={t('Unsaved changes')} />}
                <span className="kiro-config-row-size">{category.kind === 'single' && !e.size ? '' : e.size < 0 ? t('None yet') : e.size < 1024 ? `${e.size} B` : `${(e.size / 1024).toFixed(1)} KB`}</span>
              </button>
            );
          })}
          {category.creatable && (newName === null ? (
            <button className="agent-config-row kiro-config-new" onClick={() => setNewName('')}>{t('+ New')}</button>
          ) : (
            <div className="kiro-config-new-row">
              <input
                className="settings-input"
                autoFocus
                placeholder={category.ext ? t('Name ({ext} optional)', { ext: category.ext }) : t('File name')}
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
            <strong>{category.kind === 'single' ? category.file : (selectedEntry?.label || (selected && instructions ? baseOf(selected) : selected) || t('(pick one)'))}</strong>
            {selectedEntry?.readOnly && <span className="kiro-config-ro-tag">{t('Plugin · read-only')}</span>}
            {path && <span className="agent-config-editor-path" title={path}>{path}</span>}
          </div>
          <div className="kiro-config-hint">{category.hint}{!exists && ` · ${t('This file does not exist yet; saving will create it.')}`}</div>
          {loading ? (
            <div className="agent-config-editor-message">{t('Loading…')}</div>
          ) : category.kind !== 'single' && !selected ? (
            <div className="agent-config-editor-message"><span>{t('No {label} here yet.', { label: category.label })}{category.creatable ? t(' Click "+ New" on the left.') : ''}</span></div>
          ) : (
            <>
              <div className={`agent-config-editor-shell ${invalid ? 'invalid' : 'valid'}`}>
                {category.json ? (
                  <JsonCodeEditor
                    value={content}
                    readOnly={!canEdit}
                    errorLine={syntaxAt?.line}
                    onChange={setContent}
                    onKeyDown={keyDown}
                    ariaLabel={category.file || selected}
                  />
                ) : (
                  <textarea
                    className="agent-config-editor-textarea kiro-config-prose"
                    value={content}
                    readOnly={!canEdit}
                    onChange={(ev) => setContent(ev.target.value)}
                    onKeyDown={keyDown}
                    spellCheck={false}
                  />
                )}
              </div>
              {category.json && (invalid
                ? <div className="agent-config-validation invalid"><span>{invalid}</span></div>
                : <div className="agent-config-validation valid">{t('✓ Valid JSON')}</div>)}
            </>
          )}
        </div>
      </div>
      <div className="agent-config-editor-actions">
        {status && <span className={status.ok ? 'saved' : 'error'}>{status.text}</span>}
        {category.json && (
          <button className="btn deny" onClick={format} disabled={!canEdit || !!invalid}>{t('Format JSON')}</button>
        )}
        <button className="btn deny" onClick={onClose}>{t('Close')}</button>
        {!category.readOnly && (
          <button
            className="btn allow"
            onClick={() => void save()}
            disabled={!canEdit || !!invalid || saving || (!dirty && exists)}
          >
            {saving ? t('Saving…') : t('Save')}
          </button>
        )}
      </div>
    </>
  );
};
