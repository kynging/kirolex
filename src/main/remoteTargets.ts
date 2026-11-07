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
import type { ExecutorBins, RemoteTarget } from './config';
import { rememberBin, type BinHistoryMap, type ToolId } from './binDetect.ts';
import { validJump, ssmFieldError } from './sshProxy.ts';
import { tr } from './uiText.ts';

export interface RemoteTargetEntry extends RemoteTarget {
  /** 稳定 id：存进会话的 profile，重启后靠它找回同一台机器。 */
  id: string;
  /** 界面上显示的名字（徽标、选择器）。 */
  label: string;
  /** 最后一次在设置里存它的时间（ms）。打开设置时默认显示最近编辑的那台；老配置里没有。 */
  editedAt?: number;
  /** 来自老形状 `agents[].remote`（不在 `remotes[]` 里，界面上改不了也删不了）。 */
  legacy?: true;
  /** 只在 `saveRemoteTarget` 的返回值上：这次 SSH→SSM 顺手删掉的老 `agents[].remote` 的 id。 */
  droppedLegacy?: string[];
}

/** `~` 要展开 —— 配置里写 `~/k.pem` 的人不该因此连不上。 */
export function expandHome(p: string | undefined, home = os.homedir()): string | undefined {
  if (!p) return undefined;
  if (p === '~') return home;
  /*
    **两种分隔符都认** ——「看一下有没有 windows 上不能跑的东西」。
    原来只认 `~/`，于是 Windows 上填 `~\.ssh\id_rsa` 不会被展开 ——
    ssh 拿到一个字面的 `~` 目录，然后报"找不到密钥"，而那句话看不出问题在 `~` 上。

    `~` 后面必须**紧跟分隔符或者就是结尾**：否则 `~user/x`（POSIX 里"别人的家目录"）
    会被展开成 `<我的家目录>user/x`，那是另一个错。
  */
  if (/^~[\\/]/.test(p)) return path.join(home, p.slice(2));
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
  if (sshHost.startsWith('-')) return undefined;   // 会被 ssh 当成选项 —— 配置可能是从 S3 恢复回来的，按不可信处理
  const port = Number(raw?.sshPort);
  return {
    id: String(raw?.id || fallbackId),
    label: String(raw?.label || '').trim() || deriveLabel(sshHost),
    sshHost,
    sshPort: Number.isFinite(port) && port > 0 ? port : 22,
    identityFile: expandHome(typeof raw?.identityFile === 'string' ? raw.identityFile : undefined, home),
    proxyJump: typeof raw?.proxyJump === 'string' && raw.proxyJump.trim() ? raw.proxyJump.trim() : undefined,
    remoteWorkdir: typeof raw?.remoteWorkdir === 'string' && raw.remoteWorkdir.trim() ? raw.remoteWorkdir.trim() : undefined,
    bins: normalizeBins(raw?.bins),
    passwordCipher: typeof raw?.passwordCipher === 'string' && raw.passwordCipher ? raw.passwordCipher : undefined,
    editedAt: Number.isFinite(Number(raw?.editedAt)) && Number(raw?.editedAt) > 0 ? Number(raw.editedAt) : undefined,
    /* SSM 那几个字段只在 `connectVia: 'ssm'` 时出现 —— 老配置读出来的形状一个键都不多 */
    ...(raw?.connectVia === 'ssm' ? {
      connectVia: 'ssm' as const,
      ssmInstanceId: typeof raw?.ssmInstanceId === 'string' ? raw.ssmInstanceId.trim() : '',
      ssmRegion: typeof raw?.ssmRegion === 'string' ? raw.ssmRegion.trim() : '',
      ...(typeof raw?.ssmProfile === 'string' && raw.ssmProfile.trim() ? { ssmProfile: raw.ssmProfile.trim() } : {}),
      /* 缺省 false = 推临时公钥；老配置里的 identityFile 原样保留，只有勾了这个才用 */
      ...(raw?.ssmUseOwnKey === true ? { ssmUseOwnKey: true } : {}),
    } : {}),
  };
}

/**
 * 三个 CLI 的启动命令。**空串当成"没配"**（= 用默认）——
 * 界面上清空一个输入框的意思是"回到默认"，不是"用空命令启动"。
 * 全都没配时返回 `undefined`，这样配置文件里不会多出一个空对象。
 */
export function normalizeBins(raw: any): ExecutorBins | undefined {
  const pick = (v: any): string | undefined => {
    const t = typeof v === 'string' ? v.trim() : '';
    return t || undefined;
  };
  const out: ExecutorBins = { kiro: pick(raw?.kiro), claude: pick(raw?.claude), codex: pick(raw?.codex) };
  return (out.kiro || out.claude || out.codex) ? out : undefined;
}

/**
 * **本机那份**（和远端一样的三个字段）。
 *
 * 本地为什么也要配：这台 Mac 上就有两个 kiro-cli（`~/.local/bin` 那个和自己 build 的），
 * 而 `kiroCliCandidates()` 是按固定顺序猜的 —— 猜中哪个你看不出来。
 */
export function localBins(configPath: string): ExecutorBins | undefined {
  try {
    return normalizeBins(JSON.parse(fs.readFileSync(configPath, 'utf-8'))?.localBins);
  } catch {
    return undefined;
  }
}

/**
 * **哪条命令曾经真的起过** ——「记住历史成功的启动命令或位置」。
 *
 * 存在配置里的 `binHistory`：机器 key（本机是 `local`，远端用 target id）→ 工具 → 命令列表，
 * 最近的在前。执行器每次成功启动都写一次（`rememberBinSuccess`）。
 *
 * 为什么值得单独存一份：一个**真的起来过**的命令比任何检测结果都可信 —— 检测只能说
 * "这个文件在、`--version` 能跑"，而起一条 ACP 会话要的比那多（登录、agent、MCP）。
 */
export function binHistory(configPath: string): BinHistoryMap {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'))?.binHistory;
    return (raw && typeof raw === 'object') ? raw as BinHistoryMap : {};
  } catch {
    return {};
  }
}

/**
 * 记一条成功启动。**同一条命令重复调用不写盘** —— 这个函数在每次 attach 都会被调到，
 * 而无谓的写盘会让配置文件的 mtime 一直变（`manifest.json` 那次的教训）。
 */
export function rememberBinSuccess(configPath: string, machine: string, tool: ToolId, command: string): void {
  const cur = binHistory(configPath);
  const next = rememberBin(cur, machine, tool, command);
  if (JSON.stringify(next) === JSON.stringify(cur)) return;
  const cfg = readConfigObject(configPath);
  cfg.binHistory = next;
  writeConfigObject(configPath, cfg);
}

/** 存本机那份（只动 `localBins` 这一个键；空值 = 回到默认）。 */
/**
 * **本机的工作目录** ——「本机应该有工作目录这个功能，默认是用户目录下的 kirolex」。
 *
 * 没归项目的本地会话就在这个目录里干活（归了项目的用项目自己的目录）。原来它们的 cwd 是
 * 每会话的 `~/.kirolex/sessions/<id>`（KiroLex 自己的数据目录，里面没有你的东西），而且新建和
 * 重连给的还不是同一个目录 —— 对 Claude Code 这种按目录存会话的引擎，重连就找不回会话了。
 * 存的是你写的样子（`~/kirolex`），用的时候展开。
 */
export const DEFAULT_LOCAL_WORKDIR = '~/kirolex';
export function localWorkdir(configPath: string, home = os.homedir()): string {
  let raw = '';
  try { raw = String(JSON.parse(fs.readFileSync(configPath, 'utf-8'))?.localWorkdir || '').trim(); } catch { /* 没配就是默认 */ }
  return expandHome(raw || DEFAULT_LOCAL_WORKDIR, home) || path.join(home, 'kirolex');
}
/** 设置页显示的那个值（没展开的）。 */
export function localWorkdirSetting(configPath: string): string {
  try { return String(JSON.parse(fs.readFileSync(configPath, 'utf-8'))?.localWorkdir || '').trim() || DEFAULT_LOCAL_WORKDIR; } catch { return DEFAULT_LOCAL_WORKDIR; }
}
export function saveLocalWorkdir(configPath: string, dir: string): string {
  const v = String(dir || '').trim();
  if (v && !path.isAbsolute(v) && !/^~([\/]|$)/.test(v)) throw new Error(tr('The working directory must be an absolute path (or start with ~).'));
  const cfg = readConfigObject(configPath);
  if (v && v !== DEFAULT_LOCAL_WORKDIR) cfg.localWorkdir = v; else delete cfg.localWorkdir;
  writeConfigObject(configPath, cfg);
  return v || DEFAULT_LOCAL_WORKDIR;
}

export function saveLocalBins(configPath: string, bins: ExecutorBins): ExecutorBins | undefined {
  const cfg = readConfigObject(configPath);
  const next = normalizeBins(bins);
  if (next) cfg.localBins = next; else delete cfg.localBins;
  writeConfigObject(configPath, cfg);
  return next;
}

/**
 * 从配置对象里解析出可选目标。
 *
 * 顺序：`remotes[]` 在前（新形状），老的 `agents[].remote` 在后，且同一个 `sshHost` 只留一次 ——
 * 同一台机器在列表里出现两遍，人只会怀疑自己选错了。
 */
export function parseRemoteTargets(cfg: any, home = os.homedir()): RemoteTargetEntry[] {
  const out: RemoteTargetEntry[] = [];
  const seen = new Map<string, number>();
  /*
    同一个 host:port 只留一条 —— 但留**最近编辑的那条**，不是最早的那条。

    设置页曾经看不到已存的机器（开关关着时列表回空），人就一次次重加，攒出
    aws-tokyo / -2 / -3 / -4 四条同 IP。按"先到先得"去重，留下的是最早那条 **没有私钥** 的，
    后来选了密钥的那几条全被藏起来 —— 看起来就是"选了密钥不生效"。`newer` 只给新列表用；
    老形状 `agents[].remote` 排在后面、也没有 editedAt，照旧不会顶掉新列表里的同一台。
  */
  const add = (t?: RemoteTargetEntry, newer = false): void => {
    if (!t) return;
    const key = `${t.sshHost}:${t.sshPort}`;
    const at = seen.get(key);
    if (at === undefined) { seen.set(key, out.length); out.push(t); return; }
    if (newer && (t.editedAt || 0) >= (out[at].editedAt || 0)) out[at] = t;
  };
  const list = Array.isArray(cfg?.remotes) ? cfg.remotes : [];
  list.forEach((raw: any, i: number) => add(normalize(raw, `remote${i + 1}`, home), true));
  /* 兼容读老形状。`enabled: false` 照样收 —— 那个字段原来的意思是"全局开关关着"，
     而现在选不选由会话决定，所以它不再能决定一台机器要不要出现在列表里。 */
  const agents = Array.isArray(cfg?.agents) ? cfg.agents : [];
  /*
    **SSM 机器的老地址** ——「冒出一台名称是 IP、连接方式是 SSH 的幽灵机器」。
    一台机器切到 SSM 后 sshHost 变成 `user@<实例ID>`，上面按 host:port 去重就认不出它的老条目了
    （老条目里还是 IP）。所以对 SSM 机器再按"私钥 + 工作目录都一样"或"名字一样"认一次。
    只是私钥一样不算：同一把密钥常给好几台机器用。
  */
  const ssmRows = out.filter((t) => t.connectVia === 'ssm');
  const sameAsSsm = (t: RemoteTargetEntry, name: string): boolean => ssmRows.some((s) =>
    (!!t.identityFile && t.identityFile === s.identityFile && (t.remoteWorkdir || '') === (s.remoteWorkdir || ''))
    || (!!name && name.toLowerCase() === s.label.toLowerCase()));
  agents.forEach((a: any, i: number) => {
    if (!a?.remote?.sshHost) return;
    const own = typeof a.remote.label === 'string' ? a.remote.label.trim() : '';
    const name = String(a.name || '').trim();
    /* 没写 label 的老条目：不要只给一个 IP —— 那看起来像一台凭空多出来的机器 */
    const label = own || tr('{name} (old config)', { name: name || String(a.kind || '').trim() || deriveLabel(String(a.remote.sshHost)) });
    const t = normalize({ ...a.remote, id: a.id || `agent${i + 1}`, label }, a.id || `agent${i + 1}`, home);
    if (!t || sameAsSsm(t, own || name)) return;
    add({ ...t, legacy: true });
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
  const list = listRemoteTargets(configPath, home);
  const hit = list.find((t) => t.id === id);
  if (hit) return hit;
  /* 被去重掉的那几条（同 host:port 的重复项）：会话里记的可能正是它们的 id —— 认到留下来的那条 */
  try {
    const raw = (JSON.parse(fs.readFileSync(configPath, 'utf-8'))?.remotes || []).find((r: any) => String(r?.id || '') === id);
    if (!raw?.sshHost) return undefined;
    const port = Number(raw.sshPort) > 0 ? Number(raw.sshPort) : 22;
    return list.find((t) => t.sshHost === String(raw.sshHost).trim() && t.sshPort === port);
  } catch {
    return undefined;
  }
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
 *     （唯一的例外：一台机器从 SSH 切到 SSM 时，删掉和它切换前同地址的老条目，见 saveRemoteTarget）
 */
export interface RemoteTargetInput {
  id?: string;
  label?: string;
  sshHost: string;
  sshPort?: number;
  identityFile?: string;
  proxyJump?: string;
  remoteWorkdir?: string;
  /** 这台机器上三个 CLI 的启动命令（空 = 默认）。 */
  bins?: ExecutorBins;
  /** 已加密的密码；主进程在 `remote:save` 里把界面给的明文加密后放这里。空串 = 清除。 */
  passwordCipher?: string;
  /** 怎么连（缺省 ssh）。`ssm` 时下面三个字段生效，`sshHost` 是 `user@<instance-id>`。 */
  connectVia?: 'ssh' | 'ssm';
  ssmInstanceId?: string;
  ssmRegion?: string;
  /** 空 = 默认凭证链。 */
  ssmProfile?: string;
  /** SSM：「改用自己的私钥（不推临时公钥）」。缺省 false。 */
  ssmUseOwnKey?: boolean;
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
  if (!host) return tr('The IP address cannot be empty.');
  if (/\s/.test(host)) return tr('The IP address cannot contain spaces.');
  /* 以 `-` 开头会被 ssh 当成选项（`-oProxyCommand=…` = 在本机执行命令），见 sshProxy.ts unsafeSshHost */
  if (host.startsWith('-')) return tr('The IP address cannot start with `-`.');
  const port = input.sshPort === undefined || input.sshPort === null || (input.sshPort as any) === '' ? 22 : Number(input.sshPort);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return tr('The port must be a number between 1 and 65535.');
  const jump = String(input?.proxyJump || '').trim();
  /*
    白名单 —— 这个值会被拼进 `ProxyCommand`，而那串东西是交给 shell 跑的
    （见 `sshProxy.ts`）。只拦空格是不够的：`;` / `$(…)` / 反引号都能过。
  */
  if (jump && !validJump(jump)) return tr('The jump host must be `user@host` or `user@host:port` (letters, digits, `@ . - _ :` and IPv6 brackets).');
  const via = input?.connectVia;
  if (via !== undefined && via !== null && (via as any) !== '' && via !== 'ssh' && via !== 'ssm') return tr('Connection method must be ssh or ssm.');
  if (via === 'ssm') {
    /* 这几个值都会拼进交给 shell 跑的 ProxyCommand（sshProxy.ts `ssmProxyCommand`），所以全是白名单 */
    if (jump) return tr('A jump host and AWS SSM cannot be used together.');
    const ssmWhy = ssmFieldError({
      ssmInstanceId: String(input.ssmInstanceId || '').trim(),
      ssmRegion: String(input.ssmRegion || '').trim(),
      ssmProfile: String(input.ssmProfile || '').trim() || undefined,
    });
    if (ssmWhy) return ssmWhy;
    /* SSM 模式下 sshHost 只是 `user@<instance-id>`（主机名 + HostKeyAlias），不是一个能解析的地址 */
    const at = host.lastIndexOf('@');
    const user = at > 0 ? host.slice(0, at) : '';
    if (!/^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(user) || host.slice(at + 1) !== String(input.ssmInstanceId || '').trim()) {
      return tr('In AWS SSM mode the address must be <login user>@<instance ID>.');
    }
  }
  if (input.remoteWorkdir && !String(input.remoteWorkdir).startsWith('/') && !String(input.remoteWorkdir).startsWith('~')) {
    /* 相对路径会落在登录 shell 的当前目录上 —— 那是"看起来能用，但镜像跑到了别处" */
    return tr('The working directory must be an absolute path (starting with `/` or `~`).');
  }
  return null;
}

/**
 * 界面给的一份草稿里 SSM 那几个字段（「测试连接」「安装 AI 工具」这类按草稿直接连的路要带上）。
 * 不是 SSM 返回空对象 —— 直连那条路拼出来的目标一个键都不多。
 */
export function ssmFieldsOf(input: Partial<RemoteTargetInput> | undefined): Pick<RemoteTarget, 'connectVia' | 'ssmInstanceId' | 'ssmRegion' | 'ssmProfile' | 'ssmUseOwnKey'> {
  if (input?.connectVia !== 'ssm') return {};
  return {
    connectVia: 'ssm',
    ssmInstanceId: String(input.ssmInstanceId || '').trim(),
    ssmRegion: String(input.ssmRegion || '').trim(),
    ...(String(input.ssmProfile || '').trim() ? { ssmProfile: String(input.ssmProfile).trim() } : {}),
    ...(input.ssmUseOwnKey === true ? { ssmUseOwnKey: true } : {}),
  };
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
    /* 同一条规则：界面没给就不动 */
    proxyJump: has('proxyJump')
      ? (String(input.proxyJump).trim() || undefined)
      : old?.proxyJump,
    /* 和上面几个字段同一条规则：界面没给就不动（否则每次编辑都在悄悄抹掉它） */
    bins: has('bins') ? normalizeBins(input.bins) : normalizeBins(old?.bins),
    /* 同一条规则：没给就不动（界面拿不到密文，所以它永远"没给"，除非你改了或清了密码） */
    passwordCipher: has('passwordCipher') ? (String(input.passwordCipher) || undefined) : old?.passwordCipher,
    /* 同一条规则；`ssh`（缺省）不写进文件 —— 老配置存一次之后形状不变 */
    connectVia: (has('connectVia') ? input.connectVia : old?.connectVia) === 'ssm' ? 'ssm' as const : undefined,
    ssmInstanceId: has('ssmInstanceId') ? (String(input.ssmInstanceId).trim() || undefined) : old?.ssmInstanceId,
    ssmRegion: has('ssmRegion') ? (String(input.ssmRegion).trim() || undefined) : old?.ssmRegion,
    ssmProfile: has('ssmProfile') ? (String(input.ssmProfile).trim() || undefined) : old?.ssmProfile,
    /* false 不写进文件（缺省就是 false）；identityFile 不管勾没勾都原样留着 */
    ssmUseOwnKey: (has('ssmUseOwnKey') ? input.ssmUseOwnKey === true : old?.ssmUseOwnKey === true) || undefined,
    editedAt: Date.now(),
  };
  /* 合并后的那一条再验一次：只改了一部分字段（比如只给了 proxyJump）也不能拼出"跳板 + SSM" */
  if (row.connectVia === 'ssm') {
    const merged = validateTarget(row as RemoteTargetInput);
    if (merged) throw new Error(merged);
  }
  if (at >= 0) list[at] = row; else list.push(row);
  cfg.remotes = list;
  /*
    **SSH → SSM 时把这台的老 `agents[].remote` 一起删掉**（同一次原子写）。切换前它和这台同地址、
    被去重藏着；切换后地址变成实例 ID，它就会以"一台叫 IP 的 SSH 机器"冒出来。
    只删 `remote` 这个键，agent 本身的其它字段不动。
  */
  const droppedLegacy: string[] = [];
  const oldHost = String(old?.sshHost || '').trim();
  if (row.connectVia === 'ssm' && old && old.connectVia !== 'ssm' && oldHost && Array.isArray(cfg.agents)) {
    cfg.agents.forEach((a: any, i: number) => {
      if (a?.remote && String(a.remote.sshHost || '').trim() === oldHost) {
        delete a.remote;
        droppedLegacy.push(String(a.id || `agent${i + 1}`));
      }
    });
  }
  writeConfigObject(configPath, cfg);
  const entry = normalize(row, id, home)!;
  return droppedLegacy.length ? { ...entry, droppedLegacy } : entry;
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

/* ------------------------------------------------- 会话里那份 remote 快照 → 设置里现在的那台 */

/**
 * 读配置里的机器列表；**读不了 / 解析不了返回 null**（和"读到了、一台都没有"分开）——
 * `resolveSessionRemote` 靠这个区分"机器被删了"和"配置这会儿读不了，只能先用快照"。
 */
export function readRemoteTargets(configPath: string, home = os.homedir()): RemoteTargetEntry[] | null {
  try {
    return parseRemoteTargets(JSON.parse(fs.readFileSync(configPath, 'utf-8')), home);
  } catch {
    return null;
  }
}

export interface SessionRemoteResolution {
  /** 该拿去连的那份；本地会话 = undefined */
  remote?: RemoteTarget & { id?: string; label?: string };
  /** `config` = 设置里现在的那台；`snapshot` = 只能用会话记录里那份 */
  source?: 'config' | 'snapshot';
  /** 记录里的 id 在设置里已经没有了（机器被删了）—— 调用方要明说，**不许**拿快照去连旧地址 */
  deleted?: true;
}

const portOf = (p: unknown): number => (Number(p) > 0 ? Number(p) : 22);

/**
 * **会话该连哪台：按 id 取设置里现在的配置** ——「改了设置里的机器（如切 SSM），老会话仍连旧地址」。
 *
 * 会话记录里的 `profile.remote` 是建会话那一刻整份目标的快照。`remoteKiroBin` 早就学过「会变的东西不要存进会话、
 * 按 host 反查」，但只对 bins 做了；而 sshHost 本身也是会变的（直连 IP → SSM 实例 ID），按 host 反查那时也失效。
 * 实测：aws-tokyo-4 切到 SSM 之后，老会话 preflight 还在连 99.83.165.184:22。
 *
 *   · 有 id：设置里有它（或被 host:port 去重成了另一条，`resolveId`）→ 整份用设置里的（连接字段一个不留快照的）；
 *     设置里读到了、但没有这个 id → **被删了**（`deleted`），不按地址换成另一台同地址的目标（那是另一份配置）。
 *   · 没 id 的老记录：按 sshHost + 端口认回设置里那台；认不出就用快照（判断不了是不是删了，维持原来的行为）。
 *   · 配置读不了（`targets` 为 null）：只能用快照。
 */
export function resolveSessionRemote(
  snapshot: (RemoteTarget & { id?: string }) | null | undefined,
  targets: ReadonlyArray<RemoteTargetEntry> | null,
  resolveId?: (id: string) => RemoteTargetEntry | undefined,
): SessionRemoteResolution {
  const host = String(snapshot?.sshHost || '').trim();
  if (!snapshot || !host) return {};
  if (!targets) return { remote: snapshot, source: 'snapshot' };
  const id = typeof snapshot.id === 'string' && snapshot.id ? snapshot.id : '';
  const live = id
    ? (targets.find((t) => t.id === id) || resolveId?.(id))
    : targets.find((t) => t.sshHost === host && portOf(t.sshPort) === portOf(snapshot.sshPort));
  if (live) {
    const { droppedLegacy: _d, ...rest } = live;
    return { remote: rest, source: 'config' };
  }
  return id ? { remote: snapshot, source: 'snapshot', deleted: true } : { remote: snapshot, source: 'snapshot' };
}

/**
 * **设置里存了一台机器之后，会话记录里的快照跟着换** —— 返回新快照；这条会话不引用它就返回 null。
 *
 * 认的是：记录里的 id 等于存下的这台，或者等于这次顺手删掉的老 `agents[].remote`（`droppedLegacy`，同一台机器）；
 * 没 id 的老记录按**改之前**的 host + 端口认（改之后的地址它当然还不认识）。
 */
export function refreshedSnapshot(
  snapshot: (RemoteTarget & { id?: string }) | null | undefined,
  saved: RemoteTargetEntry,
  before?: { sshHost?: string; sshPort?: number },
): RemoteTargetEntry | null {
  const host = String(snapshot?.sshHost || '').trim();
  if (!snapshot || !host) return null;
  const id = typeof snapshot.id === 'string' && snapshot.id ? snapshot.id : '';
  const hit = id
    ? (id === saved.id || (saved.droppedLegacy || []).includes(id))
    : !!before?.sshHost && host === String(before.sshHost).trim() && portOf(snapshot.sshPort) === portOf(before.sshPort);
  if (!hit) return null;
  const { droppedLegacy: _d, ...rest } = saved;
  return rest;
}
