/**
 * **Claude Code 原生的「下一句预测」怎么到 KiroLex** ——「Claude Code 会话用它自己的机制生成追问建议」。
 *
 * 事实（claude-agent-acp 0.88 / 0.94 源码）：适配器给 Agent SDK 开了 `promptSuggestions: true`，CLI 每一轮
 * `result` 之后在 stream-json 输出里发一行 `{"type":"prompt_suggestion","suggestion":"…","session_id":"…"}`。
 * 0.94 把它包成 `session_info_update._meta.promptSuggestions = { suggestions: [{ text }] }` 推给客户端，
 * **但只推给 JetBrains AIR**（`publishPromptSuggestion` 里 `if (!this.toolCallCapabilities.air.client) return;`）；
 * 0.88 直接丢掉（`case "prompt_suggestion": break;`）。
 *
 * **为什么不声明 AIR**：`air.client` 一个开关同时改掉几十处行为（0.94 的 acp-agent.js 里约 20 处，加上 tool-calls/、
 * permissions/、elicitation、session-mode、session-index 等模块里的 30 多处），其中几处正好拆掉 KiroLex
 * 赖以工作的字段：
 *   · 工具调用的 `_meta.claudeCode.toolName` / `parentToolUseId` 不再给（"AIR already holds the tool name and
 *     the parent tool call"）—— `toolTrace.ts` 的工具名和子代理嵌套、`claudeCron.ts` 认定时任务、
 *     `permissionButtons.ts` 认 ExitPlanMode 全靠它们；
 *   · `ChangedMetaClient`：`tool_call_update` 只带变了的 `_meta` 键 —— KiroLex 每条 update 单独读 `_meta`；
 *   · 子代理的文字块对 AIR 不转发、后台 Bash 不再走终端、AskUserQuestion 改成 AIR 的请求格式、
 *     任务计划条目 / 斜杠命令（带 cwd）/ 权限展示（changeSet）/ 会话模式通知都换成 AIR 的形状。
 * 适配这些等于重写 Claude Code 的整条渲染路径，只为拿一行预测，代价远大于收益。
 *
 * **所以在 CLI 和适配器之间旁听那一行**：本机起适配器时多带一个 `--import <这段代码>`（Node ≥ 20.6 的预加载，
 * Electron 31 自带 Node 20.18）。它在适配器加载之前包一层 `child_process.spawn`：只对带 `--output-format
 * stream-json` 的那个 CLI 子进程，在它的 stdout 上**多挂一个只读的 'data' 监听**（不改、不拦、不暂停原来的流），
 * 认出 `prompt_suggestion` 那一行，就在适配器自己的 stdout（ACP 通道）上写一条和 0.94 给 AIR 的**一模一样**的
 * `session_info_update`。适配器的代码、node_modules 一个字节都不动；KiroLex 收这条的路（acp-client.ts）
 * 对"适配器自己发来的"和"旁听来的"是同一条。
 *
 * 写 ACP 通道安全的理由：ACP SDK 每条消息是一次完整的 `stdout.write(JSON + "\n")`（`ndJsonStream.writeJson`），
 * 这里也是一次写一整行，同一个 stream 上的写按顺序排队，不会插进别人的半行里。
 *
 * 远程会话（适配器跑在那台机器上）同一个办法（`remoteClaudeTapExecLine`）：在远端的 `bash -lc` 里找到适配器的 js 入口
 * （探测记下的绝对路径，或 `command -v` 出来的那个链接指向的文件），那台的 node 支持 `--import`（≥ 18.18 / 19）才带上旁听，
 * 并在 stderr 打一行 `REMOTE_TAP_MARKER`（acp-client 据此知道这条会话有原生预测）；入口不是 js / node 太老 → 照旧 `exec`，
 * 和原来一模一样（那里收不到预测，照旧显示固定建议）。本机适配器用 `KIROLEX_CLAUDE_ACP` 换成非 js 的可执行文件时同理。
 */

/** 预加载进适配器进程的那段代码（ESM，自包含：只用 node 内置模块）。 */
export const CLAUDE_SUGGESTION_TAP_SOURCE = String.raw`
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { StringDecoder } from 'node:string_decoder';
const MAX_PARTIAL = 65536;
const origSpawn = cp.spawn;
function publish(sessionId, text) {
  const update = { sessionUpdate: 'session_info_update', _meta: { promptSuggestions: { suggestions: text ? [{ text }] : [] }, kirolex: { tap: true } } };
  try { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sessionId || '', update } }) + '\n'); } catch {}
}
/*
  每个 CLI 子进程一份状态：expected = 上一条 result 之后还没有新的用户消息写给 CLI（和适配器自己的
  promptSuggestionExpected 同一个意思）。只在它为真时转发，转发一次就复位 —— 新一轮已经发给 CLI 之后才到的
  上一轮预测是过时的，在这里就丢掉。
*/
function onLine(state, line) {
  if (line.indexOf('"type":"result"') >= 0) {
    try { if (JSON.parse(line).type === 'result') state.expected = true; } catch {}
    return;
  }
  if (line.indexOf('"prompt_suggestion"') < 0) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || msg.type !== 'prompt_suggestion' || typeof msg.suggestion !== 'string') return;
  if (!state.expected) return;
  state.expected = false;
  publish(typeof msg.session_id === 'string' ? msg.session_id : '', msg.suggestion.trim());
}
function watch(child) {
  const out = child && child.stdout;
  if (!out || typeof out.on !== 'function') return;
  const state = { expected: false };
  const input = child.stdin;
  if (input && typeof input.write === 'function') {
    const origWrite = input.write;
    input.write = function (chunk) {
      try {
        const text = typeof chunk === 'string' ? chunk : (chunk && chunk.length < 4194304 ? Buffer.from(chunk).toString('utf8') : '');
        if (text.indexOf('"type":"user"') >= 0) state.expected = false;
      } catch {}
      return origWrite.apply(this, arguments);
    };
  }
  const dec = new StringDecoder('utf8');
  let buf = '';
  let skipping = false;
  out.on('data', (chunk) => {
    try {
      buf += typeof chunk === 'string' ? chunk : dec.write(chunk);
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (skipping) { skipping = false; continue; }
        onLine(state, line);
      }
      if (buf.length > MAX_PARTIAL) {
        /* 超长的一行不是预测；但可能是 result（最后的正文很长）—— 它照样算这一轮结束了 */
        if (buf.startsWith('{"type":"result"')) state.expected = true;
        buf = ''; skipping = true;
      }
    } catch {}
  });
}
cp.spawn = function (command, args, options) {
  const child = origSpawn.apply(this, arguments);
  try {
    if (Array.isArray(args) && args.includes('--output-format') && args.includes('stream-json')) watch(child);
  } catch {}
  return child;
};
syncBuiltinESMExports();
`;

/** `--import` 的参数：data: URL，不落盘（打包后 dist 在 asar 里，也不用管文件在哪）。 */
export function claudeSuggestionTapImport(): string {
  return `data:text/javascript,${encodeURIComponent(CLAUDE_SUGGESTION_TAP_SOURCE)}`;
}

/**
 * 本机起 Claude Code 适配器的那条命令加上旁听。只认「用 node 跑 js 入口」这一种起法（`resolveAdapter` 找到入口时
 * 就是它）；别的起法原样返回、`tapped: false`（调用方记一行为什么这条会话没有原生预测）。
 */
export function withClaudeSuggestionTap<T extends { command: string; args: string[] }>(launch: T): T & { tapped: boolean } {
  const entry = launch.args[launch.args.length - 1];
  if (launch.args.length !== 1 || !/\.(c|m)?js$/i.test(entry || '')) return { ...launch, tapped: false };
  return { ...launch, args: ['--import', claudeSuggestionTapImport(), entry], tapped: true };
}

/**
 * 远端带上旁听时在 stderr 打的那一行。前缀故意是 `KIROLEX_REMOTE_PID `：stderr 噪音过滤、退出原因摘要都已经认它、不显示，
 * 而它后面不是数字，`parseRemotePid` 也不会把它当成 PID。
 */
export const REMOTE_TAP_MARKER = 'KIROLEX_REMOTE_PID suggestion-tap';

function sq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** 远端 node 支不支持 `--import`（20+、19、18.18+）。 */
const IMPORT_SUPPORTED_JS = "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>=19||(a===18&&b>=18)?0:1)";

/**
 * 远端起 Claude Code 适配器的 `exec` 那一截，带旁听（`bash -lc` 里跑，接在报 PID 那行后面）。
 * `plainLine` 是原来的那一截（`adapterExecLine`）：带不上旁听的时候原样走它。`launch` 是探测记下的起法。
 * `mark`：会话标记的 `export …; `（`buildRemoteAdapterCommand`），两条 exec 前面都带上，进程树照样继承。
 */
export function remoteClaudeTapExecLine(bin: string, launch: { kind: string; node?: string; entry?: string } | undefined, plainLine: string, mark = ''): string {
  const abs = launch?.kind === 'absolute' && launch.node && launch.entry ? launch : undefined;
  const node = abs ? sq(abs.node!) : 'node';
  const lines: string[] = [];
  /* 和 adapterExecLine 一样：node 的目录也放进 PATH（适配器自己再起 node 子进程时按名字找） */
  if (abs) lines.push(`export PATH=${sq(abs.node!.replace(/\/[^/]*$/, '') || '/')}:"$PATH"`);
  lines.push(abs ? `e=${sq(abs.entry!)}` : `e=$(readlink -f "$(command -v ${sq(bin)} 2>/dev/null)" 2>/dev/null)`);
  lines.push(`case "$e" in *.js|*.mjs|*.cjs) if ${node} -e ${sq(IMPORT_SUPPORTED_JS)} 2>/dev/null; then echo ${sq(REMOTE_TAP_MARKER)} >&2; ${mark}exec ${node} --import ${sq(claudeSuggestionTapImport())} "$e"; fi;; esac`);
  lines.push(`${mark}${plainLine}`);
  return lines.join('; ');
}
