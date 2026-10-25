/**
 * **起一个 MCP 之前先看它的命令在这台电脑上有没有** ——「跨电脑同步的 MCP 配置路径在本机不存在」。
 *
 * 实测（2026-10-25，用户 Windows 机）：`mcp-combos.json` 开了 S3 同步，另一台 Mac 上的
 * `/Users/keyinan/.toolbox/bin/builder-mcp` 被带到了 Windows。原来照样 spawn（经 cmd），
 * 得到的是乱码的「系统找不到指定的路径」+「退出了（code 1）」，再按退避重拉 6 次才放弃。
 *
 * 判据只回答"这个程序在不在"，不回答"它能不能跑"（那由起进程 + 握手说了算）：
 *   · 带路径分隔符 / 绝对路径：就看那个文件；Windows 上没有扩展名的再按 PATHEXT 试一遍；
 *   · 裸命令：按 PATH 找（Windows 上先当前目录、再 PATH，每个目录按 PATHEXT 试，和 cmd 的找法一致）。
 * 宁可漏判（当它在、照旧去起），不可错判：Windows 上没扩展名的同名文件也算"在"。
 * 纯函数：平台、环境变量、文件判断都可以注入（测试用）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { tr } from './uiText.ts';

export interface ResolveOpts {
  platform?: string;
  env?: Record<string, string | undefined>;
  /** 是不是一个存在的文件（默认 `fs.statSync`） */
  isFile?: (p: string) => boolean;
  cwd?: string;
}

const defaultIsFile = (p: string): boolean => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};

/** Windows 上环境变量名不分大小写（`Path` / `PATH` 都有人用）。 */
function envValue(env: Record<string, string | undefined>, name: string, win: boolean): string | undefined {
  if (!win) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key ? env[key] : undefined;
}

/** 命令能解析到的那个文件；找不到 → null。 */
export function resolveCommand(command: string, opts: ResolveOpts = {}): string | null {
  let cmd = String(command ?? '').trim();
  if (cmd.length >= 2 && cmd.startsWith('"') && cmd.endsWith('"')) cmd = cmd.slice(1, -1).trim();
  if (!cmd) return null;
  const platform = opts.platform ?? process.platform;
  const win = platform === 'win32';
  const env = opts.env ?? process.env;
  const isFile = opts.isFile ?? defaultIsFile;
  const p = win ? path.win32 : path.posix;
  const cwd = opts.cwd ?? process.cwd();
  const exts = win
    ? (envValue(env, 'PATHEXT', win) || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim()).filter(Boolean)
    : [];
  const candidates = (base: string): string[] => {
    if (!win) return [base];
    const ext = p.extname(base).toLowerCase();
    if (ext && exts.some((e) => e.toLowerCase() === ext)) return [base];
    return [base, ...exts.map((e) => base + e.toLowerCase())];
  };
  const first = (base: string): string | null => candidates(base).find((c) => isFile(c)) ?? null;

  const hasSep = win ? /[\\/]/.test(cmd) : cmd.includes('/');
  if (hasSep || p.isAbsolute(cmd)) return first(p.resolve(cwd, cmd));
  const dirs = (envValue(env, 'PATH', win) || '').split(win ? ';' : ':').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  if (win) dirs.unshift(cwd);
  for (const dir of dirs) {
    const hit = first(p.join(dir, cmd));
    if (hit) return hit;
  }
  return null;
}

/**
 * 找不到时给人看的原因（写法按 docs/notices-glossary.md）：说出找不到的是什么、多半为什么。
 * 路径原样写出来 —— 一眼就能认出那是另一台电脑上的路径。
 */
export function commandMissingReason(command: string): string {
  return tr('This computer has no {cmd} (this MCP config may come from another computer)', { cmd: String(command ?? '').trim() });
}
