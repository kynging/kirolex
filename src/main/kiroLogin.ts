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
