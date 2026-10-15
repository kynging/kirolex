/** 主进程 index.ts（前半） 的中文文案。key 是英文原文（约定见 `src/main/uiText.ts`）。 */
export const ZH_INDEX_A: Record<string, string> = {
  // ── index.ts：会话连接 / 换模型 ──
  'This session is reconnecting. Wait a moment before switching the model/Agent.': '会话正在重新连接，请稍候再切换模型/Agent。',
  'The model/Agent switch for this session has not finished after 30 seconds, so it cannot connect right now.': '会话切换模型/Agent 超过 30 秒仍未完成，暂时无法连接。',
  '⚠️ The local kiro-cli model list has no "{wanted}", so this session will use one that is on the list. (Available here: {list}{more})':
    '⚠️ 本机 kiro-cli 的模型清单里没有「{wanted}」，这条会话会用清单里有的一个。（本机可用：{list}{more}）',
  "\nWhen the whole Claude family and `auto` vanish from the list, it is usually **region filtering on your outbound IP** (Anthropic models are region-restricted). Switching kiro-cli versions won't help. To use Claude, move this session to a remote machine.":
    '\n清单里 Claude 系列和 `auto` 整体消失，通常是**出口 IP 的地域过滤**（Anthropic 的模型分地区）——换 kiro-cli 版本没用。要用 Claude 就把这条会话切到远端机器上。',
  '\n…[{n} characters omitted]…\n': '\n…[省略 {n} 字符]…\n',
  ' (the largest single output was {k}K characters, which is most likely what the backend choked on; next time add `--query` / `| head` to that command to keep its output small)':
    '（其中最大的一次输出 {k}K 字符 —— 后端很可能是在这上面答不出来的，下次给那条命令加上 `--query` / `| head` 把输出截小）',

  // ── index.ts：重建历史上下文 ──
  'This session is not connected to a backend yet. Open it first, then rebuild.': '该会话尚未连接后端，先打开它再重建',
  'The backend was replaced; the rebuild will start over.': '后端已被替换，将重新开始重建',
  'Rebuild abandoned by the user': '用户已放弃重建',
  ' (attempt {n})': '（第 {n} 次尝试）',
  'Rebuilding history context {i}/{total}{retry}': '重建历史上下文 {i}/{total}{retry}',
  'Rebuilding history context{retry}': '重建历史上下文{retry}',
  'Model unavailable; switched backend ({msg})': '模型不可用，已切换后端（{msg}）',
  'Rebuilding history context {i}/{total} failed, retrying in {s}s': '重建历史上下文 {i}/{total} 失败，{s}s 后重试',

  // ── index.ts：MCP 组合 / 本地工具通道 / 远程 ──
  '⚠️ The combo file has an error ({error}), so this time it starts as "General" with no MCP attached.': '⚠️ 组合文件有错（{error}），这次按「通用」起，不挂 MCP。',
  '⚠️ Combo "{wanted}" not found (it may have been deleted), so this time it starts as "{used}".': '⚠️ 找不到组合「{wanted}」（可能被删了），这次按「{used}」起。',
  '⚠️ MCP "{mcp}" in combo "{combo}" needs environment variable(s) {vars}, which are not set on this machine; skipping it for now.':
    '⚠️ 组合「{combo}」里的 MCP「{mcp}」要用环境变量 {vars}，本机没有设置 —— 这一条先跳过。',
  "⚠️ MCP \"{mcp}\" in combo \"{combo}\" needs environment variable(s) {vars}, which are not set on this machine; it won't be attached in this remote session for now.":
    '⚠️ 组合「{combo}」里的 MCP「{mcp}」要用环境变量 {vars}，本机没有设置 —— 这条远程会话里先不挂它。',
  "⚠️ MCP \"{mcp}\" in combo \"{combo}\" can't be forwarded from this machine: {reason}. It won't be attached in this remote session for now.":
    '⚠️ 组合「{combo}」里的 MCP「{mcp}」没法从本机转发：{reason} —— 这条远程会话里先不挂它。',
  '⚠️ {host} has no agent "{agent}", so this session uses the **default agent** plus your local tools. To run it as that agent, create a config with the same name on that machine.':
    '⚠️ {host} 上没有 agent「{agent}」，这条会话用**默认 agent** + 你本机的工具。要它按那个 agent 跑，在那台机器上建一份同名配置。',
  "⚠️ The local tools channel failed to start: {error}. This remote session can't read files on your machine, so don't let it change anything yet. It will reconnect automatically once the connection is back.":
    '⚠️ 本地工具通道没起来：{error}。这条远程会话读不到你机器上的文件 —— 先别让它改东西。连接恢复后会自动重接这条会话。',
  "Can't find this machine ({machine}). Was it removed in Settings?": '找不到这台机器（{machine}）—— 设置里删掉了？',
  'ssh exit code {code}': 'ssh 退出码 {code}',
  "⚠️ It asked your machine to do something KiroLex doesn't recognise: `{raw}` ({why}).": '⚠️ 它想让你这台机器做一件我不认的事：`{raw}` —— {why}。',
  '⚠️ It has already asked to open {n} pages this turn, so the rest were not opened (`{target}`). The link is above; click it if you need it.':
    '⚠️ 这一轮它已经要求打开 {n} 个页面了，剩下的没开（`{target}`）—— 链接就在上面，需要的话点它。',
  '⚠️ Refused to open `{target}` on this machine. Only http/https is allowed.': '⚠️ 拒绝在本机打开 `{target}` —— 只允许 http/https。',
  'the remote': '远端',
  '🌐 Opened `{target}` in **your** browser (requested by the agent on {host}).': '🌐 已在**你的**浏览器里打开 `{target}`（{host} 上的它要求的）。',
  "⚠️ It asked to open `{target}`, but it couldn't be opened: {error}": '⚠️ 它要求打开 `{target}`，但没打开：{error}',
  "⚠️ The local tools connection dropped; reconnecting (attempt {n}). Until then this remote session can't read or write files on your machine.":
    '⚠️ 本机工具连接中断，正在重连（第 {n} 次）—— 这期间这条远程会话读写不了你机器上的文件。',
  '🔌 Local tools connection restored.': '🔌 本机工具连接已恢复。',
  "🔌 The local tools channel is back; reconnecting this session's executor. After that it can read and write files on your machine again.":
    '🔌 本地工具通道回来了，正在重接这条会话的执行器 —— 之后它就能读写你机器上的文件了。',
  "Can't connect to {host}: {error}": '连不上 {host}：{error}',
  "Can't connect to {host}": '连不上 {host}',
  '{host} has no ACP adapter for {engine} ({bin}). Settings → 🖥 Machines → select this machine → "Install AI tools" will install it ({pkg}). You also need to have signed in to {engine} on that machine.':
    '{host} 上没有 {engine} 的 ACP 适配器（{bin}）。设置 → 🖥 机器 → 选中这台机器 →「安装 AI 工具」会装上它（{pkg}）；另外那台机器上要登录过 {engine}。',
  '⚠️ {host} has no model "{wanted}", so this session uses "{fallback}" instead. (Available there: {list}{more}) kiro-cli silently falls back to its default model in this case, so KiroLex says so here.':
    '⚠️ {host} 上没有模型「{wanted}」，这条会话改用「{fallback}」。（远端可用：{list}{more}）kiro-cli 对这种情况是静默退回默认模型的，所以这里明说一句。',
  '{what} timed out (no response for {s}s)': '{what} 超时（{s}s 无响应）',

  // ── index.ts：改写排队 / 权限 ──
  '⏳ Queued: {label}. {n} earlier revision(s) are still running; it will be sent automatically when its turn comes.':
    '⏳ 已排队：{label} —— 前面还有 {n} 条改写没跑完，轮到它会自动发出去。',
  '⏳ Queued: {label}. This session is busy ({busy}); it will be sent automatically once it is free.':
    '⏳ 已排队：{label} —— 这条会话正忙（{busy}），空下来会自动发出去。',
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
