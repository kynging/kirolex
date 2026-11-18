/**
 * **新会话还在建立时选的权限 / 模型 / agent** —— 「新开会话马上切到自动，照样一直要批准，看着像卡死」
 * （main-20261118-200818.log，s_1795007056613_36vy96：远程会话建立 ~40s，第 8～10 秒切到 auto-approve）。
 *
 * 那时 `sessionClients` 里还没有这条会话，切换走的是「休眠只写记录」那条路；`acp:new-session` 最后用它
 * 开始时那份 profile（ask）整份写回记录，建出来的客户端也是 ask —— 用户选的那次就丢了。
 *
 * 所以正在新建时，切换入口把选择记在这里（同时写记录），新建流程：
 *   - 起执行器之前 `applyBeforeStart`：权限 / agent 直接并进 profile（起出来就是对的，不用再重连）；
 *   - 建好、登记执行器之前 `settleOnCreated`：权限当场设到客户端上；模型、以及起执行器之后才选的 agent
 *     要换执行器，返回给调用方登记成 pending，建好后接着切。
 *
 * 纯模块，不 import electron。
 */
import type { PermissionMode } from './config.ts';

export interface CreationSwitch {
  permissionMode?: PermissionMode;
  model?: string;
  /** '' = 默认 agent（和 `switchKiroAgentImpl` 的 `agentName` 一样） */
  kiroAgent?: string;
}

export class CreationSwitchBook {
  private readonly map = new Map<string, CreationSwitch>();

  /** 记一次；按字段合并，同一字段以最后一次为准 */
  set(sessionId: string, patch: CreationSwitch): void {
    this.map.set(sessionId, { ...this.map.get(sessionId), ...patch });
  }

  peek(sessionId: string): CreationSwitch | undefined {
    return this.map.get(sessionId);
  }

  take(sessionId: string): CreationSwitch | undefined {
    const out = this.map.get(sessionId);
    this.map.delete(sessionId);
    return out;
  }

  delete(sessionId: string): void {
    this.map.delete(sessionId);
  }
}

interface ProfileFields { permissionMode?: PermissionMode; model?: string; kiroAgent?: string }

/** 起执行器之前：已经选了的权限 / agent 并进 profile（模型不在这里 —— 它要走远端清单 / 降级那一套） */
export function applyBeforeStart(profile: ProfileFields, sw: CreationSwitch | undefined): void {
  if (!sw) return;
  if (sw.permissionMode) profile.permissionMode = sw.permissionMode;
  if (sw.kiroAgent !== undefined) profile.kiroAgent = sw.kiroAgent || undefined;
}

/**
 * 建好了、登记执行器之前：权限当场设到客户端和 profile 上；模型 / agent 和起出来的不一样的，
 * 返回给调用方（登记成 pending，建好后换执行器）。
 */
export function settleOnCreated(
  profile: ProfileFields,
  client: { setPermissionMode(mode: PermissionMode): unknown },
  sw: CreationSwitch | undefined,
): { model?: string; kiroAgent?: string } {
  const later: { model?: string; kiroAgent?: string } = {};
  if (!sw) return later;
  if (sw.permissionMode) {
    client.setPermissionMode(sw.permissionMode);
    profile.permissionMode = sw.permissionMode;
  }
  if (sw.model !== undefined && sw.model !== profile.model) later.model = sw.model;
  if (sw.kiroAgent !== undefined && (sw.kiroAgent || undefined) !== profile.kiroAgent) later.kiroAgent = sw.kiroAgent;
  return later;
}
