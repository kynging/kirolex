import { LANG_OPTIONS, normalizeLang } from '../i18n';
import { normalizeUiZoom, stepUiZoom, UI_ZOOM_DEFAULT, UI_ZOOM_MAX, UI_ZOOM_MIN } from '../uiZoom';
import { BackupSettings } from './BackupSettings.tsx';
import { ToggleButton } from './ToggleButton.tsx';
import { RemoteSettings } from './RemoteSettings';
import { AgentProfileSettings } from './AgentProfileSettings';
import { ForwardMcpSettings } from './ForwardMcpSettings';
import { LocalBrowserSettings } from './LocalBrowserSettings';
import { useT } from '../hooks/useLang';
import { fontSelectOptions } from '../fontOptions';
import { defaultComboOptions, type DefaultComboInfo } from '../comboPick';
import { mergeHelperModelLists, planHelperRoute, helperChoiceText, LOCAL_MACHINE, type MachineModelList } from '../../main/helperModels.ts';
import React from 'react';
import { useEffect, useState } from 'react';
import type { Settings } from '../App';

type SettingsTab = 'appearance' | 'session' | 'switches' | 'machines' | 'backup';

interface SettingsDialogProps {
  /** 打开时停在哪一页（侧栏那个 ☁️ 直接落到备份页）。不传 = 机器页。 */
  initialTab?: SettingsTab;
  /** 机器页一打开就停在「+ 添加一台机器…」（侧栏右键「运行位置 → ＋ 添加机器…」）。不传 = 和以前一样。 */
  startNewMachine?: boolean;
  settings: Settings;
  onChange: (settings: Settings) => void;
  onClose: () => void;
  confirmDeletes: boolean;
  onConfirmDeletesChange: (value: boolean) => void;
}

// Font choices. Empty value = keep the app default stack. Only fonts that ship
// with macOS/Windows are offered as presets; a legacy value outside them shows up
// as an extra "Current: …" option (see fontSelectOptions).
const FONT_PRESETS: Array<{ label: string; value: string }> = [
  { label: 'System default', value: '' },
  // 这些 label 在 fontSelectOptions 里过 t()；中文名（苹方 / 冬青黑 / 宋体 / 微软雅黑）在 i18nZh/shell.ts
  { label: 'PingFang SC', value: "'PingFang SC', -apple-system, sans-serif" },
  { label: 'Hiragino Sans GB', value: "'Hiragino Sans GB', 'PingFang SC', sans-serif" },
  { label: 'Songti SC', value: "'Songti SC', 'Times New Roman', serif" },
  { label: 'Helvetica Neue', value: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  { label: 'Segoe UI', value: "'Segoe UI', Tahoma, sans-serif" },
  { label: 'Microsoft YaHei', value: "'Microsoft YaHei', 'PingFang SC', sans-serif" },
];
const MONO_PRESETS: Array<{ label: string; value: string }> = [
  { label: 'Default mono', value: '' },
  { label: 'SF Mono', value: "'SF Mono', ui-monospace, monospace" },
  { label: 'Menlo', value: 'Menlo, monospace' },
  { label: 'Monaco', value: 'Monaco, monospace' },
  { label: 'JetBrains Mono', value: "'JetBrains Mono', Menlo, monospace" },
  { label: 'Fira Code', value: "'Fira Code', Menlo, monospace" },
  { label: 'Consolas', value: 'Consolas, monospace' },
];

/** ALL boolean behaviour switches, in ONE list.
 *
 *  They used to be split across two blocks with nothing to tell them apart: four
 *  ("自动重发", "Merge queued", the two auto-folds) plus "Confirm before deleting"
 *  sat as individual rows, and seven more lived under a separate "功能开关" heading.
 *  Same kind of control, same kind of decision, two places -- and one of them
 *  (自动重发) was even a duplicate of a switch proposed for the other list.
 *
 *  `store` says who owns the value, which is the only real difference left:
 *    'feature'  -> ~/.kirolex/config.json `features`, read by the MAIN process too
 *    'settings' -> the renderer Settings object (now on disk via ui-state.json)
 *    'prop'     -> owned by App (delete confirmation)
 *  All three are durable and all three apply immediately; the split is an
 *  implementation detail and must not leak into the UI.
 *
 *  Labels state what the switch DOES; `help` states what turning it OFF means,
 *  because that is the decision being made. */
type SwitchStore = 'feature' | 'settings' | 'prop';
/** 主进程 FEATURE_DEFAULTS 里默认关的那几个 */
const DEFAULT_OFF_FEATURES = new Set(['controlSessionAccess']);
// group / label / help 都是英文 key，渲染时过 t()；中文在 i18nZh/shell.ts（测试扫不到这张表，加条目时手动补字典）。
const SWITCH_GROUPS = ['Context & history', 'Conversation & input', 'Interface', 'Safety'] as const;
const SWITCHES: Array<{
  key: string; store: SwitchStore; group: typeof SWITCH_GROUPS[number]; label: string; help: string;
}> = [
  { key: 'rideAlongContext', store: 'feature', group: 'Context & history',
    label: 'Send history context along with the message (no extra turn)',
    help: 'On: after a restart, the first message carries a history snapshot, with no extra model turn. Off: go back to "run a rebuild turn first, then send the message".' },
  { key: 'historyFileRefresh', store: 'feature', group: 'Context & history',
    label: 'Refresh history.md every turn',
    help: 'On: the full history file is rewritten as soon as each turn ends, so the model always reads the latest. Off: written once at rebuild time and lags behind afterwards.' },
  { key: 'memoryInjection', store: 'feature', group: 'Context & history',
    label: 'Inject memory (global / project / this chat)',
    help: 'On: every turn carries the contents of ~/.kirolex/memory (about 1.3k characters), so rules like "every reply must…" hold on every turn. Off: the model sees none of this background.' },
  { key: 'recoverInterruptedTurns', store: 'settings', group: 'Context & history',
    label: 'Resend an unanswered prompt after a restart',
    help: 'On: after an interruption you didn’t cause (executor dropped mid-turn, restart, watchdog), the turn is resent automatically (along with any steer it had already taken in; this uses quota), up to the "auto-retry attempts" limit; nothing is resent if you pressed Stop. Off: the turn stays where it is and you decide whether to resend it.' },
  { key: 'pasteFolding', store: 'feature', group: 'Conversation & input',
    label: 'Fold large pastes to disk',
    help: 'On: very long pastes are saved to ~/.kirolex/pastes and shown as a placeholder in the composer (a single line folds only past 4000 characters). Off: pastes always go straight into the composer.' },
  { key: 'mergeQueuedMessages', store: 'settings', group: 'Conversation & input',
    label: 'Merge queued messages into one',
    help: 'On: multiple queued messages are merged into one when sent. Off: they are sent one by one, each taking its own turn.' },
  { key: 'promptSuggestions', store: 'feature', group: 'Conversation & input',
    label: 'Show starter prompts when the composer is empty',
    help: 'On: clickable starter prompts appear when the composer is empty. Off: none are shown, and the helper model isn’t called for them.' },
  { key: 'smartTitle', store: 'feature', group: 'Conversation & input',
    label: 'Generate chat titles automatically',
    help: 'On: the helper model names new chats. Off: they stay "New Chat". Note that chats with identical titles are hard to tell apart in the sidebar; one was deleted by mistake because of that.' },
  { key: 'splitDragResize', store: 'feature', group: 'Interface',
    label: 'Draggable pane dividers',
    help: 'On: the dividers between cells can be dragged (double-click to even them out). Off: fixed even split; the dividers are still there but can’t be dragged.' },
  { key: 'restoreUiState', store: 'settings', group: 'Interface',
    label: 'Restore the window layout after a restart',
    help: 'On: after restarting KiroLex, whether the left chat list was collapsed, each group’s folding, the right-side comment mode, and each file’s unsent comments / delete marks all come back as they were. Off: these are kept only across window reloads; a restart resets them.' },
  { key: 'autoFoldThinking', store: 'settings', group: 'Interface',
    label: 'Auto-fold thinking when it finishes (💭 thinking)',
    help: 'On: a thinking block folds up once it ends. Off: always expanded.' },
  { key: 'autoFoldTools', store: 'settings', group: 'Interface',
    label: 'Auto-fold tool calls when they finish (🔧 tool)',
    help: 'On: a tool call folds up once it ends. Off: always expanded.' },
  { key: 'confirmDeletes', store: 'prop', group: 'Safety',
    label: 'Confirm before deleting chats',
    help: 'On: ask for confirmation before deleting a chat. Off: delete on click. Deleted chats now go to ~/.kirolex/trash for 30 days, but keeping this on is still recommended.' },
  { key: 'controlSessionAccess', store: 'feature', group: 'Safety',
    label: 'Allow local tools to read and send messages through the control entry',
    help: 'On: tools on this computer that hold the token in ~/.kirolex/control.json (e.g. your local Claude Code, a script) can list chats, read the latest messages and send a message into a chat; such messages are marked "Sent via control entry". It never opens a debugging port and cannot run commands or change settings. Off (default): those requests are refused.' },
];

/**
 * 设置的分页 ——「配置里东西太多了，你可以分几个不同的 tab」+「这些内容单独弄一个 setting tab」。
 *
 * 按**你来这儿要干什么**分，不是按字段类型分。顺序 ——「第一个 tab 应该是外观然后是会话，
 * 远程和备份应该放在最后」：外观 → 会话 → 开关 → 机器 → 备份，打开设置默认是外观。
 * 从侧栏 ☁️ / 远端报错点进来的仍然直接落在机器或备份那一页（`initialTab`）。
 */

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'appearance', label: '🎨 Appearance' },
  { id: 'session', label: '💬 Chats' },
  { id: 'switches', label: '🧪 Switches' },
  { id: 'machines', label: '🖥 Machines' },
  /* 备份的**配置**在这儿；「桶里有哪些、恢复哪几条」在侧栏那颗 ☁️ 里 */
  { id: 'backup', label: '☁️ Backup' },
];

export const SettingsDialog: React.FC<SettingsDialogProps> = ({
  initialTab,
  startNewMachine,
  settings,
  onChange,
  onClose,
  confirmDeletes,
  onConfirmDeletesChange,
}) => {
  const t = useT();
  const zoom = normalizeUiZoom(settings.uiZoom);
  // Executor cap (max concurrent connected sessions). 0/'' in the input = auto.
  /* 打开时停在「机器」那一页 —— 那是当前在配的东西；不记住上次选的哪一页（多一份状态，
     换来的只是"上次我在哪"，而每次打开设置的理由通常都不一样）。 */
  /*
    **打开时停在哪一页可以被指定** —— 侧栏那个 ☁️ 按钮要直接落到备份页。
    不传就还是机器页（那是最常改的一页）。
  */
  const [tab, setTab] = useState<SettingsTab>(initialTab || 'appearance');
  /* 「直接进入添加新机器」只管这一次打开：切到别的页再回来就是平常的机器页（不再给一张空表） */
  const [newMachinePending, setNewMachinePending] = useState(!!startNewMachine);
  useEffect(() => { if (tab !== 'machines') setNewMachinePending(false); }, [tab]);
  const [capInfo, setCapInfo] = useState<{ cap: number; auto: number; overridden: boolean } | null>(null);
  const [capInput, setCapInput] = useState('');
  // Wedge-interrupt threshold in seconds. '' while loading, '0' = never interrupt.
  const [wedgeInput, setWedgeInput] = useState('');
  const [wedgeBounds, setWedgeBounds] = useState<{ min: number; max: number; default: number } | null>(null);
  // How long an open tool call may go un-updated before it stops counting as progress.
  const [toolStallInput, setToolStallInput] = useState('');
  const [toolStallBounds, setToolStallBounds] = useState<{ min: number; max: number; default: number } | null>(null);
  // Live feature flags, owned by main (~/.kirolex/config.json). Re-read on open so
  // the panel never shows a value the rest of the app has already moved past.
  const [features, setFeatures] = useState<Record<string, boolean>>({});
  const [featureBusy, setFeatureBusy] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await window.kiroApi.getFeatures?.();
        if (!cancelled && res?.flags) setFeatures(res.flags);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);
  const toggleFeature = async (key: string, enabled: boolean) => {
    setFeatureBusy(key);
    // Optimistic: the switch must feel instant, and main is the source of truth
    // that corrects it a moment later.
    setFeatures((cur) => ({ ...cur, [key]: enabled }));
    try {
      const res = await window.kiroApi.setFeature?.(key, enabled);
      if (res?.flags) setFeatures(res.flags);
      window.dispatchEvent(new CustomEvent('kirolex:features-changed', { detail: res?.flags }));
    } catch {
      setFeatures((cur) => ({ ...cur, [key]: !enabled }));
    } finally {
      setFeatureBusy(null);
    }
  };

  /** Read/write a switch without the UI caring which store owns it. Keeping this
   *  in one place is what lets the panel show a single list. */
  const switchValue = (key: string, store: SwitchStore): boolean => {
    // 还没从主进程读到时按默认值显示：默认关的那个（控制入口读写消息）不能先闪成「开」
    if (store === 'feature') return key in features ? features[key] !== false : !DEFAULT_OFF_FEATURES.has(key);
    if (store === 'prop') return confirmDeletes;
    return (settings as unknown as Record<string, boolean>)[key] !== false;
  };
  const setSwitchValue = (key: string, store: SwitchStore, value: boolean): void => {
    if (store === 'feature') { void toggleFeature(key, value); return; }
    if (store === 'prop') { onConfirmDeletesChange(value); return; }
    onChange({ ...settings, [key]: value });
  };
  useEffect(() => {
    window.kiroApi.getExecutorCapInfo?.().then((info) => {
      setCapInfo(info);
      setCapInput(String(info.cap)); // start from the CURRENT effective value so the user adjusts from it
    }).catch(() => {});
    window.kiroApi.getWedgeTimeout?.().then((info) => {
      setWedgeBounds({ min: info.min, max: info.max, default: info.default });
      setWedgeInput(String(info.seconds));
    }).catch(() => {});
    window.kiroApi.getToolStallTimeout?.().then((info) => {
      setToolStallBounds({ min: info.min, max: info.max, default: info.default });
      setToolStallInput(String(info.seconds));
    }).catch(() => {});
  }, []);

  const applyToolStall = (raw: string) => {
    setToolStallInput(raw);
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n) || n <= 0) return;   // mid-edit
    window.kiroApi.setToolStallTimeout?.(Math.floor(n)).catch(() => {});
  };

  const applyWedge = (raw: string) => {
    setWedgeInput(raw);
    const n = Number(raw);
    // Empty/non-numeric is mid-edit, not a request to change anything. 0 is a real
    // value here (turns the interrupt off), unlike the executor cap where 0 = auto.
    if (raw.trim() === '' || !Number.isFinite(n) || n < 0) return;
    window.kiroApi.setWedgeTimeout?.(Math.floor(n)).catch(() => {});
  };
  // Helper models: used ONLY for KiroLex's own background text chores (chat
  // titles, prompt suggestions), never for the chats themselves. Primary is tried
  // first, fallback only if it cannot answer.
  const [helperModel, setHelperModel] = useState('');
  const [helperFallback, setHelperFallback] = useState('');
  /*
    Offer every model kiro-cli reports on ANY machine: this machine + each remote in
    Settings (helperModels.ts). This machine's list can be region-filtered down to no
    Claude at all while a remote reports them, and runLiteOneShot runs the call on the
    machine that has the model. Until the live lists arrive, model-meta.json ids stand in.
  */
  const [helperLists, setHelperLists] = useState<{ lists: MachineModelList[]; cachedIds: string[]; fallbackOrder: string[] } | null>(null);
  const [helperListsLoading, setHelperListsLoading] = useState(false);
  const helperLiveSeq = React.useRef(0);
  const refreshHelperLists = () => {
    const seq = ++helperLiveSeq.current;
    setHelperListsLoading(true);
    window.kiroApi.listHelperModels?.()
      .then((res) => { if (res && seq === helperLiveSeq.current) setHelperLists(res); })
      .catch(() => {})
      .finally(() => { if (seq === helperLiveSeq.current) setHelperListsLoading(false); });
  };
  useEffect(() => {
    window.kiroApi.getHelperModels?.().then((h: any) => {
      if (!h) return;
      setHelperModel(h.model || '');
      setHelperFallback(h.fallback || '');
    }).catch(() => {});
    window.kiroApi.listHelperModels?.({ cachedOnly: true })
      .then((res) => { if (res) setHelperLists((prev) => prev || res); })
      .catch(() => {});
    refreshHelperLists();
  }, []);
  const helperChoices = mergeHelperModelLists(helperLists?.lists || [], helperLists?.cachedIds || []);
  const helperPending = !helperLists || helperLists.lists.some((l) => l.status === 'pending');
  const helperFailed = (helperLists?.lists || []).filter((l) => l.status === 'failed');
  const helperRoute = helperLists && !helperPending
    ? planHelperRoute({
        wanted: [helperModel, helperFallback],
        local: helperLists.lists.find((l) => l.machine === LOCAL_MACHINE && l.status === 'ok')?.ids || [],
        remotes: helperLists.lists.filter((l) => l.machine !== LOCAL_MACHINE && l.status === 'ok'),
        fallbackOrder: helperLists.fallbackOrder,
      })
    : null;
  const helperOptions = (current: string) => [
    ...(current && !helperChoices.some((c) => c.id === current) ? [<option key={current} value={current}>{current}</option>] : []),
    ...helperChoices.map((c) => <option key={c.id} value={c.id}>{helperChoiceText(c, t('This machine'), t('cached'))}</option>),
  ];
  const helperUnavailable = (m: string) => !!m && !!helperLists && !helperPending && !helperChoices.some((c) => c.id === m);
  /*
    **新会话默认组合**（Claude Code / Codex）——「帮我做一个默认通用的吧」。全局一个，项目在侧栏项目菜单里覆盖。
    只影响之后新建的会话（本机和远端），已有会话不动。设的那个本机没有时下拉里明说按通用。
  */
  const [comboInfo, setComboInfo] = useState<DefaultComboInfo | null>(null);
  const [comboErr, setComboErr] = useState('');
  useEffect(() => {
    window.kiroApi.defaultCombo?.().then((r) => { if (r) setComboInfo(r); }).catch(() => {});
  }, []);
  const saveDefaultCombo = async (id: string) => {
    setComboErr('');
    try {
      const r = await window.kiroApi.setDefaultCombo?.(id);
      if (r && !r.ok) setComboErr(r.error || '');
    } catch (err: any) { setComboErr(String(err?.message || err)); }
    const next = await window.kiroApi.defaultCombo?.().catch(() => null);
    if (next) setComboInfo(next);
  };
  const saveHelper = (model: string, fallback: string) => {
    setHelperModel(model);
    setHelperFallback(fallback);
    window.kiroApi.setHelperModels?.(model, fallback).catch(() => {});
  };

  const applyCap = (raw: string) => {
    setCapInput(raw);
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) return; // ignore empty/invalid input, don't reset
    window.kiroApi.setExecutorCap?.(Math.floor(n)).then((r) => {
      if (r?.ok) {
        setCapInfo((prev) => prev ? { ...prev, cap: r.cap, overridden: true } : prev);
        window.dispatchEvent(new CustomEvent('kirolex:executor-cap-changed', { detail: { cap: r.cap } }));
      }
    }).catch(() => {});
  };
  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className="settings-dialog">
        <div className="settings-header">
          <h3>{t(t('⚙️ Settings'))}</h3>
          {/*
            **分页** ——「配置里东西太多了，你可以分几个不同的 tab」。

            一屏塞十二项的代价不是"长"，是**找不到**：上一版为了让远端机器那一块能被看见，
            只能把它硬提到最上面（「我还是没有找到配置远程服务器的地方」）—— 那是在跟布局较劲，
            而不是解决问题。分页之后每一页只回答一件事，顺序也不再是稀缺资源。

            分法按**你来这儿要干什么**，不是按字段类型：
              · 机器 —— 在哪台机器上跑、那几个 CLI 怎么起（唯一会连到别的机器的一页）
              · 外观 —— 语言、字体、字号
              · 会话 —— 分屏、并发、卡死判定、辅助模型
              · 开关 —— 功能开关（它本来就是一整列，独占一页正好）
          */}
          <div className="settings-tabs" role="tablist">
            {TABS.map((tb) => (
              <button
                key={tb.id}
                role="tab"
                aria-selected={tab === tb.id}
                className={`settings-tab${tab === tb.id ? ' active' : ''}`}
                onClick={() => setTab(tb.id)}
              >{t(tb.label)}</button>
            ))}
          </div>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>

        <div className={`settings-body settings-body-${tab}`}>
          {/*
            机器那一页。上一版为了让它能被看见，只能把它硬排在字体前面
            （「我还是没有找到配置远程服务器的地方」）—— 那是在跟布局较劲。
            分页之后它自己一页，顺序不再是稀缺资源。
          */}
          {tab === 'machines' && <RemoteSettings startNew={newMachinePending} />}
          {tab === 'machines' && <ForwardMcpSettings />}
          {tab === 'machines' && <AgentProfileSettings />}

          {tab === 'appearance' && (
          <div className="settings-item settings-item-wide">
            <label className="settings-label">{t(t('Preview'))}</label>
            <p
              className="settings-preview"
              style={{ fontSize: settings.fontSize, fontFamily: settings.fontFamily || undefined }}
            >
              {t('The quick brown fox jumps over the lazy dog. 0O1lI')}
            </p>
            <p
              className="settings-preview"
              style={{
                fontSize: settings.fontSize,
                fontFamily: settings.monoFontFamily || 'var(--mono-font)',
              }}
            >
              {t('const answer = 42; // code font preview')}
            </p>
          </div>
          )}

          {tab === 'appearance' && (
          <div className="settings-item settings-item-wide">
            <label className="settings-label">{t(t('Font (text)'))}</label>
            <div className="settings-control">
              <select
                className="settings-select"
                value={settings.fontFamily}
                onChange={(e) => onChange({ ...settings, fontFamily: e.target.value })}
              >
                {fontSelectOptions(FONT_PRESETS, settings.fontFamily, t).map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
            </div>
          </div>
          )}

          {tab === 'appearance' && (
          <div className="settings-item settings-item-wide">
            <label className="settings-label">{t(t('Font (code)'))}</label>
            <div className="settings-control">
              <select
                className="settings-select"
                value={settings.monoFontFamily}
                onChange={(e) => onChange({ ...settings, monoFontFamily: e.target.value })}
              >
                {fontSelectOptions(MONO_PRESETS, settings.monoFontFamily, t).map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
            </div>
          </div>
          )}

          {/* Two explicit columns: the switch list is TALL, and with grid
              auto-placement it landed in whichever column had room, next to
              unrelated selects and leaving half the dialog empty. Left column =
              everything else, right column = the switches, nothing interleaved. */}
          {/* 外观那一页：语言 + 字号（字体和预览在上面，同一页） */}
          {tab === 'appearance' && (
          <div className="settings-col">
            {/*
              界面语言。放在这一页第一项：它是**改变其余所有文案**的那一个开关，
              藏在下面等于让人先看半屏自己看不懂的字再找到它。
            */}
            <div className="settings-item">
              <label className="settings-label">{t('Interface language')}</label>
              <div className="settings-control">
                <select
                  className="settings-select"
                  value={settings.language}
                  onChange={(e) => onChange({ ...settings, language: normalizeLang(e.target.value) })}
                >
                  {LANG_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="settings-item">
              <label className="settings-label">{t('Chat font size')}</label>
              <div className="settings-control">
                <button
                  className="settings-btn"
                  onClick={() => onChange({ ...settings, fontSize: Math.max(10, settings.fontSize - 1) })}
                >
                  −
                </button>
                <span className="settings-value">{settings.fontSize}px</span>
                <button
                  className="settings-btn"
                  onClick={() => onChange({ ...settings, fontSize: Math.min(22, settings.fontSize + 1) })}
                >
                  +
                </button>
              </div>
            </div>

            {/* 界面缩放：整窗按比例缩放（文字、图标、按钮、间距一起变）；Ctrl(⌘) + 加号 / 减号 / 0 改的也是这个值 */}
            <div className="settings-item">
              <label className="settings-label" title={t('Ctrl + plus / minus / 0 also work (⌘ on macOS)')}>{t('Interface zoom')}</label>
              <div className="settings-control">
                <button
                  className="settings-btn"
                  disabled={zoom <= UI_ZOOM_MIN}
                  onClick={() => onChange({ ...settings, uiZoom: stepUiZoom(zoom, 'out') })}
                >
                  −
                </button>
                <span className="settings-value">{zoom}%</span>
                <button
                  className="settings-btn"
                  disabled={zoom >= UI_ZOOM_MAX}
                  onClick={() => onChange({ ...settings, uiZoom: stepUiZoom(zoom, 'in') })}
                >
                  +
                </button>
                <button
                  className="settings-btn"
                  style={{ width: 'auto', padding: '0 10px', fontSize: 12 }}
                  disabled={zoom === UI_ZOOM_DEFAULT}
                  title={t('Back to 100% (Ctrl + 0)')}
                  onClick={() => onChange({ ...settings, uiZoom: stepUiZoom(zoom, 'reset') })}
                >
                  {t('Reset')}
                </button>
              </div>
            </div>

          </div>
          )}

          {/* 会话那一页：分屏、并发、卡死判定、辅助模型 —— 都是「会话怎么跑」的旋钮 */}
          {tab === 'session' && (
          <div className="settings-col">
            <div className="settings-item">
              <label className="settings-label">{t('Default combo for new sessions (Claude Code / Codex)')}</label>
              <div className="settings-control">
                <select
                  value={comboInfo ? (defaultComboOptions(comboInfo, 'global', t).find((o) => o.selected)?.value ?? 'default') : 'default'}
                  onChange={(e) => void saveDefaultCombo(e.target.value)}
                  disabled={!comboInfo}
                  style={{ minWidth: 220 }}
                >
                  {(comboInfo ? defaultComboOptions(comboInfo, 'global', t) : [{ value: 'default', label: t('General purpose'), selected: true }])
                    .map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
                </select>
              </div>
              <p className="settings-hint">{t('New Claude Code / Codex sessions (on this machine or remote) start with this combo; existing sessions are not changed. A project can override it from its menu in the sidebar. The combos themselves are edited on the 🧩 Combos page of the Claude Code / Codex config panel.')}</p>
              {comboErr && <p className="settings-hint error">{t('Could not set it: {reason}', { reason: comboErr })}</p>}
            </div>
            {/* 「重试次数默认是 10，可以在 setting 中调整」 */}
            <div className="settings-item">
              <label className="settings-label">{t('Auto-retry attempts (interruptions you didn’t cause)')}</label>
              <div className="settings-control">
                <button className="settings-btn"
                  onClick={() => onChange({ ...settings, autoRetryMax: Math.max(0, (settings.autoRetryMax ?? 10) - 1) })}>−</button>
                <span className="settings-value">{t('{n} times', { n: settings.autoRetryMax ?? 10 })}</span>
                <button className="settings-btn"
                  onClick={() => onChange({ ...settings, autoRetryMax: Math.min(50, (settings.autoRetryMax ?? 10) + 1) })}>＋</button>
              </div>
              <p className="settings-hint">{t('After the executor drops mid-turn, restarts, or is interrupted by the watchdog, the turn is resent automatically, up to this many times (with backoff between retries). 0 = never resend automatically. Turns you stopped yourself don’t count.')}</p>
            </div>
            <div className="settings-item">
              <label className="settings-label">{t('Split grid (click a chat in the sidebar to add it; every pane has its own composer)')}</label>
              <div className="settings-control">
                <select
                  value={settings.splitGrid}
                  onChange={(event) => onChange({ ...settings, splitGrid: event.target.value as Settings['splitGrid'] })}
                  style={{ minWidth: 120 }}
                  title={t('Rows x columns, up to 2 rows x 2 columns. An empty split slot keeps its cell in the grid and takes the width of the row above, so existing cells don’t move when you add a chat later. Remove one with the ✕ at the top-right of its cell.')}
                >
                  <option value="1x1">{t('1 × 1 (no split)')}</option>
                  <option value="1x2">{t('1 row × 2 cols (side by side)')}</option>
                  <option value="2x1">{t('2 rows × 1 col (stacked)')}</option>
                  <option value="2x2">{t('2 rows × 2 cols (maximum)')}</option>
                </select>
              </div>
            </div>

            <div className="settings-item">
              <label className="settings-label">{t('Concurrent connection limit (most chats connected at once)')}</label>
              <div className="settings-control">
                <input
                  type="number"
                  min={1}
                  max={64}
                  value={capInput}
                  onChange={(e) => applyCap(e.target.value)}
                  style={{ width: 90 }}
                />
              </div>
            </div>

            <div className="settings-item">
              <label className="settings-label">
                {t('Treat a turn as stuck after silence for (seconds, 0 = never interrupt)')}
              </label>
              <div className="settings-control">
                <input
                  type="number"
                  min={0}
                  max={wedgeBounds?.max ?? 3600}
                  step={30}
                  value={wedgeInput}
                  onChange={(e) => applyWedge(e.target.value)}
                  style={{ width: 90 }}
                  title={
                    // Both thresholds are spelled out in BOTH tooltips on purpose. Read
                    // on its own either one looks like "the" timeout, and then the
                    // on-screen countdown -- which follows whichever bound is later --
                    // appears to contradict the number on this page.
                    t('A turn is interrupted only when both conditions hold:\n  ① the turn has been completely silent at the protocol level for longer than this;\n  ② and no tool has reported progress within the “tool with no progress” time below.\n\nSo: with no tool running, this value is the actual interrupt time; with a tool running, the actual wait is the later of the two thresholds.\nA turn that produced nothing is resent automatically; one that produced partial output only gets a notice, and you decide whether to resend.\n\nRange: {min}–{max} s, default {def} s.\nSet to 0 to never interrupt automatically; only the 5-minute silence notice remains.\nIf a model with a very slow first token gets interrupted by mistake, raise this value.', { min: wedgeBounds?.min ?? 30, max: wedgeBounds?.max ?? 3600, def: wedgeBounds?.default ?? 600 })
                  }
                />
                <span className="settings-hint">
                  {wedgeInput === '0'
                    ? t('Off: notify only, never interrupt')
                    : t('With no tool running: interrupt after {s} s of silence (with a notice at 5 minutes). With a tool running, the setting below must also be met', { s: wedgeInput || '—' })}
                </span>
              </div>
            </div>

            <div className="settings-item">
              <label className="settings-label">
                {t('Treat a tool as stuck after no progress for (seconds)')}
              </label>
              <div className="settings-control">
                <input
                  type="number"
                  min={toolStallBounds?.min ?? 60}
                  max={toolStallBounds?.max ?? 86400}
                  step={60}
                  value={toolStallInput}
                  onChange={(e) => applyToolStall(e.target.value)}
                  style={{ width: 90 }}
                  disabled={wedgeInput === '0'}
                  title={
                    t('While a tool call is running, the silence check above is paused, because long commands (builds, tests) can stay quiet for a long time.\nBut that pause needs an upper bound: if the backend never sends the “tool finished” update, the pause lasts forever and a turn can hang like that (seen lasting over 5 hours).\n\nSo: once a tool call has had no update for longer than this, it no longer counts as “still running” and the silence check above applies again.\nWith a tool running, the actual interrupt time = the later of the two thresholds, which by default is this one (30 minutes). The countdown in the stall notice usually comes from here, not from the silence threshold above.\n\nRange {min}–{max} s, default {def} s.\nIf a command that genuinely runs longer without reporting any progress gets interrupted by mistake, raise this value.', { min: toolStallBounds?.min ?? 60, max: toolStallBounds?.max ?? 86400, def: toolStallBounds?.default ?? 1800 })
                  }
                />
                <span className="settings-hint">
                  {wedgeInput === '0'
                    ? t('Interrupts are off, so this has no effect')
                    : t('With a tool running: interrupt only after it has had no update for {s} s. This is where the countdown in the stall notice comes from', { s: toolStallInput || '—' })}
                </span>
              </div>
            </div>

            <div className="settings-item">
              <label className="settings-label">{t('Helper model (titles and prompt suggestions; does not affect the chat)')}</label>
              <div className="settings-control">
                <select
                  value={helperModel}
                  onChange={(e) => saveHelper(e.target.value, helperFallback)}
                  style={{ minWidth: 180 }}
                >
                  {helperOptions(helperModel)}
                </select>
                <button
                  type="button"
                  className="settings-btn"
                  onClick={refreshHelperLists}
                  disabled={helperListsLoading}
                  style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                  title={t('Fetch the model list again from this machine and every remote machine')}
                >
                  {helperListsLoading ? t('Refreshing…') : t('Refresh')}
                </button>
                {((helperRoute && helperRoute.effective && helperRoute.effective !== helperModel) || (helperFailed.length > 0 && !helperListsLoading)) && (
                  <span className="settings-hint" style={{ minWidth: 240 }}>
                    {helperRoute && helperRoute.effective && helperRoute.effective !== helperModel && (
                      <div>{t('{model} is not reported by this machine or any remote; actually using {actual}', { model: helperModel, actual: helperRoute.effective })}</div>
                    )}
                    {helperFailed.length > 0 && !helperListsLoading && (
                      <div>{t('Could not get the list from: {machines}', { machines: helperFailed.map((l) => (l.machine === LOCAL_MACHINE ? t('This machine') : l.label)).join(', ') })}</div>
                    )}
                  </span>
                )}
              </div>
            </div>

            <div className="settings-item">
              <label className="settings-label">{t('Helper-model fallback (used when the main one is unavailable)')}</label>
              <div className="settings-control">
                <select
                  value={helperFallback}
                  onChange={(e) => saveHelper(helperModel, e.target.value)}
                  style={{ minWidth: 180 }}
                >
                  <option value="">{t('No fallback')}</option>
                  {helperOptions(helperFallback)}
                </select>
                {helperUnavailable(helperFallback) && (
                  <span className="settings-hint">
                    {t('{model} is not reported by this machine or any remote; it will be skipped', { model: helperFallback })}
                  </span>
                )}
              </div>
            </div>





            {/* ONE list for every boolean behaviour switch, whoever stores it. All of
                them apply to the next operation with no restart; grouping is by what
                the switch affects, not by which file holds it. */}
          </div>
          )}


          {tab === 'backup' && <BackupSettings />}
          {tab === 'switches' && (
          <div className="settings-col">
            <div className="settings-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
              <label className="settings-label">{t('Feature switches (take effect immediately, no restart)')}</label>
              {SWITCH_GROUPS.map((group) => {
                const rows = SWITCHES.filter((sw) => sw.group === group);
                if (!rows.length) return null;
                return (
                  <div key={group} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div className="settings-switch-group">{t(group)}</div>
                    {rows.map((sw) => {
                      const on = switchValue(sw.key, sw.store);
                      return (
                        <div key={sw.key} className="settings-control" style={{ justifyContent: 'space-between', gap: 12 }}>
                          <span className="settings-switch-label" title={t(sw.help)}>
                            {t(sw.label)}
                          </span>
                          {/* 开关做成按钮 ——「开关应该改成按钮形式」（见 ToggleButton 那段） */}
                          <ToggleButton
                            on={on}
                            labels={[t('On'), t('Off')]}
                            ariaLabel={t(sw.label)}
                            title={t(sw.help)}
                            disabled={featureBusy === sw.key}
                            onChange={(next) => setSwitchValue(sw.key, sw.store, next)}
                          />
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            {/* local_browser：接管已登录的浏览器读页面（只读）。总开关默认关 */}
            <LocalBrowserSettings />
          </div>
          )}
        </div>
      </div>
    </>
  );
};
