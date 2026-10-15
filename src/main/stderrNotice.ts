/**
 * kiro-cli 的 **stderr → 界面上一句话** —— PURE。
 *
 * ## 为什么需要它
 *
 * 「我发现 mcp failure，kirolex 并不知道。kiro-cli 中的警告信息应该要放到里面才对」。
 *
 * 后端的 stderr 一直是有的（`AcpClient` 把它当 `error` 事件发出来），但两端都把它丢了：主进程只
 * `logger.warn` 一行，渲染层的 `onError` 只有一句 `console.error` —— 那是**开发者控制台**，
 * 你在界面上看不到。于是一个 MCP server 起不来（比如 `playwright` 拉不起来、`agentcore-websearch`
 * 认证过期），表现就是"模型说它没有那个工具"，而没有任何地方说过它坏了。
 *
 * ## 为什么要分类，不能全都往上抛
 *
 * stderr 里绝大多数是噪音：字体告警、进度条、ANSI 转义、各种 `INFO`。全抛上去的话界面会被刷成日志窗口，
 * 而真正的失败就淹在里面 —— 那和现在什么都不显示一样没用。
 *
 * 所以只挑**你能采取行动**的：MCP 起不来 / 认证过期 / 工具不可用 / 明确的 error。其余进日志。
 */
import { tr } from './uiText.ts';

export type NoticeLevel = 'error' | 'warn';

export interface StderrNotice {
  level: NoticeLevel;
  /** 给人看的一句话（已去掉 ANSI 和前缀噪音）。 */
  text: string;
  /** 命中的类别，给日志和测试用。 */
  kind: 'mcp' | 'auth' | 'tool' | 'error';
}

/** ANSI 转义 + 回车 —— 进度条留下的东西，不清掉界面上就是一串乱码 */
function clean(line: string): string {
  return String(line || '')
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\r/g, '')
    .trim();
}

/**
 * 已知噪音 —— 命中就丢。
 *
 * 每一条都是实测见过的：LibreOffice 转 PDF 时的 Fontconfig 告警、下载进度、kiro-cli 自己的 INFO/DEBUG。
 * 还有 KiroLex 自己的远端启动脚本往 stderr 写的那行 PID（`REMOTE_PID_MARKER`，见 acp-client）——
 * 那是给我们自己看的，不是后端在报问题。
 */
const NOISE = [
  /^KIROLEX_REMOTE_PID\b/,
  /^Fontconfig warning/i,
  /^\s*\d+(\.\d+)?%/,                     // 进度百分比
  /^(INFO|DEBUG|TRACE)\b/i,
  /^\s*at\s+/,                            // 堆栈行 —— 第一行已经说明问题了
  /^warning: unused/i,
];

/** MCP 相关的失败。名字里带 mcp、或者说的是 server 起不来。 */
const MCP_FAIL = /(mcp)/i;
const FAILISH = /(fail(ed|ure)?|error|timed? ?out|timeout|refused|unavailable|not found|cannot|can't|unable|panic|crash|exited|disconnect)/i;
const AUTHISH = /(unauthori[sz]ed|forbidden|expired|credential|token|401|403|login|sso)/i;
const TOOLISH = /(tool|command not found|permission denied)/i;

/**
 * 这一行 stderr 值不值得摆到界面上 —— PURE。不值得就 `null`。
 *
 * 判据顺序是刻意的：噪音先滤掉，然后 **MCP 优先**（那是这次要修的东西，而且它最常被静默），
 * 再是认证，再是工具，最后才是笼统的 error。一行可能同时像好几种，先命中的那个类别更能说明该干什么。
 */
export function noticeFromStderr(raw: string): StderrNotice | null {
  const line = clean(raw);
  if (!line) return null;
  if (NOISE.some((re) => re.test(line))) return null;

  if (MCP_FAIL.test(line) && FAILISH.test(line)) {
    return { level: 'error', kind: 'mcp', text: line };
  }
  if (AUTHISH.test(line) && FAILISH.test(line)) {
    return { level: 'error', kind: 'auth', text: line };
  }
  if (TOOLISH.test(line) && FAILISH.test(line)) {
    return { level: 'warn', kind: 'tool', text: line };
  }
  /* 明确自称 error/panic 的 —— 不带失败词的 `warn` 不算，那种大多是提示 */
  if (/^(error|fatal|panic)\b/i.test(line) || /^\s*(✗|✘|❌)/.test(line)) {
    return { level: 'error', kind: 'error', text: line };
  }
  return null;
}

/**
 * 一段 stderr（可能好几行）→ 值得报的那些，**去重**。
 *
 * 去重是必需的：MCP 起不来时 kiro-cli 往往每次重试都打一遍同一句，而界面上同一句话出现五遍
 * 只会让人以为坏了五个东西。
 */
export function noticesFromStderr(chunk: string): StderrNotice[] {
  const seen = new Set<string>();
  const out: StderrNotice[] = [];
  for (const line of String(chunk || '').split('\n')) {
    const n = noticeFromStderr(line);
    if (!n || seen.has(n.text)) continue;
    seen.add(n.text);
    out.push(n);
  }
  return out;
}

/** 界面上那句话的前缀 —— 说清这是**后端**报的，不是 KiroLex 自己出错。 */
export function noticeLabel(kind: StderrNotice['kind']): string {
  switch (kind) {
    case 'mcp': return tr('MCP server problem');
    case 'auth': return tr('Backend authentication problem');
    case 'tool': return tr('Tool call problem');
    default: return tr('Backend error');
  }
}
