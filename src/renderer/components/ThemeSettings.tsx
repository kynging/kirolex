/**
 * 设置 → 外观里的配色几项：主题（深色 / 浅色 / 跟随系统）、文字对比度（标准 / 高）、强调色（预设 + 取色器 + 恢复默认）、
 * `~/.kirolex/theme.json`（打开配置文件 / 恢复默认 + 第 N 项被忽略的说明），以及「在其他电脑上同步外观」。
 * 算法都在 `main/themeConfig.ts` / `main/appearanceSync.ts`；这里只是控件。
 */
import React, { useEffect, useState } from 'react';
import { useT } from '../hooks/useLang';
import { ToggleButton } from './ToggleButton.tsx';
import { ACCENT_PRESETS, normalizeAccent, normalizeContrast, normalizeThemeChoice, type IgnoredItem, type ThemeFileState } from '../../main/themeConfig.ts';
import { appearanceSyncEnabled } from '../../main/appearanceSync.ts';
import type { Settings } from '../App';

const REASON_TEXT: Record<IgnoredItem['reason'], string> = {
  'unknown-var': 'not a color variable that can be overridden',
  'bad-value': 'value is not a CSS color (#rgb / #rrggbb / #rrggbbaa / rgb() / rgba() / hsl() / hsla())',
  'unknown-section': 'unknown group (only "dark", "light" and "common")',
  'bad-section': 'a group must be an object { ... }',
  'bad-version': 'unsupported version (only 1)',
};

/** 主题 / 对比度 / 强调色三项（放在外观页的一栏里）。 */
export const ThemeColorControls: React.FC<{ settings: Settings; onChange: (s: Settings) => void }> = ({ settings, onChange }) => {
  const t = useT();
  const theme = normalizeThemeChoice(settings.theme);
  const contrast = normalizeContrast(settings.contrast);
  const accent = normalizeAccent(settings.accentColor);
  return (
    <>
      <div className="settings-item">
        <label className="settings-label">{t('Theme')}</label>
        <div className="settings-control">
          <select
            className="settings-select"
            value={theme}
            onChange={(e) => onChange({ ...settings, theme: normalizeThemeChoice(e.target.value) })}
          >
            <option value="dark">{t('Dark')}</option>
            <option value="light">{t('Light')}</option>
            <option value="system">{t('Follow system')}</option>
          </select>
        </div>
      </div>

      <div className="settings-item">
        <label className="settings-label" title={t('High makes secondary text (commands, tools, timestamps) easier to read')}>{t('Text contrast')}</label>
        <div className="settings-control">
          <select
            className="settings-select"
            value={contrast}
            onChange={(e) => onChange({ ...settings, contrast: normalizeContrast(e.target.value) })}
          >
            <option value="standard">{t('Standard')}</option>
            <option value="high">{t('High')}</option>
          </select>
        </div>
      </div>

      <div className="settings-item">
        <label className="settings-label" title={t('Buttons, links and focus rings. Engine colors and permission colors are not affected.')}>{t('Accent color')}</label>
        <div className="settings-control theme-accent-row">
          {ACCENT_PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              className={`theme-accent-swatch${accent === p.value ? ' on' : ''}`}
              style={{ background: p.value }}
              title={t(p.label)}
              aria-label={t(p.label)}
              aria-pressed={accent === p.value}
              onClick={() => onChange({ ...settings, accentColor: p.value })}
            />
          ))}
          <input
            type="color"
            className="theme-accent-picker"
            value={accent || (document.documentElement.getAttribute('data-theme') === 'light' ? '#6b5fd4' : '#7c6fe0')}
            title={t('Pick a color')}
            aria-label={t('Pick a color')}
            onChange={(e) => onChange({ ...settings, accentColor: normalizeAccent(e.target.value) })}
          />
          <button
            type="button"
            className="settings-btn"
            style={{ width: 'auto', padding: '0 10px', fontSize: 12 }}
            disabled={!accent}
            onClick={() => onChange({ ...settings, accentColor: '' })}
          >
            {t('Default')}
          </button>
        </div>
      </div>
    </>
  );
};

/** theme.json 两个按钮 + 状态 / 忽略项，以及外观同步开关（外观页整行宽）。 */
export const ThemeFileControls: React.FC<{ settings: Settings; onChange: (s: Settings) => void }> = ({ settings, onChange }) => {
  const t = useT();
  const [file, setFile] = useState<ThemeFileState | null>(null);
  const [note, setNote] = useState('');
  const [sync, setSync] = useState<{ s3Enabled: boolean; lastError?: string } | null>(null);
  useEffect(() => {
    let alive = true;
    void window.kiroApi.getThemeConfig?.().then((st) => { if (alive) setFile(st); }).catch(() => {});
    void window.kiroApi.appearanceSyncStatus?.().then((st) => { if (alive) setSync(st); }).catch(() => {});
    const off = window.kiroApi.onThemeConfig?.((st) => setFile(st));
    return () => { alive = false; try { off?.(); } catch { /* 卸载 */ } };
  }, []);

  const openFile = async () => {
    const r = await window.kiroApi.openThemeConfig?.();
    if (!r) return;
    setNote(r.ok ? (r.created ? t('Created a sample file: {path}', { path: r.path }) : '') : t('Could not open {path}: {error}', { path: r.path, error: r.error || '' }));
  };
  const resetFile = async () => {
    const r = await window.kiroApi.resetThemeConfig?.();
    if (!r) return;
    if (!r.ok) setNote(t('Could not reset: {error}', { error: r.error || '' }));
    else setNote(r.backup ? t('Back to default colors. The old file was renamed to {path}', { path: r.backup }) : t('There is no theme.json; already using default colors'));
  };

  return (
    <div className="settings-item settings-item-wide">
      <label className="settings-label">{t('Color overrides (theme.json)')}</label>
      <div className="settings-control" style={{ flexWrap: 'wrap', gap: 8 }}>
        <button type="button" className="remote-btn" onClick={() => void openFile()}>{t('Open config file')}</button>
        <button type="button" className="remote-btn" disabled={!file?.exists} onClick={() => void resetFile()}>{t('Reset to default')}</button>
        <span className="settings-hint">
          {file?.exists ? file.path : t('Not created yet — "Open config file" creates a commented sample')}
        </span>
      </div>
      {note && <div className="settings-hint theme-file-note">{note}</div>}
      {file?.error && (
        <div className="theme-file-error">{t('theme.json is not valid JSON, still using the last valid version: {error}', { error: file.error })}</div>
      )}
      {!!file?.ignored.length && (
        <ul className="theme-file-ignored">
          {file.ignored.map((i) => (
            <li key={`${i.n}-${i.where}`}>
              {t('Item {n} ignored: {where} — {reason}', { n: i.n, where: i.value ? `${i.where} = ${i.value}` : i.where, reason: t(REASON_TEXT[i.reason]) })}
            </li>
          ))}
        </ul>
      )}

      <div className="settings-control" style={{ justifyContent: 'space-between', gap: 12, marginTop: 14 }}>
        <span className="settings-switch-label" title={t('Theme, contrast, accent color, fonts, chat font size and theme.json. Interface zoom stays on this computer.')}>
          {t('Sync appearance across computers')}
        </span>
        <ToggleButton
          on={appearanceSyncEnabled(settings)}
          labels={[t('On'), t('Off')]}
          ariaLabel={t('Sync appearance across computers')}
          disabled={!sync?.s3Enabled}
          onChange={(next) => onChange({ ...settings, syncAppearance: next })}
        />
      </div>
      <div className="settings-hint" style={{ marginTop: 4 }}>
        {sync && !sync.s3Enabled
          ? t('Not enabled: set up S3 backup (☁️ in the sidebar) first. Uses the same bucket and credentials.')
          : t('Theme, contrast, accent color, fonts, chat font size and theme.json. Interface zoom stays on this computer.')}
        {sync?.lastError ? ` ${t('Last sync failed: {error}', { error: sync.lastError })}` : ''}
      </div>
    </div>
  );
};
