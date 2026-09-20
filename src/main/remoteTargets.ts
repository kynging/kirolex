/**
 * **有哪些远端可选，以及一条会话选了哪个** —— 远程会话（`docs/DESIGN_remote_sessions.md`）。
 *
 * 粒度定在"会话"这一层（设计文档「混用」那一节）：一条会话整体选一台机器，选完就固定，
 * 会话 A 本地、会话 B 远程可以**同时跑**。所以这里给的是一个**列表**，而不是一个全局开关。
 *
 * 原来的形状是 `agents[].remote.enabled` —— 那是个模式开关（改一次影响所有会话），正是要换掉的东西。
 * 但它已经在用户的配置里了（实测：`agents[0].remote = { enabled: false, sshHost: 'ec2-user@…' }`），
 * 所以**兼容读**：老配置里的那一条会作为一个可选目标出现，不用手改配置就能用。
 *
 * ```jsonc
 * {
 *   "remotes": [
 *     { "id": "tokyo", "label": "tokyo-ec2", "sshHost": "ec2-user@1.2.3.4",
 *       "identityFile": "~/k.pem", "remoteWorkdir": "/home/ec2-user/kirolex-mirror" }
 *   ]
 * }
 * ```
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { RemoteTarget } from './config';

export interface RemoteTargetEntry extends RemoteTarget {
  /** 稳定 id：存进会话的 profile，重启后靠它找回同一台机器。 */
  id: string;
  /** 界面上显示的名字（徽标、选择器）。 */
  label: string;
}

/** `~` 要展开 —— 配置里写 `~/k.pem` 的人不该因此连不上。 */
export function expandHome(p: string | undefined, home = os.homedir()): string | undefined {
  if (!p) return undefined;
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/** 没给 label 时的默认名字：`user@1.2.3.4` → `1.2.3.4`（用户名不是用来区分机器的）。 */
export function deriveLabel(sshHost: string): string {
  const h = String(sshHost || '').trim();
  const at = h.lastIndexOf('@');
  return (at >= 0 ? h.slice(at + 1) : h) || 'remote';
}

function normalize(raw: any, fallbackId: string, home: string): RemoteTargetEntry | undefined {
  const sshHost = typeof raw?.sshHost === 'string' ? raw.sshHost.trim() : '';
  if (!sshHost) return undefined;   // 没有 host 就不是一个能用的目标，不要放进列表
  const port = Number(raw?.sshPort);
  return {
    id: String(raw?.id || fallbackId),
    label: String(raw?.label || '').trim() || deriveLabel(sshHost),
    sshHost,
    sshPort: Number.isFinite(port) && port > 0 ? port : 22,
    identityFile: expandHome(typeof raw?.identityFile === 'string' ? raw.identityFile : undefined, home),
    remoteWorkdir: typeof raw?.remoteWorkdir === 'string' && raw.remoteWorkdir.trim() ? raw.remoteWorkdir.trim() : undefined,
  };
}

/**
 * 从配置对象里解析出可选目标。
 *
 * 顺序：`remotes[]` 在前（新形状），老的 `agents[].remote` 在后，且同一个 `sshHost` 只留一次 ——
 * 同一台机器在列表里出现两遍，人只会怀疑自己选错了。
 */
export function parseRemoteTargets(cfg: any, home = os.homedir()): RemoteTargetEntry[] {
  const out: RemoteTargetEntry[] = [];
  const seen = new Set<string>();
  const add = (t?: RemoteTargetEntry): void => {
    if (!t) return;
    const key = `${t.sshHost}:${t.sshPort}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  const list = Array.isArray(cfg?.remotes) ? cfg.remotes : [];
  list.forEach((raw: any, i: number) => add(normalize(raw, `remote${i + 1}`, home)));
  /* 兼容读老形状。`enabled: false` 照样收 —— 那个字段原来的意思是"全局开关关着"，
     而现在选不选由会话决定，所以它不再能决定一台机器要不要出现在列表里。 */
  const agents = Array.isArray(cfg?.agents) ? cfg.agents : [];
  agents.forEach((a: any, i: number) => {
    if (!a?.remote?.sshHost) return;
    add(normalize({ ...a.remote, id: a.id || `agent${i + 1}`, label: a.remote.label || a.name }, a.id || `agent${i + 1}`, home));
  });
  return out;
}

export function listRemoteTargets(configPath: string, home = os.homedir()): RemoteTargetEntry[] {
  try {
    return parseRemoteTargets(JSON.parse(fs.readFileSync(configPath, 'utf-8')), home);
  } catch {
    return [];   // 配置坏了不该让"新建会话"整个不能用
  }
}

/** 按 id 找；找不到返回 undefined（调用方据此退回本地，而不是猜一台机器）。 */
export function findRemoteTarget(configPath: string, id: string | undefined, home = os.homedir()): RemoteTargetEntry | undefined {
  if (!id) return undefined;
  return listRemoteTargets(configPath, home).find((t) => t.id === id);
}
