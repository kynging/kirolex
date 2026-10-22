/** 主界面框架（App / 侧栏 / 设置页 / 其余小组件） 的中文文案。key 是英文原文（约定见 `src/renderer/i18n.ts`）。 */
export const ZH_SHELL: Record<string, string> = {
  // ── App.tsx ──
  'Room for {n} more chats.': '还能再放 {n} 个会话。',
  'Minimize': '最小化',
  'Restore': '还原',
  'Maximize': '最大化',
  'Which folder should chats in "{project}" work in?\n\nLeave empty = your home folder. An absolute path = every chat in this project (including each flow step) runs there.':
    '「{project}」的会话在哪个目录里干活？\n\n留空 = 家目录。写绝对路径 = 这个 project 的所有会话（包括 flow 的每一步）都在那儿跑。',
  'Could not set it: {reason}': '设不上：{reason}',
  'Show preview panel ({n} tabs)': '显示预览栏（{n} 个标签）',
  'Hide preview panel (tabs are kept)': '隐藏预览栏（标签都留着）',
  'Show in Finder': '在 Finder 中显示',
  'Show in Explorer': '在资源管理器中显示',
  'Open location': '打开位置',
  'Stop commenting and just read': '退出批注，安静读',
  'Comment block by block: 💬 “✓ Confirm” has the chat that opened this file revise that block and write it back right away; + adds new content after the block; ✕ deletes it':
    '逐段写意见：💬「✓ 确认」当场让打开这份文件的会话改那一块并写回；＋ 在那一段后面加新内容；✕ 直接删掉',
  'Comment line by line. This tab has no owning chat, so comments can be viewed but not sent (open the file from a link in a chat to get one)':
    '逐行写意见 —— 这个标签页没有归属会话，只能看不能发（从会话里点开文件链接才有）',
  'This file type cannot be previewed. Use “📂 Open location” to open it locally.': '这种文件无法预览。用「📂 打开位置」在本地打开。',
  '⚠️ Preview truncated at 512 KB. Use “📂 Open location” to open the complete file.': '⚠️ 预览只显示前 512 KB。用「📂 打开位置」打开完整文件。',
  'Which AI': '用哪个 AI',
  'Uses {engine}’s own login and default model. To run it on a remote machine, that machine needs its ACP adapter installed (Settings → Machines → “Install AI tools”) and signed in.':
    '用 {engine} 自己的登录和默认模型；选远端机器的话，那台机器上要装好它的 ACP 适配器（设置 → 机器 →「安装 AI 工具」）并登录过。',
  'Which machine to run on': '在哪台机器上跑',
  'Local': '本地',
  'Files stay local. The remote kiro-cli reads and writes the files on this machine through a tunnel (nothing is copied).':
    '文件仍然在本地 —— 远端那个 kiro-cli 通过隧道读写你这台机器上的文件（不复制）。',
  'Open log file': '打开日志文件',
  '⋯ Loading older logs…': '⋯ 加载更早的日志…',
  '↑ Scroll up to load older logs': '↑ 上拉加载更早的日志',
  'This deletes the {n} messages after this one and reruns from the edited message.': '将删除这条之后的 {n} 条记录并基于编辑后的消息重跑。',

  // ── components/Sidebar.tsx ──
  'Switching where this runs…': '正在切换运行位置…',
  'This chat’s kiro-cli runs on {host}; the files stay on this machine. It reads and writes them by calling local tools over a reverse tunnel (no files are copied).':
    '这条会话的 kiro-cli 跑在 {host} 上；文件仍然在你这台机器上 ——它通过一条反向隧道调本地工具来读写（不复制文件）。',
  '✗ Could not switch engine: {reason}': '✗ 切换引擎失败：{reason}',
  '✗ Could not switch where this runs: {reason}': '✗ 切换运行位置失败：{reason}',
  'reason unknown': '原因不明',
  '🏷️ Move to project': '🏷️ 移动项目',
  'No other projects': '没有其他项目',
  '🤖 Engine: {engine}': '🤖 运行引擎：{engine}',
  'Run with kiro-cli (kiro’s models and agents)': '用 kiro-cli 跑（kiro 的模型和 agent）',
  'Run with {engine} (its own login and default model)': '用 {engine} 跑（它自己的登录和默认模型）',
  '{icon} Runs on: {where}': '{icon} 运行位置：{where}',
  'Switch back to running locally. Remote changes are fetched first; if they can’t be fetched, nothing is switched.':
    '切回本地跑。切之前会先把远端的改动取回来 —— 取不回来就不切。',
  'Run on {host} (files stay local, mirrored before and after each turn)': '在 {host} 上跑（文件仍在本地，每轮前后同步镜像）',
  'Opens Settings → Machines to add a new machine; once saved it shows up here': '打开 设置 → 机器，直接添加一台新机器；存好之后它就出现在这里',
  'Add machine…': '添加机器…',
  '{n} connected / limit {cap} chat executors': '已连接 {n} / 上限 {cap} 个会话执行器',
  'The last backup failed ({at}): {error}\nClick to “Restore from backup”; configure it in Settings → ☁️ Backup':
    '备份上次失败了（{at}）：{error}\n点开是「从备份恢复」；配置在 设置 → ☁️ 备份',
  'Last backup: {at} · uploaded {n} files\nClick to “Restore from backup”': '上次备份：{at} · 传了 {n} 个文件\n点开是「从备份恢复」',
  'Restore chats from a backup (not set up yet: go to Settings → ☁️ Backup)': '从备份恢复会话（还没配 —— 去 设置 → ☁️ 备份）',
  'Backup': '备份',
  'kiro-cli trace logging is **on**: over 10 GB a day. Click to turn it off (takes effect the next time an executor starts)':
    'kiro-cli trace 日志**开着** —— 每天十几 GB。点一下关掉（下一次起执行器生效）',
  'kiro trace logging is on, click to turn it off': 'kiro trace 日志开着，点一下关掉',

  // ── components/SettingsDialog.tsx ──
  // 字体预设（label 在 fontSelectOptions 里过 t()）
  'PingFang SC': 'PingFang SC / 苹方',
  'Hiragino Sans GB': 'Hiragino Sans GB / 冬青黑',
  'Songti SC': 'Songti SC / 宋体',
  'Microsoft YaHei': 'Microsoft YaHei / 微软雅黑',
  // 分页
  '🎨 Appearance': '🎨 外观',
  '💬 Chats': '💬 会话',
  '🧪 Switches': '🧪 开关',
  '🖥 Machines': '🖥 机器',
  '☁️ Backup': '☁️ 备份',
  // 开关分组 + 说明（SWITCHES 表，渲染时过 t()）
  'Context & history': '上下文与历史',
  'Conversation & input': '对话与输入',
  'Interface': '界面',
  'Safety': '安全',
  'On: after a restart, the first message carries a history snapshot, with no extra model turn. Off: go back to "run a rebuild turn first, then send the message".':
    '开：重启后第一条消息附带历史快照，不花额外的模型回合。关：改回“先跑一次重建回合再发消息”。',
  'On: the full history file is rewritten as soon as each turn ends, so the model always reads the latest. Off: written once at rebuild time and lags behind afterwards.':
    '开：每个回合结束立刻重写完整历史文件，模型随时读到的都是最新的。关：只在重建时写一次，之后会滞后。',
  'On: every turn carries the contents of ~/.kirolex/memory (about 1.3k characters), so rules like "every reply must…" hold on every turn. Off: the model sees none of this background.':
    '开：每一轮都带上 ~/.kirolex/memory 的内容（约 1.3k 字符），所以「每次回复都要…」这类规则每轮都成立。关：模型完全看不到这些背景。',
  'On: after an interruption you didn’t cause (executor dropped mid-turn, restart, watchdog), the turn is resent automatically (along with any steer it had already taken in; this uses quota), up to the "auto-retry attempts" limit; nothing is resent if you pressed Stop. Off: the turn stays where it is and you decide whether to resend it.':
    '开：不是你停的中断（执行器中途断了、重启、看门狗）之后，自动重发那一轮（连同它已经吃进去的追加指令；会消耗额度），最多重发「自动重试次数」那么多次，你按了停止就不重发。关：那一轮就留在原处，由你决定要不要重发。',
  'On: very long pastes are saved to ~/.kirolex/pastes and shown as a placeholder in the composer (a single line folds only past 4000 characters). Off: pastes always go straight into the composer.':
    '开：很长的粘贴内容存到 ~/.kirolex/pastes 并在输入框显示占位符（单行需超过 4000 字符才折叠）。关：粘贴内容一律直接进输入框。',
  'On: multiple queued messages are merged into one when sent. Off: they are sent one by one, each taking its own turn.':
    '开：排队的多条消息在发送时合并为一条。关：逐条依次发送，各自占一个回合。',
  'On: clickable starter prompts appear when the composer is empty. Off: none are shown, and the helper model isn’t called for them.':
    '开：输入框为空时显示可点击的起始提示。关：不显示，也不为此调用辅助模型。',
  'On: the helper model names new chats. Off: they stay "New Chat". Note that chats with identical titles are hard to tell apart in the sidebar; one was deleted by mistake because of that.':
    '开：用辅助模型给新会话起标题。关：保持 New Chat——注意标题相同的会话在侧栏难以区分，曾因此误删过一个会话。',
  'On: the dividers between cells can be dragged (double-click to even them out). Off: fixed even split; the dividers are still there but can’t be dragged.':
    '开：格子之间有可拖动的分隔线（双击恢复均分）。关：固定均分，分隔线仍在但不可拖。',
  'On: after restarting KiroLex, whether the left chat list was collapsed, each group’s folding, the right-side comment mode, and each file’s unsent comments / delete marks all come back as they were. Off: these are kept only across window reloads; a restart resets them.':
    '开：重启 KiroLex 之后，左侧会话栏收没收起、各组折叠、右侧 comment 模式和每份文件里没提交的 comment / 删除标记都照原样恢复。关：这些只在窗口重新加载时保留，重启就回到默认。',
  'On: a thinking block folds up once it ends. Off: always expanded.': '开：思考段落结束后自动收起。关：一直展开。',
  'On: a tool call folds up once it ends. Off: always expanded.': '开：工具调用结束后自动收起。关：一直展开。',
  'On: ask for confirmation before deleting a chat. Off: delete on click. Deleted chats now go to ~/.kirolex/trash for 30 days, but keeping this on is still recommended.':
    '开：删除会话前弹确认框。关：点了就删——删除现在会移到 ~/.kirolex/trash 保留 30 天，但仍建议保持开启。',
  // 外观页
  'The quick brown fox jumps over the lazy dog. 0O1lI': 'The quick brown fox jumps over the lazy dog. 中文预览 0O1lI',
  'const answer = 42; // code font preview': 'const answer = 42; // 代码字体预览',
  // 会话页
  'Auto-retry attempts (interruptions you didn’t cause)': '自动重试次数（非人为中断）',
  '{n} times': '{n} 次',
  'After the executor drops mid-turn, restarts, or is interrupted by the watchdog, the turn is resent automatically, up to this many times (with backoff between retries). 0 = never resend automatically. Turns you stopped yourself don’t count.':
    '执行器中途断了、重启、看门狗打断之后，自动把那一轮再发一次，最多这么多次（重试之间会退避）。0 = 不自动重发。你按了停止的不算。',
  'Rows x columns, up to 2 rows x 2 columns. An empty split slot keeps its cell in the grid and takes the width of the row above, so existing cells don’t move when you add a chat later. Remove one with the ✕ at the top-right of its cell.':
    '行 x 列，最大 2 行 x 2 列。空的分屏位占它在网格里的那一格，宽度跟随上一行，所以之后放会话进来时已有的格子不会移动；移除用该格右上角的 ✕。',
  'Treat a turn as stuck after silence for (seconds, 0 = never interrupt)': '静默多久判定卡死（秒，0 = 不中断）',
  'A turn is interrupted only when both conditions hold:\n  ① the turn has been completely silent at the protocol level for longer than this;\n  ② and no tool has reported progress within the “tool with no progress” time below.\n\nSo: with no tool running, this value is the actual interrupt time; with a tool running, the actual wait is the later of the two thresholds.\nA turn that produced nothing is resent automatically; one that produced partial output only gets a notice, and you decide whether to resend.\n\nRange: {min}–{max} s, default {def} s.\nSet to 0 to never interrupt automatically; only the 5-minute silence notice remains.\nIf a model with a very slow first token gets interrupted by mistake, raise this value.':
    '中断需要两个条件同时成立：\n  ① 这一轮在协议层完全静默超过这里设的时长；\n  ② 并且没有工具在下面那个「工具无进度」时长之内报告过进度。\n\n所以：没有工具在跑时，这个值就是实际的中断时间；有工具在跑时，实际等待是两个阈值里更晚的那个。\n未产出任何内容的会自动重发；已产出部分内容的只提示，由你决定是否重发。\n\n取值范围：{min}–{max} 秒，默认 {def} 秒。\n设为 0 则完全不自动中断，只保留 5 分钟的静默提示。\n首个 token 特别慢的模型如果被误中断，就把这个值调大。',
  'Off: notify only, never interrupt': '已关闭：只提示不中断',
  'With no tool running: interrupt after {s} s of silence (with a notice at 5 minutes). With a tool running, the setting below must also be met':
    '没有工具在跑时：静默 {s} 秒后中断（5 分钟时先提示）。有工具在跑时，还要同时满足下面那一项',
  'Treat a tool as stuck after no progress for (seconds)': '工具无进度多久判定卡死（秒）',
  'While a tool call is running, the silence check above is paused, because long commands (builds, tests) can stay quiet for a long time.\nBut that pause needs an upper bound: if the backend never sends the “tool finished” update, the pause lasts forever and a turn can hang like that (seen lasting over 5 hours).\n\nSo: once a tool call has had no update for longer than this, it no longer counts as “still running” and the silence check above applies again.\nWith a tool running, the actual interrupt time = the later of the two thresholds, which by default is this one (30 minutes). The countdown in the stall notice usually comes from here, not from the silence threshold above.\n\nRange {min}–{max} s, default {def} s.\nIf a command that genuinely runs longer without reporting any progress gets interrupted by mistake, raise this value.':
    '工具调用运行期间，上面那条静默判定会被暂停 —— 因为长命令（构建、测试）本来就会长时间不出声。\n但这个暂停必须有上界：如果后端没发出「工具已结束」的更新，暂停会无限持续，一轮对话可能就那样挂着（实测出现过 5 小时以上）。\n\n所以：一个工具调用超过这个时长没有任何更新，才不再算作「仍在进行」，上面那条静默判定也才重新生效。\n有工具在跑时，实际中断时间 = 两个阈值里更晚的那个，默认就是这一项（30 分钟）—— 停顿提示里那个倒计时通常来自这里，而不是上面的静默阈值。\n\n范围 {min}–{max} 秒，默认 {def} 秒。\n如果确实有跑得更久、且期间完全不报告进度的命令被误中断，就把这个值调大。',
  'Interrupts are off, so this has no effect': '中断已关闭，此项不生效',
  'With a tool running: interrupt only after it has had no update for {s} s. This is where the countdown in the stall notice comes from':
    '有工具在跑时：它连续 {s} 秒没有更新才中断 —— 这就是停顿提示里倒计时的来源',

  // ── components/ToggleButton.tsx / ConfirmDialog.tsx / Toasts.tsx ──
  'On': '开',
  'Off': '关',
  'Click to dismiss': '点一下关掉',

  // ── workspaceFilter.ts / deleteOutcome.ts ──
  'Nothing matches "{query}" ({total} items)': '没有匹配「{query}」的条目（共 {total} 个）',
  'Chat not deleted: {reason}': '没有删除这个会话：{reason}',

  // ── App.tsx：合并发送排队消息时的抬头 ──
  '[{n} queued messages merged]': '【已合并 {n} 条排队消息】',

  // ── App.tsx（第二轮：原来写死的英文） ──
  'Untitled': '未命名',
  'Show sidebar': '显示侧栏',
  'Hide sidebar': '隐藏侧栏',
  'File preview': '文件预览',
  'Open files': '已打开的文件',
  'Loading file…': '正在加载文件…',
  '✓ comment': '✓ 批注',
  '💬 comment': '💬 批注',
  'image': '图片',
  'Failed to fetch usage info': '获取用量信息失败',
  '💬 New Chat': '💬 新建会话',
  'Assign this chat to a project (optional). A project gives the chat its own memory.': '把这个会话归到一个项目里（可选）。项目会给会话一份自己的记忆。',
  'Project': '项目',
  'No project (unassigned)': '不归属任何项目',
  '+ New project…': '+ 新建项目…',
  'New project name…': '新项目名…',
  '(no logs yet)': '（还没有日志）',
  'Manage context': '管理上下文',
  'Choose whether to summarize older context or clear the active conversation context completely.': '选择是把较早的上下文压缩成摘要，还是把当前会话的上下文彻底清空。',
  'Compact context?': '压缩上下文？',
  'Clear context?': '清空上下文？',
  'Reset Credits counter?': '重置 Credits 计数？',
  'Kiro CLI will summarize older conversation context to free context-window capacity. The original full context cannot be restored inside this active Kiro session.':
    'Kiro CLI 会把较早的对话上下文压缩成摘要，腾出上下文窗口。在当前这个 Kiro 会话里，原来的完整上下文无法再恢复。',
  'Kiro CLI will discard the active conversation context, and KiroLex will clear the currently displayed history. This cannot be undone inside this active chat.':
    'Kiro CLI 会丢弃当前的对话上下文，KiroLex 也会清掉当前显示的历史记录。在这个会话里无法撤销。',
  'This resets the Credits counter for the current KiroLex session to 0. It does not change actual account usage, billing, or Kiro credit records.':
    '这会把当前 KiroLex 会话的 Credits 计数清零。不会改变实际的账户用量、账单或 Kiro 的 credit 记录。',
  '🗑️ Delete Session': '🗑️ 删除会话',
  'Are you sure you want to delete "{title}"? This will permanently remove the session and its history.': '确定要删除「{title}」吗？这会永久删除这个会话及其历史记录。',
  '🗑️ Delete Project': '🗑️ 删除项目',
  'Are you sure you want to delete the project "{name}"? This permanently removes its memory and {chats} inside it (with their history). This cannot be undone.':
    '确定要删除项目「{name}」吗？这会永久删除它的记忆，以及其中的 {chats}（连同历史记录）。此操作无法撤销。',
  'Are you sure you want to delete the project "{name}"? This permanently removes its memory. This cannot be undone.':
    '确定要删除项目「{name}」吗？这会永久删除它的记忆。此操作无法撤销。',
  '1 chat': '1 个会话',
  '{n} chats': '{n} 个会话',

  // ── components/ErrorBoundary.tsx ──
  'Something broke in the UI': '界面出错了',
  'KiroLex caught a rendering error instead of leaving a blank window.': 'KiroLex 接住了一个渲染错误，没让窗口变成一片空白。',
  'Reload': '重新加载',
  'Try to continue': '尝试继续',

  // ── components/PermissionBar.tsx ──
  'Failed to send the permission decision.': '权限决定没能发送出去。',
  'Try again.': '请重试。',

  // ── components/WorkspacePanel.tsx ──
  'Failed to list directory.': '列出目录失败。',
  'Workspace files': '工作区文件',

  // ── components/ContextPanel.tsx ──
  'Drag & drop files here, or click "Add" below to include context for your conversations.': '把文件拖到这里，或点下方的「添加」，给会话加上下文。',
  'Enter text context:': '输入文本上下文：',

  // ── components/MemoryDialog.tsx ──
  'Applies to all chats everywhere': '作用于所有会话',
  'Project: {name}': '项目：{name}',
  'Project (none)': '项目（无）',
  'Applies to all chats in project "{name}"': '作用于项目「{name}」里的所有会话',
  'This chat': '本会话',
  '📦 Snapshot': '📦 快照',
  'Not available for this chat': '这个会话用不了',
  "This chat isn't assigned to a project.": '这个会话没有归属项目。',
  'No chat is open.': '没有打开的会话。',

  // ── components/Sidebar.tsx（第二轮） ──
  'Chat': '会话',
  'Creates the project and moves this chat into it (its executor resets to the new memory scope).': '新建这个项目并把这个会话移进去（它的执行器会按新的记忆范围重置）。',

  // ── 会话默认标题的显示（存的值仍是 'New Chat'，见 i18n.ts displayTitle）──
  'New Chat': '新会话',
  'this session': '这个会话',
  /* 会话信息 / 复制会话 id / 找会话（Sidebar.tsx、sessionInfo.ts） */
  'Copy session id': '复制会话 id',
  'Session info…': '会话信息…',
  'Session info': '会话信息',
  'Session id': '会话 id',
  'Backend session id': '后端会话 id',
  'None yet (assigned when the chat first connects)': '还没有（第一次连上后端时才分配）',
  'Runs on': '运行位置',
  'Engine': '引擎',
  'Session folder': '会话目录',
  'Local tools': '本机工具',
  'The local tools connection is not up (it reconnects automatically)': '本地工具通道没起来（会自动重连）',
  'Not prepared yet (shown after the session connects)': '还没准备（会话连上后显示）',
  '; not forwarded: {list}': '；没转发：{list}',
  '{name} (unavailable: {reason})': '{name}（不可用：{reason}）',
  'Copy all': '全部复制',
  'Copied: {what}': '已复制：{what}',
  'Could not copy: {reason}': '没能复制：{reason}',
  'Find chat': '找会话',
  'Find chat by title or id…': '按标题或 id 找会话…',
  'No matching chats': '没有匹配的会话',
  'Click to copy': '点一下复制',
  'Click to open the folder': '点一下打开这个文件夹',
  'Could not open it: {reason}': '没能打开：{reason}',
};
