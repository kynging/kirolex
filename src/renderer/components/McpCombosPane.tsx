import React, { useEffect, useState } from 'react';
import { useT } from '../hooks/useLang';
import { formatJsonOnOpen, formatJsonText, jsonErrorAt } from '../jsonText.ts';
import { JsonCodeEditor } from './JsonCodeEditor';

/**
 * **Claude Code / Codex 面板里的「🧩 组合」那页** ——「不同对话挂不同的 MCP」。
 *
 * 直接编辑 `~/.kirolex/mcp-combos.json`（文本编辑）。这份文件是**本机全局**的，所有会话共用；
 * 每条会话只在左下角的下拉里选用哪个。保存时 main 那边校验（`mcpCombos.ts` 的 `parseMcpCombos`），
 * 校验不过就不写盘，把原因原样显示出来。这里只做一个即时的 JSON 语法提示。
 *
 * 关闭 = 丢弃未保存的改动（和其他 tab 同一条规则）。
 *
 * 文件跟着 S3 同步到别的电脑：编辑框里哪条 stdio MCP 的命令在**这台电脑**上找不到（主进程 `comboLocalAvailability`，
 * 已套上本机的 `perMachine` 覆盖），就标「这台电脑不可用」，给「为这台电脑设置命令 / 在这台电脑上禁用」——
 * 写进那条的 `perMachine["<主机名>"]`（`setMachineOverride`）然后直接保存；别的电脑上的配置不动。
 *
 * 「从本机转发」的 stdio MCP 另有一块「远程会话里在哪跑」：自动（默认：本机有就本机转发，没有就在远端找同名命令）/
 * 总是在远端运行 / 总是本机转发，存成这台电脑的 `perMachine["<主机名>"].runOn`。最近一次远程会话已经把它挪到远端跑的，
 * 标「这台电脑没有，已改在 <远端机器> 上运行」（主进程 `placeComboForwardStdio`）。
 */

type Unavailable = { comboId: string; fileId: string; comboName: string; server: string; command: string; reason: string; overrideKey?: string };
type RunOn = 'auto' | 'remote' | 'local';
type ForwardStdio = { comboId: string; fileId: string; comboName: string; server: string; runOn: RunOn; ranOnRemote?: string };

const api = () => (window as any).kiroApi;

function syntaxError(text: string, t: (k: string, v?: Record<string, string | number>) => string): string | null {
  const at = jsonErrorAt(text);
  return at && `${t('Line {line}, column {column}', { line: at.line, column: at.column })}: ${at.message}`;
}

export const McpCombosPane: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const t = useT();
  const [path, setPath] = useState('');
  const [content, setContent] = useState('');
  const [initial, setInitial] = useState('');
  const [exists, setExists] = useState(true);
  /* 「插入示例」用的样板：文件不存在时**不**直接放进编辑框（样板里有「投研」，看着像已经配好了） */
  const [template, setTemplate] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [machine, setMachine] = useState<{ hostname: string; items: Unavailable[]; forwardStdio: ForwardStdio[] } | null>(null);
  /* 正在填「为这台电脑设置命令」的那条（`fileId\u0000server`）和填的内容 */
  const [editing, setEditing] = useState<{ key: string; command: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void api()?.mcpCombosFile?.().then((r: { path: string; exists: boolean; text: string; template?: string; error?: string }) => {
      if (!alive || !r) return;
      /* 打开就展开成 2 空格缩进（不合法的原样显示，下面标出错位置）；initial 也用展开后的，光打开不算改动 */
      const text = formatJsonOnOpen(r.text);
      setPath(r.path); setExists(r.exists); setContent(r.exists ? text : ''); setInitial(r.exists ? text : '');
      setTemplate(r.template || '');
      if (r.error) setStatus({ ok: false, text: t('The file on disk has errors, so only "General" is used for now: {error}', { error: r.error }) });
    }).catch((err: any) => { if (alive) setStatus({ ok: false, text: String(err?.message || err) }); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  /* 编辑框里的内容是合法 JSON 时（停手 400ms 后）查一次这台电脑上哪些命令找不到 */
  useEffect(() => {
    if (loading || !content.trim() || jsonErrorAt(content)) { setMachine(null); return; }
    let alive = true;
    const timer = setTimeout(() => {
      void api()?.mcpCombosLocalCheck?.(content).then((r: { hostname: string; items: Unavailable[]; forwardStdio?: ForwardStdio[] }) => {
        if (alive && r) setMachine({ hostname: r.hostname, items: Array.isArray(r.items) ? r.items : [], forwardStdio: Array.isArray(r.forwardStdio) ? r.forwardStdio : [] });
      }).catch(() => { /* 查不了就不标 */ });
    }, 400);
    return () => { alive = false; clearTimeout(timer); };
  }, [content, loading]);

  /* 文件不存在、编辑框也还是空的：显示「还没有自定义组合」，不是一个空编辑框（空文本也不是合法 JSON） */
  const empty = !exists && !content.trim();
  const invalid = empty ? null : syntaxError(content, t);
  const errorLine = invalid ? jsonErrorAt(content)?.line : null;
  const dirty = content !== initial;

  const save = async (override?: string) => {
    if (saving || (empty && override === undefined)) return;
    const content0 = override ?? content;
    const invalid = syntaxError(content0, t);
    /* Ctrl+S 绕过了禁用的保存按钮：JSON 有错时也要明说没存，不能什么都不发生 */
    if (invalid) { setStatus({ ok: false, text: t('Not saved: {error}', { error: invalid }) }); return; }
    setSaving(true); setStatus(null);
    try {
      /* 按格式化后的样子写盘（只动空白，不改语义；校验仍在 main 那边） */
      const text = formatJsonText(content0).text ?? content0;
      const r = await api().saveMcpCombos(text);
      if (r?.ok) {
        setContent(text); setInitial(text); setExists(true);
        setStatus({ ok: true, text: t('Saved. Sessions using this MCP profile pick up the new content the next time they reconnect; to apply it now, switch to another MCP profile in the bottom-left and back.') });
      } else {
        setStatus({ ok: false, text: t('Not saved: {error}', { error: r?.error || t('Validation failed') }) });
      }
    } catch (err: any) {
      setStatus({ ok: false, text: t('Not saved: {error}', { error: String(err?.message || err) }) });
    } finally {
      setSaving(false);
    }
  };

  /** 「为这台电脑设置命令 / 在这台电脑上禁用」：写进 perMachine["<主机名>"]，然后直接保存（别的电脑的配置不动） */
  const applyMachineOverride = async (u: { fileId: string; server: string }, override: { command?: string; disabled?: boolean; runOn?: RunOn }) => {
    const next: string | null = await api()?.mcpCombosMachineOverride?.(content, u.fileId, u.server, override);
    if (!next) { setStatus({ ok: false, text: t('Not saved: could not find MCP "{name}" in the editor', { name: u.server }) }); return; }
    setEditing(null);
    setContent(next);
    await save(next);
  };

  return (
    <>
      <div className="agent-config-editor-workspace kiro-config-workspace mcp-combos-workspace">
        <div className="agent-config-editor-body">
          <div className="agent-config-editor-selection">
            <strong>mcp-combos.json</strong>
            <span className="kiro-config-ro-tag">{t('Shared by all sessions; with S3 sync on, also synced to your other computers')}</span>
            {path && <span className="agent-config-editor-path" title={path}>{path}</span>}
          </div>
          <div className="kiro-config-hint">
            {t('A list of MCP profiles: each has id, name, an optional effort (such as high) and mcpServers. HTTP entries use url / headers (optional timeoutSec), stdio entries use command / args / env; disabled and forwardFromLocal are optional. Values in headers and env can reference local environment variables with ')}{'${env:NAME}'}{t('. The built-in "General" (no MCP) does not need to be listed; an MCP profile with id default replaces the built-in "General".')}
          </div>
          {!!machine?.items.length && (
            <div className="mcp-combos-unavailable" role="status">
              <div>{t('⚠️ Not available on this computer ({host}): the command is not found here. This MCP profile file may come from another computer.', { host: machine.hostname })}</div>
              {machine.items.map((u) => {
                const key = `${u.fileId}\u0000${u.server}`;
                const isEditing = editing?.key === key;
                const ranOn = machine.forwardStdio.find((f) => f.comboId === u.comboId && f.server === u.server)?.ranOnRemote;
                return (
                  <div key={key} className="mcp-combos-unavailable-row">
                    {ranOn
                      ? <span className="mcp-combos-unavailable-tag ran-on-remote">{t('Not on this computer; now runs on {host}', { host: ranOn })}</span>
                      : <span className="mcp-combos-unavailable-tag">{t('Not available on this computer')}</span>}
                    <strong>{u.comboName} / {u.server}</strong>
                    <span className="mcp-combos-unavailable-reason">{u.reason}</span>
                    {isEditing ? (
                      <>
                        <input
                          autoFocus
                          value={editing!.command}
                          placeholder={t('Command on this computer, for example C:\\tools\\builder-mcp.exe')}
                          onChange={(e) => setEditing({ key, command: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && editing!.command.trim()) { e.preventDefault(); void applyMachineOverride(u, { command: editing!.command.trim(), disabled: false }); }
                            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null); }
                          }}
                        />
                        <button className="btn allow" disabled={saving || !editing!.command.trim()} onClick={() => void applyMachineOverride(u, { command: editing!.command.trim(), disabled: false })}>{t('Save')}</button>
                        <button className="btn deny" onClick={() => setEditing(null)}>{t('Cancel')}</button>
                      </>
                    ) : (
                      <span className="mcp-combos-unavailable-actions">
                        <button className="btn deny" disabled={saving} onClick={() => setEditing({ key, command: '' })}>{t('Set a command for this computer')}</button>
                        <button className="btn deny" disabled={saving} onClick={() => void applyMachineOverride(u, { disabled: true })}>{t('Turn off on this computer')}</button>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {!!machine?.forwardStdio.length && (
            <div className="mcp-combos-runon" role="group" aria-label={t('Where it runs in remote sessions')}>
              <div>{t('Where it runs in remote sessions (stdio MCPs forwarded from this computer; this setting is only for this computer, {host})', { host: machine.hostname })}</div>
              {machine.forwardStdio.map((f) => (
                <div key={`${f.fileId}\u0000${f.server}`} className="mcp-combos-unavailable-row">
                  <strong>{f.comboName} / {f.server}</strong>
                  <select
                    value={f.runOn}
                    disabled={saving}
                    aria-label={t('Where {name} runs', { name: f.server })}
                    onChange={(e) => void applyMachineOverride(f, { runOn: e.target.value as RunOn })}
                  >
                    <option value="auto">{t('Auto (default)')}</option>
                    <option value="remote">{t('Always run on the remote machine')}</option>
                    <option value="local">{t('Always forward from this computer')}</option>
                  </select>
                  {f.ranOnRemote && <span className="mcp-combos-unavailable-tag ran-on-remote">{t('Not on this computer; now runs on {host}', { host: f.ranOnRemote })}</span>}
                </div>
              ))}
            </div>
          )}
          {loading ? (
            <div className="agent-config-editor-message">{t('Loading…')}</div>
          ) : empty ? (
            <div className="agent-config-editor-message mcp-combos-empty">
              <div>{t('No custom MCP profiles yet: right now there is only the built-in "General" (no MCP). mcp-combos.json does not exist.')}</div>
              <div className="kiro-config-hint">{t('Insert example puts an example in the editor (a "General" MCP profile with local tools using forwardFromLocal, plus a "Research" MCP profile); writing id default replaces the built-in "General". Edit it, then Save to create the file.')}</div>
              <div>
                <button className="btn allow" onClick={() => setContent(formatJsonOnOpen(template))} disabled={!template}>{t('Insert example')}</button>
              </div>
            </div>
          ) : (
            <>
              <div className={`agent-config-editor-shell ${invalid ? 'invalid' : 'valid'}`}>
                <JsonCodeEditor
                  value={content}
                  errorLine={errorLine}
                  onChange={setContent}
                  onKeyDown={(ev) => {
                    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); void save(); }
                    else if (ev.key === 'Escape') { ev.preventDefault(); onClose(); }
                  }}
                  ariaLabel="mcp-combos.json"
                />
              </div>
              {invalid
                ? <div className="agent-config-validation invalid"><span>{invalid}</span></div>
                : <div className="agent-config-validation valid">{t('✓ Valid JSON (the MCP profiles are checked again on save)')}</div>}
            </>
          )}
        </div>
      </div>
      <div className="agent-config-editor-actions">
        {status && <span className={status.ok ? 'saved' : 'error'} title={status.text}>{status.text}</span>}
        {/* 插入了示例、还没存：明说还没存，免得看着像已经有了（样板里正好有个「投研」） */}
        {!exists && !status && !loading && !empty && <span className="error">{t('Not saved yet: the file does not exist, the text above is only a template. Click Save to create it.')}</span>}
        <button
          className="btn deny"
          onClick={() => { const r = formatJsonText(content); if (r.ok) setContent(r.text!); }}
          disabled={loading || empty || !!invalid || saving}
          title={t('Format with two-space indentation')}
        >
          {t('Format JSON')}
        </button>
        <button className="btn deny" onClick={onClose}>{t('Close')}</button>
        <button
          className="btn allow"
          onClick={() => void save()}
          disabled={loading || empty || !!invalid || saving || (!dirty && exists)}
        >
          {saving ? t('Saving…') : t('Save')}
        </button>
      </div>
    </>
  );
};
