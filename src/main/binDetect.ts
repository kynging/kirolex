/**
 * **那三个 CLI 到底装在哪、能不能起来** ——「把 kiro-cli 那几个工具分别自动检测位置和启动命令、
 * 自动检测是否能正常启动、记住历史成功的启动命令或位置」。
 *
 * 为什么要做成"检测 + 验证 + 记住"三件而不是一个输入框：
 *
 *   · **检测**：同一台机器上完全可能有两个 kiro-cli（装的那个 + 自己 build 的），而手写路径
 *     错一个字母的表现是"执行器起不来"，跟"机器没开"、"没登录"长得一样。
 *   · **验证**：找到文件 ≠ 能跑。实测过的坑：远端那个 `claude-code-acp` **读 stdin**，
 *     直接 `--version` 会让整条探测挂住（那次 `bash -s` 把脚本吞掉就是这么来的）——
 *     所以每一次探测都 `< /dev/null`，并且带超时。
 *   · **记住**：一个**曾经真的起来过**的命令，比任何猜测都可信。所以执行器每次成功启动都把
 *     那条命令记下来，下次检测把它排在最前面 —— 这也是"换了台机器/重装之后为什么又要配一遍"
 *     的答案。
 *
 * 这个模块只做**纯**的部分（拼脚本 / 解析输出 / 合并历史），真正去跑的那一层在 index.ts：
 * 本机用 `bash -lc`，远端用同一段脚本走 ssh —— 一份判据，两台机器，不会分叉。
 */

/** 支持的三个工具。`claude` / `codex` 目前只检测和记录，KiroLex 还只起 kiro-cli。 */
export type ToolId = 'kiro' | 'claude' | 'codex';

export interface ToolSpec {
  id: ToolId;
  /** 给人看的名字。 */
  label: string;
  /** PATH 上可能的名字（按可信度排序）。 */
  names: string[];
  /** 可能的绝对路径（`~` 会在脚本里展开成 `$HOME`）。 */
  paths: string[];
  /** 取版本用的参数。 */
  versionArg: string;
  /**
   * **版本输出必须长得像这个工具** —— 实测踩到的假阳性：PATH 上的 `kiro` 是 **Kiro IDE 的 CLI**
   * （`--version` 回 `0.12.333` + 一个 git sha），和 kiro-cli 完全是两个东西。
   * 名字像不代表是它，而"配了一个错的二进制"的表现是执行器起不来、或者起来了行为莫名不对。
   */
  verify: RegExp;
}

export const TOOLS: ToolSpec[] = [
  {
    id: 'kiro',
    label: 'kiro-cli',
    names: ['kiro-cli', 'kiro'],
    paths: ['~/.local/bin/kiro-cli', '/usr/local/bin/kiro-cli', '/opt/homebrew/bin/kiro-cli', '~/.toolbox/bin/kiro-cli'],
    versionArg: '--version',
    verify: /kiro[-_ ]?cli/i,
  },
  {
    id: 'claude',
    label: 'claude code',
    names: ['claude', 'claude-code-acp'],
    paths: ['~/.claude/local/claude', '~/.local/bin/claude', '/usr/local/bin/claude', '/opt/homebrew/bin/claude'],
    versionArg: '--version',
    /* `claude-code-acp --version` 只打一个版本号，没有名字 —— 所以这里放宽到"有版本号就算" */
    verify: /claude|^\s*v?\d+\.\d+/i,
  },
  {
    id: 'codex',
    label: 'codex',
    names: ['codex'],
    paths: ['~/.local/bin/codex', '/usr/local/bin/codex', '/opt/homebrew/bin/codex'],
    versionArg: '--version',
    verify: /codex|^\s*v?\d+\.\d+/i,
  },
];

/** 一次探测的时间上限（秒）。卡住的探测比探测失败更糟 —— 界面会一直转。 */
export const PROBE_TIMEOUT_SEC = 8;

export interface BinCandidate {
  /** 要填进配置的那个命令（PATH 上的名字，或绝对路径）。 */
  command: string;
  /**
   * `command -v` 解析出来的**真实文件**。
   *
   * 为什么要带上它：`kiro-cli` 和 `/Users/k/.local/bin/kiro-cli` 常常是**同一个文件**，
   * 而历史里记的是后者、这次检测报的是前者 —— 只按字符串比的话历史那条会被判成
   * "这次没检测到"，显示成一个刺眼的 ✗（实测就是这么出来的）。
   */
  real?: string;
  /** 它自己报的版本（`--version` 的第一行，尽量短）。 */
  version?: string;
  /** **真的能起来**（退出码 0 且有输出）。false = 文件在但跑不起来。 */
  ok: boolean;
  /** 跑不起来时的那一行原因。 */
  error?: string;
  /** 这条命令以前真的起过一条会话（历史里有）。 */
  known?: boolean;
}

export interface DetectResult {
  kiro: BinCandidate[];
  claude: BinCandidate[];
  codex: BinCandidate[];
}

/* ------------------------------------------------------------------ 脚本 */

const MARK = 'KX_BIN';

/**
 * 一段 shell：把三个工具的候选逐个试一遍，每行输出 `KX_BIN <tool> <ok|bad> <command> | <版本或原因>`。
 *
 * 三条刻意的写法：
 *   · `< /dev/null`：有的 CLI（实测 `claude-code-acp`）**读 stdin**，不给它 EOF 就会挂在那里，
 *     而挂住的探测比"没找到"糟得多 —— 界面只会一直转。
 *   · `timeout`：同理，兜住那些既不读 stdin 也不退出的。远端没有 `timeout` 时退回直接跑
 *     （AL2023 有；这里不为一个边角情况把脚本写复杂）。
 *   · **先 `command -v` 再试路径**：PATH 上那个才是"用户平时用的那个"，绝对路径是兜底。
 *     同一个命令解析到同一个文件时只报一次（去重按解析后的真实路径）。
 */
export function detectScript(tools: ToolSpec[] = TOOLS): string {
  const lines: string[] = [
    'set +e',
    `T=$(command -v timeout >/dev/null 2>&1 && echo "timeout ${PROBE_TIMEOUT_SEC}" || echo "")`,
    'seen=""',
    'probe() {',
    /* $1=tool $2=显示用的命令 $3=实际要跑的东西 */
    '  real=$(command -v "$3" 2>/dev/null || echo "$3")',
    /*
      **符号链接要解开再去重** —— 实测：`/opt/homebrew/bin/claude` 和
      `~/.local/bin/claude` 指向的是同一个 `claude.exe`，而 `command -v` 对一个绝对路径
      只会把它原样回显，于是同一个文件在列表里出现两次。候选里有重复就毁掉了这个列表的意义
      （"到底该选哪个"）。`readlink -f` 在 Linux 和新一点的 macOS 上都有；没有就退回原路径。
    */
    '  canon=$(readlink -f "$real" 2>/dev/null || echo "$real")',
    '  case " $seen " in *" $canon "*) return 0;; esac',
    '  [ -n "$real" ] || return 0',
    '  seen="$seen $canon"',
    `  out=$($T "$3" ${'$4'} < /dev/null 2>&1)`,
    '  code=$?',
    '  first=$(printf "%s" "$out" | head -1 | cut -c1-120)',
    '  if [ $code -eq 0 ]; then',
    `    echo "${MARK} $1 ok $2 :: $canon | $first"`,
    '  else',
    `    echo "${MARK} $1 bad $2 :: $canon | exit $code $first"`,
    '  fi',
    '}',
  ];
  for (const t of tools) {
    for (const n of t.names) {
      /* PATH 上有没有这个名字 —— 没有就别报（报一堆 "not found" 是噪音） */
      lines.push(`command -v ${n} >/dev/null 2>&1 && probe ${t.id} ${n} ${n} ${t.versionArg}`);
    }
    for (const p of t.paths) {
      const sh = p.replace(/^~/, '$HOME');
      lines.push(`[ -x "${sh}" ] && probe ${t.id} "${sh}" "${sh}" ${t.versionArg}`);
    }
  }
  lines.push('echo "KX_BIN_DONE"');
  return lines.join('\n');
}

/** 单个命令的验证脚本（界面上那个「测试」按钮）。 */
export function testScript(command: string, versionArg = '--version'): string {
  const c = command.replace(/"/g, '\\"');
  return `set +e; T=$(command -v timeout >/dev/null 2>&1 && echo "timeout ${PROBE_TIMEOUT_SEC}" || echo "");`
    + ` out=$($T "${c}" ${versionArg} < /dev/null 2>&1); code=$?;`
    + ` first=$(printf "%s" "$out" | head -1 | cut -c1-160);`
    + ` if [ $code -eq 0 ]; then echo "${MARK} ok | $first"; else echo "${MARK} bad | exit $code $first"; fi`;
}

/* ------------------------------------------------------------------ 解析 */

/** 把脚本输出解析成候选列表。认不出的行一律忽略（远端的 shell 会打各种欢迎语）。 */
export function parseDetect(out: string, tools: ToolSpec[] = TOOLS): DetectResult {
  const res: DetectResult = { kiro: [], claude: [], codex: [] };
  const spec = new Map(tools.map((t) => [t.id, t]));
  for (const raw of String(out || '').split('\n')) {
    const m = new RegExp(`^${MARK}\\s+(kiro|claude|codex)\\s+(ok|bad)\\s+(.+?)\\s*::\\s*(.*?)\\s*\\|\\s*(.*)$`).exec(raw.trim());
    if (!m) continue;
    const tool = m[1] as ToolId;
    const ok = m[2] === 'ok';
    const command = m[3].replace(/^"|"$/g, '').trim();
    const real = m[4].replace(/^"|"$/g, '').trim() || undefined;
    const rest = m[5].trim();
    if (!command) continue;
    if (!ok) { res[tool].push({ command, real, ok: false, error: rest || '跑不起来' }); continue; }
    /*
      **跑得起来还不够，得是这个工具** —— 实测：PATH 上的 `kiro` 是 Kiro IDE 的 CLI
      （`--version` 回 `0.12.333`），和 kiro-cli 是两个东西。名字像不代表是它。
    */
    const v = spec.get(tool)?.verify;
    if (v && rest && !v.test(rest)) {
      res[tool].push({ command, real, ok: false, version: rest, error: `跑起来了，但看着不是 ${spec.get(tool)?.label}（它报的是「${rest}」）` });
      continue;
    }
    res[tool].push({ command, real, ok: true, version: rest || undefined });
  }
  return res;
}

/** 解析单个「测试」的结果。 */
export function parseTest(out: string): { ok: boolean; version?: string; error?: string } {
  const m = new RegExp(`^${MARK}\\s+(ok|bad)\\s*\\|\\s*(.*)$`, 'm').exec(String(out || ''));
  if (!m) return { ok: false, error: '没有拿到探测结果（连不上，或者那台机器的 shell 没回话）' };
  const rest = m[2].trim();
  return m[1] === 'ok' ? { ok: true, version: rest || undefined } : { ok: false, error: rest || '跑不起来' };
}

/* -------------------------------------------------------------- 历史记忆 */

/** 一台机器上某个工具**曾经真的起过**的命令，最近的在前。 */
export type BinHistory = Partial<Record<ToolId, string[]>>;
/** 机器 → 历史。机器的 key：本机是 `local`，远端用配置里的 target id。 */
export type BinHistoryMap = Record<string, BinHistory>;

/** 历史每个工具最多记几条。多了没用 —— 你只会在最近几个里选。 */
export const MAX_HISTORY = 5;

/**
 * 记一条"真的起来过"的命令。
 *
 * **放到最前面并去重**：历史的价值是"上次那个能用"，所以顺序就是可信度；
 * 同一条命令记两遍只会把别的挤掉。
 */
export function rememberBin(map: BinHistoryMap, machine: string, tool: ToolId, command: string): BinHistoryMap {
  const cmd = String(command || '').trim();
  if (!machine || !cmd) return map;
  const cur = map[machine] || {};
  const list = [cmd, ...(cur[tool] || []).filter((c) => c !== cmd)].slice(0, MAX_HISTORY);
  return { ...map, [machine]: { ...cur, [tool]: list } };
}

/**
 * 检测结果 + 历史 = 界面上那份列表。
 *
 * **历史排在前面**（并打上 `known`）：一个曾经真的起过一条会话的命令，比任何"文件在这儿"
 * 都更可信。历史里那条现在跑不起来了也要显示 —— 不显示的话你会以为它从来没存在过，
 * 而"它昨天还好好的"本身就是重要线索。
 */
export function mergeHistory(found: BinCandidate[], history: string[] = []): BinCandidate[] {
  const out: BinCandidate[] = [];
  const left = new Map(found.map((c) => [c.command, c]));
  /*
    **按"真实文件"也要能对上** —— 实测踩到：历史里记的是 `/Users/k/.local/bin/kiro-cli`
    （执行器用的就是它），而这次检测报的是 PATH 上的 `kiro-cli`；这两个是**同一个文件**，
    但只按字符串比就会把历史那条判成"这次没检测到"，显示成一个刺眼的 ✗ —— 而它明明好着。
  */
  const byReal = new Map(found.filter((c) => c.real).map((c) => [c.real!, c]));
  for (const cmd of history) {
    const hit = left.get(cmd) || byReal.get(cmd);
    if (hit) {
      left.delete(hit.command);
      /* 显示历史里那条写法（你认得它），状态用这次实测的 */
      out.push({ ...hit, command: cmd, known: true });
      continue;
    }
    out.push({ command: cmd, ok: false, known: true, error: '这次没检测到（以前起过）' });
  }
  for (const c of found) if (left.has(c.command)) out.push(c);
  return out;
}
