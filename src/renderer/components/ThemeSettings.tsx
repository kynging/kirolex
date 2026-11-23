/**
 * 设置 → 外观里的配色几项：主题模式（深色 / 浅色 / 跟随系统）+「深色时用 / 浅色时用」哪个主题（带色块预览，悬停即时预览）、文字对比度（标准 / 高）、强调色（预设 + 取色器 + 恢复默认）、
 * `~/.kirolex/theme.json`（打开配置文件 / 恢复默认 + 第 N 项被忽略的说明），以及「在其他电脑上同步外观」。
 * 算法都在 `main/themeConfig.ts` / `main/appearanceSync.ts`；这里只是控件。
 */
import React, { useEffect, useRef, useState } from 'react';
import { useLang, useT } from '../hooks/useLang';
import { ToggleButton } from './ToggleButton.tsx';
import {
  ACCENT_PRESETS, DEFAULT_THEME_ID, allThemes, normalizeAccent, normalizeContrast, normalizeThemeChoice, normalizeThemeId, sanitizeThemeDefs, themeSwatches,
  type CustomThemeDef, type EffectiveTheme, type IgnoredItem, type ThemeFileState, type ThemePreset,
} from '../../main/themeConfig.ts';
import { appearanceSyncEnabled } from '../../main/appearanceSync.ts';
import type { Settings } from '../App';

const REASON_TEXT: Record<IgnoredItem['reason'], string> = {
  'unknown-var': 'not a color variable that can be overridden',
  'bad-value': 'value is not a CSS color (#rgb / #rrggbb / #rrggbbaa / rgb() / rgba() / hsl() / hsla())',
  'unknown-section': 'unknown group (only "dark", "light", "common" and "themes")',
  'bad-section': 'a group must be an object { ... }',
  'bad-version': 'unsupported version (only 1)',
  'bad-theme': 'a theme must be an object { "name", "base", "extends", "vars" }',
  'bad-theme-id': 'theme id may only use lowercase letters, digits, - and _ (up to 40)',
  'builtin-theme-id': 'this id is a built-in theme; pick another id',
  'bad-theme-name': 'name must be a non-empty string (up to 40 characters)',
  'bad-base': 'base must be "dark" or "light"',
  'unknown-theme-key': 'unknown key in a theme (only name, base, extends, vars)',
  'unknown-extends': 'extends points to a theme that does not exist; this theme is not used',
  'extends-cycle': 'extends goes in a circle; this theme is not used',
};

/**
 * 「深色时用 / 浅色时用」的主题下拉。原生 <select> 的选项里画不了色块，所以是自己画的列表：
 * 每一项带一条色块（背景 / 正文 / 次要文字 / 强调色）；悬停或用方向键移到某一项 → 整个界面即时预览那个主题，
 * 点击 / Enter 选中；Esc、点外面、移出列表 → 取消预览，恢复原来的主题。
 */
const ThemePicker: React.FC<{
  label: string;
  value: string;
  themes: ThemePreset[];
  onPick: (id: string) => void;
  onPreview?: (id: string | null) => void;
}> = ({ label, value, themes, onPick, onPreview }) => {
  const t = useT();
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const nameOf = (th: ThemePreset) => (lang === 'zh' ? th.name.zh : th.name.en) + (th.custom ? ` · ${t('custom')}` : '');
  const current = themes.find((th) => th.id === value) || themes[0];
  const close = () => { setOpen(false); setActive(-1); onPreview?.(null); };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  });
  /* 卸载（关掉设置）时一定恢复 */
  useEffect(() => () => onPreview?.(null), []);
  const preview = (i: number) => { setActive(i); if (themes[i]) onPreview?.(themes[i].id); };
  const pick = (id: string) => { onPick(id); setOpen(false); setActive(-1); onPreview?.(null); };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); preview(Math.max(0, themes.findIndex((th) => th.id === value))); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); preview(Math.min(themes.length - 1, active + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); preview(Math.max(0, active - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (themes[active]) pick(themes[active].id); }
  };
  const strip = (th: ThemePreset) => (
    <span className="theme-swatch-strip" aria-hidden="true">
      {themeSwatches(th).map((c, i) => <span key={i} style={{ background: c }} />)}
    </span>
  );
  return (
    <div className="theme-picker" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="settings-select theme-picker-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => (open ? close() : (setOpen(true), setActive(-1)))}
      >
        {current && strip(current)}
        <span className="theme-picker-name">{current ? nameOf(current) : value}</span>
        <span className="theme-picker-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="theme-picker-list" role="listbox" aria-label={label} onMouseLeave={() => { setActive(-1); onPreview?.(null); }}>
          {themes.map((th, i) => (
            <button
              key={th.id}
              type="button"
              role="option"
              aria-selected={th.id === value}
              className={`theme-picker-option${th.id === value ? ' on' : ''}${i === active ? ' active' : ''}`}
              onMouseEnter={() => preview(i)}
              onFocus={() => preview(i)}
              onClick={() => pick(th.id)}
            >
              {strip(th)}
              <span className="theme-picker-name">{nameOf(th)}</span>
              {th.id === value && <span className="theme-picker-check" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/** 主题模式 + 深色 / 浅色各用哪个主题 + 对比度 + 强调色（放在外观页的一栏里）。 */
export const ThemeColorControls: React.FC<{ settings: Settings; onChange: (s: Settings) => void; onPreviewTheme?: (id: string | null) => void }> = ({ settings, onChange, onPreviewTheme }) => {
  const t = useT();
  const lang = useLang();
  const theme = normalizeThemeChoice(settings.theme);
  const contrast = normalizeContrast(settings.contrast);
  const accent = normalizeAccent(settings.accentColor);
  /* theme.json 里的自定义主题 —— 主进程 watch，改了推过来 */
  const [custom, setCustom] = useState<CustomThemeDef[]>([]);
  useEffect(() => {
    let alive = true;
    void window.kiroApi.getThemeConfig?.().then((st) => { if (alive && st) setCustom(sanitizeThemeDefs(st.themes)); }).catch(() => {});
    const off = window.kiroApi.onThemeConfig?.((st) => setCustom(sanitizeThemeDefs(st?.themes)));
    return () => { alive = false; try { off?.(); } catch { /* 卸载 */ } };
  }, []);
  const list = allThemes(custom);
  const slotRow = (slot: EffectiveTheme) => {
    const key = slot === 'dark' ? 'themeDark' : 'themeLight';
    const id = normalizeThemeId(settings[key], slot);
    const options = list.filter((th) => th.base === slot);
    const found = list.find((th) => th.id === id);
    const fallback = list.find((th) => th.id === DEFAULT_THEME_ID[slot])!;
    const label = slot === 'dark' ? t('Theme when dark') : t('Theme when light');
    return (
      <div className="settings-item">
        <label className="settings-label">{label}</label>
        <div className="settings-control">
          <ThemePicker
            label={label}
            value={found ? id : fallback.id}
            themes={found && found.base !== slot ? [...options, found] : options}
            onPick={(next) => onChange({ ...settings, [key]: next })}
            onPreview={onPreviewTheme}
          />
        </div>
        {!found && (
          <div className="settings-hint theme-missing-hint">
            {t('Theme "{id}" is not on this computer (its theme.json has no such theme); using {name} for now.', { id, name: lang === 'zh' ? fallback.name.zh : fallback.name.en })}
          </div>
        )}
      </div>
    );
  };
  return (
    <>
      <div className="settings-item">
        <label className="settings-label">{t('Theme mode')}</label>
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
      {slotRow('dark')}
      {slotRow('light')}

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
