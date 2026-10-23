/**
 * **Claude Code 自己定的定时任务**（`CronCreate`）还有没有待触发的 —— PURE（`tests/autonomousTurn.test.ts`）。
 *
 * Claude Code 的 cron 只活在适配器进程里：LRU 驱逐、换后端、重启都会让它无声消失（KiroLex 的 `schedule_create` 才落盘）。
 * 驱逐前据此在那条会话里提示一句（index.ts `ensureExecutorCapacity`），不阻止驱逐。
 *
 * 只能从 tool_call 认：claude-agent-acp 0.88.0 对不认识的工具 title 就是工具名，`_meta.claudeCode.toolName` 也是；
 * `rawInput` 是工具参数。判据：调用过 `CronCreate`（没失败）且没有对应的 `CronDelete`。
 * 对应关系按 id：`CronDelete` 的 `rawInput.id` 等于某个 `CronCreate` 结果里的 id（`_meta.claudeCode.toolResponse.id`，
 * 2026-10-23 实测）或出现在它的输出文字里，就摘那个；对不上就摘最早的一个。
 * 一次性的 cron 到点后 Claude Code 自己会删，这里看不到 —— 那就会多提示一次，宁多勿漏。
 */

export interface CronCreateSeen {
  toolCallId: string;
  /** 工具输出（找 job id 用，截短） */
  output: string;
  /** 结果里明说的 job id（`_meta.claudeCode.toolResponse.id`） */
  jobId?: string;
}

export interface ClaudeCronTrack {
  creates: CronCreateSeen[];
  /** CronDelete 的调用：toolCallId → 要删的 id（rawInput 可能在后面的 update 里才到） */
  deletes: Record<string, { id?: string; done?: boolean }>;
}

function toolNameOf(u: any): string {
  const meta = u?._meta?.claudeCode?.toolName;
  if (typeof meta === 'string' && meta) return meta;
  return typeof u?.title === 'string' ? u.title.trim() : '';
}

function textOf(content: any): string {
  if (!Array.isArray(content)) return '';
  return content.map((c: any) => (typeof c?.content?.text === 'string' ? c.content.text : typeof c?.text === 'string' ? c.text : '')).join('\n');
}

export function noteClaudeCronTool(track: ClaudeCronTrack | undefined, u: any): ClaudeCronTrack | undefined {
  const kind = u?.sessionUpdate;
  if (kind !== 'tool_call' && kind !== 'tool_call_update') return track;
  const id = String(u?.toolCallId || '');
  if (!id) return track;
  const name = kind === 'tool_call' ? toolNameOf(u) : '';
  const known = track && (track.creates.some((c) => c.toolCallId === id) || id in track.deletes);
  if (name !== 'CronCreate' && name !== 'CronDelete' && !known) return track;
  const t: ClaudeCronTrack = track || { creates: [], deletes: {} };
  if (name === 'CronCreate' && !t.creates.some((c) => c.toolCallId === id)) t.creates.push({ toolCallId: id, output: '' });
  if (name === 'CronDelete' && !(id in t.deletes)) t.deletes[id] = {};
  const create = t.creates.find((c) => c.toolCallId === id);
  if (create) {
    if (u?.status === 'failed') t.creates = t.creates.filter((c) => c !== create);
    else {
      const out = textOf(u?.content);
      if (out) create.output = out.slice(0, 2000);
      /* 实测（0.88.0）：CronCreate 的结果在 `_meta.claudeCode.toolResponse`（`{ id, humanSchedule, recurring, durable }`） */
      const jobId = u?._meta?.claudeCode?.toolResponse?.id;
      if (typeof jobId === 'string' && jobId) create.jobId = jobId;
    }
  }
  const del = t.deletes[id];
  if (del) {
    const target = u?.rawInput?.id;
    if (typeof target === 'string' && target) del.id = target;
    if (u?.status === 'completed' && !del.done) {
      del.done = true;
      const hit = del.id ? t.creates.find((c) => c.jobId === del.id || c.output.includes(del.id!)) : undefined;
      const drop = hit || t.creates[0];
      if (drop) t.creates = t.creates.filter((c) => c !== drop);
    }
    if (u?.status === 'failed') delete t.deletes[id];
  }
  return t;
}

export function hasPendingClaudeCron(track: ClaudeCronTrack | undefined): boolean {
  return !!track && track.creates.length > 0;
}
