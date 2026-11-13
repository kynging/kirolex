/**
 * **Codex 会话的追问建议用 Codex 自己生成** —— codex-acp 没有追问建议（它的 `nes/suggest` 是给编辑器的
 * 「下一处编辑」），所以每一轮结束后在**同一台机器**上跑一次 `codex exec`：同一个 model、同一个 provider，
 * effort 设 low，只读沙箱、不联网、不挂 MCP / 内置浏览器之类的工具，提示词和 kiro 那份相同（`suggestionsPrompt`）。
 * 失败 / 超时（`CODEX_SUGGEST_TIMEOUT_MS`）就算了：不重试、不交给 kiro（不把这条会话的内容给另一家）。
 *
 * 用哪个 codex：和会话的适配器一致 —— codex-acp 起的是它自己带的 `@openai/codex`（`CODEX_PATH` 可覆盖），
 * 这里按同样的顺序找。本机用 Electron 自带的 Node 跑 `bin/codex.js`（和 `resolveAdapter` 同理，避开 Windows 的 `.cmd`）。
 *
 * 不 import electron：测试直接 import。远端脚本里的路径都是 POSIX（远端是 Linux）。
 */
import * as path from 'node:path';

export const CODEX_SUGGEST_TIMEOUT_MS = 45_000;

/** 远端脚本跑成功时打的标记（后面跟着 codex 的输出）；没有它 = 失败（ssh / bash -l 的杂音不算输出）。 */
export const REMOTE_CODEX_SUGGEST_OK = '__KIROLEX_CODEX_SUGGEST_OK__';

/**
 * config.toml **最顶层**（第一个表头之前）某个键的单行字符串值 —— 会话的 provider 就是这里的 `model_provider`
 * （codex-acp 读的是同一份配置）。认不出 / 没写 → undefined（codex 用它自己的默认，和适配器一样）。
 */
export function codexTopLevelString(toml: string, key: string): string | undefined {
  for (const raw of String(toml || '').split(/\r?\n/)) {
    if (/^\s*\[/.test(raw)) break;
    const m = /^\s*("?)([A-Za-z0-9_-]+)\1\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/.exec(raw);
    if (!m || m[2] !== key) continue;
    const v = m[3] !== undefined ? m[3].replace(/\\(["\\])/g, '$1') : m[4];
    return v && /^[^\r\n]+$/.test(v) ? v : undefined;
  }
  return undefined;
}

/**
 * 关掉的 Codex 功能开关（`-c features.<名字>=false`；这一版不认识的名字 codex 只是忽略）。实测（codex-cli 0.161）：
 * 关掉 `shell_tool` + `unified_exec` 之后模型手里**没有执行命令的工具了**（只剩 request_user_input / apply_patch /
 * 子代理 / clock 这几个关不掉的内置项 —— apply_patch 被 read-only 沙箱拒掉，子代理继承同一套开关、也没有 shell；
 * 万一它真去调，下面的 `codexToolAttempt` 当场掐掉、结果作废）。
 */
export const CODEX_DISABLED_FEATURES = [
  'shell_tool', 'unified_exec',                                        // 执行命令
  'apps', 'plugins', 'skill_search', 'tool_suggest', 'hooks',          // 外挂的工具 / 钩子脚本
  'browser_use', 'browser_use_external', 'in_app_browser', 'computer_use', 'code_mode_host',
  'image_generation', 'view_image', 'goals', 'multi_agent', 'multi_agent_v2', 'sleep_tool',
];

/**
 * `codex exec` 的参数（不含可执行文件本身）。prompt 走 stdin（最后那个 `-`），会话内容不进命令行。
 *   · `CODEX_DISABLED_FEATURES` 全关：没有 shell / exec、浏览器、电脑操作、插件、图片之类的工具；
 *   · `--sandbox read-only` + `approval_policy="never"`：就算有漏网的写文件也被拒、没有网络，也不会停下来等批准；
 *   · `web_search="disabled"`、`mcp_servers={}`：不联网搜索、不挂任何 MCP；
 *   · `--json`：逐条事件输出，好认出「它想调工具」（`codexToolAttempt`）并只取最后的回答（`codexFinalMessage`）；
 *   · `--ephemeral`：不在 ~/.codex 里留一条会话；`--skip-git-repo-check` + `-C <临时目录>`：不读项目里的 AGENTS.md。
 */
export function codexSuggestArgs(o: { model?: string; provider?: string; cwd: string }): string[] {
  const args = [
    'exec', '--json', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--color', 'never',
    '-c', 'model_reasoning_effort="low"',
    '-c', 'approval_policy="never"',
    '-c', 'web_search="disabled"',
    '-c', 'mcp_servers={}',
    ...CODEX_DISABLED_FEATURES.flatMap((f) => ['-c', `features.${f}=false`]),
  ];
  if (o.model) args.push('-m', o.model);
  if (o.provider) args.push('-c', `model_provider=${JSON.stringify(o.provider)}`);
  args.push('-C', o.cwd, '-');
  return args;
}

export interface CodexLaunch { command: string; args: string[]; env: Record<string, string>; shell?: boolean }

/** codex-acp 包目录下 / 旁边能找到的 `@openai/codex/bin/codex.js`（嵌套优先：那就是适配器 require 到的那份）。 */
export function bundledCodexCandidates(adapterEntry: string | null | undefined, globalRoots: string[]): string[] {
  const out: string[] = [];
  if (adapterEntry && /\.(c|m)?js$/i.test(adapterEntry)) {
    const pkgDir = path.dirname(path.dirname(adapterEntry));   // <pkg>/dist/index.js → <pkg>
    out.push(path.join(pkgDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
    /* 被提升到同一个 node_modules 里（<root>/@agentclientprotocol/codex-acp → <root>/@openai/codex） */
    out.push(path.join(path.dirname(path.dirname(pkgDir)), '@openai', 'codex', 'bin', 'codex.js'));
  }
  for (const r of globalRoots) out.push(path.join(r, '@openai', 'codex', 'bin', 'codex.js'));
  return out.filter((p, i, a) => a.indexOf(p) === i);
}

/**
 * 本机跑 `codex exec` 的命令。顺序和 codex-acp 自己一致：`CODEX_PATH` → 适配器带的那份 → 全局装的 → （非 Windows）PATH 上的 `codex`。
 * 找不到 → null（调用方记一行原因，照旧显示固定建议）。
 */
export function localCodexLaunch(o: {
  env: NodeJS.ProcessEnv; adapterEntry?: string | null; globalRoots: string[];
  exists: (p: string) => boolean; execPath: string; platform: NodeJS.Platform;
}): CodexLaunch | null {
  const runJs = (js: string): CodexLaunch => ({ command: o.execPath, args: [js], env: { ELECTRON_RUN_AS_NODE: '1' } });
  const override = String(o.env.CODEX_PATH || '').trim();
  if (override) {
    if (/\.(c|m)?js$/i.test(override)) return runJs(override);
    /* Windows 上 `.cmd` 不经 shell 起会 spawn EINVAL（AGENTS.md §5.1）—— 和 codex-acp 一样走 shell，路径加引号 */
    if (o.platform === 'win32' && /\.(cmd|bat)$/i.test(override)) return { command: `"${override}"`, args: [], env: {}, shell: true };
    return { command: override, args: [], env: {} };
  }
  const js = bundledCodexCandidates(o.adapterEntry, o.globalRoots).find((p) => o.exists(p));
  if (js) return runJs(js);
  return o.platform === 'win32' ? null : { command: 'codex', args: [], env: {} };
}

function q(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * 远端跑 `codex exec` 的 bash 脚本（交给 `runRemoteCapture`，prompt 从 stdin 送）。
 *   · codex：设置里给这台机器配了 codex 启动命令就用它；否则找远端 codex-acp 带的那份（和本机同一个顺序），再不行 PATH 上的 `codex`；
 *   · provider：没传就读**远端**的 config.toml 顶层 `model_provider`（远端会话的配置在远端）；
 *   · `timeout 45`：ssh 被杀不一定带走远端进程（AGENTS.md §4.1），让它自己到点退。
 * `launch`：远端探测记下的适配器起法（`kind: 'absolute'` 时有 node 和入口的绝对路径）。
 */
export function remoteCodexSuggestScript(o: {
  model?: string; provider?: string; codexBin?: string;
  launch?: { kind: string; node?: string; entry?: string };
}): string {
  const node = o.launch?.kind === 'absolute' && o.launch.node ? q(o.launch.node) : 'node';
  /* 用数组不用函数：`timeout` 起不了 shell 函数 */
  const pick = o.codexBin
    ? `cx=(${q(o.codexBin)})`
    : [
      o.launch?.kind === 'absolute' && o.launch.entry
        ? `a=${q(o.launch.entry)}`
        : 'a=$(readlink -f "$(command -v codex-acp 2>/dev/null)" 2>/dev/null)',
      'j=""',
      '[ -n "$a" ] && for c in "$(dirname "$(dirname "$a")")/node_modules/@openai/codex/bin/codex.js" "$(dirname "$(dirname "$(dirname "$(dirname "$a")")")")/@openai/codex/bin/codex.js"; do [ -f "$c" ] && { j="$c"; break; }; done',
      `if [ -n "$j" ]; then cx=(${node} "$j"); else cx=(codex); fi`,
    ].join('\n');
  const providerLine = o.provider
    ? `p=${q(o.provider)}`
    : `p=$(sed -n '/^[[:space:]]*\\[/q;s/^[[:space:]]*model_provider[[:space:]]*=[[:space:]]*"\\([A-Za-z0-9_.:-]*\\)".*/\\1/p' "\${CODEX_HOME:-$HOME/.codex}/config.toml" 2>/dev/null | head -n 1)`;
  /* 参数和本机同一份（`codexSuggestArgs`），provider 在下面按 $p 补 */
  const base = codexSuggestArgs({ model: o.model, cwd: '' });
  const head = base.slice(0, base.lastIndexOf('-C')).map(q);   // 到 `-C <目录> -` 之前
  return [
    pick,
    providerLine,
    `set -- ${head.join(' ')}`,
    '[ -n "$p" ] && set -- "$@" -c "model_provider=\\"$p\\""',
    'set -- "$@" -C "${TMPDIR:-/tmp}" -',
    'T=""; command -v timeout >/dev/null 2>&1 && T="timeout 45"',
    /* 一出现工具调用的事件就不再读下去（awk 退出 → codex 下一次写就断）；那一行留在输出里，本机的 codexFinalMessage 据此作废结果 */
    `out=$($T "\${cx[@]}" "$@" 2>/dev/null | awk '{ print } /"type":"item\\.(started|updated|completed)"/ && !/"item":\\{[^}]*"type":"(agent_message|reasoning|error|todo_list)"/ { exit 0 }') && printf '%s\\n%s' ${q(REMOTE_CODEX_SUGGEST_OK)} "$out"`,
  ].join('\n');
}

/** `--json` 事件里不算工具调用的条目：回答、思考、codex 自己报的提示。别的（command_execution / file_change / mcp_tool_call / web_search / collab_tool_call …）都算。 */
const NON_TOOL_ITEMS = new Set(['agent_message', 'reasoning', 'error', 'todo_list']);

/** 一行 `--json` 事件是不是「开始 / 完成了一次工具调用」：是 → 那个条目的类型（带 tool 名），不是 → null。 */
export function codexToolAttempt(line: string): string | null {
  if (!line.includes('"item.')) return null;
  let ev: any;
  try { ev = JSON.parse(line); } catch { return null; }
  if (ev?.type !== 'item.started' && ev?.type !== 'item.completed' && ev?.type !== 'item.updated') return null;
  const t = ev?.item?.type;
  if (typeof t !== 'string' || NON_TOOL_ITEMS.has(t)) return null;
  return ev.item.tool ? `${t}:${ev.item.tool}` : t;
}

/**
 * 整份 `--json` 输出 → 最后一条回答的正文。出现过任何工具调用 → 抛错（结果作废：建议必须只来自对话本身）。
 * 没有回答 → 空串。
 */
export function codexFinalMessage(jsonl: string): string {
  let last = '';
  for (const line of String(jsonl || '').split(/\r?\n/)) {
    const tool = codexToolAttempt(line);
    if (tool) throw new Error(`codex tried to call a tool (${tool}); result discarded`);
    if (!line.includes('"agent_message"')) continue;
    try {
      const ev = JSON.parse(line);
      if (ev?.type === 'item.completed' && ev?.item?.type === 'agent_message' && typeof ev.item.text === 'string') last = ev.item.text;
    } catch { /* 不是一行完整的事件 */ }
  }
  return last;
}

/** 有成功标记就返回 codex 的输出，否则 null。 */
export function parseRemoteCodexOutput(raw: string): string | null {
  const s = String(raw || '');
  const at = s.indexOf(REMOTE_CODEX_SUGGEST_OK);
  if (at < 0) return null;
  return s.slice(at + REMOTE_CODEX_SUGGEST_OK.length).replace(/^\r?\n/, '');
}
