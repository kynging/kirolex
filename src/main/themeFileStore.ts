/**
 * `~/.kirolex/theme.json` 的读 / 生成示例 / 「恢复默认」（改名成 `.bak-<时间>`，不删）。
 * 不 import electron；`home` 由调用方给（测试传临时目录）。校验在 `themeConfig.ts`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { emptyOverrides, parseThemeFile, themeBackupName, themeSampleText, type ThemeFileState } from './themeConfig.ts';

export type { ThemeFileState };

export const THEME_FILE = 'theme.json';

export function themeFilePath(home: string): string {
  return path.join(home, '.kirolex', THEME_FILE);
}


/**
 * 读一次。文件不存在 → 没有覆盖（这就是默认）；读得到但 JSON 坏了 → 保留 `last` 的覆盖和忽略列表，带上 `error`。
 * `text` 一并返回，给同步用（坏 JSON 的原文也照样同步 —— 那就是用户写的文件）。
 */
export function readThemeFile(home: string, last: ThemeFileState | null): { state: ThemeFileState; text: string | null } {
  const file = themeFilePath(home);
  let text: string | null = null;
  try { text = fs.readFileSync(file, 'utf-8'); } catch { text = null; }
  if (text === null) return { state: { path: file, exists: false, overrides: emptyOverrides(), ignored: [] }, text };
  const r = parseThemeFile(text);
  if (!r.ok) {
    return {
      state: { path: file, exists: true, overrides: last?.overrides || emptyOverrides(), ignored: last?.ignored || [], error: r.error },
      text,
    };
  }
  return { state: { path: file, exists: true, overrides: r.overrides, ignored: r.ignored }, text };
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf-8');
  fs.renameSync(tmp, file);
}

/** 「打开配置文件」：不存在就生成带注释的示例（示例里的覆盖都注释掉了，生成它不改变任何颜色）。返回路径。 */
export function ensureThemeFile(home: string): { path: string; created: boolean } {
  const file = themeFilePath(home);
  if (fs.existsSync(file)) return { path: file, created: false };
  writeAtomic(file, themeSampleText());
  return { path: file, created: true };
}

/** 「恢复默认」：改名成 `theme.json.bak-<时间>`（同一秒撞名就加序号）。没有文件 → null。 */
export function resetThemeFile(home: string, now: Date): string | null {
  const file = themeFilePath(home);
  if (!fs.existsSync(file)) return null;
  let bak = path.join(path.dirname(file), themeBackupName(now));
  for (let n = 2; fs.existsSync(bak); n += 1) bak = path.join(path.dirname(file), `${themeBackupName(now)}-${n}`);
  fs.renameSync(file, bak);
  return bak;
}

/**
 * 同步拉下来的 theme.json 落到本机：`text` 为 null = 别的电脑恢复了默认 → 本机这份同样改名备份（不删）；
 * 和本机只差空白就不写。返回有没有改动。
 */
export function writeSyncedThemeFile(home: string, text: string | null, now: Date): boolean {
  const file = themeFilePath(home);
  let cur: string | null = null;
  try { cur = fs.readFileSync(file, 'utf-8'); } catch { cur = null; }
  if (text === null) return resetThemeFile(home, now) !== null;
  if (cur !== null && cur.replace(/\s+/g, '') === text.replace(/\s+/g, '')) return false;
  writeAtomic(file, text);
  return true;
}
