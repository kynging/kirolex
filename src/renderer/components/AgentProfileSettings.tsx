import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../hooks/useLang';
import { REMOTE_TARGETS_CHANGED } from '../hooks/useRemoteTargets.ts';
import { formatJsonOnOpen, formatJsonText, jsonErrorAt } from '../jsonText.ts';
import { areaLabel, confirmText, diffText, type DiffItemView, type PlanView } from '../agentProfileView.ts';
import { JsonCodeEditor } from './JsonCodeEditor';
import { ConfirmDialog, type ConfirmRequest } from './ConfirmDialog';
import { EngineIcon } from './Icons';

/**
 * **设置 → 🖥 机器 →「AI 工具配置」** ——「统一定义远程机器上 Claude Code 的配置并同步过去」。
 *
 * 上半部分编辑本机 `~/.kirolex/agent-profiles/<claude|codex>/profile.json`（同组合页那个格式化编辑器；
 * JSON 有错不保存），下半部分每台远程机器一行：「查看差异」（只读，ssh 跑一次探测）和「同步到这台机器」
 * （先列出要改什么、确认之后才做；备份 → 装版本 → 写入 → 重新比较）。
 *
 * 本机专用的 MCP、凭证永远不同步 —— 远程会话的 MCP 靠 KiroLex 的本机转发（上面那块「转发本机 MCP」）。
 */

const api = () => (window as any).kiroApi;

type Engine = 'claude' | 'codex';
interface FileState { path: string; exists: boolean; text: string; error?: string; template: string }
interface ReadResult { root: string; claude: FileState; codex: FileState; rules: Array<{ name: string; bytes: number }>; conflicts: string[] }
interface Machine { id: string; label: string; sshHost: string }
interface MachineState {
  busy?: 'diff' | 'plan' | 'sync';
  items?: DiffItemView[];
  at?: number;
  error?: string;
  secretEnvKeys?: string[];
  log?: string;
  result?: { ok: boolean; text: string };
}

export const AgentProfileSettings: React.FC = () => {
  const t = useT();
  const [engine, setEngine] = useState<Engine>('claude');
  const [data, setData] = useState<ReadResult | null>(null);
  const [content, setContent] = useState('');
  const [initial, setInitial] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [states, setStates] = useState<Record<string, MachineState>>({});
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const logRefs = useRef<Record<string, HTMLPreElement | null>>({});

  const patch = useCallback((id: string, p: Partial<MachineState>) => {
    setStates((prev) => ({ ...prev, [id]: { ...prev[id], ...p } }));
  }, []);

  /*
    编辑框是基于磁盘上哪一份打开的（原文；null = 当时文件不存在）。保存时交给主进程比对：
    磁盘上已经被 S3 同步换成别的电脑的新版本 → 不写，免得用旧底子改出来的内容盖掉它。
  */
  const baseRef = useRef<Record<Engine, string | null>>({ claude: null, codex: null });
  /* 外部更新回调里要读最新的「当前是哪页、有没有没存的改动」 */
  const engineRef = useRef<Engine>(engine);
  engineRef.current = engine;
  const dirtyRef = useRef(false);

  /** 把编辑框换成磁盘上这一页的内容（基准也跟着换）。 */
  const showFile = useCallback((r: ReadResult, e: Engine) => {
    const f = r[e];
    const text = f.exists ? formatJsonOnOpen(f.text) : '';
    baseRef.current[e] = f.exists ? f.text : null;
    setContent(text); setInitial(text);
  }, []);

  const load = useCallback(async (keepEngine?: Engine) => {
    const r: ReadResult | undefined = await api()?.agentProfileRead?.();
    if (!r) return;
    setData(r);
    showFile(r, keepEngine || engine);
  }, [engine, showFile]);

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    const loadMachines = () => {
      void api()?.remoteTargets?.().then((r: any) => {
        setMachines(Array.isArray(r?.targets) ? r.targets.map((x: any) => ({ id: x.id, label: x.label, sshHost: x.sshHost })) : []);
      }).catch(() => {});
    };
    loadMachines();
    window.addEventListener(REMOTE_TARGETS_CHANGED, loadMachines);
    const offOut = api()?.onAgentProfileSyncOutput?.((d: { remoteId: string; chunk: string }) => {
      setStates((prev) => ({ ...prev, [d.remoteId]: { ...prev[d.remoteId], log: `${prev[d.remoteId]?.log || ''}${d.chunk}`.slice(-20000) } }));
    });
    /*
      S3 同步从别的电脑拉回了新配置 / 留了冲突副本：重读。没有没存的改动 → 编辑框直接换成新内容；
      有 → 不动你的改动，但明说文件已经变了（这时保存会被拒，见 baseRef），点「放弃修改」载入新版本。
    */
    const offChanged = api()?.onAgentProfileChanged?.(() => {
      void api()?.agentProfileRead?.().then((r: ReadResult) => {
        if (!r) return;
        const e = engineRef.current;
        setData(r);
        const before = baseRef.current[e];
        const now = r[e].exists ? r[e].text : null;
        if (now === before) return;
        if (!dirtyRef.current) {
          showFile(r, e);
          setStatus({ ok: true, text: t('This file was updated by S3 sync from another computer; the editor now shows the new version.') });
        } else {
          setStatus({ ok: false, text: t('This file was updated by S3 sync from another computer while you had unsaved changes. Saving is blocked so the new version is not overwritten; click Discard changes to load it.') });
        }
      });
    });
    return () => {
      window.removeEventListener(REMOTE_TARGETS_CHANGED, loadMachines);
      try { offOut?.(); offChanged?.(); } catch { /* 卸载时 preload 可能已经没了 */ }
    };
  }, []);

  useEffect(() => {
    for (const el of Object.values(logRefs.current)) if (el) el.scrollTop = el.scrollHeight;
  }, [states]);

  const file = data?.[engine];
  const empty = !!file && !file.exists && !content.trim();
  const at = empty ? null : jsonErrorAt(content);
  const invalid = at ? `${t('Line {line}, column {column}', { line: at.line, column: at.column })}: ${at.message}` : null;
  const dirty = content !== initial;
  dirtyRef.current = dirty;

  const switchEngine = (e: Engine) => {
    if (e === engine) return;
    setEngine(e);
    setStatus(null);
    if (data) showFile(data, e);
  };

  const save = async () => {
    if (saving || empty) return;
    if (invalid) { setStatus({ ok: false, text: t('Not saved: {error}', { error: invalid }) }); return; }
    setSaving(true); setStatus(null);
    try {
      const text = formatJsonText(content).text ?? content;
      const r = await api().agentProfileSave(engine, text, baseRef.current[engine]);
      if (r?.ok) {
        baseRef.current[engine] = text;
        setContent(text); setInitial(text);
        setStatus({ ok: true, text: t('Saved. Use "Check differences" below to compare each machine with it.') });
        const fresh: ReadResult | undefined = await api()?.agentProfileRead?.();
        if (fresh) setData(fresh);
      } else {
        setStatus({ ok: false, text: t('Not saved: {error}', { error: r?.error || t('Validation failed') }) });
      }
    } catch (err: any) {
      setStatus({ ok: false, text: t('Not saved: {error}', { error: String(err?.message || err) }) });
    } finally {
      setSaving(false);
    }
  };

  const diff = async (m: Machine) => {
    patch(m.id, { busy: 'diff', error: undefined, result: undefined });
    const r = await api()?.agentProfileDiff?.(m.id).catch((err: any) => ({ ok: false, error: String(err?.message || err) }));
    if (r?.ok) patch(m.id, { busy: undefined, items: r.items, at: r.at, secretEnvKeys: r.secretEnvKeys, error: undefined });
    else patch(m.id, { busy: undefined, error: r?.error || t('Failed') });
  };

  const runSync = async (m: Machine) => {
    patch(m.id, { busy: 'sync', log: '', result: undefined, error: undefined });
    const r = await api()?.agentProfileSync?.(m.id).catch((err: any) => ({ ok: false, error: String(err?.message || err) }));
    const failed = (r?.steps || []).filter((s: any) => !s.ok).map((s: any) => `${s.step}: ${s.detail}`);
    const after: DiffItemView[] | null = Array.isArray(r?.after) ? r.after : null;
    patch(m.id, {
      busy: undefined,
      ...(after ? { items: after, at: Date.now() } : {}),
      result: r?.ok
        ? { ok: true, text: after && !after.length ? t('Synced. Compared again: no differences left.') : t('Synced. Compared again: {n} differences left (listed above).', { n: after?.length ?? '?' }) }
        : { ok: false, text: [r?.error, ...failed].filter(Boolean).join('\n') || t('Sync failed') },
    });
  };

  const askSync = async (m: Machine) => {
    patch(m.id, { busy: 'plan', error: undefined, result: undefined });
    const r = await api()?.agentProfilePlan?.(m.id).catch((err: any) => ({ ok: false, error: String(err?.message || err) }));
    if (!r?.ok) { patch(m.id, { busy: undefined, error: r?.error || t('Failed') }); return; }
    const plan: PlanView = r.plan;
    patch(m.id, { busy: undefined, items: plan.items, at: Date.now() });
    if (!plan.hasWork) { patch(m.id, { result: { ok: true, text: t('Already the same as the config; nothing to sync.') } }); return; }
    setConfirm({
      title: t('Sync AI tool config to {host}', { host: m.label || m.sshHost }),
      message: confirmText(plan, m.sshHost, t),
      confirmLabel: t('Sync'),
      onConfirm: () => { void runSync(m); },
    });
  };

  const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

  return (
    <div className="settings-item settings-item-wide agent-profile-settings">
      <label className="settings-label">{t('AI tool config (remote machines)')}</label>
      <p className="settings-hint" style={{ marginTop: 0 }}>
        {t('Define the Claude Code / Codex config for remote machines once, then sync it to each machine: versions, settings.json, plugins and rules. Local-only MCP servers and credentials are never synced (remote sessions reach MCP through KiroLex forwarding from this computer). With S3 sync on, this config is also backed up and shared with your other computers.')}
      </p>
      <div className="agent-profile-tabs" role="tablist">
        {(['claude', 'codex'] as const).map((e) => (
          <button key={e} role="tab" aria-selected={engine === e} className={`remote-btn${engine === e ? ' remote-btn-primary' : ''}`} onClick={() => switchEngine(e)}>
            <EngineIcon engine={e} size={14} className="agent-profile-tab-icon" />
            {e === 'claude' ? 'Claude Code' : 'Codex'}
          </button>
        ))}
        {file?.path && <span className="agent-config-editor-path" title={file.path}>{file.path}</span>}
      </div>
      {!data ? (
        <div className="settings-hint">{t('Loading…')}</div>
      ) : empty ? (
        <div className="agent-config-editor-message">
          <div>{t('No {file} yet.', { file: `${engine}/profile.json` })}</div>
          <button className="remote-btn remote-btn-primary" onClick={() => setContent(formatJsonOnOpen(file!.template))}>{t('Insert template')}</button>
        </div>
      ) : (
        <>
          <div className={`agent-config-editor-shell agent-profile-editor ${invalid ? 'invalid' : 'valid'}`}>
            <JsonCodeEditor
              value={content}
              errorLine={at?.line ?? null}
              onChange={setContent}
              onKeyDown={(ev) => {
                if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); void save(); }
              }}
              ariaLabel={`${engine}/profile.json`}
            />
          </div>
          {invalid
            ? <div className="agent-config-validation invalid"><span>{invalid}</span></div>
            : <div className="agent-config-validation valid">{t('✓ Valid JSON (checked again on save)')}</div>}
        </>
      )}
      {file?.error && !dirty && <div className="agent-config-validation invalid">{t('The file on disk has errors: {error}', { error: file.error })}</div>}
      <div className="remote-row-actions agent-profile-actions">
        {status && <span className={`settings-hint ${status.ok ? 'agent-profile-ok' : 'agent-profile-bad'}`}>{status.text}</span>}
        {!file?.exists && !empty && !status && <span className="settings-hint agent-profile-bad">{t('Not saved yet: the file does not exist, the text above is only a template. Click Save to create it.')}</span>}
        <button className="remote-btn" onClick={() => void api()?.agentProfileOpenDir?.()}>{t('Open folder')}</button>
        <button className="remote-btn" disabled={empty || !!invalid || saving} onClick={() => { const r = formatJsonText(content); if (r.ok) setContent(r.text!); }}>{t('Format JSON')}</button>
        <button className="remote-btn" disabled={!dirty || saving} onClick={() => { if (data) showFile(data, engine); else setContent(initial); setStatus(null); }}>{t('Discard changes')}</button>
        <button className="remote-btn remote-btn-primary" disabled={empty || !!invalid || saving || (!dirty && !!file?.exists)} onClick={() => void save()}>
          {saving ? t('Saving…') : t('Save')}
        </button>
      </div>
      {engine === 'claude' && data && (
        <p className="settings-hint">
          {t('Rules (claude/rules/*.md, written to ~/.claude/rules/ on each machine):')}{' '}
          {data.rules.length ? data.rules.map((r) => `${r.name} (${fmtBytes(r.bytes)})`).join(', ') : t('none yet')}
        </p>
      )}
      {!!data?.conflicts.length && (
        <p className="settings-hint agent-profile-bad">
          {t('S3 sync found this config changed on two computers; neither side was overwritten. The other computer\'s version was saved as: {files}', { files: data.conflicts.join(', ') })}
        </p>
      )}

      <label className="settings-label" style={{ marginTop: 12 }}>{t('Differences from the config')}</label>
      {!machines.length && <p className="settings-hint">{t('No remote machines yet. Add one above.')}</p>}
      {machines.map((m) => {
        const st = states[m.id] || {};
        return (
          <div key={m.id} className="agent-profile-machine">
            <div className="agent-profile-machine-head">
              <strong>🌐 {m.label}</strong>
              <span className="settings-hint">{m.sshHost}</span>
              <span style={{ flex: 1 }} />
              <button className="remote-btn" disabled={!!st.busy} onClick={() => void diff(m)}>
                {st.busy === 'diff' ? t('Checking…') : t('Check differences')}
              </button>
              <button className="remote-btn remote-btn-primary" disabled={!!st.busy} onClick={() => void askSync(m)}>
                {st.busy === 'sync' ? t('Syncing…') : st.busy === 'plan' ? t('Checking…') : t('Sync to this machine')}
              </button>
            </div>
            {st.error && <p className="settings-hint agent-profile-bad">{st.error}</p>}
            {st.items && (st.items.length === 0
              ? <p className="settings-hint agent-profile-ok">{t('✓ Same as the config')}</p>
              : (
                <ul className="agent-profile-diff">
                  {st.items.map((it, i) => (
                    <li key={`${it.area}:${it.key}:${i}`} className={it.area === 'warning' || it.status === 'error' ? 'warn' : ''}>
                      <span className="agent-profile-area">{areaLabel(it.area, t)}</span>
                      <span className="agent-profile-text">{diffText(it, t)}</span>
                    </li>
                  ))}
                </ul>
              ))}
            {!!st.secretEnvKeys?.length && (
              <p className="settings-hint">{t('Credential env on that machine (names only, kept as they are): {keys}', { keys: st.secretEnvKeys.join(', ') })}</p>
            )}
            {st.log && <pre ref={(el) => { logRefs.current[m.id] = el; }} className="remote-log">{st.log}</pre>}
            {st.result && <p className={`settings-hint ${st.result.ok ? 'agent-profile-ok' : 'agent-profile-bad'}`} style={{ whiteSpace: 'pre-wrap' }}>{st.result.ok ? '✓ ' : '✗ '}{st.result.text}</p>}
          </div>
        );
      })}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
};
