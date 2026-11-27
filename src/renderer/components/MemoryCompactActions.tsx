import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../hooks/useLang';
import { diffView } from '../diffView.ts';
import { ConfirmDialog, type ConfirmRequest } from './ConfirmDialog';

/**
 * 「已整理 <层> 记忆：X KB → Y KB，备份在 <路径>」那条 KiroLex 提示下面的两个按钮（token 优化 4/5，主进程 `compactLargeMemoryLayer`）：
 *   · 查看差异：备份（整理前）对现在的文件，按行 diff（`diffView`）；
 *   · 撤销：用备份覆盖回去（`acp:memory-compact-undo`），先确认 —— 整理后又手改过的也会被盖掉。
 * 备份路径来自这条提示的 noteGroup（`memoryCompactNote.ts`）。
 */
export const MemoryCompactActions: React.FC<{ backupPath: string }> = ({ backupPath }) => {
  const t = useT();
  const [diff, setDiff] = useState<{ before: string; after: string } | null>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const view = useMemo(() => (diff ? diffView(diff.before, diff.after) : null), [diff]);

  const openDiff = async () => {
    const r = await window.kiroApi.memoryCompactDiff?.(backupPath);
    if (r?.ok) { setDiff({ before: r.before ?? '', after: r.after ?? '' }); setStatus(null); }
    else setStatus({ kind: 'error', text: r?.error || t('Could not read the backup.') });
  };
  const undo = () => setConfirm({
    title: t('Undo memory compaction'),
    message: t('Overwrite the memory file with the backup taken before compaction? Anything written to it since then is replaced too.'),
    detail: backupPath,
    confirmLabel: t('Undo'),
    destructive: true,
    onConfirm: () => {
      setBusy(true);
      void window.kiroApi.memoryCompactUndo?.(backupPath).then((r) => {
        setStatus(r?.ok ? { kind: 'ok', text: t('Restored from the backup.') } : { kind: 'error', text: r?.error || t('Undo failed.') });
      }).finally(() => setBusy(false));
    },
  });

  return (
    <div className="adapter-install memory-compact-actions" data-phase={status?.kind === 'error' ? 'failed' : 'idle'}>
      <button type="button" className="adapter-install-btn safeguard-secondary" onClick={() => { void openDiff(); }}>{t('View diff')}</button>
      <button type="button" className="adapter-install-btn safeguard-secondary" disabled={busy} onClick={undo}>{t('Undo')}</button>
      {status && <span className="adapter-install-status">{status.text}</span>}
      {/* 弹窗挂到 body：聊天区的祖先带 transform / contain，fixed 定位在里面会被裁掉 */}
      {createPortal(<ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />, document.body)}
      {diff && view && createPortal(
        <>
          <div className="overlay" onClick={() => setDiff(null)} />
          <div className="settings-dialog memory-compact-diff" role="dialog" aria-modal="true" style={{ width: 'min(960px, 94vw)' }}>
            <div className="settings-header">
              <h3>{t('Memory compaction diff (−{removed} / +{added} lines)', { removed: view.removed, added: view.added })}</h3>
              <button className="settings-close" onClick={() => setDiff(null)}>✕</button>
            </div>
            <div className="memory-compact-diff-body">
              {view.lines.length ? (
                <pre className="files-item-diff diff-lines">
                  {view.lines.map((l, i) => (
                    <div key={i} className={`diff-line diff-${l.op === '-' ? 'del' : l.op === '+' ? 'add' : l.op === '…' ? 'skip' : 'ctx'}`}>
                      {l.op === '…' ? t('… unchanged lines …') : `${l.op} ${l.text}`}
                    </div>
                  ))}
                </pre>
              ) : <p className="settings-preview">{t('No difference: the memory file is the same as the backup.')}</p>}
            </div>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
};
