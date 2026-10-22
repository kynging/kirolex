import React, { useEffect, useState } from 'react';
import type { PermissionRequest } from '../hooks/useAcp';
import { useT } from '../hooks/useLang';
import { permissionButtons } from '../permissionButtons';

interface PermissionBarProps {
  request: PermissionRequest;
  onRespond: (optionId: string) => Promise<void>;
}

export const PermissionBar: React.FC<PermissionBarProps> = ({
  request,
  onRespond,
}) => {
  const t = useT();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSubmitting(false);
    setError(null);
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
        <div className={`permission-bar-actions${buttons.some((b) => b.label) ? ' named' : ''}`}>
          {buttons.map((b) => (
            <button
              key={b.optionId}
              className={b.role === 'reject' ? 'reject' : undefined}
              disabled={submitting}
              onClick={() => void respond(b.optionId)}
            >
              {b.label || generic[b.role]}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="permission-bar-error">⚠ {error} {t('Try again.')}</div>}
    </div>
  );
};

