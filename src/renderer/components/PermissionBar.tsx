import React, { useEffect, useState } from 'react';
import type { PermissionRequest } from '../hooks/useAcp';
import { useT } from '../hooks/useLang';
import { permissionButtons, planIsLong } from '../permissionButtons';
import { optionTone, toneClass } from '../permissionTone';

interface PermissionBarProps {
  request: PermissionRequest;
  onRespond: (optionId: string) => Promise<void>;
  /** 计划正文怎么渲染（Markdown）—— ChatArea 传它自己的 MarkdownView，避免这里反过来 import ChatArea */
  renderMarkdown?: (markdown: string) => React.ReactNode;
}

export const PermissionBar: React.FC<PermissionBarProps> = ({
  request,
  onRespond,
  renderMarkdown,
}) => {
  const t = useT();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* 批准计划时的计划正文（审计 2b）：长了默认折起来，换一个请求重新按长短定 */
  const [planOpen, setPlanOpen] = useState(() => !request.plan || !planIsLong(request.plan));

  useEffect(() => {
    setSubmitting(false);
    setError(null);
    setPlanOpen(!request.plan || !planIsLong(request.plan));
  }, [request.requestId]);

  const respond = async (optionId: string) => {
    setSubmitting(true);
    setError(null);
    try {
      await onRespond(optionId);
    } catch (responseError: any) {
      setSubmitting(false);
      setError(responseError?.message || t('Failed to send the permission decision.'));
    }
  };

  /* 同一种 kind 有好几个选项（Claude Code 批准计划）时逐个列出、用它们自己的名字，见 permissionButtons.ts */
  const buttons = permissionButtons(request.options);
  const generic = { allow_once: `✓ ${t('Allow once')}`, allow_always: `⟲ ${t('Always allow')}`, reject: `⊘ ${t('Reject')}` };
  /* 权限风险色（permissionTone.ts）：跳过权限的红 + ⚠、总是允许琥珀、允许一次正常、拒绝低调 */
  const toneOf = (optionId: string) => {
    const o = request.options.find((x) => x.optionId === optionId);
    return optionTone(o || { optionId });
  };
  const hints = {
    danger: t('⚠ Skips all permission prompts: the model can edit files and run commands without asking you'),
    caution: t('Partly automatic: some actions (such as file edits) go ahead without asking you'),
  };

  return (
    <div className="permission-bar" role="region" aria-live="polite" aria-label={t('Tool permission required')}>
      <div className="permission-bar-main">
        <span className="permission-bar-lock" aria-hidden="true">🔐</span>
        <div className="permission-bar-copy">
          <strong>{request.toolTitle || t('Tool permission required')}</strong>
          {request.description && request.description !== request.toolTitle && (
            <code title={request.description}>{request.description}</code>
          )}
        </div>
        {request.plan && (
          <div className={`permission-plan${planOpen ? '' : ' collapsed'}`}>
            <div className="permission-plan-body">
              {renderMarkdown ? renderMarkdown(request.plan) : <pre>{request.plan}</pre>}
            </div>
            {planIsLong(request.plan) && (
              <button type="button" className="permission-plan-toggle" onClick={() => setPlanOpen((o) => !o)}>
                {planOpen ? t('Collapse the plan') : t('Show the whole plan')}
              </button>
            )}
          </div>
        )}
        <div className={`permission-bar-actions${buttons.some((b) => b.label) ? ' named' : ''}`}>
          {buttons.map((b) => {
            const tone = toneOf(b.optionId);
            const label = b.label || generic[b.role];
            return (
              <button
                key={b.optionId}
                className={[b.role === 'reject' ? 'reject' : '', toneClass(tone)].filter(Boolean).join(' ') || undefined}
                disabled={submitting}
                onClick={() => void respond(b.optionId)}
                title={tone === 'danger' || tone === 'caution' ? hints[tone] : undefined}
              >
                {tone === 'danger' ? `⚠ ${label}` : label}
              </button>
            );
          })}
        </div>
      </div>
      {error && <div className="permission-bar-error">⚠ {error} {t('Try again.')}</div>}
    </div>
  );
};

