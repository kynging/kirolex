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
 */

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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void api()?.mcpCombosFile?.().then((r: { path: string; exists: boolean; text: string; error?: string }) => {
      if (!alive || !r) return;
      /* 打开就展开成 2 空格缩进（不合法的原样显示，下面标出错位置）；initial 也用展开后的，光打开不算改动 */
      const text = formatJsonOnOpen(r.text);
      setPath(r.path); setExists(r.exists); setContent(text); setInitial(r.exists ? text : '');
      if (r.error) setStatus({ ok: false, text: t('The file on disk has errors, so only "General" is used for now: {error}', { error: r.error }) });
    }).catch((err: any) => { if (alive) setStatus({ ok: false, text: String(err?.message || err) }); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const invalid = syntaxError(content, t);
  const errorLine = invalid ? jsonErrorAt(content)?.line : null;
  const dirty = content !== initial;

  const save = async () => {
    if (saving) return;
    /* Ctrl+S 绕过了禁用的保存按钮：JSON 有错时也要明说没存，不能什么都不发生 */
    if (invalid) { setStatus({ ok: false, text: t('Not saved: {error}', { error: invalid }) }); return; }
    setSaving(true); setStatus(null);
    try {
      /* 按格式化后的样子写盘（只动空白，不改语义；校验仍在 main 那边） */
      const text = formatJsonText(content).text ?? content;
      const r = await api().saveMcpCombos(text);
      if (r?.ok) {
        setContent(text); setInitial(text); setExists(true);
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
            <span className="kiro-config-ro-tag">{t('Shared by all sessions; with S3 sync on, also synced to your other computers')}</span>
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
                : <div className="agent-config-validation valid">{t('✓ Valid JSON (the combos are checked again on save)')}</div>}
            </>
          )}
        </div>
      </div>
      <div className="agent-config-editor-actions">
        {status && <span className={status.ok ? 'saved' : 'error'} title={status.text}>{status.text}</span>}
        {/* 文件不存在时编辑框里是样板（样板里正好有个「投研」）—— 明说还没存，免得看着像已经有了 */}
        {!exists && !status && !loading && <span className="error">{t('Not saved yet: the file does not exist, the text above is only a template. Click Save to create it.')}</span>}
        <button
          className="btn deny"
          onClick={() => { const r = formatJsonText(content); if (r.ok) setContent(r.text!); }}
          disabled={loading || !!invalid || saving}
          title={t('Format with two-space indentation')}
        >
          {t('Format JSON')}
        </button>
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
