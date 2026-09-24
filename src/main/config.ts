import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

/**
 * A session's execution profile. An executor process is bound to (model, host);
 * `projectId` is a WRITE-ONCE memory-scoping dimension (see design §4/§6.4).
 *
 * When `remote` is set, the executor spawns `kiro-cli acp` on the remote host
 * over SSH instead of locally (Remote-SSH). The remote kiro-cli operates on the
 * REMOTE filesystem and loads the REMOTE host's own MCP/agent configuration, so
 * all file edits, shell commands, downloads and MCP servers happen on the remote
 * host — KiroLex is purely the chat/UI front-end over the SSH stdio pipe.
 */
export type PermissionMode = 'auto-approve' | 'ask';

/** Where and how to reach a remote kiro-cli executor over SSH. */
/**
 * **每台机器上那三个 CLI 怎么起** ——「不管是本地还是远程必须要配置 kiro、claude、codex 的
 * 启动命令，是默认 kiro 还是某个路径下的」。
 *
 * 空 / 不填 = **用默认**（`kiro-cli`：本地按 `kiroCliCandidates()` 找，远端按 PATH）。
 * 填了就用你给的那个（可以是绝对路径，也可以是 PATH 里的另一个名字）。
 *
 * 为什么必须可配：同一台机器上完全可能有两个 kiro-cli（一个装在 `~/.local/bin`、一个是
 * 你自己 build 的），而"跑的到底是哪一个"决定了模型列表、agent 支持、MCP 行为 ——
 * 猜错了的表现是"远端少了几个模型 / agent 没生效"，而那种问题查半天都看不出根因。
 *
 * `claude` / `codex` 现在**只存不用**：KiroLex 还只起 kiro-cli。先把配置面留出来，
 * 加执行器的时候不用再动一遍配置格式和界面。
 */
export interface ExecutorBins {
  /** kiro-cli 的命令或绝对路径。空 = 默认。 */
  kiro?: string;
  /** claude code 的命令或绝对路径（暂未使用）。 */
  claude?: string;
  /** codex 的命令或绝对路径（暂未使用）。 */
  codex?: string;
}

export interface RemoteTarget {
  /** SSH destination, e.g. "ec2-user@10.0.0.1" (may include the user). */
  sshHost: string;
  /** SSH port; 22 when omitted. */
  sshPort?: number;
  /** Absolute path to a private key passed to `ssh -i`. */
  identityFile?: string;
  /** Working directory kiro-cli uses on the remote host (session cwd). */
  remoteWorkdir?: string;
  /** 这台机器上三个 CLI 的启动命令（空 = 默认）。 */
  bins?: ExecutorBins;
}

export interface AgentProfile {
  /** Backend model, e.g. "claude-opus-4.6". Bound to the executor process. */
  model: string;

  /** The model the USER actually wants. `model` may be temporarily replaced by a
   *  fallback when the preferred one is unavailable/throttled, and that effective
   *  model is persisted so startup does not re-pay a dead-model timeout every
   *  boot. Without this field that persistence silently DESTROYS the preference
   *  (choose Opus once -> one Opus outage -> permanently downgraded to Sonnet).
   *  It is therefore tried first on every attach, so the preferred model is
   *  reinstated automatically as soon as it is available again. */
  preferredModel?: string;

  /** Tool permission behavior. Undefined legacy records retain the historical
   * auto-approve behavior. KiroLex handles permission requests client-side so
   * this mode can switch between Auto and Ask without replacing the executor. */
  permissionMode?: PermissionMode;

  /** Named kiro-cli agent launched via `kiro-cli acp --agent <name>`.
   * Undefined means kiro-cli's built-in default agent. */
  kiroAgent?: string;

  /**
   * Project identity for the layered memory store. WRITE-ONCE:
   *  - may be set at session creation, OR
   *  - assigned once to a session that has none (null -> projectId), OR
   *  - left undefined (an unassigned / scratch session -> global memory only).
   * It is NEVER changed project->project and never un-set. Callers must enforce
   * this via `canAssignProjectId` before mutating.
   */
  projectId?: string;

  /**
   * Remote target. When set, this profile's executor spawns over SSH (see the
   * RemoteTarget docstring). Undefined means local execution.
   */
  remote?: RemoteTarget;
}

/** Ordered fallback chain: KiroLex tries these in order and uses the first one
 *  that actually starts, so an unavailable / throttled / retired model no longer
 *  leaves a chat dead.
 *
 *  NO CLAUDE MODEL IS IN IT, on purpose. It used to lead with `claude-sonnet-5`
 *  then `claude-sonnet-4.6`, which produced exactly the outcome this chain exists
 *  to avoid: during a Claude-wide outage (measured 2026-08-10 23:42-23:47 —
 *  kiro-cli listed NO claude model at all) a chat created on `claude-opus-5`
 *  silently ended up displaying `claude-sonnet-4.6`, a model nobody had ever
 *  chosen, reached only after a wasted failed hop on `claude-sonnet-5`. A fallback
 *  whose first stops share the failure mode of the thing that just failed is not a
 *  fallback.
 *
 *  Exactly three entries, chosen by the user: `gpt-5.6-sol` first (2.40x credits,
 *  the strongest GPT), `gpt-5.6-terra` next (1.00x, same as `auto`), and
 *  `deepseek-3.2` last (0.25x) as the final keep-the-chat-alive stop. Nothing else
 *  is listed — `gpt-5.6-luna` and the minimax/glm models are deliberately absent,
 *  and if all three of these are down, failing loudly beats silently seating the
 *  chat on some model that was never asked for.
 *
 *  This is a keep-the-chat-alive net, not a model choice: an automatic fallback
 *  never overwrites `preferredModel`, so the next attach retries what was actually
 *  picked (see the `preferredModel` note in the attach handler). */
export const MODEL_FALLBACK_ORDER = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'deepseek-3.2',
];

/** PREFERRED model for a new chat. Opus is the wanted default; the chain above is
 *  only the safety net for when it is unavailable/throttled, so a transient Opus
 *  outage degrades to a working model instead of a dead chat. */
export const DEFAULT_MODEL = 'claude-opus-5';

/**
 * Default project identity for a working directory: its basename. This aligns
 * with kiro-cli's own cwd-scoped native session store, and lets a local dir and
 * a (future) remote dir with the same basename share one project memory layer.
 */
export function deriveProjectId(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  const resolved = cwd === '~' ? os.homedir() : cwd;
  const base = path.basename(resolved.replace(/[\\/]+$/, ''));
  return base || undefined;
}

/**
 * Enforce the WRITE-ONCE rule for projectId. Returns true only for the allowed
 * transition null/undefined -> a concrete projectId. Any project->project change
 * or un-set (project -> null) is rejected. (Design §6.4.)
 */
export function canAssignProjectId(current: string | undefined, next: string | undefined): boolean {
  if (!next) return false;              // never un-set / assign empty
  if (current && current !== next) return false; // never change between projects
  return current === undefined || current === next;
}

/** True if this profile targets a remote host (executor spawns over SSH). */
export function isRemoteProfile(p: AgentProfile): boolean {
  return !!p.remote?.sshHost;
}

/**
 * Persisted KiroLex agent entry in ~/.kirolex/config.json. The file holds an
 * `agents` array plus an `activeAgentId`; an agent may declare a `remote` block.
 * All fields are optional/untrusted here — the loader validates before use.
 */
interface PersistedAgentConfig {
  id?: string;
  label?: string;
  kind?: string;
  remote?: {
    enabled?: boolean;
    sshHost?: string;
    sshPort?: number;
    identityFile?: string;
    remoteWorkdir?: string;
  };
}

/**
 * Read the ACTIVE agent's remote target from ~/.kirolex/config.json.
 *
 * Returns undefined (→ local execution) when the file is absent/invalid, no
 * agent is active, or the active agent's remote block is missing/disabled or has
 * no sshHost. The active agent is the one whose id matches `activeAgentId`,
 * falling back to the first agent in the list. Never throws.
 */
export function loadActiveRemoteTarget(configPath: string): RemoteTarget | undefined {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const agents: PersistedAgentConfig[] = Array.isArray(cfg?.agents) ? cfg.agents : [];
    if (agents.length === 0) return undefined;
    const active =
      agents.find((a) => a && a.id === cfg?.activeAgentId) || agents[0];
    const r = active?.remote;
    if (!r || r.enabled === false || !r.sshHost) return undefined;
    return {
      sshHost: r.sshHost,
      sshPort: typeof r.sshPort === 'number' ? r.sshPort : undefined,
      identityFile: r.identityFile || undefined,
      remoteWorkdir: r.remoteWorkdir || undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Default working directory for a remote target that omits `remoteWorkdir`.
 * Derives the login user from an "user@host" sshHost and returns that user's
 * conventional Linux home (`/root` for root, `/home/<user>` otherwise). Falls
 * back to "~" when no user is present, which the remote login shell expands.
 */
export function defaultRemoteWorkdir(sshHost: string): string {
  const user = sshHost.includes('@') ? sshHost.split('@')[0].trim() : '';
  if (!user) return '~';
  if (user === 'root') return '/root';
  return `/home/${user}`;
}

/**
 * The working directory kiro-cli's session should use for this profile:
 *  - remote profile → **this local directory's mirror** under the target's remoteWorkdir,
 *  - local profile  → the provided local default (a per-session scratch dir).
 *
 * 远程那一路**不是** `remoteWorkdir` 本身，而是 `remoteWorkdir/<本地目录的镜像>`
 * （`docs/DESIGN_remote_sessions.md`）：远端执行器只能看见远端的文件系统（实测 kiro-cli 不用
 * ACP 的客户端 fs 能力，声明了也 0 回调），所以文件靠 rsync 镜像过去，而 agent 的 cwd 必须正是
 * 那份镜像。直接用 remoteWorkdir 会让所有项目挤在同一个目录里互相覆盖。
 */
export function sessionCwd(profile: AgentProfile, localDefault: string): string {
  if (profile.remote?.sshHost) {
    /*
      **远端不再放项目的副本** ——「要不把镜像去掉，我们尝试一下给远程配一些能调用本地 MCP 的能力？」

      用户的文件留在他自己机器上，远端那条会话通过反向隧道调本地工具去读写
      （`localMcp.ts` / `remoteLocalTools.ts`）。所以远端的 cwd 只是一个**草稿目录**：
      它自己要落个临时文件时有地方放，而不是"项目在这里"。
      一条会话一个目录 —— 共用一个的话两条会话的临时文件会互相覆盖。
    */
    const wd = profile.remote.remoteWorkdir || defaultRemoteWorkdir(profile.remote.sshHost);
    /* 名字里带一段**本地目录的哈希**：`~/code/blog` 和 `~/work/blog` 的 basename 一样，
       只用 basename 会把两条会话的草稿目录叠在一起。 */
    const base = (localDefault.split('/').filter(Boolean).pop() || 'session').replace(/[^\w.@-]+/g, '_');
    const h = crypto.createHash('sha1').update(localDefault).digest('hex').slice(0, 8);
    return `${wd.replace(/\/+$/, '')}/scratch/${base}-${h}`;
  }
  return localDefault;
}
