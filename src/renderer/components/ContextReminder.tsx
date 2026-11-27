/**
 * **上下文到 60% 的提醒**（输入框上方一条窄带，不进对话）—— 判据在 `main/contextReminder.ts`。
 *
 * 「上下文已用 N%，后面每轮会更贵。[压缩上下文] [换后端会话并带摘要]」，可关；同一会话关掉后到下一个 10% 档
 * （70%、80%…）再提醒一次。关掉的档按会话存在 ui-state（`kirolex-context-remind-dismissed`），刷新 / 重启不复现。
 * 「压缩上下文」走引擎现有的压缩命令（Codex 没有 → 不给这颗）；「换后端会话并带摘要」是 `acp:new-backend-session`
 * （同 SafeguardCard 的「换一个新的后端会话」，上下文跟着下一条带过去）。正在跑一轮时两颗都置灰。
 */
import React, { useEffect, useState } from 'react';
import { useT } from '../hooks/useLang';
import { uiGet, uiSet } from '../uiStore';
import { compactCommandFor, nextDismissal, reminderBand, shouldRemind, type ContextEngine } from '../../main/contextReminder.ts';
import { cleanIpcError } from '../sessionRequestStatus.ts';

const DISMISSED_KEY = 'kirolex-context-remind-dismissed';

function readDismissed(): Record<string, number> {
  try {
    const raw = JSON.parse(uiGet(DISMISSED_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

function writeDismissed(sessionId: string, band: number | undefined): void {
  const all = readDismissed();
  if (band === undefined) delete all[sessionId]; else all[sessionId] = band;
  try { uiSet(DISMISSED_KEY, JSON.stringify(all)); } catch { /* 存不上只是下次多提醒一次 */ }
}

/** 同一次运行里同一会话同一档只记一行日志（分屏 / 重渲染不刷屏）。 */
const loggedBands = new Set<string>();

export const ContextReminder: React.FC<{
  sessionId: string | null;
  pct: number | null | undefined;
  engine?: ContextEngine;
  /** 这一轮还在跑（含重建历史）—— 按钮置灰，「这一轮结束后再压」。 */
  isStreaming: boolean;
  /**
   * 上一轮被停止 / 打断、在等你重发（输入框下一条会**覆盖**那一轮）。这时发 /compact 会被当成那次重发，
   * 把停下的那条消息和没写完的回复从记录里截掉 —— 所以「压缩上下文」置灰并说明；换后端会话不发消息，照常可点。
   */
  turnInterrupted?: boolean;
  /** 发引擎的压缩命令（按目标会话发、不带输入框里的附件），等那一轮结束再回。 */
  onCompact: (pct: number) => Promise<{ ok: boolean; error?: string }>;
  onNewBackend: (pct: number) => Promise<{ ok: boolean; error?: string }>;
}> = ({ sessionId, pct, engine, isStreaming, turnInterrupted, onCompact, onNewBackend }) => {
  const t = useT();
  const [dismissed, setDismissed] = useState<number | undefined>(() => (sessionId ? readDismissed()[sessionId] : undefined));
  /* 两颗按钮共用一份进度：kind 说明是哪颗在跑（压缩那一轮本身在跑时不显示「这一轮结束后再压」，显示「正在压缩…」） */
  const [backend, setBackend] = useState<{ phase: 'idle' | 'working' | 'failed'; kind?: 'compact' | 'backend'; error?: string }>({ phase: 'idle' });
  useEffect(() => {
    setDismissed(sessionId ? readDismissed()[sessionId] : undefined);
    setBackend({ phase: 'idle' });
  }, [sessionId]);
  const value = typeof pct === 'number' ? pct : NaN;
  /* 压下去到 60 以下：关掉过的档清掉，之后再涨上来照常提醒 */
  useEffect(() => {
    if (!sessionId || dismissed === undefined) return;
    if (nextDismissal(value, dismissed) === undefined) { writeDismissed(sessionId, undefined); setDismissed(undefined); }
  }, [sessionId, value, dismissed]);
  const show = !!sessionId && shouldRemind(value, dismissed);
  const band = reminderBand(value);
  useEffect(() => {
    if (!show || !sessionId || band === null) return;
    const key = `${sessionId}:${band}`;
    if (loggedBands.has(key)) return;
    loggedBands.add(key);
    window.kiroApi?.logContext?.({ kind: 'remind', sessionId, pct: value });
  }, [show, sessionId, band, value]);
  if (!show || !sessionId || band === null) return null;
  const dismiss = () => { writeDismissed(sessionId, band); setDismissed(band); };
  const canCompact = !!compactCommandFor(engine);
  const working = backend.phase === 'working';
  const waitTitle = t('Compact after this turn ends');
  const interruptedTitle = t('Resend the stopped turn from the composer first; compacting now would replace it');
  const blockedByInterrupt = !isStreaming && !!turnInterrupted;
  return (
    <div className="session-notice warn context-reminder" role="status">
      <span className="session-notice-text">
        {t('Context is {pct}% used; every turn from here costs more.', { pct: Math.round(value) })}
        <span className="context-reminder-actions">
          {canCompact && (
            <button
              type="button"
              className="session-notice-action"
              disabled={isStreaming || working || blockedByInterrupt}
              title={isStreaming ? waitTitle : blockedByInterrupt ? interruptedTitle : t('Have the engine summarize older context in this backend session')}
              onClick={async () => {
                setBackend({ phase: 'working', kind: 'compact' });
                try {
                  const r = await onCompact(value);
                  if (r?.ok) { setBackend({ phase: 'idle' }); dismiss(); } else setBackend({ phase: 'failed', error: cleanIpcError(r?.error || '') });
                } catch (err) {
                  setBackend({ phase: 'failed', error: cleanIpcError(err) });
                }
              }}
            >
              {working && backend.kind === 'compact' ? t('Compacting…') : t('Compact context')}
            </button>
          )}
          <button
            type="button"
            className="session-notice-action"
            disabled={isStreaming || working}
            title={isStreaming ? waitTitle : t('Start a fresh backend session; the conversation goes along with the next message')}
            onClick={async () => {
              setBackend({ phase: 'working', kind: 'backend' });
              try {
                const r = await onNewBackend(value);
                if (r?.ok) { setBackend({ phase: 'idle' }); dismiss(); } else setBackend({ phase: 'failed', error: cleanIpcError(r?.error || '') });
              } catch (err) {
                setBackend({ phase: 'failed', error: cleanIpcError(err) });
              }
            }}
          >
            {working && backend.kind === 'backend' ? t('Switching…') : t('New backend session with summary')}
          </button>
          {isStreaming && !working && <span className="context-reminder-wait">{waitTitle}</span>}
          {canCompact && blockedByInterrupt && <span className="context-reminder-wait">{interruptedTitle}</span>}
          {backend.phase === 'failed' && <span className="session-notice-action-error">{backend.error || t('Failed')}</span>}
        </span>
      </span>
      <button className="session-notice-close" onClick={dismiss} title={t('Close notice')}>✕</button>
    </div>
  );
};
