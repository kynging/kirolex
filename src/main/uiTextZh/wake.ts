/** 模型自己安排的定时检查 / 后台命令 / 监视（schedule.ts、bgJobs.ts、wakeTools.ts、index.ts 里的接线）。 */
export const ZH_WAKE: Record<string, string> = {
  // ── schedule.ts ──
  'kind must be one of interval / daily / weekly / once': 'kind 只能是 interval / daily / weekly / once',
  'maxRuns is required for a recurring job (how many times it may run at most)': '循环任务必须给 maxRuns（最多跑几次）',
  'Expired': '已过期',
  // ── bgJobs.ts ──
  '{n} sec': '{n} 秒',
  '{m} min {s} sec': '{m} 分 {s} 秒',
  '{h} h {m} min': '{h} 小时 {m} 分',
  '…(earlier output omitted, showing the last {n} bytes)': '…（前面的输出省略，只显示最后 {n} 字节）',
  'command is empty': 'command 是空的',
  'This session already has {n} background commands / watches running (the limit is {n}). Stop one with bg_stop first':
    '这条会话已经有 {n} 个后台命令 / 监视在跑（上限 {n} 个）。先用 bg_stop 停掉一个',
  'The working directory does not exist: {dir}': '工作目录不存在：{dir}',
  'No such background task: {id}': '没有这个后台任务：{id}',
  '⏹️ Background task "{label}" was stopped by the user ({id})': '⏹️ 后台任务「{label}」已被用户停止（{id}）',
  '👀 Watch "{label}" ({id}) new output:': '👀 监视「{label}」（{id}）有新输出：',
  '👀 Watch "{label}" reached its time limit ({dur}) and was stopped ({id})': '👀 监视「{label}」到了时间上限（{dur}），已结束（{id}）',
  '🔔 Background command "{label}" timed out after {dur} and was stopped ({id})': '🔔 后台命令「{label}」跑了 {dur} 超时，已结束（{id}）',
  '👀 Watch "{label}" was stopped: too many events (more than {n} within {sec} sec). Use a command that prints less often, or filter its output ({id})':
    '👀 监视「{label}」已被限流停掉：事件太多（{sec} 秒内超过 {n} 条）。换一个输出少一些的命令，或者先过滤输出（{id}）',
  'Last output:': '输出末尾：',
  '(no output)': '（没有输出）',
  '🔔 Background command "{label}" could not run: {why} ({id})': '🔔 后台命令「{label}」没能运行：{why}（{id}）',
  '👀 Watch "{label}" ended: the command exited with code {code} ({id})': '👀 监视「{label}」已结束：命令退出，退出码 {code}（{id}）',
  '🔔 Background command "{label}" finished: exit code {code}, ran {dur} ({id})': '🔔 后台命令「{label}」已结束：退出码 {code}，用时 {dur}（{id}）',
  '⚠️ KiroLex restarted, so background task "{label}" ({id}) was interrupted and is no longer running':
    '⚠️ KiroLex 重启，后台任务「{label}」（{id}）已中断，不再运行',
};
