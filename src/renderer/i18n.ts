/**
 * 界面语言（中 / 英）—— 纯逻辑,PURE。
 *
 * ## 为什么需要它
 *
 * 这个界面原来是**两种语言各写了一半**:`+ New Session` / `Type a message...` / `Archived` /
 * `connected` 是英文,而 tooltip、设置、记忆对话框、各种确认框全是中文。同一屏上两种语言 ——
 * 那不是「有中英两版」,是没人做过这个决定。
 *
 * ## 判据:什么进字典,什么不进
 *
 *   进    按钮、标签、tooltip、placeholder、对话框文案 —— 也就是**界面自己说的话**
 *   不进  会话内容、模型回复、文件路径、agent / 模型名字 —— 那些是**数据**,翻译它们就是篡改
 *   不进  代码高亮的语言名（`viewerLangFor` 那套）—— 那是技术标识符,不是文案
 *
 * ## 为什么 key 是英文短语而不是 `sidebar.newSession`
 *
 * 点号命名空间读起来要在两个文件之间来回跳才知道一句话长什么样。这里 key 直接用**英文原文**:
 * `t('New Session')` 在调用点就能看出它会显示什么,漏翻的时候退化成英文原文（见 `t()`），
 * 而不是屏幕上出现一个 `sidebar.newSession` 这样的裸 key —— 那种退化用户看得见,而且没法猜。
 */

import { ZH_MAIN, ZH_MAIN_PARTS, rememberTr, textVariants, type TextVariants } from '../main/uiText.ts';
import { ZH_REVIEW } from './i18nZh/review.ts';
import { ZH_SETTINGS_PANELS } from './i18nZh/settingsPanels.ts';
import { ZH_CHAT } from './i18nZh/chat.ts';
import { ZH_SHELL } from './i18nZh/shell.ts';

export type Lang = 'zh' | 'en';

/** 设置里那个下拉的选项。语言名**用它自己的语言写**,这是所有做对了的软件的做法。 */
export const LANG_OPTIONS: Array<{ value: Lang; label: string }> = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
];

/** 存进 `kirolex-settings` 之前先过一遍 —— 坏值/旧值一律退回中文（现状就是中文为主）。 */
export function normalizeLang(raw: unknown): Lang {
  return raw === 'en' ? 'en' : 'zh';
}

/**
 * 中文文案表。**key 是英文原文**,所以英文那一版不需要第二张表 —— `t()` 在 `en` 下直接返回 key。
 *
 * 这样做的代价是 key 会比较长；换来的是**不可能出现「英文漏翻」**:漏的只可能是中文，
 * 而漏中文的表现是那一处显示英文原文 —— 难看但可读,不会是一个裸 key。
 */
const ZH_BASE: Record<string, string> = {
  // ── 侧栏 ────────────────────────────────────────────────────────────────
  'New Session': '新建会话',
  'New Project': '新建项目',
  'Create a project': '新建一个项目',
  'Project name': '项目名',
  'New chat in project': '在此项目中新建会话',
  'Unassigned': '未分组',
  'Archived': '已归档',
  'Delete': '删除',
  'Rename': '重命名',
  'Rename project': '重命名项目',
  'Delete project': '删除项目',
  'Archive': '归档',
  'Restore to Unassigned': '恢复到未分组',
  'Move to': '移动到',
  'Pin': '置顶',
  'Unpin': '取消置顶',
  'Rebuild context': '重建上下文',
  'Open workspace files': '打开工作区文件',
  'Close workspace files': '关闭工作区文件',
  /* 「移出项目」听起来像把会话从项目里拿走（甚至删掉），而这个动作其实是**移到未分组**那一组里去 ——
     和上面那条「恢复到未分组」是同一个去处。文案要说去哪儿，不是说从哪儿走。 */
  'Unassign': '移到未分组',
  'New project…': '新建项目…',
  'Renames the project and relabels all its sessions.': '重命名项目，并同步改掉它所有会话的标签。',
  'Memory': '记忆',
  'Settings': '设置',
  'Logs': '日志',
  'connected': '已连接',
  'connecting': '连接中',
  'disconnected': '未连接',
  'Collapse sidebar': '收起侧栏',
  'Expand sidebar': '展开侧栏',
  'Working directory': '工作目录',
  '(home directory)': '（家目录）',

  'Pinned': '已置顶',
  'Drag to reorder projects': '拖动以调整项目顺序',
  'Project options': '项目选项',
  'Dismiss': '点掉',
  'Project name…': '项目名…',
  'OK': '确定',
  'Move': '移动',
  'Move to new project': '移动到新项目',
  'Show this chat in a split pane (each pane has its own composer)':
    '分屏显示这个会话（每个分屏都能独立输入）',
  'Add to split': '加入分屏',
  'Remove from split': '从分屏移除',
  'Split pane {n} · right-click, or the pane ✕, to remove':
    '分屏第 {n} 格 · 右键或该格的 ✕ 可移除',
  '{n} subagent(s) running:': '{n} 个子代理在跑：',
  'Now at: {dir}': '现在在：{dir}',
  'Now at the home directory — click to point at a repo; this project\'s chats all work there':
    '现在在家目录 —— 点这里指一个仓库，这个 project 的会话都在那儿干活',
  // 占用原因（侧栏那个点的 tooltip）
  'Busy: switching model / agent…': '占用中：正在切换模型 / Agent…',
  'Busy: connecting / reconnecting the backend…': '占用中：正在连接 / 重新连接后端…',
  'Busy: rebuilding history (press Stop to give up)': '占用中：正在重建历史（按「停止」可放弃）',
  'Busy: history missing, about to rebuild it; new messages wait': '占用中：缺历史，即将重建历史；新消息会等它完成',
  'Busy: turn in progress…': '占用中：回合进行中…',
  'Working…': '处理中…',
  'Connecting…': '连接中…',
  'Unread reply': '有未读回复',
  'Live — ready (background)': '在线 —— 就绪（后台）',
  'Not connected — select to activate': '未连接 —— 点选以激活',
  'Archived — inactive': '已归档 —— 未激活',
  'Live — idle': '在线 —— 空闲',

  // ── 输入条 / 聊天区 ──────────────────────────────────────────────────────
  'Type a message...': '输入消息…',
  'Send': '发送',
  'Stop': '停止',
  'Queue': '排队',
  'Attach files': '附加文件',
  'Copy': '复制',
  'Edit': '编辑',
  'Fork': '分叉',
  'Rerun': '重跑',
  'Steer': '追加指令',
  'Load earlier messages': '加载更早的消息',
  'Jump to latest': '回到最新',
  'Thinking': '思考',
  'Changed files': '改动的文件',
  'Commands run': '运行的命令',
  'tokens': 'tokens',

  'Auto': '自动',
  'Ask': '询问',
  'Auto-approve all tools (click to require approval)': '自动批准所有工具（点一下改为逐个批准）',
  'Ask before each tool (click to auto-approve)': '每个工具都先问（点一下改为自动批准）',

  'Slash commands': '斜杠命令',
  'Remove attachment': '移除附件',
  'Starter prompts': '起步提示',
  'Stop looping': '停止循环重发',
  'Click to add this prompt (pick several); click again to remove. You can keep typing too.':
    '点击添加这条提示，可以多选；再点一次移除。也可以自己继续补充。',

  // ── 会话内搜索 ───────────────────────────────────────────────────────────
  'Find in this chat…': '在这个会话中查找…',
  'Previous (Shift+Enter)': '上一个 (Shift+Enter)',
  'Next (Enter)': '下一个 (Enter)',
  'Close (Esc)': '关闭 (Esc)',
  'Find in this file…': '在这个文件中查找…',
  'This file type does not support search': '此类文件不支持搜索',
  'No results': '无结果',

  // ── 工作区面板 ───────────────────────────────────────────────────────────
  'Workspace': '工作区',
  'Close workspace': '关闭工作区',
  'Up one level': '上一级',
  'Refresh': '刷新',
  'Loading…': '加载中…',
  '(empty directory)': '（空目录）',
  'Filter in this directory…': '在这个目录中筛选…',
  'Clear (Esc)': '清空（Esc）',

  // ── 设置 ─────────────────────────────────────────────────────────────────
  'Interface language': '界面语言',
  'Chat font size': '聊天字号',
  'Interface zoom': '界面缩放',
  'Ctrl + plus / minus / 0 also work (⌘ on macOS)': '也可以按 Ctrl + 加号 / 减号 / 0（macOS 上是 ⌘）',
  'Back to 100% (Ctrl + 0)': '回到 100%（Ctrl + 0）',
  'Reset': '重置',
  'UI font': '界面字体',
  'Code font': '代码字体',
  'System default': '系统默认',
  'Default mono': '默认等宽',
  'Split layout': '分屏布局',
  'Confirm before deleting chats': '删除会话前确认',
  'Close': '关闭',
  'MCPs forwarded from this machine to remote sessions': '远程会话从本机转发的 MCP',
  'Enter the names used under mcpServers in your Kiro agent file (e.g. mx-ds-mcp). In remote sessions (Kiro, Claude Code and Codex alike) their requests are sent from this machine: an HTTP upstream sees your local outbound IP, ${env:…} in request headers is expanded from your local environment, and keys never reach the remote. The timeout only applies to HTTP entries (at least 120 seconds). Changes apply to the next remote session; local sessions are not affected.':
    '填 Kiro agent 文件里 mcpServers 的名字（例如 mx-ds-mcp）。远程会话里（Kiro、Claude Code、Codex 都一样），这些 MCP 的请求从你这台机器发出：HTTP 型的上游看到的是你本机的出口 IP，请求头里的 ${env:…} 用你本机的环境变量展开，密钥不会出现在远端。超时只对 HTTP 型生效（最少按 120 秒算）。改动对下一条远程会话生效；本地会话不受影响。',
  'MCP name': 'MCP 名字',
  'Timeout (seconds)': '超时（秒）',
  'sec': '秒',
  'Remove this entry': '删掉这一项',
  '+ Add': '＋ 添加',
  'List is empty: remote sessions only forward MCPs whose command is a local path (same as before).': '名单为空：远程会话只转发命令是本机路径的 MCP（和以前一样）。',
  'Saving…': '正在保存…',
  'Not saved — try editing again': '没存上，再改一下试试',
  'Cancel': '取消',
  'Confirm': '确认',
  'Save': '保存',

  // ── 分屏 / 文件查看器（App 的界面文案）────────────────────────────────────
  'Remove from split view': '从分屏中移除',
  'This pane is empty.': '这一格是空的分屏位。',
  'Put a chat here: click any chat in the list on the left, or right-click it and pick “⇆ Add to split”.':
    '把会话放进来：在左侧会话列表点任意一个会话，或右键该会话选「⇆ 加入分屏」。',
  'Remove a pane: click the ✕ at its top-right, or right-click the chat and pick “⇆ Remove from split”.':
    '移除某一格：点该格右上角的 ✕，或右键该会话选「⇆ 从分屏移除」。',
  'Resize: drag the divider between panes; double-click a divider to even them out.':
    '调整大小：拖动格子之间的分隔线，双击分隔线恢复均分。',
  'Change the layout: Settings → Split layout.': '换布局：设置 → 分屏网格。',
  'Every pane is a full chat, each with its own composer, queue and attachments.':
    '每一格都是完整的会话，各自有输入框、队列和附件。',
  'Click any chat in the list on the left to put it in this pane':
    '点击左侧列表里的任意会话，把它加入这一格',
  'Click a chat on the left to fill this pane': '点左侧会话加入这一格',
  '{n} more can go here': '还能放 {n} 个',
  'unknown reason': '未知原因',
  'Drag to resize (double-click to even out)': '拖动调整高度（双击恢复均分）',
  'Drag to resize width (double-click to even out)': '拖动调整宽度（双击恢复均分）',
  'Drag to resize width': '拖动调整宽度',
  'Pane dragging is turned off in Settings': '分屏拖拽已在设置中关闭',
  'Could not read the file.': '无法读取文件。',
  'This file is no longer on disk (deleted or renamed). What is shown below is the last content read.':
    '文件已不在磁盘上（被删除或改名）。下面显示的是最后读到的内容。',
  'Show the rendered view (Markdown / syntax highlighting / formatted JSON)':
    '显示优化视图（Markdown 渲染 / 语法高亮 / JSON 格式化）',
  'Show the raw file': '显示文件原文',
  '◉ Rendered': '◉ 渲染',
  '◎ Raw': '◎ 原文',
  'Re-read this file from disk (keeps scroll position and current view)':
    '从磁盘重新读取这个文件（保留滚动位置和当前视图）',
  'Close panel': '关闭面板',
  'Close tab': '关闭标签',
  'Formatted for display (the file itself is minified JSON). Click “Raw” to see it unformatted.':
    '已格式化显示（原文为压缩 JSON）。点「原文」查看未格式化内容。',
  'Close logs': '关闭日志',
  'Edit and rerun': '编辑并重跑',
  'Confirm and rerun': '确认并重跑',
  '🔒 This chat cannot be deleted from here': '🔒 这个会话不能从这里删',
  'Got it': '知道了',

  // ── 聊天区（ChatArea）────────────────────────────────────────────────────
  'Copy this code': '复制这段代码',
  '✓ Copied': '✓ 已复制',
  'Copied': '已复制',
  'Code': '代码',
  'Click to collapse': '点击收起',
  'Click to expand': '点击展开',
  'Expand': '展开',
  'Collapse': '收起',
  'Fold': '折叠',
  'Table data': '表格数据',
  'Jump to the latest message': '回到最新消息',
  'Open the file inside KiroLex': '在 KiroLex 内打开文件',
  '🌐 This file is on {host}, not on your machine.': '🌐 这份文件在 {host} 上，不在你机器上。',
  'the remote machine': '远端机器',
  '⇩ Copy to this machine': '⇩ 复制到本机',
  'Copy failed': '复制失败',
  'Copied to {path}': '已复制到 {path}',
  'Explain what this project does and how it is structured': '解释这个项目是做什么的，整体结构是怎样的',
  'Find and fix bugs in the current directory': '找出并修复当前目录里的 bug',
  'Add unit tests for the main modules': '为主要模块补充单元测试',
  'Summarise the recent git changes': '总结最近的 git 改动',
  'Review this code for security problems': '审查这段代码有没有安全问题',
  'Click to expand the pasted content': '点击展开粘贴内容',
  '(pasted content unavailable: the file was deleted)': '（粘贴内容已不可用：文件已被删除）',
  'Reading…': '读取中…',
  '🤖 Subagents': '🤖 子代理',
  'Pasted content': '粘贴内容',
  'Send this message again on a schedule': '按时间重复发送这条消息（定时任务）',
  'Make it a scheduled job': '设为定时任务',
  'A loop is running — stop it first': '循环运行中，请先停止循环',
  'This turn was interrupted. Resubmit below; the new message replaces it': '这一轮已中断，在下方重新提交会替换它',
  'Merged': '合并模式',
  'One by one': '逐条发送',
  'Looping this message — click Stop to end it': '正在循环重发消息，点击 Stop 停止',
  'Loop running · Stop to end it': '循环运行中 · Stop 停止循环',
  'Stop the loop': 'Stop 停止循环',
  'Task list': 'Task 清单',
  '⚡ Commands run': '⚡ 运行的命令',
  'Show the first line only': '只显示第一行',
  'Show the full command': '显示完整命令',
  'Failed': '失败',
  'Running': '运行中',
  'Unsaved agent config': '未保存的 Agent 配置',
  'Discard': '丢弃',
  'Unknown agent': '未知 agent',
  'Compacting…': '压缩中…',
  'Compact': '压缩',
  'Open the memory editor and clean it up yourself': '打开记忆编辑器自己清理',
  'Resume: keep running on the original schedule': '恢复：按原计划继续运行',
  'Pause: keep the job, stop it firing': '暂停：保留任务，但不再触发',
  '💭 Thinking': '💭 思考',
  '🔧 Tools': '🔧 工具',

  // ── 权限条 / 上下文面板 / 记忆对话框 ──────────────────────────────────────
  'Tool permission required': '需要工具授权',
  'Allow once': '允许一次',
  'Always allow': '总是允许',
  'Reject': '拒绝',
  'No context has been injected into this chat yet': '这个会话还没有注入过上下文',
  '⚙︎ Hand-edited context (pinned) · the next message sends this verbatim instead of the auto snapshot':
    '⚙︎ 手工编辑的上下文（已固定）· 下一条消息将原样发送这份，而不是自动生成的快照',
  'Context': '上下文',
  'Add File': '添加文件',
  'Add Text': '添加文本',
  'Remove': '移除',
  'Saved': '已保存',
  'Save and pin': '保存并固定',
  'Back to auto-generated': '已回到自动生成',
  'Restore auto-generated': '恢复自动生成',
  'Discard changes': '放弃修改',
  'Drop the hand-edited copy and go back to the snapshot generated from the current conversation.':
    '删掉手工编辑的这份，回到按当前对话自动生成的快照。',
  '(Nothing recorded yet: context is written when it is actually injected, so it appears after you send a message. You can also write one here — save it and the next message uses it.)':
    '（还没有记录：上下文只在实际注入时写入，发一条消息后就会出现。也可以直接在这里写一份，保存后下一条消息就用它。）',

  // ── 设置对话框 ──────────────────────────────────────────────────────────
  '⚙️ Settings': '⚙️ 设置',
  'Preview': '预览',
  'Font (text)': '字体（正文）',
  'Font (code)': '字体（代码）',
  'Current: {value}': '当前：{value}',
  '1 × 1 (no split)': '1 x 1（不分屏）',
  '1 row × 2 cols (side by side)': '1 行 x 2 列（左右）',
  '2 rows × 1 col (stacked)': '2 行 x 1 列（上下）',
  '2 rows × 2 cols (maximum)': '2 行 x 2 列（最大）',
  'Split grid (click a chat in the sidebar to add it; every pane has its own composer)': '分屏网格（点侧栏会话即加入分屏，每屏可独立输入）',
  'Draggable pane dividers': '分屏可拖拽调整大小',
  'Feature switches (take effect immediately, no restart)': '功能开关（改完立即生效，无需重启）',
  'Send history context along with the message (no extra turn)': '历史上下文随消息附带（零额外回合）',
  'Fold large pastes to disk': '大段粘贴折叠到磁盘',
  'Allow local tools to read and send messages through the control entry': '允许本机工具通过控制入口读取和发送消息',
  'On: tools on this computer that hold the token in ~/.kirolex/control.json (e.g. your local Claude Code, a script) can list chats, read the latest messages and send a message into a chat; such messages are marked "Sent via control entry". It never opens a debugging port and cannot run commands or change settings. Off (default): those requests are refused.':
    '开：本机持有 ~/.kirolex/control.json 里 token 的工具（例如你本机的 Claude Code、脚本）可以列出会话、读最近的消息、往某条会话里发消息；这样发的消息标「经控制入口发送」。不会打开调试端口，也不能执行命令或改设置。关（默认）：这些请求一律拒绝。',
  'Tool stall threshold (seconds without progress)': '工具无进度多久判定卡死（秒）',
  'Auto-fold tool calls when they finish (🔧 tool)': '工具调用结束后自动折叠（🔧 tool）',
  'Concurrent connection limit (most chats connected at once)': '并发连接上限（最多同时连接的会话数）',
  'Auto-fold thinking when it finishes (💭 thinking)': '思考结束后自动折叠（💭 thinking）',
  'Merge queued messages into one': '排队消息合并成一条发送',
  'Refresh history.md every turn': '每回合刷新 history.md',
  'Inject memory (global / project / this chat)': '注入记忆（全局/项目/本会话）',
  'Show starter prompts when the composer is empty': '空输入框显示提示建议',
  'Generate chat titles automatically': '自动生成会话标题',
  'Helper-model fallback (used when the main one is unavailable)': '辅助模型备用（主模型不可用时自动改用）',
  'Helper model (titles and prompt suggestions; does not affect the chat)': '辅助模型（生成标题与提示词建议，不影响对话本身）',
  'Default combo for new sessions (Claude Code / Codex)': '新会话默认组合（Claude Code / Codex）',
  'New Claude Code / Codex sessions (on this machine or remote) start with this combo; existing sessions are not changed. A project can override it from its menu in the sidebar. The combos themselves are edited on the 🧩 Combos page of the Claude Code / Codex config panel.': '新建的 Claude Code / Codex 会话（本机和远端）默认用这个组合；已有会话不变。项目可以在侧栏的项目菜单里单独设。组合本身在 Claude Code / Codex 配置面板的「🧩 组合」页里改。',
  '🧩 New-session combo: {name}': '🧩 新会话默认组合：{name}',
  'Combo for new Claude Code / Codex sessions in this project; existing sessions are not changed': '这个项目里新建 Claude Code / Codex 会话默认用的组合；已有会话不变',
  'No fallback': '不使用备用',
  'Resend an unanswered prompt after a restart': '重启后自动重发未完成的提问',
  'Restore the window layout after a restart': '重启后恢复界面状态（侧栏、折叠、comment 标记）',
  'Silence before a turn counts as wedged (seconds, 0 = never)': '静默多久判定卡死（秒，0 = 不中断）',

  // ── 聊天区主体（ChatArea）───────────────────────────────────────────────
  'Merged: the whole queue goes out as one message (10 per batch at most)': '合并模式：整个队列会作为 1 条消息一次性发出（每批最多 10 条）',
  'One by one: only the first is sent, the rest keep queueing': '逐条模式：每次只发队首 1 条，其余继续排队',
  'Send as one message': '合并为 1 条发送',
  '📋 Task list': '📋 Task 清单',
  '📝 Changed files': '📝 改动的文件',
  'Back it up, then have this chat merge and de-duplicate the memory file (merge only — facts that still hold are kept)': '备份后，让当前会话把这个记忆文件合并去重（只合并，不删除仍然成立的事实）',
  'View': '查看',
  '▶️ Resume': '▶️ 恢复',
  '⏸️ Pause': '⏸️ 暂停',
  'Click again to confirm cancellation (cannot be undone)': '再点一次确认取消（不可恢复）',
  'Cancel this scheduled job': '取消这个定时任务',
  'Confirm cancel?': '确认取消？',
  '🗑️ Cancel': '🗑️ 取消',
  'Loading history…': '正在加载历史记录…',
  'The timeout interrupt is off, so it will wait indefinitely.': '超时中断已关闭，会一直等下去。',
  'About to interrupt this turn…': '即将中断这一轮…',
  'This turn has produced no output and no tool activity.': '这一轮既没有输出，也没有工具活动。',
  '↓ Latest': '↓ 最新',
  'The previous turn was interrupted': '上一轮已中断',
  'The original text is back in the composer. Enter replaces and reruns this turn; it does not send a new message.': '原文已填回输入框。按 Enter 将覆盖并重跑这一轮，不会发送新消息。',
  'Edit agent config (global)': '编辑 Agent 配置（全局）',
  '⏰ Scheduled job': '⏰ 定时任务',
  'Trigger': '触发方式',
  'Daily at a set time': '每天固定时间',
  'Weekly at a set time': '每周固定时间',
  'Repeat on an interval': '按间隔重复',
  'Once, at a given moment': '只在某个时刻跑一次',
  'Day of week': '星期几',
  'Time (HH:MM, 24-hour)': '时间（HH:MM，24 小时制）',
  'Trigger moment': '触发时刻',
  'Maximum number of runs (required)': '运行次数上限（必填）',
  'Create scheduled job': '创建定时任务',
  'Create': '创建',

  // ── 确认框 / 提示 ────────────────────────────────────────────────────────
  "Don't ask again": '不再询问',
  'Delete this chat?': '删除这个会话？',
  'This cannot be undone.': '此操作不可撤销。',

  // ── 系统通知（钉住的会话闲下来）──────────────────────────────────────────
  'Finished': '已完成',
  'Stopped with an error': '出错了',
  'Stopped with an error: {error}': '出错了：{error}',

  // ── 删除会话：已删除、部分文件暂时被占用 ────────────────────────────────
  'Chat deleted. Some files are in use and will be cleaned up automatically later.': '会话已删除，部分文件被占用，稍后自动清理',
};

/** 渲染层的分表（按界面区域分文件，见 `i18nZh/`）。 */
const ZH_PARTS: Record<string, Record<string, string>> = {
  base: ZH_BASE,
  review: ZH_REVIEW,
  settingsPanels: ZH_SETTINGS_PANELS,
  chat: ZH_CHAT,
  shell: ZH_SHELL,
};

const ZH: Record<string, string> = Object.assign({}, ...Object.values(ZH_PARTS));

/**
 * 取一条文案。
 *
 * `en` 直接返回 key（key 就是英文原文）;`zh` 查表,**查不到也返回 key** ——
 * 漏翻的那一处显示英文原文,难看但可读,而不是把一个裸 key 摆到用户面前。
 */
export function t(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  const raw = lang === 'en' ? key : (ZH[key] ?? ZH_MAIN[key] ?? key);
  // `{name}` 占位符。两种语言的语序不同，所以占位符必须是**命名**的，不能按位置 ——
  // 「第 3 格」和 "pane 3" 里那个数字的位置就不一样。
  const out = vars ? raw.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : raw;
  // 记一笔「这句是哪个 key + 哪些值翻出来的」—— 写进会话的提示要靠它拿到中英两版（`noteVariants`）
  return rememberTr(out, key, vars);
}

/**
 * 一句刚用 `t()` 翻出来的话（占位符里嵌着的译文也算）的中英两版 —— 渲染层写进会话的 KiroLex 提示
 * 把它一起交给主进程落盘，切语言、重新打开时按当时的界面语言显示。认不出就是 undefined。
 */
export function noteVariants(text: string): TextVariants | undefined {
  return textVariants(text, t);
}

/**
 * 一段**只剩文字**的 KiroLex 话（典型：主进程 `tr()` 出来、经 IPC 报错传过来的 `err.message`）的中英两版。
 *
 * 先查渲染层刚 `t()` 出来的那些（`noteVariants`）；查不到就拿字典里的句子当模板反过来对
 * （中文模板和英文 key 两边都试，占位符的值抠出来、本身也按同样的办法换）。Electron 包的那层
 * `Error invoking remote method '…': Error: ` 前缀原样留着。系统 / 网络原文（ECONNREFUSED 之类）认不出 —— 不猜，返回 undefined。
 */
interface Template { key: string; names: string[]; zh: RegExp; en: RegExp; literal: number }
let templates: Template[] | null = null;
function templateOf(key: string, zh: string): Template | null {
  const names = [...key.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  // 字面部分太短的（'{label}: {text}' 之类）什么都能对上 —— 不拿它当模板
  const literal = key.replace(/\{\w+\}/g, '').trim().length;
  if (literal < 6) return null;
  const toRe = (s: string, order: string[]) => {
    const parts = s.split(/(\{\w+\})/);
    // 占位符可以是空的（`{hint}` 没内容时）—— 所以是 `*?` 不是 `+?`
    const src = parts.map((p) => (/^\{\w+\}$/.test(p) ? '([\\s\\S]*?)' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('');
    order.push(...parts.filter((p) => /^\{\w+\}$/.test(p)).map((p) => p.slice(1, -1)));
    return new RegExp(`^${src}$`);
  };
  const zhOrder: string[] = []; const enOrder: string[] = [];
  const zhRe = toRe(zh, zhOrder); const enRe = toRe(key, enOrder);
  return { key, names: [zhOrder.join(','), enOrder.join(',')], zh: zhRe, en: enRe, literal };
}
function allTemplates(): Template[] {
  if (!templates) {
    templates = [];
    for (const table of [ZH, ZH_MAIN]) {
      for (const [k, v] of Object.entries(table)) {
        const tpl = templateOf(k, v);
        if (tpl) templates.push(tpl);
      }
    }
    templates.sort((a, b) => b.literal - a.literal);   // 字面越长越具体，先试
  }
  return templates;
}
const ELECTRON_PREFIX = /^(Error invoking remote method '[^']+': (?:Error: )?)([\s\S]*)$/;
export function messageVariants(text: string, depth = 0): TextVariants | undefined {
  const raw = String(text ?? '');
  if (!raw || depth > 3) return undefined;
  const known = noteVariants(raw);
  if (known) return known;
  const wrapped = ELECTRON_PREFIX.exec(raw);
  if (wrapped) {
    const inner = messageVariants(wrapped[2], depth + 1);
    return inner ? { zh: wrapped[1] + inner.zh, en: wrapped[1] + inner.en } : undefined;
  }
  for (const tpl of allTemplates()) {
    for (const side of ['zh', 'en'] as const) {
      const m = (side === 'zh' ? tpl.zh : tpl.en).exec(raw);
      if (!m) continue;
      const order = (side === 'zh' ? tpl.names[0] : tpl.names[1]).split(',').filter(Boolean);
      const vals: Record<string, string> = {};
      order.forEach((name, i) => { vals[name] = m[i + 1]; });
      const varsIn = (lang: Lang) => Object.fromEntries(Object.entries(vals).map(
        ([k, v]) => [k, messageVariants(v, depth + 1)?.[lang] ?? v],
      ));
      const both = { zh: '', en: '' };
      for (const lang of ['zh', 'en'] as const) both[lang] = t(lang, tpl.key, varsIn(lang));
      return both;
    }
  }
  /*
    整段对不上模板：常见的是「原始错误 + 空行 + KiroLex 的说明 + 空行 + kiro-cli 原话」这样拼出来的。
    按空行分段，各段分别认 —— 认得的段换语言，认不出的段（系统原文）原样；一段都不认得就是认不出。
  */
  const paras = raw.split(/(\n\n+)/);
  if (paras.length > 1) {
    let hit = false;
    const both = { zh: '', en: '' };
    for (const p of paras) {
      const v = /^\n+$/.test(p) ? undefined : messageVariants(p, depth + 1);
      if (v) hit = true;
      both.zh += v?.zh ?? p;
      both.en += v?.en ?? p;
    }
    if (hit) return both;
  }
  return undefined;
}

/**
 * 「还挂在屏幕上的那一句」（输入框上方的活动状态行等）的中英两版 —— 设的时候钉住，显示的时候按当前语言取。
 * 状态本身还是一个字符串（判断它的那些 `includes(...)` 照旧），只是显示多查一步。有上限，旧的先挤掉。
 */
const pinned = new Map<string, TextVariants>();
const PINNED_MAX = 200;
export function pinShown(text: string, variants?: TextVariants): void {
  const v = variants ?? noteVariants(text);
  if (!text || !v) return;
  pinned.delete(text);
  pinned.set(text, v);
  if (pinned.size > PINNED_MAX) pinned.delete(pinned.keys().next().value as string);
}
export function shownIn(lang: Lang, text: string | null): string | null {
  if (!text) return text;
  return pinned.get(text)?.[lang] ?? text;
}

/**
 * 会话标题的**显示**。新会话的默认标题 `'New Chat'` 是数据（存盘、标题生成都按这个英文值认），
 * 不能改存的值；只在显示时按语言换成译文。别的标题（用户改过的、自动生成的）原样返回。
 */
export function displayTitle(lang: Lang, title: string | undefined | null): string {
  const raw = String(title ?? '');
  return raw === 'New Chat' ? t(lang, 'New Chat') : raw;
}

/** 中文表里还缺哪些 key —— 给测试用,防止「加了调用点忘了加文案」悄悄退化成英文。 */
export function missingZh(keys: string[]): string[] {
  return keys.filter((k) => !(k in ZH) && !(k in ZH_MAIN));
}

/** 两张表（渲染层 + 主进程 `ZH_MAIN`）的全部条目 —— 测试用它逐条核对中英两版对不对得上。 */
export function zhEntries(): Array<[key: string, zh: string, table: string]> {
  const out: Array<[string, string, string]> = [];
  for (const [name, part] of Object.entries(ZH_PARTS)) for (const [k, v] of Object.entries(part)) out.push([k, v, `renderer/${name}`]);
  for (const [name, part] of Object.entries(ZH_MAIN_PARTS)) for (const [k, v] of Object.entries(part)) out.push([k, v, `main/${name}`]);
  return out;
}

/** 字典里一共有多少条 —— 测试用它钉住「不许越翻越少」。 */
export function zhKeyCount(): number {
  return Object.keys(ZH).length;
}
