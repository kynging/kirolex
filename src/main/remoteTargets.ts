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

/* ------------------------------------------------------ 写：界面上能加/改/删 */

/**
 * **界面上得能配一台机器** ——「界面上甚至没有配置远程EC2的地方」。
 *
 * 原来只能手改 `~/.kirolex/config.json`：功能做出来了，但没有入口，等于没有。
 *
 * 写回去的规则：
 *   · 只动 `remotes` 这一个键，配置里别的东西**原样保留**（这份文件里还有 agents、features…）
 *   · 先写临时文件再 rename —— 这是用户唯一的配置文件，写一半被中断就等于把它弄坏了
 *   · 老形状 `agents[].remote` **不改写**：它照旧被读出来当一个可选目标，但编辑动的是新列表
 */
export interface RemoteTargetInput {
  id?: string;
  label?: string;
  sshHost: string;
  sshPort?: number;
  identityFile?: string;
  remoteWorkdir?: string;
}

/** 新建时的 id：按 label/host 生成一个稳定的可读 id（不用时间戳 —— 那种 id 在配置文件里没法认）。 */
export function newTargetId(input: RemoteTargetInput, taken: string[] = []): string {
  const base = (input.label || deriveLabel(input.sshHost) || 'remote')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'remote';
  if (!taken.includes(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}

/** 校验一条输入。返回一句给人看的错误，或者 `null` = 可以存。 */
export function validateTarget(input: RemoteTargetInput): string | null {
  const host = String(input?.sshHost || '').trim();
  if (!host) return 'SSH 地址不能为空（形如 `ec2-user@1.2.3.4`）。';
  if (/\s/.test(host)) return 'SSH 地址里不能有空格。';
  const port = input.sshPort === undefined || input.sshPort === null || (input.sshPort as any) === '' ? 22 : Number(input.sshPort);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return '端口要是 1–65535 之间的数字。';
  if (input.remoteWorkdir && !String(input.remoteWorkdir).startsWith('/') && !String(input.remoteWorkdir).startsWith('~')) {
    /* 相对路径会落在登录 shell 的当前目录上 —— 那是"看起来能用，但镜像跑到了别处" */
    return '远端工作目录要写绝对路径（`/home/ec2-user/kirolex-mirror`）。';
  }
  return null;
}

function readConfigObject(configPath: string): any {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeConfigObject(configPath: string, cfg: any): void {
  /* 原子写：这是用户唯一的配置文件，写一半被打断就等于弄坏它 */
  const tmp = `${configPath}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
  fs.renameSync(tmp, configPath);
}

/** 存一条（有 id 就是改，没有就是新建）。返回存下来的那一条。 */
export function saveRemoteTarget(configPath: string, input: RemoteTargetInput, home = os.homedir()): RemoteTargetEntry {
  const why = validateTarget(input);
  if (why) throw new Error(why);
  const cfg = readConfigObject(configPath);
  const list: any[] = Array.isArray(cfg.remotes) ? cfg.remotes.slice() : [];
  const id = input.id || newTargetId(input, list.map((r) => String(r?.id || '')));
  const at = list.findIndex((r) => String(r?.id || '') === id);
  const old = at >= 0 ? list[at] : undefined;
  /*
    **"界面没给的字段"和"界面要求清空"是两回事** ——「我为什么选了密钥不生效」。

    第一版把缺省的字段当成新值写回去（`identityFile` 变 undefined、`sshPort` 变默认 22），
    于是界面每次编辑都在悄悄抹掉密钥、把端口改回 22 —— 而界面之所以没给这两个字段，
    是因为发给它的列表里本来就漏了它们（见 `app:remote-targets` 那段注释）。

    所以规则是：**键在 input 里才动它**，默认值只在新建时用；传空串 = 明确清除。
  */
  const has = (k: keyof RemoteTargetInput): boolean =>
    Object.prototype.hasOwnProperty.call(input, k) && (input as any)[k] !== undefined;
  const sshHost = String(input.sshHost).trim();
  const port = Number((input as any).sshPort);
  const row = {
    id,
    label: (has('label') && String(input.label).trim())
      ? String(input.label).trim()
      : (old?.label || deriveLabel(sshHost)),
    sshHost,
    sshPort: has('sshPort') && Number.isFinite(port) && port > 0 ? port : (old?.sshPort ?? 22),
    /* `~` **不在这里展开**：配置里留着 `~/k.pem` 更可读，读的时候才展开（`expandHome`） */
    identityFile: has('identityFile')
      ? (String(input.identityFile).trim() || undefined)
      : old?.identityFile,
    remoteWorkdir: has('remoteWorkdir')
      ? (String(input.remoteWorkdir).trim() || undefined)
      : old?.remoteWorkdir,
  };
  if (at >= 0) list[at] = row; else list.push(row);
  cfg.remotes = list;
  writeConfigObject(configPath, cfg);
  return normalize(row, id, home)!;
}

/** 删一条。删不掉（id 不在新列表里）时返回 false —— 老 `agents[].remote` 那条不在这里管。 */
export function deleteRemoteTarget(configPath: string, id: string): boolean {
  const cfg = readConfigObject(configPath);
  const list: any[] = Array.isArray(cfg.remotes) ? cfg.remotes : [];
  const next = list.filter((r) => String(r?.id || '') !== id);
  if (next.length === list.length) return false;
  cfg.remotes = next;
  writeConfigObject(configPath, cfg);
  return true;
}

/**
 * **给人看的名字，而不是 IP** ——「右边那个 tag 不要显示 ip，显示 profile 名字，比如 aws-tokyo」。
 *
 * 按 `sshHost` 反查配置里的 `label`。为什么是"反查"而不是把名字存进会话的 profile：
 *   · 已有的会话里没有这个字段，存字段就得做迁移；反查对老会话一样有效。
 *   · 名字是**会改的**（你在设置里改一次，所有会话上的徽标就该跟着变）。存下来的那份会变成旧名字，
 *     而"两个地方显示的名字不一样"比显示 IP 更让人怀疑自己看错了。
 *
 * 配置里找不到（那台机器被删了、或者会话比配置老）就退回 host —— 宁可显示 IP，不要空着。
 */
export function labelForHost(configPath: string, sshHost: string | undefined, home = os.homedir()): string {
  const host = String(sshHost || '').trim();
  if (!host) return '';
  const hit = listRemoteTargets(configPath, home).find((t) => t.sshHost === host);
  return hit?.label || deriveLabel(host);
}
