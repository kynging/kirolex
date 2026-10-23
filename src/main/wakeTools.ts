/**
 * **「过一会儿再看」的那组工具** —— 挂在 kirolex-local（`localMcp.ts`）上，本地会话和远程会话都有：
 *
 *   · `schedule_create / schedule_list / schedule_delete`：定时提示。**复用**现有的定时任务
 *     （`schedule.ts` / `scheduleStore.ts` / index.ts 的 `runScheduledJob` 和 20 秒一跳的计时器）——
 *     关窗也触发、按次计费、重启保留，只是多标一句「由模型创建」、循环类默认 7 天过期（`expiresInDays` 1–30）。
 *     目标型任务（`until` + 可选 `checkCommand`）：按目标停，检查命令在本机跑、没变化不叫醒模型。
 *     到点把 prompt 发进**创建它的那条会话**。`once` + `delaySec` 就是「N 秒后叫醒我继续」。
 *   · `bg_run / bg_status / bg_stop`：后台命令，退出时把退出码 + 输出末尾发回会话（`bgJobs.ts`）。
 *   · `watch`：长期运行的命令，每行 stdout 一个事件唤醒会话。
 *
 * 这里只做参数解释、上限和给模型看的文字；真正的存储、计时、进程都由 index.ts 经 `WakeHost` 注入。
 * 纯逻辑，不 import electron。
 */

import { CHECK_ERROR_LIMIT, MODEL_SCHEDULE_MAX_DAYS, MODEL_SCHEDULE_MIN_DAYS, modelScheduleFromArgs, type ScheduleSpec } from './schedule.ts';
import {
  BG_DEFAULT_TIMEOUT_SEC, BG_MAX_TIMEOUT_SEC, MAX_JOBS_PER_SESSION, WATCH_DEFAULT_TIMEOUT_SEC, WATCH_MAX_TIMEOUT_SEC,
  WATCH_COALESCE_MS, WATCH_RATE_LIMIT, formatDuration, type BgJobView, type BgStartInput,
} from './bgJobs.ts';
import { tr, uiLang } from './uiText.ts';

/** 单会话同时最多几个**还活着的**定时任务（结束了的不占名额）。 */
export const MAX_SCHEDULES_PER_SESSION = 20;

export interface WakeScheduleRow {
  id: string;
  describe: string;
  prompt: string;
  runs: number;
  /** `null`：目标型任务，不按次数停。 */
  maxRuns: number | null;
  paused: boolean;
  terminal: string | null;
  nextRunAt: number | null;
  createdBy?: 'model';
  expiresAt?: number | null;
  until?: string;
  checkCommand?: string;
}

export interface WakeHost {
  now(): number;
  createSchedule(sessionId: string, spec: ScheduleSpec, expiresAt: number | null): { ok: boolean; id?: string; describe?: string; nextRunAt?: number | null; error?: string };
  listSchedules(sessionId: string): WakeScheduleRow[];
  deleteSchedule(sessionId: string, id: string): { ok: boolean; error?: string };
  bg: {
    start(input: BgStartInput): { ok: true; job: BgJobView } | { ok: false; error: string };
    status(sessionId: string, jobId: string): BgJobView | null;
    tail(sessionId: string, jobId: string): string | null;
    stop(jobId: string, by: 'user' | 'model', sessionId?: string): Promise<{ ok: boolean; error?: string }>;
  };
  /** 后台命令的工作目录：这条会话的本地工作目录（远程会话也一样 —— 同 `local_bash`，跑在本机）。 */
  cwdFor(sessionId: string, fallback: string): string;
  /** 后台输出要交给这条会话的模型了（bg_status）：持久标记「见过后台输出」，之后这条会话的故障诊断包不抄会话内容。 */
  markOutputSeen(sessionId: string): void;
}

const WHEN = '要过一段时间再看结果，或等某个后台过程结束，用这些工具（schedule_create / bg_run / watch）；'
  + '**不要在一轮里 sleep 轮询**（那会一直占着这一轮，而且会被超时打断）。结果会作为一条新消息自动发回这条会话，'
  + '那时你再接着处理。会话正忙时会等这一轮结束再发。';
/**
 * **Claude Code / Codex 会话：定时用 KiroLex 的，不用后端自带的** —— Claude Code 的 `CronCreate` / `ScheduleWakeup`
 * 只活在适配器进程里，LRU 回收、换模型 / 换机器（换后端）、重启都会让它无声消失；`schedule_create` 由主进程定时、落盘。
 * 每轮注入给模型（index.ts `sendPromptOnce`，和文件位置说明同一处），kiro 会话不说（它没有那两个工具）。
 */
export const ADAPTER_SCHEDULE_NOTE = '[定时] 要定时提醒、过一会儿再看、或等某件事结束再继续，用 kirolex-local 的 schedule_create'
  + '（会话被换后端也还在）；不要用 Claude Code 自带的 CronCreate / ScheduleWakeup —— 它们只活在后端进程里，后端一换就没了。';

export function adapterScheduleNote(engine: string | undefined): string {
  return engine === 'claude' || engine === 'codex' ? ADAPTER_SCHEDULE_NOTE : '';
}

/** 已知限制（不改实现）：POSIX 上只按任务的进程组结束，主动脱离进程组的漏在外面；Windows 的作业对象能覆盖到。 */
const DETACH_LIMIT = '别用它起要长期留着的服务。会自己脱离进程组的程序（`setsid`、`daemonize`、Node `detached: true` 等）'
  + '在 macOS/Linux 上不在任务的进程组里，任务结束 / 被停止 / 退出 KiroLex 时都不会被自动结束（Windows 上会）。';

export function wakeToolDefs(): Array<{ name: string; description: string; inputSchema: any }> {
  return [
    {
      name: 'schedule_create',
      description: `安排一条**定时提示**：到点把 prompt 作为一条新消息发进这条会话，你带着上下文继续。${WHEN}\n`
        + '用法：`once` + `delaySec` = 「N 秒后叫醒我继续」；`interval` + `everySec`（最短 60 秒）= 每隔一段时间看一次；'
        + '`daily` / `weekly` + `atTime`（HH:MM，本地时间）+ `weekday`（0=周日）。'
        + `循环类要给 maxRuns（最多跑几次，每次都要花一轮），默认 7 天后过期（\`expiresInDays\` 可设 ${MODEL_SCHEDULE_MIN_DAYS}–${MODEL_SCHEDULE_MAX_DAYS} 天）；单会话最多 ${MAX_SCHEDULES_PER_SESSION} 个。\n`
        + '**要「盯到某件事结束」**（例如每 30 分钟查一次，直到几个任务都合并）：用 `until` 写清什么情况算达成，**不要拍一个 maxRuns**'
        + '（事先不知道要跑几次；给了 until 就可以不给 maxRuns，按目标停）。每次到点的消息里会带上这条目标，达成后你调用 schedule_delete 结束它。'
        + '能用一条命令判断的，再给 `checkCommand`：到点先跑这条命令、不叫醒你 —— 退出码 0 = 已达成（任务自动结束，叫醒你做最终汇报）；'
        + '1 = 还没达成（输出和上次一样就跳过这一次、不叫醒你，输出变了才带着新输出叫醒你）；其他退出码 / 超时算出错（叫醒你并附上错误输出，'
        + `连续 ${CHECK_ERROR_LIMIT} 次出错自动暂停）。所以命令的输出只打印「状态」，别带时间戳之类每次都变的东西。`
        + '`checkCommand` **只在用户本机跑**（同 bg_run：cwd = 这条会话的本地工作目录，远程会话也是本机，不在远程机器上跑），超时同 bg_run 的默认值。\n'
        + '用户能在聊天顶部看到并停掉它（标「由模型创建」），也能延长过期时间或改成不过期。',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '到点时发给你自己的话，写清楚要查什么、查完怎么汇报' },
          kind: { type: 'string', enum: ['interval', 'daily', 'weekly', 'once'] },
          everySec: { type: 'number', description: 'interval：间隔秒数，≥ 60' },
          atTime: { type: 'string', description: 'daily / weekly：HH:MM（24 小时制，用户本机时间）' },
          weekday: { type: 'number', description: 'weekly：0 = 周日 … 6 = 周六' },
          atEpoch: { type: 'number', description: 'once：触发时刻（epoch 毫秒）' },
          delaySec: { type: 'number', description: 'once：多少秒之后触发（和 atEpoch 二选一）' },
          maxRuns: { type: 'number', description: '最多跑几次。interval / daily / weekly 必填（给了 until 时可不填，按目标停）；once 默认 1' },
          until: { type: 'string', description: '目标：写清什么情况算达成，例如「d0a22e82、66540cd0 都 done 或 cancelled」。达成后调用 schedule_delete' },
          checkCommand: { type: 'string', description: '可选，需配 until：到点先在用户本机跑的检查命令（语法同 local_bash）。退出码 0 = 达成，1 = 还没达成，其他 = 出错' },
          expiresInDays: { type: 'number', description: `循环类多少天后过期，${MODEL_SCHEDULE_MIN_DAYS}–${MODEL_SCHEDULE_MAX_DAYS}，默认 7（不能设成不过期）` },
        },
        required: ['prompt', 'kind'],
      },
    },
    {
      name: 'schedule_list',
      description: '列出这条会话的定时任务（含用户手动建的；用户删掉的不再出现）。',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'schedule_delete',
      description: '删掉这条会话的一个定时任务（不再触发）。',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    {
      name: 'bg_run',
      description: `在用户本机后台跑一条 shell 命令（cwd = 这条会话的工作目录，语法同 local_bash），**立即返回 jobId**；`
        + `命令**退出时**把退出码和输出末尾（最多 4KB）作为一条新消息发回这条会话。${WHEN}\n`
        + '典型用法：等一个过程结束 —— `until aws cloudformation describe-stacks --stack-name X | grep -qE "COMPLETE|FAILED"; do sleep 30; done; '
        + 'aws cloudformation describe-stack-events --stack-name X --max-items 20`。'
        + `超时默认 ${BG_DEFAULT_TIMEOUT_SEC} 秒、上限 ${BG_MAX_TIMEOUT_SEC} 秒；单会话同时最多 ${MAX_JOBS_PER_SESSION} 个后台命令 + 监视。`
        + '命令结束时，它自己放到后台的进程（`nohup x &` / `start /b x`）也会一起结束。' + DETACH_LIMIT,
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          label: { type: 'string', description: '给人看的简短名字（例如「等 CloudFormation 栈」）' },
          timeoutSec: { type: 'number', description: `默认 ${BG_DEFAULT_TIMEOUT_SEC}，上限 ${BG_MAX_TIMEOUT_SEC}` },
        },
        required: ['command', 'label'],
      },
    },
    {
      name: 'bg_status',
      description: '看一个后台命令 / 监视的状态（running / exited / timeout / stopped …）、运行时长和输出末尾。',
      inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
    },
    {
      name: 'bg_stop',
      description: '停掉一个后台命令 / 监视（只结束它自己起的进程）。',
      inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
    },
    {
      name: 'watch',
      description: `**监视**一条长期运行的命令（例如 \`tail -f\` 日志并 grep 关键行）：它的**每行 stdout** 作为一个事件发回这条会话唤醒你，`
        + `${WATCH_COALESCE_MS}ms 内的几行合并成一条。${WHEN}\n`
        + `事件太多（${Math.round(WATCH_RATE_LIMIT.windowMs / 1000)} 秒内超过 ${WATCH_RATE_LIMIT.events} 条）会被自动停掉 —— 所以先在命令里过滤，只让值得叫醒你的行打出来。`
        + `超时默认 ${WATCH_DEFAULT_TIMEOUT_SEC / 60} 分钟、上限 ${WATCH_MAX_TIMEOUT_SEC / 3600} 小时，结束时也会通知。` + DETACH_LIMIT,
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          label: { type: 'string', description: '给人看的简短名字' },
          timeoutSec: { type: 'number', description: `默认 ${WATCH_DEFAULT_TIMEOUT_SEC}，上限 ${WATCH_MAX_TIMEOUT_SEC}` },
        },
        required: ['command', 'label'],
      },
    },
  ];
}

const NAMES = new Set(['schedule_create', 'schedule_list', 'schedule_delete', 'bg_run', 'bg_status', 'bg_stop', 'watch']);
/**
 * **换运行位置时，这条会话手上还在跑的后台任务 / 定时任务怎么办** —— 照常：
 * 后台命令和监视一直跑在**本机**（同 `local_bash`，远程会话也是），定时任务按 KiroLex 会话 id 记账，
 * 两样都不跟执行器走，所以换到哪台机器都不动它们，结果照常作为新消息发回这条会话。
 * 在切换提示里明说一句（没有就不说），别让人以为它们跟着旧机器一起断了。
 */
export function switchCarryOverText(bgRunning: number, schedulesLive: number): string {
  if (bgRunning <= 0 && schedulesLive <= 0) return '';
  const parts: string[] = [];
  if (bgRunning > 0) parts.push(tr('{n} background task(s) (bg_run / watch) keep running on this computer', { n: bgRunning }));
  if (schedulesLive > 0) parts.push(tr('{n} scheduled task(s) still fire on time', { n: schedulesLive }));
  return tr('⏳ {what}; results still come back to this session.', { what: parts.join(tr('; ')) });
}

export function isWakeTool(name: string): boolean {
  return NAMES.has(name);
}

/** 秒数夹在 [1, max]；没给 / 不是数就用默认。 */
function clampSec(v: unknown, def: number, max: number): number {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n) || n <= 0) return def;
  return Math.min(max, Math.max(1, n));
}

const when = (at: number | null | undefined): string => (typeof at === 'number' && at > 0 ? new Date(at).toLocaleString() : '—');

export async function callWakeTool(
  name: string,
  args: any,
  sessionId: string,
  workdir: string,
  host: WakeHost,
): Promise<{ text: string; isError?: boolean }> {
  const err = (text: string) => ({ text, isError: true });
  switch (name) {
    case 'schedule_create': {
      const live = host.listSchedules(sessionId).filter((s) => !s.terminal).length;
      if (live >= MAX_SCHEDULES_PER_SESSION) {
        return err(`没建：这条会话已经有 ${live} 个定时任务（上限 ${MAX_SCHEDULES_PER_SESSION} 个）。先用 schedule_delete 删掉不要的。`);
      }
      const parsed = modelScheduleFromArgs(args, host.now(), uiLang());
      if ('error' in parsed) return err(`没建：${parsed.error}`);
      const r = host.createSchedule(sessionId, parsed.spec, parsed.expiresAt);
      if (!r.ok) return err(`没建：${r.error || '未知原因'}`);
      return {
        text: `已建定时任务 ${r.id}：${r.describe || ''}，${parsed.spec.maxRuns === null ? '不按次数停、按目标停' : `最多 ${parsed.spec.maxRuns} 次`}`
          + `${parsed.spec.until ? `，目标：${parsed.spec.until}` : ''}`
          + `${parsed.spec.checkCommand ? '，到点先在本机跑检查命令（没变化不叫醒你）' : ''}`
          + `${r.nextRunAt ? `，下一次 ${when(r.nextRunAt)}` : r.nextRunAt === 0 ? '，马上第一次' : ''}`
          + `${parsed.expiresAt ? `，${when(parsed.expiresAt)} 过期` : ''}。到点会作为一条新消息发进这条会话；现在可以结束这一轮了。`,
      };
    }
    case 'schedule_list': {
      const rows = host.listSchedules(sessionId);
      if (!rows.length) return { text: '这条会话没有定时任务。' };
      return {
        text: rows.map((s) => `${s.id} · ${s.describe} · ${s.maxRuns === null || s.maxRuns === undefined ? `按目标停（已跑 ${s.runs} 次）` : `已跑 ${s.runs}/${s.maxRuns}`}`
          + `${s.terminal ? ` · 已结束（${s.terminal}）` : s.paused ? ' · 已暂停' : ` · 下一次 ${when(s.nextRunAt)}`}`
          + `${s.expiresAt ? ` · ${when(s.expiresAt)} 过期` : ''}`
          + `${s.createdBy === 'model' ? ' · 由模型创建' : ' · 用户建的'}`
          + `${s.until ? `\n  目标：${s.until.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`
          + `${s.checkCommand ? `\n  检查命令：${s.checkCommand.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`
          + `\n  prompt: ${s.prompt.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n'),
      };
    }
    case 'schedule_delete': {
      const id = String(args?.id || '');
      if (!id) return err('schedule_delete 需要 id');
      if (!host.listSchedules(sessionId).some((s) => s.id === id)) return err(`这条会话没有定时任务 ${id}`);
      const r = host.deleteSchedule(sessionId, id);
      return r.ok ? { text: `已删除定时任务 ${id}` } : err(`没删掉：${r.error || '未知原因'}`);
    }
    case 'bg_run':
    case 'watch': {
      const command = String(args?.command || '');
      if (!command.trim()) return err(`${name} 需要 command`);
      const kind = name === 'watch' ? 'watch' : 'run';
      const timeoutSec = kind === 'watch'
        ? clampSec(args?.timeoutSec, WATCH_DEFAULT_TIMEOUT_SEC, WATCH_MAX_TIMEOUT_SEC)
        : clampSec(args?.timeoutSec, BG_DEFAULT_TIMEOUT_SEC, BG_MAX_TIMEOUT_SEC);
      const r = host.bg.start({
        sessionId, kind, command, label: String(args?.label || ''), cwd: host.cwdFor(sessionId, workdir), timeoutMs: timeoutSec * 1000,
      });
      if (!r.ok) return err(`没起来：${r.error}`);
      return {
        text: kind === 'watch'
          ? `已开始监视 ${r.job.jobId}（「${r.job.label}」，最长 ${formatDuration(timeoutSec * 1000)}）。每有新输出会作为一条新消息发回这条会话；现在可以结束这一轮了。`
          : `已在后台运行 ${r.job.jobId}（「${r.job.label}」，最长 ${formatDuration(timeoutSec * 1000)}）。退出时会把退出码和输出末尾发回这条会话；现在可以结束这一轮了，不要等。`,
      };
    }
    case 'bg_status': {
      const jobId = String(args?.jobId || '');
      const job = host.bg.status(sessionId, jobId);
      if (!job) return err(`这条会话没有后台任务 ${jobId}`);
      const ran = formatDuration((job.endedAt ?? host.now()) - job.startedAt);
      /* 输出进模型的上下文之前先打标记 —— 这一轮之后失败的诊断包、上下文快照都不能留这段输出 */
      host.markOutputSeen(sessionId);
      const tail = host.bg.tail(sessionId, jobId) || '';
      return {
        text: `${job.jobId}「${job.label}」(${job.kind}) 状态 ${job.state}${job.exitCode !== null ? `，退出码 ${job.exitCode}` : ''}，运行 ${ran}`
          + `${job.kind === 'watch' ? `，已发 ${job.events} 个事件` : ''}\n输出末尾：\n${tail || '（没有输出）'}`,
      };
    }
    case 'bg_stop': {
      const jobId = String(args?.jobId || '');
      const r = await host.bg.stop(jobId, 'model', sessionId);
      return r.ok ? { text: `已停止 ${jobId}` } : err(r.error || `这条会话没有后台任务 ${jobId}`);
    }
    default:
      return err(`没有这个工具：${name}`);
  }
}
