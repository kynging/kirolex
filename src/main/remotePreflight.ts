/**
 * **连远端之前先问三句话** —— 远程会话（`docs/DESIGN_remote_sessions.md`）。
 *
 * 不做这个检查的代价不是"少一条提示"，而是失败会伪装成别的东西：没装 rsync → 推送失败 →
 * 界面上是"这一轮没发出去"；远端没登录 → kiro-cli 起来了但每一轮都空回 → 看起来就是那个
 * 查了整整一天的 `EmptyResponse`。所以在起执行器之前一次性问清，并且**三种情况给三句不同的话**。
 *
 * 一条 SSH 问完（不是三条）：握手本身就要一秒级，而这三件事互相独立。
 */

import type { RemoteTarget } from './config';

export type PreflightCode = 'ok' | 'unreachable' | 'missing-tools' | 'not-logged-in';

export interface Preflight {
  code: PreflightCode;
  /** 给人看的一句话：说清是什么问题、下一步干什么。 */
  message: string;
  /** 缺了哪些命令（`missing-tools` 时有值）。 */
  missing?: string[];
  raw?: string;
}

/** 远端要有的东西。构建链不在里面 —— 远程会话不做构建/测试。 */
export const REQUIRED_TOOLS = ['kiro-cli', 'rsync', 'git'];

/** 一条命令问清三件事：哪些工具在、有没有登录。 */
export function preflightScript(tools: string[] = REQUIRED_TOOLS): string {
  return [
    `for b in ${tools.join(' ')}; do command -v "$b" >/dev/null 2>&1 && echo "HAVE $b" || echo "MISS $b"; done`,
    /* `whoami` 的输出形状不保证，所以只看它成不成 —— 未登录时 kiro-cli 是非零退出 */
    'if command -v kiro-cli >/dev/null 2>&1; then kiro-cli whoami >/dev/null 2>&1 && echo "AUTH ok" || echo "AUTH no"; fi',
  ].join('; ');
}

/**
 * 把输出翻译成结论。
 *
 * 顺序是**故意**的：连不上 → 缺工具 → 没登录。缺 rsync 的时候谈登录没有意义，
 * 而把顺序倒过来会让人先去折腾登录，然后发现真正的问题在别处。
 */
export function judgePreflight(
  exitCode: number | null,
  stdout: string,
  stderr: string,
  remote: RemoteTarget,
  bootstrapHint = 'scripts/remote-bootstrap.sh',
): Preflight {
  const host = remote.sshHost || 'remote';
  const out = String(stdout || '');
  if (exitCode !== 0 && !/HAVE |MISS /.test(out)) {
    const why = firstLine(stderr) || `ssh exit ${exitCode}`;
    return {
      code: 'unreachable',
      message: `连不上 ${host}：${why}。检查网络/密钥/安全组（这台机器的 kiro-cli 和文件都在它上面，连不上就跑不了）。`,
      raw: why,
    };
  }
  const missing = REQUIRED_TOOLS.filter((b) => new RegExp(`MISS ${escape(b)}(\\s|$)`, 'm').test(out));
  if (missing.length) {
    return {
      code: 'missing-tools',
      missing,
      message: `${host} 上缺 ${missing.join('、')}。在远端跑一次预置脚本装齐：`
        + `\`scp ${bootstrapHint} ${host}:~/ && ssh ${host} 'bash ~/${baseName(bootstrapHint)}'\``
        + `（KiroLex 不替你在远端装东西）。`,
    };
  }
  if (/AUTH no/.test(out)) {
    return {
      code: 'not-logged-in',
      message: `${host} 上的 kiro-cli 没登录。去那台机器跑一次 \`kiro-cli login\`——`
        + `没登录的话执行器起得来、但每一轮都空回，看起来就像服务端在返空响应。`,
    };
  }
  return { code: 'ok', message: `${host}：kiro-cli 已登录，rsync/git 都在。` };
}

function firstLine(s: string): string {
  return String(s || '')
    .split('\n')
    .map((l) => l.trim())
    /* SSH 的后量子告警每次都有，不是原因 —— 认它会让每一次"连不上"都指错 */
    .filter((l) => l && !/post-quantum|store now, decrypt later|openssh\.com|^\*\*/.test(l))[0] || '';
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function baseName(p: string): string {
  const parts = String(p).split('/');
  return parts[parts.length - 1] || p;
}
