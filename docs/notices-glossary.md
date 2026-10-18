# 会话内提示：用词表 + 写法规则

会话里 KiroLex 自己说的话（聊天区里的 KiroLex 卡片、输入框上方的状态行、错误横幅、进度行、气泡上的小标签 / tooltip）
都按这一页写。代码里写新提示时引用这一页（`docs/notices-glossary.md`）。逐条清单见 `docs/notices-audit.md`。

## 1. 写法

1. **一句话说清两件事**：发生了什么 + 你要不要做什么（要的话做什么）。主句中文 ≤ 40 字左右；不用你做事的只说结果。
2. **诊断细节折叠**：pid、后端会话 id、`EmptyResponse`、日志原文、「实测……」这类解释放进「详情」，不进主句。
   - 主进程：`withNoteDetail(主句, 详情)`（`src/main/kirolexNote.ts`）拼起来再交给 `noteInSession` / `sessionNotice`；
     界面上 `splitNoteDetail` 拆开，详情折叠在「详情」里（聊天区卡片和状态行都认）。
   - 抛给界面的错误（横幅 / 失败气泡）不折叠：诊断细节只进日志。
3. **不写安慰话**：「磁盘上的对话记录一条都没动」之类删掉。换会话 / 换模型 / 重建历史时可以留一句短的「对话记录不变」。
4. **说的要和做的一致**：写「会自动重试」就必须真的会重试；有条件的（例如「这一轮还没产出时」）把条件写出来。
5. **放在哪**：
   - 只需知道、不用操作的（已排队、已恢复连接、已切到 X）→ **状态行**（`sessionNotice`），几秒后淡出，不进对话记录；
   - 需要你决定或影响结果的（失败、被中断、没发出、换了模型 / 后端会话）→ **对话记录**（`noteInSession`）；
   - 同一件事只说一处，不要聊天区一条、状态行再一条。
   - 连续的同类提示只显示一条并计数（「×3」），内容取最新那条：发提示时带 group（`noteInSession(…, group)` /
     `sessionNotice(…, { group })`），写成「类型:对象[→结果]」，例如 `local-tools-reconnect`、`model-fallback:想要→实际`、
     `revise-queued:<文件>`。对象或结果不同就是不同的 group，分开显示。没带 group 的按整句一字不差合并（`src/renderer/noticeMerge.ts`）。
6. **emoji 只用四个**，一条最多一个，放在开头：

   | emoji | 含义 |
   |---|---|
   | ⚠️ | 需要注意 / 失败 / 被拦下 |
   | ⏳ | 进行中 / 等待中 |
   | 🔀 | 切换（模型、后端会话、运行位置、引擎、组合） |
   | ✅ | 完成 |

   其余（♻️ 🤖 🧩 🔌 🌐 📁 ⟳ 🗜️ 🛡 ❌ ⛔ ⏰ 🔁 …）在会话内提示里不再用。
   状态行的醒目样式和停留时长仍按「有没有 ⚠️」判断（`useSessionNotice`）。

## 2. 用词

| 统一叫法（中文） | 英文 | 不再用 |
|---|---|---|
| 会话 | session | 对话（指 KiroLex 会话时）、chat |
| 对话记录 | conversation / transcript（给人看用 conversation） | 磁盘上的对话记录 |
| 这一轮 | this turn | 本回合、该轮、回合 |
| 模型 | model | |
| 后端会话（只在必须说清"换了一个"时用，尽量放详情） | backend session | ACP 会话、会话 id |
| 后端 | backend | 尽量少用：能说「模型」「kiro-cli」「连接」就不说后端 |
| 追加指令 | steer | 插话、steer |
| 排队 | queue | |
| 重建历史 | rebuild history | 历史上下文重建、上下文重建、重建历史上下文 |
| 远端 / 本机 | remote / this machine | 远程机器、本地（指这台电脑时） |
| 本机工具连接 | local tools connection | 本地工具通道、本机工具通道 |
| 停止（按钮） | Stop | 按 Stop |
| 重跑（按钮） | Rerun | |
| 自动重发 | resend automatically | |
| 中断 | interrupt | |

「远程会话」= 跑在远端的会话，照旧这么叫。
