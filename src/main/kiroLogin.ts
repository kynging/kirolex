/**
 * **远端怎么登录 kiro** ——「另外如果远程需要登录 kiro 怎么办呢」+「你记得在脚本里加 kiro 登录流程哈」。
 *
 * 远端是一台没有浏览器的机器，而 `kiro-cli login` 默认要开浏览器。它有一个专门给这种机器用的开关：
 * `--use-device-flow` —— 打印一个 URL + 一串 code，你在**本机**浏览器里完成授权，远端那条命令随即返回。
 *
 * 还需要两个参数（Identity Center 登录）：`--identity-provider <start URL>` 和 `--region`。
 * 这两个值**不写进仓库**（是这个账号自己的），做法和 web search MCP 的端点一样：从**本机已经登录**
 * 的那份状态里读出来（`kiro-cli whoami` 的输出），由 KiroLex 用环境变量传给脚本。读不到就只提示、不猜。
 */

export interface KiroLoginHints {
  /** Identity Center 的 start URL，例如 `https://x.awsapps.com/start`。 */
  identityProvider?: string;
  /** 例如 `us-east-1`。 */
  region?: string;
}

/**
 * 从本机 `kiro-cli whoami` 的输出里认出登录参数。
 *
 * 实测的输出形状：
 * ```
 * Logged in with IAM Identity Center (https://d-95675c11dc.awsapps.com/start)
 * Email: someone@example.com
 *
 * Profile:
 * QDefaultProfile
 * arn:aws:codewhisperer:us-east-1:843493563478:profile/YD3ARYRUKXQP
 * ```
 * start URL 在第一行的括号里，region 在那条 ARN 的第四段 —— 这是唯一能拿到 region 的地方
 * （`kiro-cli settings all` 里没有）。
 */
export function parseWhoami(text: string): KiroLoginHints {
  const s = String(text || '');
  const url = /(https:\/\/[^\s)]+\/start)/.exec(s)?.[1];
  /*
    **这个 region 不是 Identity Center 的区** —— 它是 profile ARN 的区
    （`arn:aws:codewhisperer:us-east-1:…` = CodeWhisperer profile 所在的区）。
    实测这两者可以不一样：那份 ARN 写 us-east-1，而 IdC 实例在 ap-northeast-1，
    拿 ARN 的区去 `kiro-cli login` 会 `InvalidRequestException`。

    `whoami` 的输出里**没有** IdC 的区，所以这里只能给出一个线索。
    `scripts/remote-bootstrap.sh` 把它当候选列表的第一个，不对就往下试 ——
    错的区会秒失败，代价只是多两秒。
  */
  const region = /arn:aws:[a-z0-9-]+:([a-z0-9-]+):/.exec(s)?.[1];
  return { identityProvider: url, region };
}

/** 登录方式：Identity Center 用 `pro`。没有 start URL 就当不知道，交给脚本去提示。 */
export function loginEnv(hints: KiroLoginHints): Record<string, string> {
  if (!hints.identityProvider) return {};
  return {
    KIRO_LOGIN_PROVIDER: hints.identityProvider,
    ...(hints.region ? { KIRO_LOGIN_REGION: hints.region } : {}),
  };
}

/* ─────────── 会话里 / 设置里的「登录 kiro」（远端经同一条连接 ssh -t 跑 device flow；本机直接开终端） ─────────── */

export type KiroLicense = 'free' | 'pro';
/** 用户在登录卡片里选 / 填的：免费（Builder ID）还是 Pro（Identity Center，start URL + 区）。 */
export interface KiroLoginChoice { license: KiroLicense; identityProvider?: string; region?: string }

const START_URL_RE = /^https:\/\/[^\s'"]+$/;
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;

/** 渲染层传来的选择 → 干净的一份；不合法返回 `null`（start URL 只认 https、区只认 `ap-northeast-1` 这种）。 */
export function normalizeKiroLoginChoice(raw: unknown): KiroLoginChoice | null {
  const r = (raw || {}) as Record<string, unknown>;
  if (r.license !== 'free' && r.license !== 'pro') return null;
  if (r.license === 'free') return { license: 'free' };
  const idp = String(r.identityProvider || '').trim();
  const region = String(r.region || '').trim();
  if (idp && !START_URL_RE.test(idp)) return null;
  if (region && !REGION_RE.test(region)) return null;
  return { license: 'pro', ...(idp ? { identityProvider: idp } : {}), ...(region ? { region } : {}) };
}

/**
 * `kiro-cli login` 的参数。远端没有浏览器，必须 `--use-device-flow`（打印 URL + code，在本机浏览器里授权）。
 * Pro 没填 start URL / 区的就不带 —— 终端是交互的（ssh -t），kiro-cli 会自己问。
 */
export function kiroLoginArgs(c: KiroLoginChoice, opts: { deviceFlow: boolean }): string[] {
  return [
    'login',
    '--license', c.license,
    ...(c.license === 'pro' && c.identityProvider ? ['--identity-provider', c.identityProvider] : []),
    ...(c.license === 'pro' && c.region ? ['--region', c.region] : []),
    ...(opts.deviceFlow ? ['--use-device-flow'] : []),
  ];
}

function shq(s: string): string { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

/** 远端跑的那一条：`bash -lc '<kiro 启动命令> login … --use-device-flow'`（登录 shell 才找得到 ~/.local/bin 里的 kiro-cli）。 */
export function remoteKiroLoginCommand(bin: string, c: KiroLoginChoice): string {
  return `bash -lc ${shq([shq(bin || 'kiro-cli'), ...kiroLoginArgs(c, { deviceFlow: true }).map(shq)].join(' '))}`;
}

/**
 * `buildSshArgs` 的结果加 `-t`（device flow 要交互、要显示 code）。`buildSshArgs` 的最后两项永远是 `host, 远端命令`，
 * `-t` 插在 host 前面 —— SSM 的 ProxyCommand、临时公钥、跳板这些传输参数原样保留（同一条连接）。
 */
export function withTty(sshArgs: string[]): string[] {
  if (sshArgs.length < 2) throw new Error('ssh args must end with host and command');
  return [...sshArgs.slice(0, -2), '-t', ...sshArgs.slice(-2)];
}

/**
 * 卡片打开时默认选什么：这台机器上次在 KiroLex 里怎么登的（记住的那份）→ 本机 kiro-cli 是 Identity Center 登录的
 * （start URL 当 Pro 的默认；区不跟：whoami 里那个是 profile ARN 的区，不一定是 IdC 的区，见上面 `parseWhoami`）→ 都没有就不选，让用户选 free / pro。
 */
export function kiroLoginDefaults(remembered: KiroLoginChoice | undefined, local: KiroLoginHints | undefined): { choice?: KiroLoginChoice; source: 'remembered' | 'local' | 'none' } {
  if (remembered) return { choice: remembered, source: 'remembered' };
  if (local?.identityProvider) return { choice: { license: 'pro', identityProvider: local.identityProvider }, source: 'local' };
  return { source: 'none' };
}

/** 记住的登录方式：`~/.kirolex/kiro-login.json`，`{ <机器>: KiroLoginChoice }`（机器 = 'local' 或远端 id）。 */
export function readKiroLoginChoices(file: string, read: (p: string) => string | null): Record<string, KiroLoginChoice> {
  try {
    const j = JSON.parse(read(file) || '{}');
    const out: Record<string, KiroLoginChoice> = {};
    for (const [k, v] of Object.entries(j || {})) { const c = normalizeKiroLoginChoice(v); if (c) out[k] = c; }
    return out;
  } catch { return {}; }
}
