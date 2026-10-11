import React, { useEffect, useState } from 'react';

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

function syntaxError(text: string): string | null {
  try { JSON.parse(text); return null; } catch (e: any) {
    const msg = String(e?.message || e);
    const pos = /position (\d+)/.exec(msg);
    return pos ? `第 ${text.slice(0, Number(pos[1])).split('\n').length} 行：${msg}` : msg;
  }
}

export const McpCombosPane: React.FC<{ onClose: () => void }> = ({ onClose }) => {
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
      if (r.error) setStatus({ ok: false, text: `盘上的文件有错，现在按只有「通用」处理：${r.error}` });
    }).catch((err: any) => { if (alive) setStatus({ ok: false, text: String(err?.message || err) }); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const invalid = syntaxError(content);
  const dirty = content !== initial;

  const save = async () => {
    if (invalid || saving) return;
    setSaving(true); setStatus(null);
    try {
      const r = await api().saveMcpCombos(content);
      if (r?.ok) {
        setInitial(content); setExists(true);
        setStatus({ ok: true, text: '已保存 —— 正在用这个组合的会话要下次重连时才按新内容起；想马上生效，在左下角先切到别的组合、再切回来。' });
      } else {
        setStatus({ ok: false, text: `没有保存：${r?.error || '校验没通过'}` });
      }
    } catch (err: any) {
      setStatus({ ok: false, text: `没有保存：${String(err?.message || err)}` });
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
            <span className="kiro-config-ro-tag">本机全局，所有会话共用</span>
            {path && <span className="agent-config-editor-path" title={path}>{path}</span>}
          </div>
          <div className="kiro-config-hint">
            组合列表：每个组合有 id、name、可选 effort（如 high）和 mcpServers。http 型写 url / headers（可选 timeoutSec），
            stdio 型写 command / args / env；可选 disabled、forwardFromLocal。headers 和 env 的值可以用 {'${env:NAME}'} 引用本机环境变量。
            内置「通用」（不挂 MCP）不用写。{!exists && ' · 这个文件还不存在，下面是样板，保存就会建出来。'}
          </div>
          {loading ? (
            <div className="agent-config-editor-message">Loading…</div>
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
                : <div className="agent-config-validation valid">✓ JSON 格式正确（保存时还会检查组合内容）</div>}
            </>
          )}
        </div>
      </div>
      <div className="agent-config-editor-actions">
        {status && <span className={status.ok ? 'saved' : 'error'}>{status.text}</span>}
        <button className="btn deny" onClick={onClose}>Close</button>
        <button
          className="btn allow"
          onClick={() => void save()}
          disabled={loading || !!invalid || saving || (!dirty && exists)}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>
  );
};
