/** The "本机" entry of the machine picker in Settings → 机器. */
/** 工作目录的默认值，直接填进输入框（真值，不是示例）。`~` 由主进程按登录用户展开（resolveRemoteWorkdir）。 */
export const DEFAULT_WORKDIR = '~/kirolex';
export const LOCAL = '__local__';

/**
 * Which machine Settings → 机器 shows when it opens ——「默认显示本机，如果有远程机器就显示
 * 最近编辑的那台的配置信息，而不是新加机器界面」.
 *
 * No remote machines = 本机. Otherwise the one with the newest `editedAt`; old configs
 * saved before `editedAt` existed count as oldest, so among those the LAST in the list
 * (= most recently added) wins. 「+ 添加一台机器…」 is never the default — it appears only
 * when you pick it.
 */
export function defaultPick(list: { id: string; editedAt?: number }[]): string {
  if (!list.length) return LOCAL;
  let best = list.length - 1;
  list.forEach((x, i) => { if ((x.editedAt || 0) > (list[best].editedAt || 0)) best = i; });
  return list[best].id;
}

/**
 * 「用户名」和「IP 地址」在界面上是两栏 ——「为什么远程机器没有用户名这个选项」——
 * 但存下去仍然是一个 `sshHost`（`用户名@IP`），因为 ssh、远端检测、默认工作目录
 * （`/home/<用户名>/kirolex`）都按这个形状读它。拆和拼都只在界面这一层。
 * 用最后一个 `@` 切：用户名里不会有 `@`，而 IPv6 / 主机名里也不会有。
 */
export function splitSshHost(sshHost: string): { user: string; host: string } {
  const s = String(sshHost || '');
  const at = s.lastIndexOf('@');
  return at >= 0 ? { user: s.slice(0, at), host: s.slice(at + 1) } : { user: '', host: s };
}

export function joinSshHost(user: string, host: string): string {
  const u = String(user || '').trim();
  const h = String(host || '').trim();
  return u ? `${u}@${h}` : h;
}

/**
 * 「测试连接」那一次结果属于**哪一组连接参数**。改了 IP / 用户名 / 端口 / 私钥 / 跳板，
 * 上一次的"连得上"就不再算数 ——「你得测试连接通过才能安装 AI 工具啊」。
 */
export function connectionKey(d: { sshHost?: string; sshPort?: number; identityFile?: string; proxyJump?: string; password?: string; clearPassword?: boolean } | null): string {
  /* 不含 id：新建那台第一次自动保存才拿到 id，那不是"连接参数变了"。换机器由 pick() 清掉结果。
     含密码：改了密码就得重测（只在内存里比较，不存不发）。 */
  if (!d) return '';
  return JSON.stringify([(d.sshHost || '').trim(), d.sshPort ?? 22, d.identityFile || '', d.proxyJump || '', d.password || '', !!d.clearPassword]);
}
