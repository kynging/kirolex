/**
 * **传输层的瞬时错误** —— 「⚠️ …'acp:prompt': Error: Internal error — Encountered an error in the
 * response stream: An unknown error occurred: dispatch failure」。
 *
 * `dispatch failure` 是 AWS SDK 在**连不上**时给的（DNS、TLS、连接被掐），不是模型的问题、也不是
 * 会话坏了。实测一条会话上 9 次，其中 6 次挤在 20 秒里 —— 显然是网络抖了一下，而每一次都把这句
 * 原文甩到界面上：既不告诉你该做什么，也不自己重试一次。
 *
 * 判据只认几个明确的传输层特征，不做模糊匹配：`Internal error` 是 kiro-cli 的万能错误，
 * 拿它当"可重试"会把真正的后端故障也一并重发。
 *
 * 单独一个文件（而不是留在 `index.ts` 里）：重试判据 `promptRetry` 要用它，而 `index.ts` 里有
 * electron —— 纯判据必须能在测试里直接 import。
 */
/**
 * **SSH 自己掉线的退出码是 255** —— 远程会话（`docs/DESIGN_remote_sessions.md`）里的执行器是
 * `ssh -T … kiro-cli acp`，所以"连接断了"会以**进程退出**的形式出现，而不是一句错误文本。
 *
 * 这个区别很要紧：本地的判据是「`code 0` 是正常退出，其他都是崩溃」。照搬到远程会话上，
 * 一次网络抖动（255）就会被当成"后端会话坏了"，于是去重建会话 —— 而重建对掉线毫无用处，
 * 只会把那条对话在后端的历史白扔一次（这一点在 `EmptyResponse` 那次已经付过学费了）。
 *
 * 255 是 ssh 的专用出口：远端命令自己的退出码 ssh 会原样透传，只有 ssh 这一层出问题
 * （连不上、认证失败、连接中断）才给 255。所以它可以放心地归到"传输层瞬时错误、可以自动重发"。
 */
export const SSH_TRANSPORT_EXIT = 255;

export function isSshTransportExit(code: number | null | undefined): boolean {
  return code === SSH_TRANSPORT_EXIT;
}

/**
 * 远端执行器退出时给的话。文本里带 `connection closed`，让下面的判据认得出它可重试。
 *
 * **`stderr` 里有原因就说原因** —— 退出码 255 只说"连接没了"，而实测最容易撞上的那一种
 * 根本不是掉线：`Warning: remote port forwarding failed for listen port 39100`
 * （换 agent 时新 ssh 去绑旧 ssh 还占着的那个端口）。只报"SSH 连接断了"会把人引到网络上去查，
 * 而那句 warning 就在手边。
 */
export function sshDropMessage(code: number | null | undefined, stderr = ''): string {
  const fwd = /remote port forwarding failed for listen port (\d+)/i.exec(String(stderr || ''));
  if (fwd) {
    return `SSH connection closed（ssh exit ${code}）：远端端口 ${fwd[1]} 被占用，本地工具的隧道没建起来。`
      + `KiroLex 会换一个端口重试 —— 要是反复出现，那台机器上可能有上次留下的 kiro-cli 还占着它。`;
  }
  return `SSH connection closed（ssh exit ${code}）—— 远端执行器的连接断了，KiroLex 会按退避自动重发这一轮。`;
}

export function isTransientTransportError(text: string): boolean {
  const t = String(text || '');
  return /dispatch failure/i.test(t)
    || /\b(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE)\b/i.test(t)
    || /(connection|network)\s+(reset|closed|error|timed out)/i.test(t)
    || /\b(timeout|timed out)\b.*\b(connect|handshake|tls)\b/i.test(t);
}
