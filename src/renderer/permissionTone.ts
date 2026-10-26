/**
 * **权限风险配色** ——「bypass permission 之类权限最大的选项按钮要变成红色，其他选项颜色也看看要不要调」。
 *
 * 一处定义、四档，按「放手的程度」分：
 *   - `danger`（红 + ⚠）：跳过所有权限确认 —— Claude Code `bypassPermissions`、Codex `agent-full-access`、
 *     kiro 的 Auto（`auto-approve`）、权限条里名字 / optionId 带 bypass / full access / 跳过权限的选项；
 *   - `caution`（琥珀）：半放 —— 自动批编辑 / 自动审 / 能写工作区、权限条的「总是允许」、`exit-plan-auto`；
 *   - `normal`（默认按钮样式）：允许一次、`exit-plan-default`、default / ask / read-only；
 *   - `neutral`（低调灰）：拒绝 / No, keep planning、plan 模式。
 *
 * 用在：输入区的权限模式下拉（ChatArea `ChatInputBox`）、kiro 的 Auto/Ask 按钮、权限请求条（PermissionBar）。
 * 这是**风险色**，不是引擎强调色：不随引擎变、也不受「按引擎区分颜色」开关影响（见 engineTheme.ts 的名单）。
 * 只管颜色 / 图标 / 悬停提示，不碰权限行为、默认值、选项顺序。
 */

export type PermissionTone = 'danger' | 'caution' | 'normal' | 'neutral';
export const PERMISSION_TONES: readonly PermissionTone[] = ['danger', 'caution', 'normal', 'neutral'];

/** 名字 / id 里出现这些就是「权限全放」—— 未知的新模式、新选项也靠它兜底判红。 */
const DANGER_RE = /bypass|full[\s_-]?access|跳过(所有)?权限|dangerously/i;

/** 三个引擎已知的模式值。kiro 的是 KiroLex 自己的 Auto / Ask（`permissionMode`）。 */
export const ENGINE_MODE_TONES: Record<'kiro' | 'claude' | 'codex', Record<string, PermissionTone>> = {
  kiro: { 'auto-approve': 'danger', ask: 'normal' },
  claude: { default: 'normal', acceptEdits: 'caution', plan: 'neutral', auto: 'caution', bypassPermissions: 'danger' },
  codex: {
    'read-only': 'normal', auto: 'caution', agent: 'caution', 'workspace-write': 'caution',
    'full-access': 'danger', 'agent-full-access': 'danger',
  },
};

/** 权限模式的风险档。`name` 是下拉里显示的名字（可缺）；不认识的模式默认 normal，带 bypass / full access 的判 danger。 */
export function modeTone(engine: string | null | undefined, mode: string, name?: string): PermissionTone {
  const table = ENGINE_MODE_TONES[engine === 'claude' || engine === 'codex' ? engine : 'kiro'];
  if (Object.prototype.hasOwnProperty.call(table, mode)) return table[mode];
  if (DANGER_RE.test(`${mode} ${name || ''}`)) return 'danger';
  return 'normal';
}

export interface PermissionOptionToneInput { optionId: string; name?: string; kind?: string }

/** 权限条上一个选项的风险档：拒绝永远低调；名字 / id 带 bypass 的红；总是允许 / exit-plan-auto 琥珀；其余（允许一次）正常。 */
export function optionTone(o: PermissionOptionToneInput): PermissionTone {
  if (o.kind?.startsWith('reject')) return 'neutral';
  if (DANGER_RE.test(`${o.optionId} ${o.name || ''}`)) return 'danger';
  if (o.optionId === 'exit-plan-default') return 'normal';
  if (o.optionId === 'exit-plan-auto' || o.kind === 'allow_always') return 'caution';
  return 'normal';
}

/** 下拉里每一项前面的图标：颜色不是唯一区分（下拉弹出来的选项颜色系统不一定画）。 */
export const TONE_ICONS: Record<PermissionTone, string> = { danger: '⚠', caution: '◐', normal: '○', neutral: '◌' };

/**
 * 每一档的颜色，暗色 / 亮色各一套。`text` 当文字（≥ 4.5:1）、`border` 当图形（≥ 3:1），都对落上去的底色算
 * （`tests/permissionTone.test.ts` 逐个算，并核对 global.css 里 `--perm-*` 的值和这里一致）。
 * danger / caution 还有一层浅底：`border` 色、透明度 `BG_ALPHA`（测试按叠上去之后的颜色算文字对比度）。
 * normal 用默认按钮样式，不在这里定义；neutral 只是文字变灰（不加底、不加深边框 —— 它要比 normal 更不起眼）。
 * 暗色 danger 的边框 / 浅底就是 `--error`（#ef5350）—— 它当文字落在浅红底上只有 ~2.9:1，所以文字提亮一档；
 * caution 的边框沿用原来 semi 的 #d9a441，文字同样提亮一档。
 */
export const TONE_COLORS: Record<'dark' | 'light', Record<Exclude<PermissionTone, 'normal'>, { text: string; border?: string }>> = {
  dark: {
    danger: { text: '#ff8f8a', border: '#ef5350' },
    caution: { text: '#e8b85a', border: '#d9a441' },
    neutral: { text: '#a8a8a8' },
  },
  light: {
    danger: { text: '#a51d17', border: '#c62828' },
    caution: { text: '#7a5000', border: '#a06a00' },
    neutral: { text: '#555555' },
  },
};
export const BG_ALPHA = 0.12;

/** 挂在按钮 / 下拉 / 选项上的 class（global.css 的 `.perm-*`）；normal 不挂，用默认样式。 */
export function toneClass(tone: PermissionTone): string {
  return tone === 'normal' ? '' : `perm-${tone}`;
}
