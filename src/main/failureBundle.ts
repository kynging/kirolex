/**
 * **一次发送失败，把"当时到底发了什么"整包留下来** ——「这个问题很严重必须修好」。
 *
 * 为什么需要它：这次查到最后卡在一件事上 —— **同一时间同一模型，kiro-cli 里好的，KiroLex 里不好**
 * （「是我后来换成 kiro-cli 才好了」）。那就说明两边发出去的请求有差别，而 KiroLex 手里
 * 只有一句 `Internal error`：请求体是 kiro-cli 拼的，工具调用是通知（没有返回值可拦），
 * 事后 transcript 里也只留成功那一轮的东西。于是每次都只能靠猜，而故障又不能按需复现
 * （实测那 25 分钟过去之后，同样的 ACP 路径、同样的 opus-5、同样 16KB 注入，一次就过）。
 *
 * 所以失败的那一刻把四样东西落盘，下一次犯的时候可以**对着差异看**，而不是再猜一轮：
 *   1. `prompt.txt`      —— KiroLex 这一轮实际发出去的全部文本（含随行快照 + memory 注入）
 *   2. `cli-session.json(l)` —— kiro-cli **自己**存的那份会话状态和历史
 *      （`~/.kiro/sessions/cli/<id>`；这次才发现它是存盘的），里面有 model_info、
 *      `context_usage_percentage`、每一条 toolUse/toolResult
 *   3. `kiro-log.txt`    —— kiro-cli 日志在失败前后那一段（`err=EmptyResponse` 那行就在这儿）
 *   4. `meta.json`       —— 模型、pid、这一轮的工具数/最大工具输出、错误原文
 *
 * 每条会话只留最近 `KEEP_PER_SESSION` 次，且同一条会话 `COOLDOWN_MS` 内不重复落盘 ——
 * 诊断不能变成磁盘负担（一次连着失败 6 次就会写 6 份几乎一样的东西）。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { HostOps } from './hostOps.ts';
import { kiroCliLogPath } from './kiroCliLog.ts';

export const KEEP_PER_SESSION = 5;
export const COOLDOWN_MS = 60_000;

export interface BundleInput {
  sessionId: string;
  cliSessionId?: string;
  /** 这一轮发出去的文本块（KiroLex 侧的原样）。 */
  promptText: string;
  /**
   * 这一轮带着**后台命令 / 监视的输出**（模型自己起的 bg_run / watch，见 bgJobs.ts）：那段输出只回到会话、不额外落盘
   * （里面可能有凭证）。所以不抄 kiro-cli 自己那份会话历史（里面也有它）；prompt 用 `diagnosticPromptText` 换成占位。
   */
  omitConversation?: boolean;
  error: string;
  model?: string;
  pid?: number;
  toolsThisTurn?: number;
  maxToolOutput?: number;
  /**
   * 从**哪台机器**抄这些证据。远程会话里 kiro-cli 的日志和会话都在远端，
   * 用本地的 fs 去抄只会抄到一包空的（那比没有更糟：看起来像"抄到了，但什么都没有"）。
   */
  host: HostOps;
  /** kiro-cli 开了 trace 时日志涨得极快，512KB 可能只盖住一秒 —— 那时多抄一些。 */
  cliLogTailBytes?: number;
  home?: string;
  now?: number;
}

/**
 * 诊断包要不要**去掉会话内容**（prompt 原文 + kiro-cli 的会话历史）。
 * 不光是带着后台输出的那一轮：输出一旦进了会话，之后每一轮的历史（kiro-cli 那份会话、随行的历史快照）里都有它，
 * 所以这条会话之后任何一轮失败都一样不抄（`bgOutputSeen` 记在会话记录里，重启后也成立）。
 */
export function bundleOmitsSessionContent(o: { bgOutputThisTurn: boolean; sessionSawBgOutput: boolean }): boolean {
  return o.bgOutputThisTurn || o.sessionSawBgOutput;
}

/** 进诊断包的 prompt 原文；`omitOutput` = 这一轮是后台输出，只留一句占位和字数。 */
export function diagnosticPromptText(prompt: any[], omitOutput: boolean): string {
  const text = (prompt || []).map((b: any) => (typeof b === 'string' ? b : b?.text || '')).join('');
  return omitOutput ? `(background command output omitted: ${text.length} chars; it is kept only in the session)` : text;
}

export function bundleRoot(home = os.homedir()): string {
  return path.join(home, '.kirolex', 'failures');
}

/** 只留最近 N 个目录，其余删掉 —— 返回删掉的那些，方便日志说清。 */
export function prunable(dirs: string[], keep = KEEP_PER_SESSION): string[] {
  return [...dirs].sort().slice(0, Math.max(0, dirs.length - keep));
}

const lastWrite = new Map<string, number>();

/** 落一包。返回目录路径；被冷却挡下或写不成功时返回 null（诊断永远不能让发送失败）。 */
export async function writeFailureBundle(input: BundleInput): Promise<string | null> {
  const now = input.now ?? Date.now();
  const prev = lastWrite.get(input.sessionId) || 0;
  if (now - prev < COOLDOWN_MS) return null;
  lastWrite.set(input.sessionId, now);
  try {
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const dir = path.join(bundleRoot(input.home), input.sessionId, stamp);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'prompt.txt'), input.promptText ?? '');
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      at: new Date(now).toISOString(),
      sessionId: input.sessionId,
      cliSessionId: input.cliSessionId,
      model: input.model,
      pid: input.pid,
      toolsThisTurn: input.toolsThisTurn ?? 0,
      maxToolOutput: input.maxToolOutput ?? 0,
      promptChars: (input.promptText || '').length,
      error: String(input.error || '').slice(0, 2000),
    }, null, 2));
    /* kiro-cli 自己那份会话（状态 + 历史）—— 这是唯一能看到"后端手里是什么"的东西。
       路径挂在**跑 kiro-cli 那台机器**的 HOME 下，所以 home 从 host 问，不是 os.homedir()。 */
    if (input.cliSessionId && !input.omitConversation) {
      const base = path.join(await input.host.home(), '.kiro', 'sessions', 'cli', input.cliSessionId);
      await save(input.host, base + '.json', path.join(dir, 'cli-session.json'), 8 * 1024 * 1024, 'all');
      await save(input.host, base + '.jsonl', path.join(dir, 'cli-session.jsonl'), 2 * 1024 * 1024, 'tail');
    }
    const logPath = kiroCliLogPath(await input.host.tmpdir());
    await save(input.host, logPath, path.join(dir, 'kiro-log.txt'), input.cliLogTailBytes ?? 512 * 1024, 'tail');
    /* 只留最近几包 */
    const parent = path.join(bundleRoot(input.home), input.sessionId);
    const kids = fs.readdirSync(parent).filter((d) => !d.startsWith('.'));
    for (const old of prunable(kids)) {
      fs.rmSync(path.join(parent, old), { recursive: true, force: true });
    }
    return dir;
  } catch {
    return null;
  }
}

/**
 * 从 `host` 上抄一份到本地（`all` = 整个文件，`tail` = 只要尾部 `bytes` 字节）。
 *
 * **读不到就一个文件都不写** —— 远端没有的东西如果落成一个空文件，事后看起来像"抄到了但是空的"，
 * 那比缺一份糟得多（会让人对着一个空文件找原因）。
 */
async function save(host: HostOps, from: string, to: string, bytes: number, how: 'all' | 'tail'): Promise<void> {
  try {
    const text = how === 'all' ? await host.readAll(from, bytes) : await host.readTail(from, bytes);
    if (text === null || text === '') return;
    fs.writeFileSync(to, text);
  } catch { /* 没有就算了 */ }
}

/** 测试用：清掉冷却记录。 */
export function _resetCooldown(): void { lastWrite.clear(); }
