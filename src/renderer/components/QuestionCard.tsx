import React, { useMemo, useRef, useState } from 'react';
import { useT } from '../hooks/useLang';
import { engineLabel } from '../engineLabel';
import {
  answerLines, buildAcceptContent, fieldLabel, initialValues,
  type QuestionCard, type QuestionField, type QuestionValue,
} from '../../main/elicitation.ts';

/**
 * **提问卡片** —— 模型向你提问 / 让你选（ACP `elicitation/create`，见 `main/elicitation.ts`）。
 *
 * 挂着的时候是一张表单：单选是一排按钮、多选是复选、文字是输入框、布尔是开关、数字是数字框，
 * 每题的「其他 / 自定义答案」框画在那一题下面。「提交」= accept，「跳过」= decline。
 * 关掉之后（答了 / 跳过 / 停止 / 超时 / 代理撤回）变成只读摘要：问了什么、选了什么。状态只由主进程推来的卡片决定。
 */
export const QuestionCardView: React.FC<{ card: QuestionCard }> = ({ card }) => {
  const t = useT();
  const [values, setValues] = useState<Record<string, QuestionValue>>(() => initialValues(card.fields));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [badKeys, setBadKeys] = useState<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pending = card.status === 'pending';
  const engine = engineLabel(card.engine);

  /* 滚不滚到眼前由 ChatArea 决定（挂着的卡片画在这一轮最下面；你在往上翻历史时不抢滚动，改为底部浮标），见 `revealPendingAsk` */

  const mainFields = useMemo(() => card.fields.filter((f) => !f.customFor), [card.fields]);
  const customOf = (key: string) => card.fields.filter((f) => f.customFor === key);
  const set = (key: string, v: QuestionValue) => {
    setValues((prev) => ({ ...prev, [key]: v }));
    setBadKeys((prev) => { if (!prev.has(key)) return prev; const next = new Set(prev); next.delete(key); return next; });
  };

  const send = async (action: 'accept' | 'decline') => {
    setError(null);
    if (action === 'accept') {
      const check = buildAcceptContent(card.fields, values);
      if (!check.ok) {
        const bad = [...check.missing, ...check.invalid];
        setBadKeys(new Set(bad));
        const labels = bad.map((k) => { const f = card.fields.find((x) => x.key === k); return f ? fieldLabel(f) : k; }).join(t(', '));
        setError(check.missing.length ? t('Please answer: {fields}', { fields: labels }) : t('Please check: {fields}', { fields: labels }));
        return;
      }
    }
    setSubmitting(true);
    try {
      const r = await window.kiroApi.answerQuestion?.(card.sessionId, card.id, action, values);
      if (!r) throw new Error(t('KiroLex could not send the answer.'));
      if (!r.ok) {
        setSubmitting(false);
        if (r.error === 'invalid') {
          setBadKeys(new Set([...(r.missing || []), ...(r.invalid || [])]));
          setError(t('Some answers are missing or not valid.'));
        } else {
          setError(t('This question is no longer waiting for an answer.'));
        }
      }
      /* 成功：主进程推来关掉的卡片，这一张自己变成只读摘要 */
    } catch (e: any) {
      setSubmitting(false);
      setError(e?.message || t('KiroLex could not send the answer.'));
    }
  };

  const statusText: Record<string, string> = {
    answered: t('Answered'),
    declined: t('Skipped'),
    cancelled: card.cancelledBy === 'switch' ? t('Cancelled (you switched to another chat)') : t('Cancelled (the turn was stopped)'),
    timeout: t('No answer within {n} min, so it was cancelled', { n: Math.round((card.expiresAt - card.askedAt) / 60_000) }),
    withdrawn: t('Withdrawn by {engine}', { engine }),
  };

  const header = (
    <div className="question-card-head">
      <span className="question-card-icon" aria-hidden="true">❓</span>
      <div className="question-card-copy">
        <span className="question-card-who">{pending ? t('{engine} is asking you', { engine }) : t('{engine} asked you', { engine })}</span>
        {card.message && <strong className="question-card-message">{card.message}</strong>}
        {card.title && card.title !== card.message && <span className="question-card-desc">{card.title}</span>}
        {card.description && <span className="question-card-desc">{card.description}</span>}
      </div>
      {!pending && <span className={`question-card-status ${card.status}`}>{statusText[card.status] || card.status}</span>}
    </div>
  );

  if (!pending) {
    const lines = answerLines(card);
    return (
      <div className="question-card closed" id={`question-${card.id}`} ref={rootRef} role="group" aria-label={t('Question from the model')}>
        {header}
        {card.status === 'answered' && lines.length > 0 ? (
          <ul className="question-card-summary">
            {lines.map((l) => (
              <li key={l.key}>
                <span className="question-card-summary-label">{l.label}{/[?？:：]$/.test(l.label.trim()) ? '' : ':'}</span>
                <span className="question-card-summary-value">{l.boolean !== undefined ? (l.boolean ? t('Yes') : t('No')) : l.value}</span>
              </li>
            ))}
          </ul>
        ) : card.status === 'answered' ? (
          <div className="question-card-desc">{t('Submitted without filling anything in')}</div>
        ) : mainFields.length > 0 && (
          <ul className="question-card-summary asked">
            {mainFields.map((f) => <li key={f.key}><span className="question-card-summary-label">{fieldLabel(f)}</span></li>)}
          </ul>
        )}
      </div>
    );
  }

  const deadline = new Date(card.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <form
      className="question-card"
      id={`question-${card.id}`}
      ref={rootRef as any}
      role="group"
      aria-label={t('Question from the model')}
      onSubmit={(e) => { e.preventDefault(); void send('accept'); }}
    >
      {header}
      {mainFields.map((f) => (
        <div key={f.key} className={`question-field${badKeys.has(f.key) ? ' bad' : ''}`}>
          {(f.title || f.description) && (
            <div className="question-field-label">
              {f.title && <span className="question-field-title">{f.title}{f.required ? <span className="question-field-required" title={t('Required')}> *</span> : null}</span>}
              {f.description && f.description !== f.title && <span className="question-field-desc">{f.description}</span>}
            </div>
          )}
          <FieldControl field={f} value={values[f.key]} onChange={(v) => set(f.key, v)} disabled={submitting} />
          {customOf(f.key).map((c) => (
            <input
              key={c.key}
              className={`question-input question-custom${badKeys.has(c.key) ? ' bad' : ''}`}
              type={c.secret ? 'password' : 'text'}
              value={typeof values[c.key] === 'string' ? (values[c.key] as string) : ''}
              placeholder={c.description || c.title || t('Other answer (optional)')}
              aria-label={c.title || t('Other answer (optional)')}
              disabled={submitting}
              onChange={(e) => set(c.key, e.target.value)}
            />
          ))}
        </div>
      ))}
      <div className="question-card-actions">
        <span className="question-card-deadline">{t('If nobody answers, it is cancelled at {time}', { time: deadline })}</span>
        <button type="button" className="question-skip" disabled={submitting} onClick={() => void send('decline')}>{t('Skip')}</button>
        <button type="submit" className="question-submit" disabled={submitting}>{submitting ? t('Sending…') : t('Submit')}</button>
      </div>
      {error && <div className="question-card-error" role="alert">{error}</div>}
    </form>
  );
};

const FieldControl: React.FC<{ field: QuestionField; value: QuestionValue | undefined; onChange: (v: QuestionValue) => void; disabled: boolean }> = ({ field: f, value, onChange, disabled }) => {
  const t = useT();
  if (f.kind === 'single') {
    return (
      <div className="question-options" role="radiogroup" aria-label={fieldLabel(f)}>
        {(f.options || []).map((o) => {
          const on = value === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              className={`question-option${on ? ' on' : ''}`}
              disabled={disabled}
              title={o.description || undefined}
              /* 再点一下取消（不是必填时可以一个都不选，改在「其他」里写） */
              onClick={() => onChange(on && !f.required ? '' : o.value)}
            >
              <span className="question-option-title">{o.title}</span>
              {o.description && <span className="question-option-desc">{o.description}</span>}
            </button>
          );
        })}
      </div>
    );
  }
  if (f.kind === 'multi') {
    const picks = Array.isArray(value) ? value : [];
    return (
      <div className="question-options multi" role="group" aria-label={fieldLabel(f)}>
        {(f.options || []).map((o) => {
          const on = picks.includes(o.value);
          return (
            <label key={o.value} className={`question-option check${on ? ' on' : ''}`} title={o.description || undefined}>
              <input
                type="checkbox"
                checked={on}
                disabled={disabled}
                onChange={() => onChange(on ? picks.filter((x) => x !== o.value) : [...picks, o.value])}
              />
              <span className="question-option-title">{o.title}</span>
              {o.description && <span className="question-option-desc">{o.description}</span>}
            </label>
          );
        })}
      </div>
    );
  }
  if (f.kind === 'boolean') {
    return (
      <label className="question-toggle">
        <input type="checkbox" role="switch" checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span>{value === true ? t('Yes') : t('No')}</span>
      </label>
    );
  }
  if (f.kind === 'number' || f.kind === 'integer') {
    return (
      <input
        className="question-input number"
        type="number"
        step={f.kind === 'integer' ? 1 : 'any'}
        min={f.minimum}
        max={f.maximum}
        value={typeof value === 'number' || typeof value === 'string' ? String(value) : ''}
        disabled={disabled}
        aria-label={fieldLabel(f)}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <input
      className="question-input"
      type={f.secret ? 'password' : 'text'}
      value={typeof value === 'string' ? value : ''}
      maxLength={f.maxLength}
      disabled={disabled}
      aria-label={fieldLabel(f)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
};
