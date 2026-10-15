import React, { useEffect, useState } from 'react';
import { useT } from '../hooks/useLang';

/**
 * **Claude Code / Codex 面板里的「🧩 组合」那页** ——「不同对话挂不同的 MCP」。
 *
 * 直接编辑 `~/.kirolex/mcp-combos.json`（文本编辑）。这份文件是**本机全局**的，所有会话共用；
 * 每条会话只在左下角的下拉里选用哪个。保存时 main 那边校验（`mcpCombos.ts` 的 `parseMcpCombos`），
 * 校验不过就不写盘，把原因原样显示出来。这里只做一个即时的 JSON 语法提示。
 *
 * 关闭 = 丢弃未保存的改动（和其他 tab 同一条规则）。
 */

const api = () => (window as any).kiroApi;

function syntaxError(text: string, t: (k: string, v?: Record<string, string | number>) => string): string | null {
  try { JSON.parse(text); return null; } catch (e: any) {
    const msg = String(e?.message || e);
    const pos = /position (\d+)/.exec(msg);
    return pos ? t('Line {line}: {msg}', { line: text.slice(0, Number(pos[1])).split('\n').length, msg }) : msg;
  }
}

export const McpCombosPane: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const t = useT();
  const [path, setPath] = useState('');
  const [content, setContent] = useState('');
  const [initial, setInitial] = useState('');
  const [exists, setExists] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void api()?.mcpCombosFile?.().then((r: { path: string; exists: boolean; text: string; error?: string }) => {
      if (!alive || !r) return;
      setPath(r.path); setExists(r.exists); setContent(r.text); setInitial(r.exists ? r.text : '');
      if (r.error) setStatus({ ok: false, text: t('The file on disk has errors, so only "General" is used for now: {error}', { error: r.error }) });
    }).catch((err: any) => { if (alive) setStatus({ ok: false, text: String(err?.message || err) }); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const invalid = syntaxError(content, t);
  const dirty = content !== initial;

  const save = async () => {
    if (invalid || saving) return;
    setSaving(true); setStatus(null);
    try {
      const r = await api().saveMcpCombos(content);
      if (r?.ok) {
        setInitial(content); setExists(true);
        setStatus({ ok: true, text: t('Saved. Sessions using this combo pick up the new content the next time they reconnect; to apply it now, switch to another combo in the bottom-left and back.') });
      } else {
        setStatus({ ok: false, text: t('Not saved: {error}', { error: r?.error || t('Validation failed') }) });
      }
    } catch (err: any) {
      setStatus({ ok: false, text: t('Not saved: {error}', { error: String(err?.message || err) }) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="agent-config-editor-workspace kiro-config-workspace mcp-combos-workspace">
        <div className="agent-config-editor-body">
          <div className="agent-config-editor-selection">
            <strong>mcp-combos.json</strong>
            <span className="kiro-config-ro-tag">{t('Global on this machine, shared by all sessions')}</span>
            {path && <span className="agent-config-editor-path" title={path}>{path}</span>}
          </div>
          <div className="kiro-config-hint">
            {t('A list of combos: each has id, name, an optional effort (such as high) and mcpServers. HTTP entries use url / headers (optional timeoutSec), stdio entries use command / args / env; disabled and forwardFromLocal are optional. Values in headers and env can reference local environment variables with ')}{'${env:NAME}'}{t('. The built-in "General" (no MCP) does not need to be listed.')}{!exists && ` · ${t('This file does not exist yet. Below is a template; saving will create it.')}`}
          </div>
          {loading ? (
            <div className="agent-config-editor-message">{t('Loading…')}</div>
          ) : (
            <>
              <div className={`agent-config-editor-shell ${invalid ? 'invalid' : 'valid'}`}>
                <textarea
                  className="agent-config-editor-textarea"
                  value={content}
                  onChange={(ev) => setContent(ev.target.value)}
                  onKeyDown={(ev) => {
                    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); void save(); }
                    else if (ev.key === 'Escape') { ev.preventDefault(); onClose(); }
                  }}
                  spellCheck={false}
                  aria-label="mcp-combos.json"
                />
              </div>
              {invalid
                ? <div className="agent-config-validation invalid"><span>{invalid}</span></div>
                : <div className="agent-config-validation valid">{t('✓ Valid JSON (the combos are checked again on save)')}</div>}
            </>
          )}
        </div>
      </div>
      <div className="agent-config-editor-actions">
        {status && <span className={status.ok ? 'saved' : 'error'}>{status.text}</span>}
        <button className="btn deny" onClick={onClose}>{t('Close')}</button>
        <button
          className="btn allow"
          onClick={() => void save()}
          disabled={loading || !!invalid || saving || (!dirty && exists)}
        >
          {saving ? t('Saving…') : t('Save')}
        </button>
      </div>
    </>
  );
};
