/** 主进程 index.ts（前半） 的中文文案。key 是英文原文（约定见 `src/main/uiText.ts`）。 */
export const ZH_INDEX_A: Record<string, string> = {
  // ── index.ts：会话连接 / 换模型 ──
  'This session is reconnecting. Wait a moment before switching the model/Agent.': '会话正在重新连接，请稍候再切换模型/Agent。',
  'The model/Agent switch for this session has not finished after 30 seconds, so it cannot connect right now.': '会话切换模型/Agent 超过 30 秒仍未完成，暂时无法连接。',
  '⚠️ This machine has no model "{wanted}", so this session uses "{model}" instead.': '⚠️ 本机没有模型「{wanted}」，这条会话改用「{model}」。',
  'Available here: {list}{more}': '本机可用：{list}{more}',
  '\nNo Claude model and no `auto` in the list: usually your outbound IP is region-filtered (switching kiro-cli versions won\'t help). To use Claude, move this session to a remote machine.': '\n清单里没有任何 Claude 和 `auto`：通常是出口 IP 被按地区过滤（换 kiro-cli 版本没用）。要用 Claude，把这条会话切到远端。',
  '\n…[{n} characters omitted]…\n': '\n…[省略 {n} 字符]…\n',
  ' (the largest tool output was {k}K characters, likely what broke it; next time add `--query` / `| head` to that command)': '（最大一次工具输出 {k}K 字符，多半是它导致的；下次给那条命令加 `--query` / `| head` 截短）',

  // ── index.ts：重建历史上下文 ──
  'This session is not connected yet. Open it first, then rebuild history.': '会话还没连上，先打开它再重建历史。',
  'The session reconnected; rebuilding history will start over.': '会话重连了，重建历史将从头开始。',
  'You gave up rebuilding history': '已放弃重建历史',
  ' (attempt {n})': '（第 {n} 次尝试）',
  'Rebuilding history {i}/{total}{retry}': '重建历史 {i}/{total}{retry}',
  'Rebuilding history{retry}': '重建历史{retry}',
  'Model unavailable, switched to {to}; rebuilding history starts over ({msg})': '模型不可用，已换成 {to}，重建历史从头开始（{msg}）',
  'Rebuilding history {i}/{total} failed, retrying in {s}s': '重建历史 {i}/{total} 失败，{s} 秒后重试',

  // ── index.ts：MCP 组合 / 本地工具通道 / 远程 ──
  '⚠️ The combo file has an error ({error}), so this time it starts as "General" with no MCP attached.': '⚠️ 组合文件有错（{error}），这次按「通用」起，不挂 MCP。',
  '⚠️ Combo "{wanted}" not found (it may have been deleted), so this time it starts as "{used}".': '⚠️ 找不到组合「{wanted}」（可能被删了），这次按「{used}」起。',
  '⚠️ MCP "{mcp}" in combo "{combo}" needs environment variable(s) {vars}, not set on this machine; it is skipped this time.': '⚠️ 组合「{combo}」的 MCP「{mcp}」缺本机环境变量 {vars}，这次先不挂。',
  "⚠️ MCP \"{mcp}\" in combo \"{combo}\" can't be forwarded from this machine ({reason}); it is skipped this time.": '⚠️ 组合「{combo}」的 MCP「{mcp}」没法从本机转发（{reason}），这次先不挂。',
  '⚠️ {host} has no agent "{agent}", so the default agent is used. To use it, create a config with that name on that machine.': '⚠️ {host} 上没有 agent「{agent}」，改用默认 agent；要用它，请在那台机器上建同名配置。',
  "⚠️ The local tools connection failed ({error}); this remote session can't read or write your files for now. It reconnects automatically.": '⚠️ 本机工具连接没建起来（{error}），这条远程会话暂时读写不了你的文件，会自动重连。',
  "Can't find this machine ({machine}). Was it removed in Settings?": '找不到这台机器（{machine}）—— 设置里删掉了？',
  'ssh exit code {code}': 'ssh 退出码 {code}',
  "⚠️ Ignored an unrecognised request for this machine: `{raw}` ({why}).": '⚠️ 已忽略一条不认识的本机操作：`{raw}`（{why}）。',
  '⚠️ This turn already opened {n} pages, so `{target}` was not opened; click the link above if you need it.': '⚠️ 这一轮已打开 {n} 个页面，`{target}` 没再打开；需要的话点上面的链接。',
  '⚠️ Refused to open `{target}`: only http/https links can be opened on this machine.': '⚠️ 已拒绝打开 `{target}`：本机只打开 http/https 链接。',
  'the remote': '远端',
  'Opened `{target}` in your browser (requested from {host}).': '已在你的浏览器里打开 `{target}`（{host} 上的会话请求的）。',
  "⚠️ Couldn't open `{target}`: {error}": '⚠️ 没能打开 `{target}`：{error}',
  "⚠️ The local tools connection dropped; reconnecting (attempt {n}). Until then this remote session can't read or write your files.": '⚠️ 本机工具连接中断，正在重连（第 {n} 次），这期间读写不了你的文件。',
  'Local tools connection restored.': '本机工具连接已恢复。',
  "⏳ Local tools connection restored; reconnecting this session…": '⏳ 本机工具连接已恢复，正在重连这条会话…',
  "Can't connect to {host}: {error}": '连不上 {host}：{error}',
  "Can't connect to {host}": '连不上 {host}',
  '⚠️ {host} has no model "{wanted}", so this session uses "{fallback}" instead.': '⚠️ {host} 上没有模型「{wanted}」，这条会话改用「{fallback}」。',
  'Available there: {list}{more}': '远端可用：{list}{more}',
  '{what} timed out (no response for {s}s)': '{what} 超时（{s}s 无响应）',
  '⏳ Queued: {label} ({why}); it will be sent automatically.': '⏳ 已排队：{label}（{why}），轮到时自动发出。',
  '{n} earlier revision(s) still running': '前面还有 {n} 条改写',
  'session busy: {busy}': '会话正忙：{busy}',

  // ── index.ts：改写排队 / 权限 ──
  'Tool call awaiting approval': '需要批准的工具调用',

  // ── index.ts：S3 备份 ──
  'No encrypted storage (keychain / keyring) is available on this machine, so KiroLex refuses to write the secret into the config in plain text.':
    '这台机器上没有可用的加密存储（keychain / keyring）—— 拒绝把 secret 明文写进配置。',
  'S3 backup is not fully set up: missing {fields} (Settings → ☁️ Backup).': 'S3 备份还没配好：缺 {fields}（设置 → ☁️ 备份）。',
  "The S3 secret can't be decrypted any more: the key in the keychain has changed (new machine or reinstall?). Enter it again.":
    'S3 的 secret 解不开了 —— keychain 里那把密钥变了（换过机器/重装过？）。重新填一次。',
  '{key}: {error}': '{key}：{error}',
  'The previous sync is still running': '上一轮还在跑',
  'Backing off': '退避中',
  "What was read back doesn't match what was written. The bucket may have a policy that rewrites content.": '写进去又读回来的内容不一致 —— 桶上可能有改写内容的策略。',
  ' (the test object could not be deleted: {error}. {key} was left in the bucket; this key may lack s3:DeleteObject)':
    '（测试对象没删掉：{error} —— 桶里留了 {key}，这个 key 可能没有 s3:DeleteObject）',
  'Read and write OK ({bucket} / {region}){leftover}': '可读可写（{bucket} / {region}）{leftover}',
  'There are no backups in this bucket yet (sync once first).': '这个桶里还没有备份（先同步一次）。',
  'Invalid project name.': '项目名不合法。',
  'Not confirmed: the project to delete must be passed back exactly.': '没确认 —— 要删哪个项目得原样传回来。',
  'The bucket has no catalog yet (never synced).': '桶里还没有 catalog（没同步过）。',
  'The catalog could not be read.': 'catalog 读不出来。',
  'The bucket has no backups belonging to "{project}".': '桶里没有属于「{project}」的备份。',
  'Unassigned': '未分组',
  'No sessions selected, or none of them exist on this machine.': '没选会话，或者本机没有这几条。',
  'No sessions selected.': '没选会话。',
  'None of the selected sessions are in the bucket any more.': '选的这些桶里已经没有了。',
  'Invalid session id.': '会话 id 不合法。',
  'This session is in the middle of a turn. Wait for it to finish before restoring, or the unsaved part of this turn will be lost.':
    '这条会话正在跑一轮 —— 等它跑完再恢复，不然这一轮还没落盘的内容会丢。',
  'The bucket has no files for {id}.': '桶里没有 {id} 的文件。',
};
