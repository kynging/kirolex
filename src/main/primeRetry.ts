/**
 * 重建历史上下文失败之后该怎么办 —— PURE。
 *
 * 实测的死循环：`chunk 1/6 FAILED chars=1982 tries=20`，每 60 秒一次，永远不放弃。
 * 重建循环里已经有三样保护（换模型有上限、失败两次就把块对半拆、退避封顶 60 秒），独独缺一个
 * 放弃条件；而这次的形状让三样全都无效：不是模型退役，所以不换模型；块只有 1982 字，已经在
 * `PRIME_MIN_CHUNK_CHARS = 2000` 的地板上拆不动；于是每次都落到退避那一支，无限。
 *
 * 判据：
 *   `retry`（busy）  后端还在收尾（compaction / 上一轮没结束）—— 不是错误，等它，不受次数限制
 *   `split`          同一块连续失败，而它还拆得动 —— 先怀疑"这一发太大"，拆开再试
 *   `give-up`        拆不动了还失败 = 确定性失败（大小已经不是原因），或者次数到顶
 *   `retry`          其余，退避重试
 *
 * 放弃不等于"重建好了"：调用方不清 `needsHistoryPrime`，下次真正用到这个会话时再试一次
 * （那时后端可能已经重连过了），并把原因记在 `primeLastError` 上。
 */
import { tr, trConcat } from './uiText.ts';
import { NOTE_DETAIL_SEP } from './kirolexNote.ts';

export type PrimeVerdict = 'retry' | 'split' | 'give-up';

export interface PrimeVerdictInput {
  /** 同一块连续失败几次了（从 1 开始，不含"后端还在收尾"的那几次）。 */
  tries: number;
  /** 这一块多大。 */
  chunkChars: number;
  /** 后端还在收尾 —— 不是错误状态。 */
  stillBusy: boolean;
  /** 块的下限；到了这个尺寸就拆不动了。 */
  minChunkChars: number;
  /** 连续失败几次开始拆。 */
  splitAfter: number;
  /** 同一块的总次数上限 —— 任何原因都不该超过它。 */
  maxTries: number;
  /** 已经在地板上、还失败几次就放弃。不是 1：一次失败可能是瞬时的（限流、网络抖动）；
   *  但也不该等到 `maxTries` —— 地板上的失败不可能是大小问题，多试只是多烧。 */
  giveUpAtFloor: number;
}

export function primeVerdict(input: PrimeVerdictInput): PrimeVerdict {
  // 后端在收尾不算失败，等它 —— 这一支刻意排在所有计数之前
  if (input.stillBusy) return 'retry';
  if (input.tries >= input.maxTries) return 'give-up';
  const canSplit = input.chunkChars > input.minChunkChars;
  if (canSplit) return input.tries >= input.splitAfter ? 'split' : 'retry';
  // 拆不动了：大小已经不是原因，再试就是确定性地重复同一个失败
  return input.tries >= input.giveUpAtFloor ? 'give-up' : 'retry';
}

/** 放弃时留在会话上的那句话：卡在哪、为什么不再试、你能做什么。 */
export function primeGiveUpNote(opts: {
  chunk: number; total: number; chars: number; tries: number; error: string; atFloor: boolean;
}): string {
  const why = opts.atFloor
    ? tr('This chunk is already small, so size is not the cause; the session connection is most likely broken. ')
    : tr('The same chunk hit the retry limit ({n}). ', { n: opts.tries });
  /* 主句只有"试了几次 + 简短原因"（拼进「重建历史没完成（…）」那句）；分块编号、字数、原始错误全文、下一步折进详情 */
  const short = String(opts.error || '').split('\n')[0].slice(0, 60);
  return trConcat(
    tr('failed {tries} times in a row: {error}', { tries: opts.tries, error: short }),
    NOTE_DETAIL_SEP,
    tr('Rebuilding history got stuck at chunk {chunk}/{total} ({chars} chars) after {tries} tries: {error}. {why}It retries the next time you send; you can also fork this session and continue in the new one.', {
      chunk: opts.chunk, total: opts.total, chars: opts.chars, tries: opts.tries, error: opts.error, why,
    }));
}
