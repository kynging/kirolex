/**
 * **三个引擎在「将要运行的那台机器」上能不能用** —— 新建会话选引擎处、设置 → 机器 → 本机那页。
 * ✅ 可用 / ⚠️ 没登录（点「登录」：本机开终端跑登录命令、登上了自动刷新；远端给去哪登）/ ❌ 没装（点「安装」直接装）。
 * 状态主进程缓存 5 分钟（`engines:status`），这里不会每次打开都卡一下；「重新检测」跳过缓存。
 */
import React, { useEffect, useSyncExternalStore } from 'react';
import { useT } from '../hooks/useLang';
import { EngineIcon } from './Icons';
import {
  createEngineStatusStore, ENGINE_NAMES, ENGINE_ORDER, outputTail, stateIcon,
  type EngineId, type EngineStatusLite, type EngineStatusStore, type MachineState,
} from '../engineStatusView';

const KIRO_DOWNLOAD_URL = 'https://kiro.dev/docs/cli/installation/';

let shared: EngineStatusStore | null = null;
/** 整个窗口一份（新建会话框和设置页看到的是同一份状态、同一次安装的进度）。 */
export function engineStatusStore(): EngineStatusStore {
  if (shared) return shared;
  const api = (window as any).kiroApi;
  shared = createEngineStatusStore({
    fetch: (machine, force) => api?.enginesStatus ? api.enginesStatus(machine, { force }) : Promise.resolve({ ok: false, error: 'unavailable' }),
    install: (machine, engine) => api?.enginesInstall ? api.enginesInstall(machine, engine) : Promise.resolve({ ok: false, error: 'unavailable' }),
    login: (machine, engine) => api?.enginesLogin ? api.enginesLogin(machine, engine) : Promise.resolve({ ok: false, error: 'unavailable' }),
  });
  try {
    api?.onEnginesInstallOutput?.((d: { machine: string; engine: EngineId; chunk: string }) => shared!.appendOutput(d.machine, d.engine, d.chunk));
  } catch { /* 没有这个事件就不显示进度 */ }
  return shared;
}

/** 读一台机器的状态（挂上时取一次；主进程有缓存）。 */
export function useEngineStatuses(machine: string): MachineState | undefined {
  const store = engineStatusStore();
  const st = useSyncExternalStore(store.subscribe, () => store.get(machine));
  useEffect(() => { void store.load(machine); }, [machine, store]);
  return st;
}

function StateText({ s }: { s: EngineStatusLite }) {
  const t = useT();
  if (s.state === 'ok') return <>{s.loginUnknown ? t('Ready (login status could not be checked)') : t('Available')}</>;
  if (s.state === 'not-logged-in') return <>{t('Not logged in')}</>;
  if (s.state === 'missing') return <>{t('Not installed')}</>;
  return <>{t('Unknown')}</>;
}

const verdictMark = (v: string): string => (v === 'ok' ? '✓' : v === 'denied' ? '✗' : '?');
function BedrockLine({ b }: { b: NonNullable<EngineStatusLite['bedrock']> }) {
  const t = useT();
  return (
    <div className={`engine-status-detail${b.missing.length && !(b.model !== 'denied' && b.webSearchDisabled) ? ' engine-status-fail' : ''}`} data-testid="engine-bedrock">
      {t('Bedrock permissions')}{': '}{t('Model calls {m}', { m: verdictMark(b.model) })}{' · '}{t('Web search {m}', { m: verdictMark(b.webSearch) })}
      {b.webSearchDisabled ? ` ${t('(web search is turned off on that machine)')}` : ''}
      {b.missing.length > 0 && ` — ${t('missing {actions}; the policy to add is under 🔑 Login', { actions: b.missing.join(', ') })}`}
    </div>
  );
}

export function EngineStatusPanel({ machine, selected, compact, title }: {
  /** `'local'` = 本机，否则远端 id。 */
  machine: string;
  /** 新建会话框里选中的那一家（高亮）。 */
  selected?: EngineId;
  compact?: boolean;
  title?: string;
}) {
  const t = useT();
  const store = engineStatusStore();
  const st = useEngineStatuses(machine);
  const loadingFirst = !st?.statuses && (st?.loading ?? true);
  return (
    <div className={`engine-status-panel${compact ? ' compact' : ''}`} data-machine={machine}>
      <div className="engine-status-head">
        <span className="engine-status-title">{title || t('Status on this machine')}</span>
        <button
          type="button"
          className="engine-status-refresh"
          disabled={!!st?.loading}
          onClick={() => { void store.load(machine, true); }}
          title={t('Checks again now (results are otherwise reused for 5 minutes)')}
        >{st?.loading ? t('Checking…') : t('↻ Check again')}</button>
      </div>
      {st?.error && !st.statuses && <div className="engine-status-error">{t('Could not check: {why}', { why: st.error })}</div>}
      {ENGINE_ORDER.map((e) => {
        const s = st?.statuses?.find((x) => x.engine === e);
        const a = st?.actions[e];
        const busy = a?.phase === 'installing' || a?.phase === 'logging-in';
        return (
          <div key={e} className={`engine-status-row${selected === e ? ' selected' : ''}`} data-engine={e} data-state={s?.state || 'loading'}>
            <div className="engine-status-line" title={s?.detail || ''}>
              <span className="engine-status-icon">{loadingFirst ? '…' : stateIcon(s?.state)}</span>
              <EngineIcon engine={e} size={14} />
              <span className="engine-status-name">{ENGINE_NAMES[e]}</span>
              {s?.version && <span className="engine-status-ver">{s.version}</span>}
              <span className="engine-status-text">{s ? <StateText s={s} /> : loadingFirst ? t('Checking…') : ''}</span>
              {s?.state === 'missing' && (
                <button type="button" className="engine-status-btn" disabled={busy} onClick={() => { void store.install(machine, e); }}>
                  {a?.phase === 'installing' ? t('Installing…') : a?.phase === 'install-failed' ? t('Try installing again') : t('Install')}
                </button>
              )}
              {s?.state === 'not-logged-in' && (
                <button type="button" className="engine-status-btn" disabled={busy} onClick={() => { void store.login(machine, e); }}>
                  {a?.phase === 'logging-in' ? t('Waiting for login…') : t('Log in')}
                </button>
              )}
            </div>
            {s?.detail && s.state !== 'ok' && (!compact || selected === e) && !a && <div className="engine-status-detail">{s.detail}</div>}
            {/* Codex 走 Bedrock：IAM 权限预检（缺网页搜索权限时一用就整轮断；怎么补在 🔑 登录 里） */}
            {e === 'codex' && s?.bedrock && <BedrockLine b={s.bedrock} />}
            {a?.phase === 'installing' && (
              <pre className="adapter-install-output">{outputTail(a.output) || t('Starting…')}</pre>
            )}
            {a?.phase === 'install-failed' && (
              <div className="engine-status-detail engine-status-fail">
                {a.error || t('Install failed.')}
                {e === 'kiro' && (
                  <button type="button" className="engine-status-link" onClick={() => { void (window as any).kiroApi?.openExternal?.(KIRO_DOWNLOAD_URL); }}>
                    {t('Open the official download page')}
                  </button>
                )}
              </div>
            )}
            {a?.phase === 'logging-in' && <div className="engine-status-detail">{t('A terminal window opened with the login command. Finish logging in there; this updates by itself.')}</div>}
            {a?.phase === 'login-failed' && <div className="engine-status-detail engine-status-fail">{a.error || t('Did not see a login yet. Click Log in to try again.')}</div>}
            {a?.phase === 'login-how' && <div className="engine-status-detail">{a.how}</div>}
          </div>
        );
      })}
    </div>
  );
}
