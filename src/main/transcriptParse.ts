/**
 * transcript.jsonl 的解析（从 sessionStore.ts 抽出来：那个模块在 `node --test` 下不能直接加载，这里能单测）。
 *
 * 两种读法结果完全一样：
 *   - `parseTranscriptText`：同步一口气解析（老路径，很多同步调用点还在用）；
 *   - `parseTranscriptTextChunked`：分片解析，每片（默认约 8ms）之后让出事件循环 ——「远程会话连接的前半段输入框没法输入」：
 *     transcript 实测 2–4.5 MB，attach / hydrate 时同步整读 + 逐行 JSON.parse 叠起来，主进程停住、Windows 上窗口不响应键盘。
 */
import { isKirolexNote } from './kirolexNote.ts';
import type { StoredMessage } from './sessionStore.ts';

/** transcript 的一行 → 追加进 `out`（或并进前面那条用户消息）。 */
export function parseTranscriptLine(line: string, out: StoredMessage[]): void {
  const t = line.trim();
  if (!t) return;
  try {
    const message = JSON.parse(t) as StoredMessage;
    /* 补记的本轮消耗（压缩那一条的花费在压缩真正完成时才到，见 `compactWait.compactUsagePatch`）：并进目标那条，不单独成一条 */
    if (message.usageForMessageId) {
      const target = out.find((candidate) => candidate.id === message.usageForMessageId);
      if (target && message.turnUsage) target.turnUsage = message.turnUsage;
      return;
    }
    if (message.mergeIntoMessageId) {
      const target = out.find((candidate) => candidate.id === message.mergeIntoMessageId);
      /* 目标是 KiroLex 的提示（也是 role:'user'）就不并：追加指令单独留一条，文字不丢 */
      if (target?.role === 'user' && !isKirolexNote(target)) {
        if (message.content) target.content = `${target.content}
${message.content}`;
        // 带附件的 steer：附件并到这一轮那条用户消息上（气泡里本来就是这么显示的）
        if (message.attachments?.length) target.attachments = [...(target.attachments || []), ...message.attachments];
        /* 记下这一段从哪开始 —— 界面按它把追加指令拆回独立的几条显示（content 照旧是合并后的）。
           只有附件、没有文字的那段没有接进 content，也就不记边界（否则拆分对不上） */
        if (message.content) (target.steerParts ||= []).push({ id: message.id, content: message.content, ts: message.ts });
        return;
      }
    }
    out.push(message);
  } catch { /* skip a torn final line */ }
}

export function parseTranscriptText(raw: string): StoredMessage[] {
  const out: StoredMessage[] = [];
  for (const line of raw.split('\n')) parseTranscriptLine(line, out);
  return out;
}

export const TRANSCRIPT_SLICE_MS = 8;

export async function parseTranscriptTextChunked(
  raw: string,
  opts: { sliceMs?: number; now?: () => number; yieldFn: () => Promise<void> },
): Promise<StoredMessage[]> {
  const sliceMs = opts.sliceMs ?? TRANSCRIPT_SLICE_MS;
  const now = opts.now ?? Date.now;
  const out: StoredMessage[] = [];
  const lines = raw.split('\n');
  let sliceAt = now();
  for (let i = 0; i < lines.length; i++) {
    parseTranscriptLine(lines[i], out);
    if (now() - sliceAt >= sliceMs) {
      await opts.yieldFn();
      sliceAt = now();
    }
  }
  return out;
}
