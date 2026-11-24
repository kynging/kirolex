/**
 * **每轮告诉模型「这台电脑是谁」** ——「会话同步到别的电脑后，模型要知道现在在哪台电脑上跑」（2026-11-24）。
 *
 * 用户原本想写进全局记忆，但全局记忆跨电脑同步（三方合并）：在 A 上写死「这台是 A」，同步到 B 就错了。
 * 所以由 KiroLex 每轮按**当前这台**现算一行 `[本机] …`，和记忆块放在一起（最前面），
 * 不写进任何 memory.md、不进 S3 同步，也不从会话记录里读旧机器 —— 会话从哪台来的都一样，说的永远是这台。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { machineTag } from './s3Sync.ts';

export interface LocalMachineInfo {
  /** 和同步里用的同一个标识（`machineTag(os.hostname())`）。 */
  label: string;
  /** 主机名（给人看）。 */
  hostname: string;
  /** 本机数据目录的设备 ID（`cloudTrash.loadOrCreateDeviceId`）；拿不到是空串。 */
  deviceId: string;
  /** Windows / macOS / Linux（没见过的原样）。 */
  platform: string;
  osRelease: string;
  user: string;
  kirolexHome: string;
  edition: '标准版' | 'advanced';
  /** `0.1.0 (abcdef1)`；缺 commit 只有版本号，都缺是空串。 */
  version: string;
}

export interface LocalMachineInput {
  hostname?: string;
  platform?: string;
  osRelease?: string;
  user?: string;
  kirolexHome?: string;
  deviceId?: string;
  /** 是不是 KiroLex Advanced（调用方判定，见 index.ts `currentMachineInfo`）。 */
  advanced?: boolean;
  version?: string;
  commit?: string;
}

export function platformDisplayName(platform: string): string {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'macOS';
  if (platform === 'linux') return 'Linux';
  return String(platform || '');
}

/** 远程说明里对用户机器的称呼 —— 按真实系统，不再写死「用户的 Mac」。 */
export function userMachineName(platform: string): string {
  return `用户的 ${platformDisplayName(platform) || '本地'} 电脑`;
}

function safe(get: () => string): string {
  try { return String(get() || ''); } catch { return ''; }
}

/** 纯函数：给什么用什么，没给的取这台电脑的（`os.*`），任何一项拿不到都不抛。 */
export function localMachineInfo(input: LocalMachineInput = {}): LocalMachineInfo {
  const hostname = input.hostname ?? safe(() => os.hostname());
  const version = String(input.version || '').trim();
  const commit = String(input.commit || '').trim();
  return {
    label: hostname ? machineTag(hostname) : '',
    hostname,
    deviceId: String(input.deviceId || ''),
    platform: platformDisplayName(input.platform ?? process.platform),
    osRelease: input.osRelease ?? safe(() => os.release()),
    user: input.user ?? safe(() => os.userInfo().username),
    kirolexHome: input.kirolexHome ?? safe(() => path.join(os.homedir(), '.kirolex')),
    edition: input.advanced ? 'advanced' : '标准版',
    version: version ? (commit ? `${version} (${commit})` : version) : '',
  };
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/** 那一行（≤200 字符、单行）：`[本机] kyn-workstation · Windows 10.0.26100 · 用户 kyn06 · KiroLex 标准版 0.1.0 (abcdef1) · 数据目录 C:\…`。 */
export function machineInfoLine(info: LocalMachineInfo): string {
  const one = (s: string, max: number) => clip(String(s || '').replace(/\s+/g, ' ').trim(), max);
  const parts = [
    `[本机] ${one(info.hostname || info.label || '(未知主机)', 40)}`,
    one([info.platform, info.osRelease].filter(Boolean).join(' '), 40),
    info.user ? `用户 ${one(info.user, 24)}` : '',
    one(['KiroLex', info.edition, info.version].filter(Boolean).join(' '), 48),
  ].filter(Boolean);
  const head = parts.join(' · ');
  const room = 200 - head.length - ' · 数据目录 '.length;
  return info.kirolexHome && room > 8 ? `${head} · 数据目录 ${one(info.kirolexHome, room)}` : head;
}

/**
 * 注入块：第一行永远是 `[本机] …`。
 * - 远程会话（`remoteLabel`）：再说一句本机 = 用户的电脑、你在哪台远端上；
 * - `lastUsedOn`（会话上次用过的机器 label，若有）和这台不同时，附一句。
 */
export function machineInfoBlock(info: LocalMachineInfo, opts: { remoteLabel?: string; lastUsedOn?: string } = {}): string {
  const lines = [machineInfoLine(info)];
  const remote = String(opts.remoteLabel || '').trim();
  if (remote) lines.push(`本机 = 用户的电脑（上面这台），你所在的远端是 ${remote}。`);
  const last = String(opts.lastUsedOn || '').trim();
  if (last && last !== info.label) lines.push(`这条会话上次在 ${last} 上用过；现在是在上面这台上。`);
  return lines.join('\n');
}

/**
 * 构建 commit：从 `dir` 的 `.git` 读 HEAD（只读文件，不起 git 进程）。打包后没有 `.git`，返回空串。
 * worktree 的 `.git` 是一行 `gitdir: …`，分支 ref 可能在 packed-refs 里（在公共目录 `commondir`）。
 */
export function readGitCommit(dir: string): string {
  try {
    let gitDir = path.join(dir, '.git');
    const st = fs.statSync(gitDir);
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'));
      if (!m) return '';
      gitDir = path.resolve(dir, m[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim();
    if (!ref) return /^[0-9a-f]{7,40}$/i.test(head) ? head.slice(0, 7) : '';
    let common = gitDir;
    try { common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch { /* 不是 worktree */ }
    for (const d of [gitDir, common]) {
      try {
        const sha = fs.readFileSync(path.join(d, ref), 'utf8').trim();
        if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha.slice(0, 7);
      } catch { /* 试下一个 */ }
    }
    const packed = fs.readFileSync(path.join(common, 'packed-refs'), 'utf8');
    const line = packed.split('\n').find((l) => l.trim().endsWith(` ${ref}`));
    const sha = line?.split(' ')[0] || '';
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7) : '';
  } catch {
    return '';
  }
}
