/** The "本机" entry of the machine picker in Settings → 机器. */
/** 工作目录的默认值，直接填进输入框（真值，不是示例）。`~` 由主进程按登录用户展开（resolveRemoteWorkdir）。 */
export const DEFAULT_WORKDIR = '~/kirolex';
export const LOCAL = '__local__';

/**
 * Which machine Settings → 机器 shows when it opens ——「默认显示本机，如果有远程机器就显示
 * 最近编辑的那台的配置信息，而不是新加机器界面」.
 *
 * No remote machines = 本机. Otherwise the one with the newest `editedAt`. When nothing has
 * an `editedAt` (configs saved before it existed), the FIRST machine of the new `remotes[]`
 * list wins —「一打开机器配置就是 SSH、名称是 IP」：old-shape `agents[].remote` entries
 * (`legacy`) sit at the end of the list, so "the last one" used to pick exactly that ghost.
 * 「+ 添加一台机器…」 is never the default — it appears only when you pick it.
 */
export function defaultPick(list: { id: string; editedAt?: number; legacy?: boolean }[]): string {
  if (!list.length) return LOCAL;
  let best = -1;
  list.forEach((x, i) => { if ((x.editedAt || 0) > (best < 0 ? 0 : (list[best].editedAt || 0))) best = i; });
  if (best >= 0) return list[best].id;
  return (list.find((x) => !x.legacy) || list[0]).id;
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
export function connectionKey(d: { sshHost?: string; sshPort?: number; identityFile?: string; proxyJump?: string; password?: string; clearPassword?: boolean; connectVia?: string; ssmInstanceId?: string; ssmRegion?: string; ssmProfile?: string; ssmUseOwnKey?: boolean } | null): string {
  /* 不含 id：新建那台第一次自动保存才拿到 id，那不是"连接参数变了"。换机器由 pick() 清掉结果。
     含密码：改了密码就得重测（只在内存里比较，不存不发）。 */
  if (!d) return '';
  const base = [(d.sshHost || '').trim(), d.sshPort ?? 22, d.identityFile || '', d.proxyJump || '', d.password || '', !!d.clearPassword];
  /* SSM 的区域 / profile 变了也得重测；直连那条的 key 和原来一样 */
  if (d.connectVia === 'ssm') base.push('ssm', d.ssmInstanceId || '', d.ssmRegion || '', d.ssmProfile || '', !!d.ssmUseOwnKey);
  return JSON.stringify(base);
}

/** SSM 模式下默认的登录用户（Amazon Linux 的默认用户）。 */
export const DEFAULT_SSM_USER = 'ec2-user';

/**
 * **切换连接方式**。SSM 时 `sshHost` 是 `<登录用户>@<实例 ID>`（主机名 + HostKeyAlias），
 * 所以 IP 那一栏不要了；切回 SSH 时实例 ID 不是一个能连的地址，主机那一半清空让你重填。
 * 端口 / 密码**不清**：SSM 下只是不显示（端口仍是 AWS-StartSSHSession 的 portNumber），切回 SSH 还在。
 */
export function switchVia<D extends { sshHost: string; connectVia?: 'ssh' | 'ssm'; ssmInstanceId?: string; proxyJump?: string }>(draft: D, via: 'ssh' | 'ssm'): D {
  const user = splitSshHost(draft.sshHost).user;
  return via === 'ssm'
    ? { ...draft, connectVia: 'ssm', proxyJump: '', sshHost: joinSshHost(user || DEFAULT_SSM_USER, draft.ssmInstanceId || '') }
    : { ...draft, connectVia: 'ssh', sshHost: joinSshHost(user, '') };
}

/** 机器下拉里那一行。SSM 的显示「实例ID · 区域」——整串 `ec2-user@i-…` 又长又看不出在哪个区。 */
export function machineOptionText(r: { label: string; sshHost: string; connectVia?: string; ssmInstanceId?: string; ssmRegion?: string }): string {
  if (r.connectVia === 'ssm') return `🌐 ${r.label} — ${[r.ssmInstanceId, r.ssmRegion].filter(Boolean).join(' · ')}  [SSM]`;
  return `🌐 ${r.label} — ${r.sshHost}`;
}
