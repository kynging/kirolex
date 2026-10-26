/**
 * **Codex 走 Amazon Bedrock 时要的 IAM 权限** —— 检查、报错解析、给出怎么补。
 *
 * 2026-10-25 实测：aws-tokyo 上的 Codex（`model_provider = "amazon-bedrock"`，用 EC2 实例角色）问了个要上网查的问题，
 * 这一轮直接断，会话里只有一句「stream disconnected before completion: Access denied: web search is not authorized for
 * this identity.」。Codex 自带的 web_search 走 Bedrock 的网页搜索，要另外三项权限（`WEB_SEARCH_ACTIONS`），
 * 而那台机器的角色只有调模型的权限。
 *
 * 这里只做纯逻辑（预检脚本文本、预检输出 / 报错文本的解析、最小策略 JSON、config.toml 的合并），
 * 真正 ssh 过去跑的在 index.ts（`ai-login:bedrock-check` / `ai-login:codex-web-search`）。
 * **KiroLex 不改 IAM**：脚本里只有只读调用（sts get-caller-identity、iam get-role、iam simulate-principal-policy、
 * 一次极短的 codex exec），怎么补只给出策略文本，由你自己贴进 IAM。
 */

import { topLevelValue } from './aiLogin.ts';
import { tr } from './uiText.ts';

/** 模型调用（Codex 走的是 Bedrock 的 Responses / Mantle 端点）。 */
export const MODEL_ACTIONS = ['bedrock-mantle:CreateInference'];
/** Codex 自带 web_search 走的 Bedrock 网页搜索。资源是 `arn:aws:bedrock-websearch:<region>:aws:tool/*`。 */
export const WEB_SEARCH_ACTIONS = ['bedrock-websearch:InvokeSearch', 'bedrock-websearch:InvokeFetch', 'bedrock-websearch:ExternalWebAccess'];
/** Codex 走 Bedrock 时的默认区域（`aiLogin.ts` 的 BEDROCK_DEFAULTS.codex.region）。 */
const DEFAULT_REGION = 'us-east-1';

const DENIED_RE = /\bnot authorized\b|\baccess ?denied\b|AccessDeniedException/i;
const ARN_RE = /arn:aws[\w-]*:(?:sts|iam)::\d{12}:[\w+=,.@/-]+/;
const trimArn = (s: string): string => s.replace(/[.,;:]+$/, '');

/** 这段错误文本是不是"没权限"那一类。 */
export function isAccessDeniedError(text: string): boolean {
  return DENIED_RE.test(String(text || ''));
}

export interface AccessDenied {
  /** 缺的 IAM 动作。 */
  actions: string[];
  /** 错误里给出的身份（常见是 `arn:aws:sts::<acct>:assumed-role/<role>/<session>`）。 */
  identityArn?: string;
  /** 要改策略的那个 principal（assumed-role 换成 `arn:aws:iam::<acct>:role/<role>`）。 */
  roleArn?: string;
  resource?: string;
  /** 资源 ARN 里的区域。 */
  region?: string;
  /** 是不是网页搜索那一族（「暂时关掉网页搜索」按钮只对它有意义）。 */
  webSearch: boolean;
}

/** STS 的 assumed-role 身份 → 可以挂策略的 IAM role ARN；IAM user / role 原样。 */
export function roleArnOf(identity?: string): string | undefined {
  const s = String(identity || '');
  const m = s.match(/^arn:(aws[\w-]*):sts::(\d{12}):assumed-role\/([^/]+)/);
  if (m) return `arn:${m[1]}:iam::${m[2]}:role/${m[3]}`;
  return /^arn:aws[\w-]*:iam::\d{12}:/.test(s) ? s : undefined;
}

/**
 * 错误文本 → 缺哪个动作、哪个身份。不是 Bedrock 的（别的服务的 AccessDenied）、或者只有一句笼统 Access denied 的，回 `undefined`
 * —— 猜错了的提示卡比没有更误导。
 */
export function parseAccessDenied(text: string): AccessDenied | undefined {
  const s = String(text || '');
  if (!isAccessDeniedError(s)) return undefined;
  const actions: string[] = [];
  const add = (a: string): void => { if (!actions.includes(a)) actions.push(a); };
  if (/web ?search/i.test(s)) WEB_SEARCH_ACTIONS.forEach(add);
  for (const m of s.matchAll(/(?<![:\w])(bedrock(?:-[a-z]+)?:[A-Z*][A-Za-z*]*)/g)) add(m[1]);
  if (!actions.length) {
    /* 明确说了别的服务的动作（s3:GetObject 之类）：不是这张卡管的 */
    if (/perform:?\s+[a-z0-9-]+:[A-Za-z*]+/i.test(s)) return undefined;
    if (!/bedrock|model|inference/i.test(s)) return undefined;
    MODEL_ACTIONS.forEach(add);
  }
  const id = s.match(ARN_RE);
  const identityArn = id ? trimArn(id[0]) : undefined;
  const res = s.match(/on resource:?\s*(arn:[^\s"'，。)）]+)/i);
  const resource = res ? trimArn(res[1]) : undefined;
  const region = resource?.split(':')[3] || undefined;
  return {
    actions,
    ...(identityArn ? { identityArn, roleArn: roleArnOf(identityArn) } : {}),
    ...(resource ? { resource } : {}),
    ...(region ? { region } : {}),
    webSearch: actions.some((a) => a.startsWith('bedrock-websearch:')),
  };
}

/**
 * 可以直接贴进 IAM（内联策略 / 新建策略）的最小策略：网页搜索那几项限定到那个区的 `tool/*`；
 * 模型调用那几项用错误里给的资源，没给就是 `*`。
 */
export function minimalPolicy(actions: string[], region = DEFAULT_REGION, resource?: string): string {
  const ws = actions.filter((a) => a.startsWith('bedrock-websearch:'));
  const other = actions.filter((a) => !a.startsWith('bedrock-websearch:'));
  const Statement: Array<Record<string, unknown>> = [];
  if (other.length) Statement.push({ Sid: 'KiroLexCodexBedrockModel', Effect: 'Allow', Action: other, Resource: resource || '*' });
  if (ws.length) Statement.push({ Sid: 'KiroLexCodexWebSearch', Effect: 'Allow', Action: ws, Resource: `arn:aws:bedrock-websearch:${region || DEFAULT_REGION}:aws:tool/*` });
  return JSON.stringify({ Version: '2012-10-17', Statement }, null, 2);
}

// ---------------------------------------------------------------- 预检

export type Verdict = 'ok' | 'denied' | 'unknown';

export interface BedrockIamCheck {
  /** `sts get-caller-identity` 的 Arn。 */
  identity?: string;
  /** 模拟 / 挂策略用的 principal。 */
  roleArn?: string;
  /** simulate = iam simulate-principal-policy；probe = 一次极短的 codex exec；none = 两样都没做成。 */
  method: 'simulate' | 'probe' | 'none';
  model: Verdict;
  webSearch: Verdict;
  missing: string[];
  /** 缺权限时的最小策略 JSON。 */
  policy?: string;
  /** Codex 配置里的 Bedrock 区域。 */
  region: string;
  /** 那台机器的 config.toml 里已经 `web_search = "disabled"`。 */
  webSearchDisabled: boolean;
  /** 判不了的原因（给人看）。 */
  note?: string;
  checkedAt: number;
  /** 那台机器的 Codex 没走 Bedrock（没查；界面不显示这一行）。 */
  notBedrock?: boolean;
  /** 试调用的报错点名的资源（例如具体的模型 ARN）：策略 / 启动提示卡照它收窄，不给成 *。 */
  resource?: string;
  /** 网页搜索那一半用的判据（日志里记下；见 `judgeWebSearch`）。 */
  basis?: IamBasis;
  /** 模拟给不出结论（只有 implicitDeny）、还没试调用：调用方再跑一次 `bedrockProbeScript` / `localBedrockProbeOutput`。 */
  probeNeeded?: boolean;
}

/**
 * 网页搜索判据：带 `--resource-arns tool/*` 的模拟 / 不带资源的模拟 / 一次极短的 codex exec。
 *
 * 2026-10-26 实测误报：tokyo-graviton 的角色挂着 AdministratorAccess（`"Action":"*","Resource":"*"`），模拟器带资源时把
 * `bedrock-websearch:ExternalWebAccess` 判成 implicitDeny、不带资源是 allowed，真跑 codex 网页搜索 4 次都没被拒。
 * 所以 implicitDeny 不算缺权限：只有 explicitDeny、或试调用真的被拒（`parseAccessDenied` 认出动作）才算。
 */
export type IamBasis = 'simulate-with-resource' | 'simulate-no-resource' | 'probe';

/** 一次试调用（`codex exec`）的结论。 */
export interface ProbeVerdict { model: Verdict; webSearch: Verdict; missing: string[]; resource?: string; note?: string }

/** 试调用的输出 + 退出码 → 结论（`rc` 124 = 超时）。 */
export function parseProbe(body: string, rc: number): ProbeVerdict {
  const denied = parseAccessDenied(body);
  /* 网页搜索被拒说明模型那一下已经通了（是模型发起的搜索） */
  if (denied?.webSearch) return { model: 'ok', webSearch: 'denied', missing: WEB_SEARCH_ACTIONS.slice() };
  if (denied) return { model: 'denied', webSearch: 'unknown', missing: denied.actions, ...(denied.resource ? { resource: denied.resource } : {}) };
  if (rc === 124) return { model: 'unknown', webSearch: 'unknown', missing: [], note: tr('The test call did not finish within 60 seconds, so permissions could not be determined.') };
  if (rc === 0) {
    /* 模型不一定真的搜了：只有输出里有 web_search 事件才算网页搜索 ✓ */
    if (/web_search/.test(body)) return { model: 'ok', webSearch: 'ok', missing: [] };
    return { model: 'ok', webSearch: 'unknown', missing: [], note: tr('The model did not run a web search in the test call, so web search could not be confirmed.') };
  }
  const last = body.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
  return { model: 'unknown', webSearch: 'unknown', missing: [], note: tr('The test call failed (exit code {code}): {err}', { code: Number.isFinite(rc) ? rc : '?', err: last.slice(0, 200) }) };
}

export interface WebSearchJudgement {
  verdict: Verdict;
  /** 只在 denied 时有：两次模拟都没 allowed 的那几项 / 试调用报的那几项。 */
  missing: string[];
  basis?: IamBasis;
  /** 模拟只有 implicitDeny、又没给试调用结果：要再跑一次试调用才能下结论。 */
  probeNeeded: boolean;
  note?: string;
}

/**
 * **网页搜索那一半的判定**（模型调用那一半不走这里）：
 * - 任何一次模拟里有 explicitDeny → denied（策略真的拒了）；
 * - 带资源全部 allowed → ok（simulate-with-resource）；每项至少在一次模拟里 allowed → ok（simulate-no-resource：
 *   不带资源 = 资源 *，按 * 授权的策略对 tool/* 一样有效）；
 * - 剩下的只是 implicitDeny（模拟器对 ExternalWebAccess + tool/* 的判定不可信）：以试调用为准 —— 没给就 `probeNeeded`；
 *   试调用被拒 → denied，真的搜了 → ok，别的（超时、没去搜、笼统的失败）→ unknown，都不报缺。
 */
export function judgeWebSearch(sim: { withResource: Record<string, string>; noResource?: Record<string, string> }, probe?: ProbeVerdict): WebSearchJudgement {
  const w = sim.withResource;
  const n = sim.noResource || {};
  const notAllowed = WEB_SEARCH_ACTIONS.filter((a) => (a in w || a in n) && w[a] !== 'allowed' && n[a] !== 'allowed');
  const explicitW = WEB_SEARCH_ACTIONS.some((a) => w[a] === 'explicitDeny');
  if (explicitW || WEB_SEARCH_ACTIONS.some((a) => n[a] === 'explicitDeny')) {
    /* 显式拒绝压过另一次的 allowed */
    const missing = WEB_SEARCH_ACTIONS.filter((a) => notAllowed.includes(a) || w[a] === 'explicitDeny' || n[a] === 'explicitDeny');
    return { verdict: 'denied', missing, basis: explicitW ? 'simulate-with-resource' : 'simulate-no-resource', probeNeeded: false };
  }
  if (WEB_SEARCH_ACTIONS.every((a) => w[a] === 'allowed')) return { verdict: 'ok', missing: [], basis: 'simulate-with-resource', probeNeeded: false };
  if (!notAllowed.length) return { verdict: 'ok', missing: [], basis: 'simulate-no-resource', probeNeeded: false };
  if (!probe) return { verdict: 'unknown', missing: [], probeNeeded: true };
  if (probe.webSearch === 'denied') {
    const ws = probe.missing.filter((a) => a.startsWith('bedrock-websearch:'));
    return { verdict: 'denied', missing: ws.length ? ws : WEB_SEARCH_ACTIONS.slice(), basis: 'probe', probeNeeded: false };
  }
  if (probe.webSearch === 'ok') return { verdict: 'ok', missing: [], basis: 'probe', probeNeeded: false };
  return { verdict: 'unknown', missing: [], basis: 'probe', probeNeeded: false, ...(probe.note ? { note: probe.note } : {}) };
}

/** 旧判据（不分 implicitDeny / explicitDeny）记下的结论：没记判据、却判了网页搜索 denied —— 不沿用，下次按新判据重算。 */
export function staleBedrockCheck(c: BedrockIamCheck): boolean {
  return !c.notBedrock && !c.basis && c.webSearch === 'denied';
}

const PROBE_PROMPT = 'Use the web search tool exactly once to look up example.com, then reply with only the word OK.';

/**
 * 在那台机器上跑的只读预检（`bash -lc`）。每行带 `KX_IAM_*` 前缀，`parseIamPrecheck` 读。
 * 能用 `iam simulate-principal-policy` 就用它（不花钱、不出网）；没权限模拟时才跑一次极短的 `codex exec`（60 秒封顶，
 * 强制打开网页搜索），按它的报错判断。最后附上 `~/.codex/config.toml`（区域、网页搜索开关）。
 */
export function bedrockCheckScript(): string {
  const one = (v: string): string => `$(printf '%s' "${v}" | tr '\\n' ' ' | cut -c1-300)`;
  const query = `--query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output text 2>&1 </dev/null`;
  return [
    /* 不走 Bedrock 的 Codex 不查（引擎状态那条路每台机器都会跑一次） */
    String.raw`if ! grep -qE '^[[:space:]]*model_provider[[:space:]]*=[[:space:]]*"amazon-bedrock"' ~/.codex/config.toml 2>/dev/null; then echo KX_IAM_NOT_BEDROCK; else`,
    /* 网页搜索的资源带区域：按 Codex 配置里的 Bedrock 区域模拟（和 minimalPolicy 给出的资源一致） */
    String.raw`R=$(awk '/^[ \t]*\[model_providers\."?amazon-bedrock"?\.aws\]/{f=1;next} /^[ \t]*\[/{f=0} f&&/^[ \t]*region[ \t]*=/{gsub(/.*=[ \t]*"|".*/,"");print;exit}' ~/.codex/config.toml 2>/dev/null)`,
    `[ -n "$R" ] || R=${DEFAULT_REGION}`,
    'echo "KX_IAM_REGION $R"',
    'PROBE=1',
    'if ! command -v aws >/dev/null 2>&1; then echo KX_IAM_NO_AWS; else',
    '  ARN=$(aws sts get-caller-identity --query Arn --output text 2>&1 </dev/null); RC=$?',
    `  if [ "$RC" -ne 0 ]; then echo "KX_IAM_ARN_ERR ${one('$ARN')}"; else`,
    '    echo "KX_IAM_ARN $ARN"; P="$ARN"',
    '    case "$ARN" in arn:aws*:sts::*:assumed-role/*)',
    '      PART=$(printf %s "$ARN" | cut -d: -f2); ACCT=$(printf %s "$ARN" | cut -d: -f5); RN=$(printf %s "$ARN" | cut -d/ -f2)',
    '      P=$(aws iam get-role --role-name "$RN" --query Role.Arn --output text 2>/dev/null </dev/null) || P=""',
    '      case "$P" in arn:*) ;; *) P="arn:$PART:iam::$ACCT:role/$RN" ;; esac ;;',
    '    esac',
    '    echo "KX_IAM_PRINCIPAL $P"',
    /*
      两次模拟、各用自己的资源：模型调用按 *（minimalPolicy 给的就是 *）；网页搜索按 arn:aws:bedrock-websearch:<区域>:aws:tool/*。
      不传 --resource-arns 时模拟的资源是 *，只按 tool/* 授权的策略会被误判成 implicitDeny。
    */
    `    SIM1=$(aws iam simulate-principal-policy --policy-source-arn "$P" --action-names ${MODEL_ACTIONS.join(' ')} ${query}); RC1=$?`,
    `    SIM2=$(aws iam simulate-principal-policy --policy-source-arn "$P" --action-names ${WEB_SEARCH_ACTIONS.join(' ')} --resource-arns "arn:aws:bedrock-websearch:$R:aws:tool/*" ${query}); RC2=$?`,
    /* 网页搜索再模拟一次、不带资源：带资源的那次对 ExternalWebAccess 会误判 implicitDeny（见 judgeWebSearch） */
    `    SIM3=$(aws iam simulate-principal-policy --policy-source-arn "$P" --action-names ${WEB_SEARCH_ACTIONS.join(' ')} ${query}); RC3=$?`,
    '    if [ "$RC1" -eq 0 ] && [ "$RC2" -eq 0 ] && [ -n "$SIM1" ] && [ -n "$SIM2" ]; then printf \'%s\\n%s\\n\' "$SIM1" "$SIM2" | sed \'s/^/KX_IAM_SIM /\'; PROBE=0;',
    '      if [ "$RC3" -eq 0 ] && [ -n "$SIM3" ]; then printf \'%s\\n\' "$SIM3" | sed \'s/^/KX_IAM_SIMNR /\'; fi',
    `    else echo "KX_IAM_SIM_ERR ${one('$SIM1 $SIM2')}"; fi`,
    '  fi',
    'fi',
    'if [ "$PROBE" = 1 ]; then',
    bedrockProbeScript(),
    'fi',
    'fi',
    'echo KX_IAM_TOML',
    'cat ~/.codex/config.toml 2>/dev/null || true',
  ].join('\n');
}

/**
 * 只跑那一次极短的试调用（60 秒封顶、强制打开网页搜索）。预检的模拟给不出结论（`probeNeeded`）时单独补跑；
 * 输出接在预检输出前面交给 `parseIamPrecheck`。
 */
export function bedrockProbeScript(): string {
  return [
    'if command -v codex >/dev/null 2>&1; then',
    '  echo KX_IAM_PROBE_BEGIN',
    '  D=$(mktemp -d 2>/dev/null || echo /tmp)',
    `  (cd "$D" && timeout 60 codex exec --ephemeral --skip-git-repo-check -s read-only --json -c 'web_search="live"' '${PROBE_PROMPT}' </dev/null 2>&1) | tail -c 6000; PRC=\${PIPESTATUS[0]}`,
    '  echo; echo "KX_IAM_PROBE_END $PRC"',
    '  [ "$D" != /tmp ] && rm -rf "$D"',
    'else echo KX_IAM_NO_CODEX; fi',
  ].join('\n');
}

/** 本机跑一个工具：`null` = 本机没有这个命令；`code` 是退出码，超时 `timedOut`。 */
export type LocalToolRun = (tool: 'aws' | 'codex', args: string[], timeoutMs: number) => Promise<{ code: number | null; out: string; timedOut?: boolean } | null>;

/**
 * **本机的同一份预检** —— 本机（尤其 Windows）不能假定有 bash，所以不跑 `bedrockCheckScript`，而是用注入的 `run`
 * 逐条跑同样的只读调用（不经 shell），拼出同样的 `KX_IAM_*` 输出交给 `parseIamPrecheck`。判据、资源、60 秒上限都和远端那份一样。
 */
export async function localBedrockCheckOutput(readConfig: () => string, run: LocalToolRun): Promise<string> {
  const toml = String(readConfig() || '');
  const out: string[] = [];
  const one = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!/^\s*model_provider\s*=\s*"amazon-bedrock"/m.test(toml)) {
    out.push('KX_IAM_NOT_BEDROCK');
  } else {
    const region = bedrockRegionOf(toml);
    out.push(`KX_IAM_REGION ${region}`);
    let probe = true;
    const id = await run('aws', ['sts', 'get-caller-identity', '--query', 'Arn', '--output', 'text'], 30_000);
    if (!id) out.push('KX_IAM_NO_AWS');
    else if (id.code !== 0) out.push(`KX_IAM_ARN_ERR ${one(id.out)}`);
    else {
      const arn = id.out.trim().split(/\s+/).pop() || '';
      out.push(`KX_IAM_ARN ${arn}`);
      let principal = arn;
      const role = arn.match(/^arn:aws[\w-]*:sts::\d{12}:assumed-role\/([^/]+)/);
      if (role) {
        const got = await run('aws', ['iam', 'get-role', '--role-name', role[1], '--query', 'Role.Arn', '--output', 'text'], 30_000);
        const real = got?.code === 0 ? got.out.trim().split(/\s+/).pop() || '' : '';
        principal = /^arn:/.test(real) ? real : (roleArnOf(arn) || arn);
      }
      out.push(`KX_IAM_PRINCIPAL ${principal}`);
      const q = ['--query', 'EvaluationResults[].[EvalActionName,EvalDecision]', '--output', 'text'];
      const s1 = await run('aws', ['iam', 'simulate-principal-policy', '--policy-source-arn', principal, '--action-names', ...MODEL_ACTIONS, ...q], 30_000);
      const s2 = await run('aws', ['iam', 'simulate-principal-policy', '--policy-source-arn', principal, '--action-names', ...WEB_SEARCH_ACTIONS,
        '--resource-arns', `arn:aws:bedrock-websearch:${region}:aws:tool/*`, ...q], 30_000);
      /* 网页搜索再模拟一次、不带资源（见 judgeWebSearch） */
      const s3 = await run('aws', ['iam', 'simulate-principal-policy', '--policy-source-arn', principal, '--action-names', ...WEB_SEARCH_ACTIONS, ...q], 30_000);
      if (s1?.code === 0 && s2?.code === 0 && s1.out.trim() && s2.out.trim()) {
        for (const l of `${s1.out.trim()}\n${s2.out.trim()}`.split(/\r?\n/)) if (l.trim()) out.push(`KX_IAM_SIM ${l.trim()}`);
        if (s3?.code === 0) for (const l of s3.out.trim().split(/\r?\n/)) if (l.trim()) out.push(`KX_IAM_SIMNR ${l.trim()}`);
        probe = false;
      } else {
        out.push(`KX_IAM_SIM_ERR ${one(`${s1?.out || ''} ${s2?.out || ''}`)}`);
      }
    }
    if (probe) out.push(await localBedrockProbeOutput(run));
  }
  out.push('KX_IAM_TOML', toml);
  return out.join('\n');
}

/** 本机的那一次试调用（同 `bedrockProbeScript`，不经 shell）。 */
export async function localBedrockProbeOutput(run: LocalToolRun): Promise<string> {
  /* `web_search=live`：值不是合法 TOML 时 codex 按原样字符串用 —— 省掉引号，Windows 上 .cmd 经 shell 也不会被拆 */
  const r = await run('codex', ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '--json', '-c', 'web_search=live', PROBE_PROMPT], 60_000);
  if (!r) return 'KX_IAM_NO_CODEX';
  return ['KX_IAM_PROBE_BEGIN', r.out.slice(-6000), `KX_IAM_PROBE_END ${r.timedOut ? 124 : (r.code ?? 1)}`].join('\n');
}

/** config.toml 里 Codex 的 Bedrock 区域（`[model_providers.amazon-bedrock.aws] region`）；没写就是默认的 us-east-1。 */
export function bedrockRegionOf(toml: string): string {
  const lines = String(toml || '').split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s*\[model_providers\.("?)amazon-bedrock\1\.aws\]/.test(l));
  for (let i = at + 1; at >= 0 && i < lines.length && !/^\s*\[/.test(lines[i]); i++) {
    const m = lines[i].match(/^\s*region\s*=\s*["']([^"']+)["']/);
    if (m) return m[1];
  }
  return DEFAULT_REGION;
}

/** 预检脚本的输出 → 结果。 */
export function parseIamPrecheck(out: string, now = Date.now()): BedrockIamCheck {
  const text = String(out || '');
  const tomlAt = text.indexOf('KX_IAM_TOML');
  const toml = tomlAt >= 0 ? text.slice(tomlAt + 'KX_IAM_TOML'.length).replace(/^\r?\n/, '') : '';
  const head = tomlAt >= 0 ? text.slice(0, tomlAt) : text;
  const lines = head.split(/\r?\n/);
  const val = (tag: string): string | undefined => {
    const l = lines.find((x) => x.startsWith(`${tag} `));
    return l ? l.slice(tag.length + 1).trim() : undefined;
  };
  const region = bedrockRegionOf(toml);
  const identity = val('KX_IAM_ARN');
  const roleArn = val('KX_IAM_PRINCIPAL') || roleArnOf(identity);
  const notes: string[] = [];
  if (lines.includes('KX_IAM_NO_AWS')) notes.push(tr('The AWS CLI is not installed on that machine, so the identity cannot be read.'));
  const arnErr = val('KX_IAM_ARN_ERR');
  if (arnErr) notes.push(tr('Could not read the identity: {err}', { err: arnErr }));

  let method: BedrockIamCheck['method'] = 'none';
  let model: Verdict = 'unknown';
  let webSearch: Verdict = 'unknown';
  let missing: string[] = [];
  let resource: string | undefined;
  let basis: IamBasis | undefined;
  let probeNeeded = false;

  const simOf = (tag: string): Record<string, string> => Object.fromEntries(lines.filter((l) => l.startsWith(`${tag} `))
    .map((l) => l.slice(tag.length + 1).trim().split(/\s+/)).filter((x) => x.length >= 2).map(([a, d]) => [a, d]));
  const decided = simOf('KX_IAM_SIM');
  const b = lines.indexOf('KX_IAM_PROBE_BEGIN');
  const e = lines.findIndex((l) => l.startsWith('KX_IAM_PROBE_END'));
  const probe = b >= 0 && e > b ? parseProbe(lines.slice(b + 1, e).join('\n'), Number(lines[e].split(/\s+/)[1])) : undefined;
  const noCodex = lines.includes('KX_IAM_NO_CODEX');
  if (Object.keys(decided).length) {
    method = 'simulate';
    /* 模型调用那一半：照旧按（不带资源的）模拟 */
    model = MODEL_ACTIONS.every((a) => decided[a] === 'allowed') ? 'ok'
      : MODEL_ACTIONS.some((a) => a in decided && decided[a] !== 'allowed') ? 'denied' : 'unknown';
    /* 网页搜索那一半：implicitDeny 不算数，要么不带资源的模拟 allowed、要么以试调用为准（judgeWebSearch） */
    const ws = judgeWebSearch({ withResource: decided, noResource: simOf('KX_IAM_SIMNR') }, probe);
    webSearch = ws.verdict;
    basis = ws.basis;
    probeNeeded = ws.probeNeeded && !noCodex;
    if (ws.probeNeeded && noCodex) notes.push(tr('Codex is not installed on that machine.'));
    if (ws.note) notes.push(ws.note);
    missing = [...MODEL_ACTIONS.filter((a) => a in decided && decided[a] !== 'allowed'), ...ws.missing];
  } else if (probe) {
    method = 'probe';
    basis = 'probe';
    ({ model, webSearch, missing, resource } = probe);
    if (probe.note) notes.push(probe.note);
  } else if (noCodex) {
    notes.push(tr('Codex is not installed on that machine.'));
  }
  return {
    ...(identity ? { identity } : {}),
    ...(roleArn ? { roleArn } : {}),
    method, model, webSearch, missing,
    ...(missing.length ? { policy: minimalPolicy(missing, region, resource) } : {}),
    ...(resource ? { resource } : {}),
    ...(basis ? { basis } : {}),
    ...(probeNeeded ? { probeNeeded: true } : {}),
    region,
    webSearchDisabled: codexWebSearchDisabled(toml),
    ...(lines.includes('KX_IAM_NOT_BEDROCK') ? { notBedrock: true } : {}),
    ...(notes.length ? { note: notes.join(' ') } : {}),
    checkedAt: now,
  };
}

/** 预检结果挂到引擎状态上（登录页 / 引擎面板读 `bedrock`）。 */
export function withBedrockCheck<T extends object>(status: T, check: BedrockIamCheck | undefined): T & { bedrock?: BedrockIamCheck } {
  return check ? { ...status, bedrock: check } : status;
}

// ---------------------------------------------------------------- 关掉网页搜索

/** 顶层 `web_search = "disabled"`（codex 0.16x：`"live"` / `"indexed"` / `"cached"` / `"disabled"`）。 */
export function codexWebSearchDisabled(toml: string): boolean {
  return topLevelValue(String(toml || ''), 'web_search') === 'disabled';
}

const TABLE_LINE = /^\s*\[/;
const WEB_SEARCH_LINE = /^\s*web_search\s*=/;

/**
 * **改之前读那份 config.toml，读不干净就不改** —— 读失败当成空文件、再整份写回去，会把 provider / 模型 / 区域全冲掉。
 * `existed: false` 只在明确知道文件不存在时出现（才允许从空配置开始）。
 */
export type ConfigRead = { ok: true; text: string; existed: boolean } | { ok: false; error: string };

/**
 * 远端读法：先确认文件在不在；在就 cat，前后各一个标记 —— 结尾标记只在 cat 成功之后才打印，
 * 所以 ssh 半路断掉、cat 出错、输出被截断都会缺结尾标记（`runRemoteCapture` 出错但有输出时也会把半截交回来）。
 */
export const REMOTE_CONFIG_READ_SCRIPT = 'F=~/.codex/config.toml; if [ ! -e "$F" ]; then echo KX_CFG_MISSING; else echo KX_CFG_BEGIN; cat "$F" && printf \'\\nKX_CFG_END_OK\\n\'; fi';

export function parseRemoteConfigRead(out: string): ConfigRead {
  /* 不做换行归一：文件内容原样（CRLF 的文件写回去还是 CRLF）；标记是远端 echo / printf 打的 LF */
  const s = String(out ?? '');
  const begin = s.indexOf('KX_CFG_BEGIN\n');
  const end = s.lastIndexOf('\nKX_CFG_END_OK');
  if (begin >= 0 && end >= begin + 'KX_CFG_BEGIN'.length && /\nKX_CFG_END_OK\n?$/.test(s)) {
    return { ok: true, text: s.slice(begin + 'KX_CFG_BEGIN\n'.length, end), existed: true };
  }
  if (begin < 0 && /^KX_CFG_MISSING\s*$/m.test(s)) return { ok: true, text: '', existed: false };
  return { ok: false, error: tr('the file could not be read completely') };
}

/** 本机读法：只有「文件不存在」（ENOENT）算空配置；别的错误（没权限、是目录…）一律不改。 */
export function readLocalConfig(file: string, readFile: (f: string) => string): ConfigRead {
  try {
    return { ok: true, text: readFile(file), existed: true };
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { ok: true, text: '', existed: false };
    return { ok: false, error: String(err?.code || err?.message || err) };
  }
}

/**
 * 关 / 开网页搜索：读 → 合并 → 写。读不干净就抛错、**不写**（原文件不动）。
 * 返回写进去的内容。
 */
export async function toggleCodexWebSearch(read: () => Promise<ConfigRead>, write: (text: string, existed: boolean) => Promise<void>, enabled: boolean): Promise<string> {
  const r = await read();
  if (!r.ok) throw new Error(tr('Could not read ~/.codex/config.toml ({why}), so nothing was changed.', { why: r.error }));
  const next = setCodexWebSearch(r.text, enabled ? null : 'disabled');
  await write(next, r.existed);
  return next;
}

/**
 * 把那台机器 config.toml 的顶层 `web_search` 设成 `"disabled"`（`null` = 删掉这一行，回到 Codex 默认）。
 * 只动顶层这一行：表里的同名键（`[tools] web_search`）、其余所有行逐字保留。
 */
export function setCodexWebSearch(existing: string, mode: 'disabled' | null): string {
  const src = String(existing || '');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  let firstTable = lines.findIndex((l) => TABLE_LINE.test(l));
  if (firstTable < 0) firstTable = lines.length;
  const line = `web_search = ${JSON.stringify(mode)}`;
  const at = lines.findIndex((l, i) => i < firstTable && WEB_SEARCH_LINE.test(l));
  if (at >= 0) {
    if (mode) lines[at] = line; else lines.splice(at, 1);
    return lines.join(eol);
  }
  if (!mode) return src;
  let pos = firstTable;
  while (pos > 0 && !lines[pos - 1].trim()) pos--;
  if (pos === firstTable && pos < lines.length && TABLE_LINE.test(lines[pos])) lines.splice(pos, 0, line, '');
  else lines.splice(pos, 0, line);
  return lines.join(eol);
}

// ---------------------------------------------------------------- 会话里的提示卡

/**
 * 提示卡的 group：`bedrock-denied:<机器 id>@<区域>→<动作,…>[|<资源>]`（同机器同动作同资源的连着几条并成一条）。
 * `resource`：报错里点名的资源（例如具体的模型 ARN）—— 卡上的策略照它收窄，不给成 `*`。
 */
export function deniedNoteGroup(x: { machineId?: string; region: string; actions: string[]; resource?: string }): string {
  return `bedrock-denied:${encodeURIComponent(x.machineId || '')}@${x.region}→${x.actions.join(',')}${x.resource ? `|${encodeURIComponent(x.resource)}` : ''}`;
}

export function parseDeniedNoteGroup(group: string | undefined): { machineId?: string; region: string; actions: string[]; resource?: string } | undefined {
  const m = String(group || '').match(/^bedrock-denied:([^@]*)@([^→]*)→([^|]+)(?:\|(.+))?$/);
  if (!m) return undefined;
  const machineId = decodeURIComponent(m[1]);
  const resource = m[4] ? decodeURIComponent(m[4]) : '';
  return {
    ...(machineId ? { machineId } : {}), region: m[2] || DEFAULT_REGION, actions: m[3].split(',').filter(Boolean),
    ...(resource ? { resource } : {}),
  };
}

/** 界面判断缺权限卡显不显示要用的那几项预检结果（主进程 `bedrock:check` 推过来的 BedrockIamCheck）。 */
export type NoteCheck = Pick<BedrockIamCheck, 'checkedAt' | 'model' | 'webSearch' | 'missing'>;

/**
 * **缺权限卡此刻还算不算数** —— 卡只跟 Codex、只跟卡上那台机器有关：
 * - 会话当前引擎不是 Codex → 不显示（切到 Claude Code / kiro 立即撤掉）；
 * - 会话当前机器不是卡上那台（`machineId`：设置里的机器 id，本机 'local'）→ 不显示；认不出是哪台（卡上没记机器、会话远程但不知道 id）也不显示；
 * - 那台机器在这张卡之后的预检里通过了（卡上的动作都不缺、对应那一半 ok）→ 不显示。
 * 不是这类卡（group 认不出来）→ true，不管。只改显示，记录不动；切回来、又缺了照样显示。
 */
export function bedrockNoteActive(group: string | undefined, at: number, ctx: { engine?: string; machineId?: string; check?: NoteCheck }): boolean {
  const g = parseDeniedNoteGroup(group);
  if (!g) return true;
  if (ctx.engine !== 'codex') return false;
  /* 只有能确认「就是那台」才显示：卡上没记机器、或认不出会话当前在哪台（远程但不知道 id）都不显示 */
  if (!g.machineId || !ctx.machineId || g.machineId !== ctx.machineId) return false;
  const c = ctx.check;
  if (c && c.checkedAt > at && !g.actions.some((a) => c.missing.includes(a))) {
    const web = g.actions.some((a) => a.startsWith('bedrock-websearch:'));
    const model = g.actions.some((a) => !a.startsWith('bedrock-websearch:'));
    if ((!web || c.webSearch === 'ok') && (!model || c.model === 'ok')) return false;
  }
  return true;
}

/** 卡上那段策略：动作 + 区域 + 报错里点名的资源（`deniedNoteGroup` 带过来的）。 */
export function deniedCardPolicy(group: string | undefined): string | undefined {
  const g = parseDeniedNoteGroup(group);
  return g ? minimalPolicy(g.actions, g.region, g.resource) : undefined;
}

/** 提示正文里的 role ARN（中英两版的正文都是这个 ARN 原样）。 */
export function deniedRoleArn(text: string): string | undefined {
  const m = String(text || '').match(/arn:aws[\w-]*:iam::\d{12}:(?:role|user)\/[\w+=,.@/-]+/);
  return m ? trimArn(m[0]) : undefined;
}
