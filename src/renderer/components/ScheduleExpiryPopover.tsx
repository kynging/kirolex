import React, { useEffect, useRef, useState } from 'react';
import { useLang, useT } from '../hooks/useLang';
import { EXPIRY_PRESET_DAYS, parseExtendInput, parseUntilInput } from '../scheduleView';

/** 交给主进程 `schedule:set-expiry` 的具体值（同 main 的 `ScheduleExpiryChange`）。 */
export type ScheduleExpiryChange = { mode: 'extend'; ms: number } | { mode: 'until'; at: number } | { mode: 'never' };

/**
 * 聊天顶部那条定时任务上的「⏳ 延长…」—— **延长多久由用户定**（原来写死 7 天）。
 *
 * 贴着按钮的小弹层，不是整页对话框：显示当前到期时间；常用档点一下就生效；自定义天数 / 小时，或直接选到期时间；
 * 「♾️ 不过期」也在这里。输入不合法就地提示、不生效；Esc / 点外面关闭，什么都不改。
 * 用户设的没有 30 天上限（那只约束模型的 `expiresInDays`）；真正的计算和校验在主进程 `computeScheduleExpiry`。
 */
export function ScheduleExpiryPopover({ expiresAt, onApply }: {
  expiresAt: number;
  /** 发给主进程；返回错误就留在弹层里显示，成功就关。 */
  onApply: (change: ScheduleExpiryChange) => Promise<{ ok: boolean; error?: string }>;
}) {
  const t = useT();
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [unit, setUnit] = useState<'day' | 'hour'>('day');
  const [until, setUntil] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  const close = () => { setOpen(false); setError(null); setAmount(''); setUntil(''); };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown, true); document.removeEventListener('keydown', onKey, true); };
  }, [open]);

  const apply = async (change: ScheduleExpiryChange) => {
    const r = await onApply(change);
    if (r.ok) close(); else setError(r.error || t('unknown reason'));
  };

  const when = new Date(expiresAt).toLocaleString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <span className="schedule-expiry" ref={rootRef}>
      <button
        className="schedule-banner-extend"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        title={t('Choose how long to keep this job: extend it, set an expiry time, or never expire')}
      >{t('⏳ Extend…')}</button>
      {open && (
        <div className="schedule-expiry-popover" role="dialog" aria-label={t('Expiry')}>
          <div className="schedule-expiry-current">{t('Currently expires: {when}', { when })}</div>
          <div className="schedule-expiry-row">
            <span className="schedule-expiry-label">{t('Extend by')}</span>
            {EXPIRY_PRESET_DAYS.map((d) => (
              <button key={d} className="schedule-expiry-preset" onClick={() => void apply({ mode: 'extend', ms: d * 24 * 3600_000 })}>
                {t('+{n} days', { n: d })}
              </button>
            ))}
          </div>
          <form
            className="schedule-expiry-row"
            onSubmit={(e) => {
              e.preventDefault();
              const r = parseExtendInput(amount, unit, lang);
              if ('error' in r) { setError(r.error); return; }
              void apply({ mode: 'extend', ms: r.ms });
            }}
          >
            <span className="schedule-expiry-label">{t('Custom')}</span>
            <input
              className="schedule-expiry-amount"
              inputMode="numeric"
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setError(null); }}
              placeholder="10"
              aria-label={t('Custom')}
            />
            <select value={unit} onChange={(e) => setUnit(e.target.value === 'hour' ? 'hour' : 'day')}>
              <option value="day">{t('days')}</option>
              <option value="hour">{t('hours')}</option>
            </select>
            <button type="submit" className="schedule-expiry-apply">{t('Extend')}</button>
          </form>
          <form
            className="schedule-expiry-row"
            onSubmit={(e) => {
              e.preventDefault();
              const r = parseUntilInput(until, Date.now(), lang);
              if ('error' in r) { setError(r.error); return; }
              void apply({ mode: 'until', at: r.at });
            }}
          >
            <span className="schedule-expiry-label">{t('Or expire at')}</span>
            <input
              type="datetime-local"
              className="schedule-expiry-until"
              value={until}
              onChange={(e) => { setUntil(e.target.value); setError(null); }}
              aria-label={t('Or expire at')}
            />
            <button type="submit" className="schedule-expiry-apply">{t('Set')}</button>
          </form>
          {error && <div className="schedule-expiry-error" role="alert">{error}</div>}
          <div className="schedule-expiry-row">
            <button
              className="schedule-expiry-never"
              onClick={() => void apply({ mode: 'never' })}
              title={t('Keep it until the goal is reached or you cancel it (only you can set this; the model cannot)')}
            >{t('♾️ Never expire')}</button>
          </div>
        </div>
      )}
    </span>
  );
}
