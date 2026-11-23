/**
 * **外观配置跨电脑同步** ——「这套外观配置能在多台电脑间同步」。
 *
 * 同步的**只有**这些（`SYNCED_SETTING_KEYS` + theme.json 原文），打成一份 `appearance.json` 放在桶里
 * （`<prefix>/v1/appearance.json`，和会话同一个桶、同一套凭证，不需要新的 IAM 权限）：
 *   · 设置里的 主题模式 / 深色和浅色各用哪个主题（id）/ 文字对比度 / 强调色 / 界面字体 / 等宽字体 / 聊天字号；
 *   · `~/.kirolex/theme.json` 的原文（没有 = null）。
 * **不同步**：界面缩放 uiZoom（每台屏幕 / 远程桌面分辨率不同）、语言、以及机器 / 路径 / 远端 / 权限等一切别的设置
 * （`config.json` 照旧完全不同步）。
 *
 * 冲突：整份按「最后一次修改的时刻」取新的（`planAppearanceSync`）；两边规整后一样（只差空白）不互传。
 * 本机的修改时刻由主进程在看到变化时记下（`noteLocalAppearance`，存 `~/.kirolex/appearance-sync.json`，不上传）。
 * 「在其他电脑上同步外观」关掉 → 既不上传也不应用桶里的。
 *
 * 纯逻辑，不碰 fs / 网络 / electron；`index.ts` 收集状态后调用。
 */
import { THEME_ID_RE } from './themeConfig.ts';

/** 桶里那份的相对路径（S3 key 里 `v1/` 之后那段）。 */
export const APPEARANCE_REL = 'appearance.json';

/** 跟着同步的设置字段。**没有 uiZoom**（留在本机）。 */
export const SYNCED_SETTING_KEYS = ['theme', 'themeDark', 'themeLight', 'contrast', 'accentColor', 'fontFamily', 'monoFontFamily', 'fontSize'] as const;
export type SyncedSettingKey = typeof SYNCED_SETTING_KEYS[number];

export interface SyncedSettings {
  theme?: 'dark' | 'light' | 'system';
  contrast?: 'standard' | 'high';
  accentColor?: string;
  fontFamily?: string;
  monoFontFamily?: string;
  /** 「深色时用 / 浅色时用」的主题 id（内置预设或 theme.json 里的自定义主题，见 themeConfig.ts 的 THEME_PRESETS）。 */
  themeDark?: string;
  themeLight?: string;
  fontSize?: number;
}

export interface AppearancePayload {
  settings: SyncedSettings;
  /** theme.json 原文；本机没有这个文件 = null。 */
  themeJson: string | null;
}

/** 本机快照 / 桶里那份：内容 + 最后一次修改的时刻（毫秒）。 */
export interface AppearanceSnapshot {
  updatedAt: number;
  payload: AppearancePayload;
}

export interface AppearanceBundle extends AppearanceSnapshot {
  version: 1;
  /** 哪台电脑传的（只给人看）。 */
  from?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** theme.json 原文最多带多大（再大就不是一份颜色配置了）。 */
export const MAX_THEME_JSON_CHARS = 64 * 1024;

/**
 * 从整份设置里**只挑**同步的那几项，并校验类型 / 范围（坏值不进载荷）。
 * 字号范围和设置页一致（10～22）；字体是字符串（下拉框的预设或旧值，原样同步，限长）。
 */
export function pickSyncedSettings(settings: unknown): SyncedSettings {
  const s = isObj(settings) ? settings : {};
  const out: SyncedSettings = {};
  if (s.theme === 'dark' || s.theme === 'light' || s.theme === 'system') out.theme = s.theme;
  if (s.contrast === 'standard' || s.contrast === 'high') out.contrast = s.contrast;
  if (typeof s.accentColor === 'string' && (s.accentColor === '' || /^#[0-9a-fA-F]{6}$/.test(s.accentColor))) out.accentColor = s.accentColor.toLowerCase();
  if (typeof s.fontFamily === 'string' && s.fontFamily.length <= 300) out.fontFamily = s.fontFamily;
  if (typeof s.monoFontFamily === 'string' && s.monoFontFamily.length <= 300) out.monoFontFamily = s.monoFontFamily;
  if (typeof s.themeDark === 'string' && THEME_ID_RE.test(s.themeDark)) out.themeDark = s.themeDark;
  if (typeof s.themeLight === 'string' && THEME_ID_RE.test(s.themeLight)) out.themeLight = s.themeLight;
  if (typeof s.fontSize === 'number' && Number.isInteger(s.fontSize) && s.fontSize >= 10 && s.fontSize <= 22) out.fontSize = s.fontSize;
  return out;
}

/**
 * 同步那几项的默认值（和渲染端 `App.tsx` 的 `DEFAULT_SETTINGS` 一致，测试核对）。载荷里缺的项一律补成默认值：
 * 新电脑启动时 ui-state 里还没有设置（`{}`），渲染端随后把带默认值的整份设置存一次 —— 两者必须算「一样」，
 * 否则这次自动保存会被当成「刚刚的真实修改」，首次同步就把默认值传上去、盖掉别的电脑上设好的外观。
 */
export const SYNCED_DEFAULTS: Required<SyncedSettings> = {
  theme: 'dark', themeDark: 'kirolex-dark', themeLight: 'kirolex-light', contrast: 'standard', accentColor: '', fontFamily: '', monoFontFamily: '', fontSize: 12,
};

export function makePayload(settings: unknown, themeJson: string | null | undefined): AppearancePayload {
  const t = typeof themeJson === 'string' && themeJson.length <= MAX_THEME_JSON_CHARS ? themeJson : null;
  return { settings: { ...SYNCED_DEFAULTS, ...pickSyncedSettings(settings) }, themeJson: t };
}

/** 比较用：去掉全部空白（「只差空白」算一样）。 */
export function normalizeThemeText(text: string | null): string | null {
  return text === null ? null : (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\s+/g, '');
}

function canonicalSettings(s: SyncedSettings): string {
  const picked = pickSyncedSettings(s) as Record<string, unknown>;
  return JSON.stringify(SYNCED_SETTING_KEYS.map((k) => [k, picked[k] ?? null]));
}

/** 两份载荷是不是一样（设置逐项比；theme.json 只差空白也算一样）。 */
export function samePayload(a: AppearancePayload, b: AppearancePayload): boolean {
  return canonicalSettings(a.settings) === canonicalSettings(b.settings)
    && normalizeThemeText(a.themeJson) === normalizeThemeText(b.themeJson);
}

/**
 * 本机看到一份当前载荷（设置保存了 / theme.json 变了 / 启动时）：和快照一样 → 原样返回（`changed: false`）；
 * 不一样 → 新快照。修改时刻按**改的是什么**定：
 *   · 设置变了 → `now`（设置只能在应用里改，保存的那一刻就是修改时刻）；
 *   · 只有 theme.json 变了 → 用文件的实际 mtime（`themeMtime`）——它可能是应用关着时编辑的，
 *     启动时才发现；记成启动时刻会让这份旧编辑显得比别的电脑之后的修改更新、把它们盖掉。
 *     mtime 早于上一次快照（拷贝保留了旧 mtime）时取「上一次快照 + 1」，晚于 now（时钟不准）时取 now；
 *     文件被删了（没有 mtime）→ `now`。
 * 第一次（没有快照）→ 修改时刻记 `firstAt`（调用方给 theme.json 的 mtime，没有就是 0）：
 * 新装的电脑不该因为「刚记下快照」就显得比别的电脑上真改过的更新、把它们盖掉。
 */
export function noteLocalAppearance(
  prev: AppearanceSnapshot | undefined,
  current: AppearancePayload,
  now: number,
  firstAt = 0,
  themeMtime?: number,
): { snapshot: AppearanceSnapshot; changed: boolean } {
  if (!prev) return { snapshot: { updatedAt: firstAt, payload: current }, changed: true };
  if (samePayload(prev.payload, current)) return { snapshot: prev, changed: false };
  const settingsChanged = canonicalSettings(prev.payload.settings) !== canonicalSettings(current.settings);
  let at = now;
  if (!settingsChanged && current.themeJson !== null && typeof themeMtime === 'number' && Number.isFinite(themeMtime)) {
    at = Math.min(now, Math.max(themeMtime, prev.updatedAt + 1));
  }
  return { snapshot: { updatedAt: at, payload: current }, changed: true };
}

export type AppearancePlan =
  | { action: 'none'; reason: 'disabled' | 'same' | 'nothing' }
  | { action: 'upload'; bundle: AppearanceBundle }
  | { action: 'apply'; payload: AppearancePayload; updatedAt: number };

/**
 * 这一轮怎么同步外观：
 *   · 开关关着 → 什么都不做（不上传、不应用）；
 *   · 桶里没有（或读不懂）→ 传本机的；
 *   · 两边一样（只差空白）→ 不动；
 *   · 本机改得更晚 → 传；桶里的更晚 → 应用到本机；时刻一样内容不同 → 应用桶里的（两台电脑收敛到同一份）。
 */
export function planAppearanceSync(input: {
  enabled: boolean;
  local: AppearanceSnapshot | undefined;
  remote: AppearanceBundle | null;
  machine?: string;
}): AppearancePlan {
  const { enabled, local, remote } = input;
  if (!enabled) return { action: 'none', reason: 'disabled' };
  if (!local) return remote ? { action: 'apply', payload: remote.payload, updatedAt: remote.updatedAt } : { action: 'none', reason: 'nothing' };
  const upload = (): AppearancePlan => ({ action: 'upload', bundle: { version: 1, updatedAt: local.updatedAt, from: input.machine, payload: local.payload } });
  if (!remote) return upload();
  if (samePayload(local.payload, remote.payload)) return { action: 'none', reason: 'same' };
  if (local.updatedAt > remote.updatedAt) return upload();
  return { action: 'apply', payload: remote.payload, updatedAt: remote.updatedAt };
}

/** 读桶里那份。格式不对 → null（当作桶里没有，下一次上传会换成好的）。 */
export function parseBundle(text: string | null | undefined): AppearanceBundle | null {
  if (!text) return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObj(v) || v.version !== 1 || typeof v.updatedAt !== 'number' || !Number.isFinite(v.updatedAt)) return null;
  const p = v.payload;
  if (!isObj(p)) return null;
  const themeJson = typeof p.themeJson === 'string' ? p.themeJson : null;
  return {
    version: 1,
    updatedAt: v.updatedAt,
    from: typeof v.from === 'string' ? v.from : undefined,
    payload: makePayload(p.settings, themeJson),
  };
}

export function serializeBundle(b: AppearanceBundle): string {
  return `${JSON.stringify({ version: 1, updatedAt: b.updatedAt, from: b.from, payload: { settings: pickSyncedSettings(b.payload.settings), themeJson: b.payload.themeJson } }, null, 2)}\n`;
}

/** 本机快照文件的读写格式（`~/.kirolex/appearance-sync.json`）。坏的 = 没有。 */
export function parseSnapshot(text: string | null | undefined): AppearanceSnapshot | undefined {
  if (!text) return undefined;
  try {
    const v = JSON.parse(text);
    if (!isObj(v) || typeof v.updatedAt !== 'number' || !isObj(v.payload)) return undefined;
    const p = v.payload;
    return { updatedAt: v.updatedAt, payload: makePayload(p.settings, typeof p.themeJson === 'string' ? p.themeJson : null) };
  } catch { return undefined; }
}

/**
 * 把桶里来的设置并进本机整份设置：只改同步的那几项（桶里没写的那项保持本机的），
 * uiZoom、语言、开关等其他字段一律不动。
 */
export function applySyncedSettings<T extends Record<string, unknown>>(local: T, synced: SyncedSettings): T {
  const picked = pickSyncedSettings(synced) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...local };
  for (const k of SYNCED_SETTING_KEYS) if (k in picked) out[k] = picked[k];
  return out as T;
}

/** 「在其他电脑上同步外观」：缺省开，只有明确写了 false 才算关。 */
export function appearanceSyncEnabled(settings: unknown): boolean {
  return !(isObj(settings) && settings.syncAppearance === false);
}

export interface AppearanceSyncDeps {
  /** 「在其他电脑上同步外观」此刻开没开（每次调用都现读，不缓存）。 */
  isEnabled: () => boolean;
  /** 本机快照（调用前已经把最新改动记进去）。 */
  local: () => AppearanceSnapshot | undefined;
  /** 读桶里那份原文（没有 = null）。 */
  getRemote: () => Promise<string | null>;
  put: (text: string) => Promise<void>;
  apply: (payload: AppearancePayload, updatedAt: number, from?: string) => void;
  machine?: string;
}

/**
 * 跑一轮外观同步。**读桶是网络请求，可能要好几秒** —— 用户在这期间关掉开关，回来时必须立即作罢：
 * 开关在请求之前看一次、请求回来之后、决定上传 / 应用之前再看一次（`plan` 用的就是这次读到的值）。
 */
export async function runAppearanceSync(deps: AppearanceSyncDeps): Promise<{ plan: AppearancePlan; uploaded: boolean }> {
  const off: AppearancePlan = { action: 'none', reason: 'disabled' };
  if (!deps.isEnabled()) return { plan: off, uploaded: false };
  const raw = await deps.getRemote();
  const enabled = deps.isEnabled();
  if (!enabled) return { plan: off, uploaded: false };
  const remote = parseBundle(raw);
  const plan = planAppearanceSync({ enabled, local: deps.local(), remote, machine: deps.machine });
  if (plan.action === 'upload') {
    await deps.put(serializeBundle(plan.bundle));
    return { plan, uploaded: true };
  }
  if (plan.action === 'apply') deps.apply(plan.payload, plan.updatedAt, remote?.from);
  return { plan, uploaded: false };
}
