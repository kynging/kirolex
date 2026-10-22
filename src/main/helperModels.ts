/**
 * **辅助模型（标题 / 提示词建议 / 会话记忆压缩）的多机清单和选机器** ——
 * 「设置里的辅助模型下拉没有自动更新成所有模型」。
 *
 * 本机 kiro-cli 会被出口地域过滤（实测只报 8 个、一个 Claude 都没有），而同一个账号在远程机器上
 * 报得出全部。以前下拉只问本机，于是看不到；默认辅助模型 `claude-sonnet-5` 本机没有，
 * `runLiteOneShot` 就悄悄换成别的、只写日志 —— 设置里显示的和实际在用的对不上。
 *
 * 这里是纯逻辑（不 import electron / fs，渲染端也用）：
 *   - `mergeHelperModelLists`：本机 + 每台远程的清单去重合并，本机优先，单台失败只少那台；
 *     还有机器没拉回来时用缓存 id 占位；
 *   - `planHelperRoute`：一次辅助调用按什么顺序、在哪台机器上试；
 *   - `remoteLiteScript` / `parseRemoteLiteOutput`：在远程机器上跑同一条一次性调用。
 */

/** 本机在清单里的机器名（和 `acp:list-models` 的 `'local'` 一致）。 */
export const LOCAL_MACHINE = 'local';

export interface MachineModelList {
  /** `LOCAL_MACHINE` 或 `remotes[].name` */
  machine: string;
  /** 给人看的名字（本机写「本机」，远程就是机器名） */
  label: string;
  /** `pending` = 还没拉回来；`failed` = 这台拉不到（只少这台，不影响别的） */
  status: 'ok' | 'failed' | 'pending';
  ids: string[];
  error?: string;
}

export interface HelperModelChoice {
  id: string;
  /** 在哪台机器上能用；占位（缓存里的、还不知道在哪）为 null */
  machine: string | null;
  label: string | null;
  placeholder?: boolean;
}

/** `auto` 不是一个能钉进 agent JSON 的具体模型，不进辅助模型清单。 */
const usableId = (id: string) => !!id && id !== 'auto';

/**
 * 合并多机清单。本机的排前面、两边都有的只标本机；远程按传入顺序，先报的那台算数。
 * 只要还有机器在 `pending`，缓存里有、实时清单里还没有的 id 作为占位排在最后；
 * 全部拉完（成功或失败）后占位就不再出现 —— 实时清单替换了它。
 */
export function mergeHelperModelLists(lists: MachineModelList[], cachedIds: string[] = []): HelperModelChoice[] {
  const ordered = [
    ...lists.filter((l) => l.machine === LOCAL_MACHINE),
    ...lists.filter((l) => l.machine !== LOCAL_MACHINE),
  ];
  const out: HelperModelChoice[] = [];
  const seen = new Set<string>();
  for (const l of ordered) {
    if (l.status !== 'ok') continue;
    for (const raw of l.ids || []) {
      const id = String(raw || '').trim();
      if (!usableId(id) || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, machine: l.machine, label: l.label });
    }
  }
  if (lists.some((l) => l.status === 'pending')) {
    for (const raw of cachedIds || []) {
      const id = String(raw || '').trim();
      if (!usableId(id) || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, machine: null, label: null, placeholder: true });
    }
  }
  return out;
}

/** 下拉里一项的文字：「claude-opus-5.5 · tokyo-arm」「gpt-5.6-terra · 本机」「x · 缓存」。 */
export function helperChoiceText(c: HelperModelChoice, localLabel: string, cachedLabel: string): string {
  if (c.placeholder || !c.machine) return `${c.id} · ${cachedLabel}`;
  return `${c.id} · ${c.machine === LOCAL_MACHINE ? localLabel : (c.label || c.machine)}`;
}

export interface HelperAttempt { model: string; machine: string }

/**
 * 辅助调用的尝试顺序。对设置里的每个模型（主 → 备用）：
 *   本机清单里有 → 本机；否则某台远程报了它 → 那台远程；本机清单问不到时，远程报了它也先去远程
 *   （下拉里已经确认它在那儿能用），之后再照旧在本机试一次（没依据不换）。
 * 本机清单是知道的、而尝试里没有一个落在本机时，最后补一个本机的兜底（`fallbackOrder` 里本机有的第一个）——
 * 远程也失败才走它，和以前"两个都退役了就挑一个清单里真有的"是同一条路。
 *
 * `effective` = 第一个会被试的模型；`substituted` = 它不是设置里的任何一个（界面要说出来）。
 */
export function planHelperRoute(opts: {
  wanted: string[];
  local: string[];
  remotes: Array<{ machine: string; ids: string[] }>;
  fallbackOrder: string[];
}): { attempts: HelperAttempt[]; effective: string; substituted: boolean } {
  const wanted = opts.wanted.map((m) => String(m || '').trim()).filter((m, i, arr) => !!m && arr.indexOf(m) === i);
  const localKnown = opts.local.length > 0;
  const attempts: HelperAttempt[] = [];
  for (const m of wanted) {
    if (localKnown && opts.local.includes(m)) { attempts.push({ model: m, machine: LOCAL_MACHINE }); continue; }
    const remote = opts.remotes.find((r) => (r.ids || []).includes(m));
    if (remote) attempts.push({ model: m, machine: remote.machine });
    if (!localKnown) attempts.push({ model: m, machine: LOCAL_MACHINE });
  }
  if (localKnown && !attempts.some((a) => a.machine === LOCAL_MACHINE)) {
    const first = wanted[0] || '';
    const picked = opts.local.includes(first)
      ? first
      : (opts.fallbackOrder.find((m) => opts.local.includes(m)) || opts.local[0]);
    if (!attempts.some((a) => a.model === picked && a.machine === LOCAL_MACHINE)) {
      attempts.push({ model: picked, machine: LOCAL_MACHINE });
    }
  }
  const effective = attempts[0]?.model || wanted[0] || '';
  return { attempts, effective, substituted: !!effective && !wanted.includes(effective) };
}

/** 远程一次性调用成功时打在输出最前面的标记（`runRemoteCapture` 在 ssh 报错但有输出时也会返回）。 */
export const REMOTE_LITE_OK = '__KIROLEX_LITE_OK__';

const sq = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** 远程机器上那份 lite agent 的名字：按模型分开（理由见 `remoteLiteScript`）。 */
export function remoteLiteAgentName(baseAgent: string, model: string): string {
  return `${baseAgent}-${String(model).replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

/**
 * 远程机器上跑辅助调用的脚本。**`--model` 在 `chat --no-interactive` 上不生效**（见 `runLiteOneShot`），
 * 真正说话的是 agent JSON 的 `model` —— 所以先把钉好模型的 agent 写进那台机器的 `~/.kiro/agents/`
 * （**每个模型一份**：`remoteLiteAgentName`。共用一个文件的话，标题 / 建议 / 记忆整理同时在跑、
 * 其中一次换了模型时，会在另一次「写完配置 → kiro-cli 读配置」之间把它覆盖掉，用错模型。
 * 按模型分开后，同一个文件只会被写成同一份内容，并发也无所谓；base64 送过去，不碰引号；临时文件 + mv），再用它跑。prompt 从 stdin 读：记忆压缩的 prompt 可能很长，
 * 拼进命令行既有长度上限也有引号问题。
 */
export function remoteLiteScript(bin: string, baseAgent: string, agentJson: Record<string, unknown>, model: string): string {
  const agentName = remoteLiteAgentName(baseAgent, model);
  const b64 = Buffer.from(JSON.stringify({ ...agentJson, name: agentName, model })).toString('base64');
  const file = `~/.kiro/agents/${agentName}.json`;
  return [
    'mkdir -p ~/.kiro/agents',
    `printf %s ${sq(b64)} | base64 -d > ${file}.tmp.$$`,
    `mv -f ${file}.tmp.$$ ${file}`,
    `out=$(${sq(bin)} chat --no-interactive --agent ${sq(agentName)} --model ${sq(model)} "$(cat)" 2>/dev/null)`
      + ` && printf '%s\\n%s' ${sq(REMOTE_LITE_OK)} "$out"`,
  ].join(' && ');
}

/** 有成功标记就返回模型的输出，否则 null（当作这台机器上这次失败了）。 */
export function parseRemoteLiteOutput(raw: string): string | null {
  const s = String(raw || '');
  const at = s.indexOf(REMOTE_LITE_OK);
  if (at < 0) return null;
  return s.slice(at + REMOTE_LITE_OK.length).replace(/^\r?\n/, '');
}
