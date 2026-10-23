/**
 * 权限条上画哪几个按钮（`components/PermissionBar.tsx`）。
 *
 * 通常一种 kind 只有一个选项（kiro、Claude Code 的 Bash / Write / WebFetch）：照旧画三个通用按钮
 * （允许一次 / 总是允许 / 拒绝），按 kind 各取第一个。
 *
 * **同一种 kind 出现不止一个时，按 kind 挑就会挑错** —— 实测：Claude Code 批准计划（ExitPlanMode）给五个选项，
 * 三个是 allow_always，第一个是「清空上下文并跳过所有权限」。原来「⟲ 总是允许」点下去就是它，另外两个看不到。
 * 这时每个选项各画一个按钮、用 agent 自己给的名字（和模型名一样不翻译），顺序照 agent 给的。
 */
export interface PermissionOptionLike { optionId: string; name?: string; kind?: string }
export interface PermissionButton {
  optionId: string;
  role: 'allow_once' | 'allow_always' | 'reject';
  /** 只在逐个列出时有：agent 给这个选项起的名字 */
  label?: string;
}

const roleOf = (kind?: string): PermissionButton['role'] =>
  kind?.startsWith('reject') ? 'reject' : kind === 'allow_always' ? 'allow_always' : 'allow_once';

export function permissionButtons(options: PermissionOptionLike[]): PermissionButton[] {
  const kinds = options.map((o) => o.kind || '');
  if (new Set(kinds).size !== kinds.length) {
    return options.map((o) => ({ optionId: o.optionId, role: roleOf(o.kind), ...(o.name ? { label: o.name } : {}) }));
  }
  const allowOnce = options.find((o) => o.kind === 'allow_once');
  const allowAlways = options.find((o) => o.kind === 'allow_always');
  const reject = options.find((o) => o.kind === 'reject_once')
    || options.find((o) => o.kind === 'reject_always')
    || options.find((o) => o.kind?.startsWith('reject'));
  const out: PermissionButton[] = [];
  if (allowOnce) out.push({ optionId: allowOnce.optionId, role: 'allow_once' });
  if (allowAlways) out.push({ optionId: allowAlways.optionId, role: 'allow_always' });
  if (reject) out.push({ optionId: reject.optionId, role: 'reject' });
  return out;
}

/**
 * **批准计划时的计划正文**（审计 2b）—— Claude Code 的 ExitPlanMode 权限请求：标题只是「Approve Plan」，
 * 正文在 `toolCall.rawInput.plan`，同一份也在 `toolCall.content[0].content.text`（实测附录 A12）。
 * 只认这一种请求（工具名 ExitPlanMode，或 kind `switch_mode`）—— 普通工具的 content 是它的入参说明，不是计划。
 */
export function planTextOf(toolCall: any): string | undefined {
  if (!toolCall || typeof toolCall !== 'object') return undefined;
  const isPlan = toolCall.name === 'ExitPlanMode' || toolCall.kind === 'switch_mode'
    || toolCall._meta?.claudeCode?.toolName === 'ExitPlanMode';
  if (!isPlan) return undefined;
  const raw = typeof toolCall.rawInput?.plan === 'string' ? toolCall.rawInput.plan : '';
  if (raw.trim()) return raw.trim();
  const block = Array.isArray(toolCall.content) ? toolCall.content.find((c: any) => typeof c?.content?.text === 'string') : undefined;
  const text = block?.content?.text || '';
  return text.trim() || undefined;
}

/** 计划长了默认折起来（超过这么多行或字） */
export function planIsLong(plan: string): boolean {
  return plan.length > 700 || plan.split('\n').length > 14;
}
