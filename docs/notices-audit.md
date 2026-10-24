# 会话内提示清单（第一波）

范围：**会话里**出现的提示 —— 聊天区里的 KiroLex 卡片（进对话记录）、输入框上方的状态行（几秒后淡出，不进对话记录）、
错误横幅、进度行（输入框上方那行「⏳ …」）、气泡上的小标签 / tooltip。设置页、对话框长说明、flow / advanced 专属文案不在这一波。
中英两套一起改（英文是 key，中文在 `src/main/uiTextZh/*.ts`、`src/renderer/i18nZh/chat.ts`、`src/renderer/i18n.ts`）。

写法和用词见 **[`docs/notices-glossary.md`](./notices-glossary.md)**（一句话两件事、诊断细节折进「详情」、不写安慰话、
只用 ⚠️ ⏳ 🔀 ✅ 四个 emoji、统一用词）。

## 这一波顺带加的呈现方式

| 改动 | 在哪 | 测试 |
|---|---|---|
| **「详情」折叠**：主句和诊断细节拼在同一段文字里（分隔符 `NOTE_DETAIL_SEP`），界面拆开、详情默认收起（聊天区 KiroLex 卡片、状态行、错误横幅、以及 KiroLex 接在回复末尾的说明——例如超时中断那句——都认）。落盘、IPC、中英两版（`trConcat` → `bothLangs`）都不用改形状；旧提示没有分隔符，整句照旧显示 | `src/main/kirolexNote.ts`（`withNoteDetail` / `splitNoteDetail`）；`ChatArea.tsx` 的 `NoticeBody`（KiroLex 卡片 + 状态行共用） | `tests/noticeMerge.test.ts`、`tests/noticePlacement.test.ts` |
| **连续同类提示合并计数「×N」**：提示带「类型:对象[→结果]」的 group（`noteGroup` 落盘 / `group` 随状态行事件发）。聊天区相邻、同 group 的 KiroLex 卡片并成一条；状态行还挂着时又来同 group 的一句只计数。**显示最新那条的内容**（「第 3 次」、详情里新的原因都以最新为准）；对象或结果不同（换到的模型不同、改写的是另一份文件）group 不同，分开显示。没带 group 的旧记录退回「一字不差才合并」 | `src/renderer/noticeMerge.ts`（`collapseAdjacent` / `mergeNotice`）；`ChatArea.tsx` 的 `renderGroups`；`useSessionNotice.ts` | `tests/noticeMerge.test.ts`、`tests/noticePlacement.test.ts` |
| **状态行 vs 对话记录**：只需知道的降为状态行（改写排队、拒绝打开链接）；影响结果的进对话记录（忙时选的切换没生效、**自动改用备用模型**——本机和远端两条路，都在**连上之后**按实际起来的模型说；同一对每条会话只记一次，真的写进记录才登记；新建会话时记录还没落盘，先攒着，`createSession` 之后补写，界面当场插进这条新会话） | `src/main/modelFallbackNote.ts`（纯逻辑，`tests/modelFallbackNote.test.ts`）+ `src/main/index.ts` | `tests/noticePlacement.test.ts`（状态行那条路不写 transcript；降级 / 升级的几句走的是对的那条路） |
| **写进对话记录的提示当场显示**：原来没人听 `acp:user-message`，`noteInSession` 写的提示要重新打开会话才看得见。现在当场插进那条会话；这一轮正在流式输出时先攒着、这一轮结束再插（插在流中间会把回复拆成两段）；没读过历史的会话不插（等打开时从盘上读） | `preload.ts` 的 `onUserMessage`；`useAcp.ts`（`heldNotesRef` / `showLiveNotes`）；`noticeMerge.withLiveNote` | `tests/noticeMerge.test.ts`、`tests/noticePlacement.test.ts` |
| **错误横幅不叠 emoji**：原来一律前缀 ❌，句子自己带 ⚠️ 时变成「❌ ⚠️ …」。现在句子已带固定 emoji 就不加，没有就补 ⚠️ | `noticeMerge.ts` 的 `bannerText`；`ChatArea.tsx` 两处横幅 | `tests/noticeMerge.test.ts` |

## 改动清单

「位置」是新 key 在源码里的调用点（行号会漂，按文案 grep 即可）。「旧文案 / 新文案」列中文；英文 key 同步改写。
「／」分开的是主句和折进「详情」的部分（或合并后的参数句）。「⏎」是换行。

| # | 位置 | 场景 | 旧文案（中文） | 新文案（中文） | 处理 | 文案与行为不符 |
|---|---|---|---|---|---|---|
| 1 | src/main/index.ts:7361 | 连续几次笼统 Internal error、这一轮没产出 → 自动换模型重发（对话记录） | 🔀 后端连着 {n} 次拒绝为这一轮生成回答（kiro-cli 日志里是 `EmptyResponse`，流开了但一个 token 都没发）。换后端会话对这种情况没用（实测换三个都失败），所以这次换的是模型：{from} → {to}，原话原样重发。 | 🔀 连续 {n} 次没拿到回答，已把模型从 {from} 换成 {to} 并重发这条消息。 ／ 每次都只回了笼统的 Internal error，换后端会话也没用，所以改换模型。对话记录不变。 | 改写；原因折进「详情」 | 旧文案说「kiro-cli 日志里是 EmptyResponse」「实测换三个都失败」：代码判据是 isBareInternalError + 连续次数，并不读日志确认 EmptyResponse，也不数换了几个后端会话。新文案只说代码确实知道的事。 |
| 2 | src/main/index.ts（sendPromptOnce 的 `verdict === 'recreate'` 分支，`noteInSession(sessionId, note)`） | 后端会话连续出错 → 换新的后端会话（对话记录） | 后端连着 {n} 次拒绝为这段对话生成回答（{err}）——pid 没变，所以不是"会话过期"，是这段历史本身后端咽不下去（常见成因：某次工具调用的结果）。已经换成新的后端会话（{id}…）并把上下文带过去；磁盘上的对话记录一条都没动。 | 🔀 这段对话连续 {n} 次出错（{err}），已换到新的后端会话并带上上下文。 ／ 进程（pid）没变，不是会话过期，多半是这段历史本身出的问题（常见是某次工具结果）。新的后端会话：{id}…。对话记录不变。 | 改写；pid / 后端会话 id / 推理折进「详情」；♻️ → 🔀 |  |
| 3 | src/main/index.ts:7608 | 换了后端会话但这一轮跑过工具 → 不自动重发（错误横幅 / 失败气泡） | （这一轮已经跑了 {n} 个工具调用{hint}，重发会把它们再执行一遍，所以 KiroLex 只换了新的后端会话（{id}…）、没有自动重发。点重跑或者再发一条就会落在新会话上。） | （这一轮已经跑了 {n} 个工具调用{hint}，为免重复执行没有自动重发。点「重跑」或再发一条即可。） | 改写；去掉后端会话 id |  |
| 4 | src/main/index.ts（connectWithModelFallback：`client.connect()` 成功之后 → `noteModelFallback`） | 本机 kiro-cli 清单里没有选的模型，自动改用别的 | ⚠️ 本机 kiro-cli 的模型清单里没有「{wanted}」，这条会话会用清单里有的一个。（本机可用：{list}{more}）<br>——<br>⏎清单里 Claude 系列和 `auto` 整体消失，通常是**出口 IP 的地域过滤**（Anthropic 的模型分地区）——换 kiro-cli 版本没用。要用 Claude 就把这条会话切到远端机器上。 | ⚠️ 本机没有模型「{wanted}」，这条会话改用「{model}」。 ／ 本机可用：{list}{more} ／ ⏎清单里没有任何 Claude 和 `auto`：通常是出口 IP 被按地区过滤（换 kiro-cli 版本没用）。要用 Claude，把这条会话切到远端。 | 改写；连上之后说实际用的模型；可用清单和地域过滤原因折进「详情」；**从状态行改进对话记录**（换了模型影响结果），同一对「想要→实际」每条会话只记一次；新建会话时先攒着、记录落盘后补写（`modelFallbackNote.ts`） |  |
| 5 | src/main/modelFallbackNote.ts（`remoteText`，由 connectWithModelFallback / 换机器 在连上之后调用） | 远端没有选的模型，改用备用模型 | ⚠️ {host} 上没有模型「{wanted}」，这条会话改用「{fallback}」。（远端可用：{list}{more}）kiro-cli 对这种情况是静默退回默认模型的，所以这里明说一句。 | ⚠️ {host} 上没有模型「{wanted}」，这条会话改用「{fallback}」。 ／ 远端可用：{list}{more} | 改写；可用清单折进「详情」，删掉"为什么要说这一句"的元解释；**从状态行改进对话记录**；`pickRemoteModel` 连接之前只记下挑了什么，**连上之后按实际起来的模型写**（挑的备用模型可能没起来、换成了下一个；全都起不来就不写），同一对只记一次（`modelFallbackNote.ts`） |  |
| 6 | src/renderer/hooks/useAcp.ts:4679 | 手动换模型后后端仍报旧模型（错误横幅） | 切换模型未生效（后端仍在使用 {model}）。请重试或选择其他模型。 | ⚠️ 换模型没生效（仍在用 {model}），请重试或换一个模型。 | 改写 |  |
| 7 | src/main/index.ts:9267 | 换模型失败且回滚失败（状态行） | ⚠️ 换模型失败，而且回滚也没成功 —— 这条会话现在没连着执行器。点一下它会自动重连（重连走的是常规那条路，是可靠的）。 | ⚠️ 换模型失败，回滚也没成功，会话已断开。点一下这条会话即可重连。 | 改写 |  |
| 8 | src/main/index.ts（`queueSwitchWhileBusy` / `applyPendingSwitchBatch`） | 忙时选的切换：等待 → 执行 → 生效 | 🔀 这一轮结束，已应用刚才选的切换：{list} | 等待（对话记录，带「停止这一轮并立即切换」「取消切换」、秒数实时走）：⏳ 这一轮还在跑，跑完后切到 {target} ⏎ 执行（状态行）：正在启动本机 {engine}… → 正在把对话历史交给新后端… ⏎ 生效（对话记录）：✅ 已切到 {target} ⏎ 取消（对话记录）：已取消切换，这条会话保持原来的设置。 | 负责人反馈（2026-10-23）「后台让我在等，但会话没有提示」：等待改为对话记录里的卡片，它的收尾也进对话记录；执行中的过程走状态行 |  |
| 9 | src/main/index.ts（`applyPendingSwitchBatch`） | 忙时选的切换没能生效 | ⚠️ 刚才选的切换没能生效：{list}，保持原设置。 | ⚠️ 没能切换：{list}。这条会话还在 {current} 上，可以继续用。 | 改写：说清现在实际在用的设置；仍进对话记录（影响结果） |  |
| 10 | src/main/index.ts:7185 | 工具长时间无进度 → 这一轮被中断（写在这一轮回复末尾） | ⚠️ 这一轮被 KiroLex 按超时中断：静默 {quiet}，其中 {count} 个工具调用有 {idle}没有进度更新（上限 {limit} 分钟）。工具本身可能仍在后台继续跑。可在设置「工具无进度多久判定卡死」里调大。 | ⚠️ 这一轮因工具长时间无进度被中断。 ／ {count} 个工具 {idle}无进度（上限 {limit} 分钟），工具可能仍在后台跑。要多等，在设置里调大「工具无进度多久判定卡死」。 | 改写；主句只说被中断了、为什么；工具数、无进度时长、上限、设置项折进「详情」（回复气泡认详情分隔符） |  |
| 11 | src/main/index.ts:7187 | 整轮静默超时 → 被中断（写在这一轮回复末尾） | ⚠️ 这一轮被 KiroLex 按超时中断：静默 {quiet}（上限 {limit} 分钟），没有工具在运行。可在设置「静默多久判定卡死」里调大。 | ⚠️ 这一轮因长时间没有输出被中断。 ／ {quiet}没有输出（上限 {limit} 分钟）。要多等，在设置里调大「静默多久判定卡死」。 | 改写；时长、上限、设置项折进「详情」 |  |
| 12 | src/renderer/hooks/useAcp.ts:2710 | 中断后自动续写（进度行） | ⚠️ 这一轮静默太久被中断，正在自动续写（第 {n}/{max} 次）… | ⏳ 这一轮静默太久已中断，正在自动续写（第 {n}/{max} 次）… | 改写；⚠️ → ⏳（进行中） |  |
| 13 | src/renderer/hooks/useAcp.ts:2726 | 没有产出的一轮被中断后自动重发（进度行） | ⚠️ 该轮无响应，已中断，正在自动重发… | ⏳ 这一轮没有响应已中断，正在自动重发… | 改写；⚠️ → ⏳ |  |
| 14 | src/renderer/hooks/useAcp.ts:2781<br>src/renderer/hooks/useAcp.ts:3822 | 执行器中途断开 → 重连并重发（进度行，两处） | ⟳ 执行器中途断了，重连后自动重发这一轮… | ⏳ 连接中途断了，正在重连并重发这一轮… | 改写；⟳ → ⏳；「执行器」→「连接」 |  |
| 15 | src/renderer/hooks/useAcp.ts:1292 | 重启后自动重发上次没完成的一轮（进度行） | ⟳ 上次未完成的这一轮，正在自动重发…（第 {n}/{max} 次） | ⏳ 正在自动重发没完成的这一轮…（第 {n}/{max} 次） | 改写；⟳ → ⏳ |  |
| 16 | src/renderer/hooks/useAcp.ts:1119 | 重载后接回还活着的那一轮（进度行） | ⟳ 上一轮仍在运行，已接回它的回复（没有重发） | ⏳ 上一轮还在跑，已接回它的回复（没有重发） | 改写；⟳ → ⏳（保留「已接回」，代码按它清进度行） |  |
| 17 | src/renderer/hooks/useAcp.ts:1232 | 会话忙，稍后自动重发（进度行） | ⏳ 会话正忙（连接 / 重建中），稍后自动重发… | ⏳ 会话正忙（连接或重建历史中），稍后自动重发… | 改写（保留「重建」，代码按它认重建中的进度行） |  |
| 18 | src/renderer/hooks/useAcp.ts:1303 | 自动重发失败（错误横幅） | 自动重发失败：{error}。可对该消息手动点重跑。 | ⚠️ 自动重发失败：{error}。可在那条消息上点「重跑」。 | 改写；加 ⚠️ |  |
| 19 | src/main/index.ts:7639 | 传输层错误，自动重发预算用光（错误横幅） | 连不上后端（{err}）—— KiroLex 自己重发了 {n} 次都失败。检查网络/VPN 后再发一次。 | 连不上模型服务（{err}），已自动重发 {n} 次都失败。检查网络/VPN 后再发。 | 改写；「后端」→「模型服务」 |  |
| 20 | src/main/promptRetry.ts:115 | 笼统错误，自动重发预算用光（错误横幅） | （KiroLex 已经自己重发了 {n} 次，都是同一个结果。这一轮什么都没产出，所以重发是安全的、也确实做了；到这一步说明问题在后端而不是这条消息 ——可以点重跑再试，或者把这一轮拆小一点再发。） | （已自动重发 {n} 次，结果相同。可点「重跑」再试，或把这一轮拆小。） | 改写；删掉"重发是安全的、也确实做了"这类辩解 |  |
| 21 | src/main/acp-client.ts:417 | 执行器正常退出（错误横幅） | 执行器已退出（正常退出，code 0）—— KiroLex 会自动重连并重发这一轮。 | 执行器正常退出了（code 0），会自动重连。 | 改写 | 旧文案说「会自动重连并重发这一轮」：重发要过 planRetry（这一轮出过文字或跑过工具就不重发），并不总会发生。新文案只说「会自动重连」。 |
| 22 | src/main/transientError.ts:45<br>src/main/transientError.ts:47 | 远程会话 ssh 掉线（错误横幅） | SSH connection closed（ssh exit {code}）—— 远端执行器的连接断了，KiroLex 会按退避自动重发这一轮。 | SSH connection closed（ssh exit {code}）：和远端的连接断了。会自动重连；这一轮还没产出时才自动重发。 | 改写（保留 `SSH connection closed`，重试判据按它认） | 旧文案说「会按退避自动重发这一轮」：同样受 planRetry 约束，跑过工具 / 出过文字就不重发。新文案写明条件。 |
| 23 | src/main/transientError.ts:45<br>src/main/transientError.ts:47 | 远端端口被占，本机工具连接没建起来（错误横幅） | SSH connection closed（ssh exit {code}）：远端端口 {port} 被占用，本地工具的隧道没建起来。KiroLex 会换一个端口重试 —— 要是反复出现，那台机器上可能有上次留下的 kiro-cli 还占着它。 | SSH connection closed（ssh exit {code}）：远端端口 {port} 被占用，本机工具连接没建起来，会换端口重试。反复出现的话，可能是那台机器上残留的 kiro-cli 占着端口。 | 改写 |  |
| 24 | src/main/kiroCliLog.ts:99 | 失败时从 kiro-cli 日志认出空响应（附在错误后面） | kiro-cli 的日志里是 `err=EmptyResponse`：服务端把回复流开了，但一个 token 都没发过来。这跟你的消息、跟这条对话的历史都没关系（实测：换一个几乎空的新会话照样失败，而上下文更满的那个反而好了；失败是按时间段聚堆的）。KiroLex 会按退避自己重发；整段时间都这样就换个模型，或者过几分钟再来。 | 服务端返回了空回复，与你的消息和这段历史都无关。过几分钟再试，或换个模型。 | 改写；`EmptyResponse` 和实测推理只进日志 | 旧文案说「KiroLex 会按退避自己重发」：这句只在自动重发已经结束（预算用光 / 跑过工具不重发）之后才会出现，所以此时不会再重发。新文案改成「过几分钟再试，或换个模型」。 |
| 25 | src/main/kiroCliLog.ts:104 | 失败时从 kiro-cli 日志认出连接错误（附在错误后面） | kiro-cli 的日志里是连接层错误（{detail}）：连不上后端。看网络/VPN。 | 连不上模型服务，检查网络/VPN。 ／ kiro-cli 日志：{detail} | 改写；日志原文折进「详情」（`kiro-cli log: …`） |  |
| 26 | src/main/kiroCliLog.ts:110 | 失败时从 kiro-cli 日志认出请求被拒（附在错误后面） | 服务端判这次请求不合法（{detail}）：通常是历史里有超限的东西（图片、过长的一段）。 | 请求被服务端拒绝，通常是历史里有超限的内容（图片、过长的一段）。 ／ kiro-cli 日志：{detail} | 改写；日志原文折进「详情」 |  |
| 27 | src/main/kiroCliLog.ts（explainCliError） | 失败时从 kiro-cli 日志认出限流（附在错误后面） | 被限流了（{detail}）：等一下再发，或者换个模型。 | 被限流了：等一下再发，或者换个模型。 ／ kiro-cli 日志：{detail} | 改写；日志原文折进「详情」 |  |
| 28 | src/main/kiroCliLog.ts（explainCliError 兜底） | 失败时 kiro-cli 日志里认不出的错误（附在错误后面） | kiro-cli 的日志里是：{detail} | kiro-cli 报了错。 ／ kiro-cli 日志：{detail} | 改写；主句只说 kiro-cli 报了错，日志原文折进「详情」 |  |
| 29 | src/main/index.ts:965 | 失败的一轮里有超大工具输出（附在错误后面） | （其中最大的一次输出 {k}K 字符 —— 后端很可能是在这上面答不出来的，下次给那条命令加上 `--query` / `\| head` 把输出截小） | （最大一次工具输出 {k}K 字符，多半是它导致的；下次给那条命令加 `--query` / `\| head` 截短） | 改写 |  |
| 30 | src/main/index.ts:7499 | 上一轮还在后端跑，这条没发出（错误横幅） | 上一回合仍在后端运行（active turn，可能在压缩上下文）。请等它结束，或点 Stop 中断后再发送。 | 上一轮仍在后端运行（active turn，可能在压缩上下文），等它结束或按「停止」后再发。 | 改写（保留「仍在后端运行」「active turn」，渲染端和主进程按它认"这一轮还在跑"） |  |
| 31 | src/renderer/hooks/useAcp.ts:3811 | 同上，渲染端的进度行 | ⏳ 当前回合仍在进行（可能在压缩上下文），请等它结束后再发送。 | ⏳ 当前这一轮还在跑（可能在压缩上下文），等它结束再发。 | 改写 |  |
| 32 | src/renderer/hooks/useAcp.ts:3840 | 重连重发时上一轮还在收尾（进度行） | ⏳ 上一轮仍在收尾，这条未发出；稍后可直接重发 | ⏳ 上一轮还在收尾，这条没发出，稍后再发 | 改写 |  |
| 33 | src/renderer/hooks/useAcp.ts:2174 | 正在压缩上下文（进度行） | 🗜️ 正在压缩上下文… | ⏳ 正在压缩上下文… | 改写；🗜️ → ⏳ |  |
| 34 | src/renderer/hooks/useAcp.ts:355 | 回复达到输出上限（错误横幅） | ⚠️ 回复被截断：达到本回合输出上限（stopReason: max_tokens）。发送「继续」可让它接着写。 | ⚠️ 回复达到输出上限被截断。发「继续」让它接着写。 | 改写；`stopReason: max_tokens` 删掉 |  |
| 35 | src/renderer/hooks/useAcp.ts:358 | 这一轮达到工具调用上限（错误横幅） | ⚠️ 回合被终止：达到本回合的工具调用次数上限（stopReason: max_turn_requests）。发送「继续」可让它接着做。 | ⚠️ 这一轮达到工具调用次数上限被终止。发「继续」让它接着做。 | 改写；`stopReason` 删掉 |  |
| 36 | src/renderer/hooks/useAcp.ts:361 | 模型拒绝（错误横幅） | ⚠️ 模型拒绝了这次请求（stopReason: refusal）。换个说法或拆小问题再试。 | ⚠️ 模型拒绝了这次请求。换个说法或拆小再试。 | 改写；`stopReason` 删掉 |  |
| 37 | src/renderer/hooks/useAcp.ts:363 | 其他异常结束原因（错误横幅） | ⚠️ 回合非正常结束（stopReason: {reason}）。 | ⚠️ 这一轮异常结束（{reason}）。 | 改写（原因保留在括号里） |  |
| 38 | src/renderer/hooks/useAcp.ts:374 | 一轮没有任何输出（错误横幅） | ⚠️ 这一轮没有产生任何输出（stopReason: {reason}）。可以重发或点重跑。 | ⚠️ 这一轮没有任何输出（{reason}）。可重发或点「重跑」。 | 改写 |  |
| 39 | src/renderer/hooks/useAcp.ts:375 | 一轮没有任何输出且没有原因（错误横幅） | ⚠️ 这一轮没有产生任何输出，后端也没有说明结束原因。可以重发或点重跑。 | ⚠️ 这一轮没有任何输出。可重发或点「重跑」。 | 改写；删掉"后端也没有说明" |  |
| 40 | src/renderer/components/ChatArea.tsx（两处 `chat-error-banner` / 空会话错误） | 错误横幅的前缀 |  | （删除） | `❌` 前缀改成 `bannerText`：句子已带 ⚠️/⏳/🔀/✅ 就不再叠，没有就补 ⚠️ | 旧横幅一律前缀 ❌，于是「⚠️ 这一轮没有任何输出」显示成「❌ ⚠️ …」（一条两个 emoji）。 |
| 41 | src/main/index.ts:6893 | 重建历史没完成，这条消息没发出（错误横幅） | 历史上下文重建未完成（{why}），这条消息未发出以免在空上下文上作答。再发一次会重新尝试重建；不想重建就按 Stop 放弃（之后的消息会照常发出，只是后端没有历史）。<br>——<br>历史上下文重建未完成（{why}），这条消息未发出以免在空上下文上作答。重建会继续自动重试；不想等就按 Stop 放弃重建（这一条消息会照常发出，只是后端没有历史）。 | 重建历史没完成（{why}），这条消息没发出。{next} ／ 再发一次会重试。 ／ 重建还在自动重试。 ／ 按「停止」可放弃重建，之后的消息不带历史发出。 | **合并**两条只差半句的旧文案为一条带参数的（`{next}`）；主句只放原因的主句（例如「连续 3 次失败：Internal error」），分块编号 / 字数 / 原始错误和「按停止放弃」折进「详情」（错误横幅认详情分隔符） | 旧的第二条说「按 Stop 放弃后，这一条消息会照常发出」：这句话出现时这条消息已经被拒（抛错），按停止只影响之后的消息（`primeAbandoned`）。新文案改成「之后的消息不带历史发出」。 |
| 42 | src/renderer/hooks/useAcp.ts:2556 | 缺历史，正在重建（进度行） | ⏳ 历史上下文缺失，正在重建（会重试到完成）；新消息排队，完成后依次发出。按 Stop 放弃重建（之后的消息会照常发出，只是后端没有这个会话的历史） | ⏳ 正在重建历史，完成后再发新消息；按「停止」可放弃。 | 改写 |  |
| 43 | src/main/index.ts:1660 | 重建历史进度（进度行） | 重建历史上下文 {i}/{total}{retry} | 重建历史 {i}/{total}{retry} | 改写（统一叫「重建历史」） |  |
| 44 | src/main/index.ts:1661 | 重建历史进度（进度行） | 重建历史上下文{retry} | 重建历史{retry} | 改写 |  |
| 45 | src/main/index.ts:1748 | 重建某一块失败、稍后重试（进度行） | 重建历史上下文 {i}/{total} 失败，{s}s 后重试 | 重建历史 {i}/{total} 失败，{s} 秒后重试 | 改写 |  |
| 46 | src/main/index.ts:1660<br>src/main/index.ts:1661<br>src/main/index.ts:1748<br>src/main/primeRetry.ts:63<br>src/renderer/components/ChatArea.tsx:4230<br>src/renderer/hooks/useAcp.ts:2550<br>src/renderer/hooks/useAcp.ts:2553<br>src/renderer/hooks/useAcp.ts:2556<br>src/renderer/hooks/useAcp.ts:5059 | 重建历史（进度行默认文案） | 重建历史上下文 | 重建历史 | 改写 |  |
| 47 | src/main/primeRetry.ts:61 | 重建历史放弃（附在错误里） | 重建历史上下文卡在第 {chunk}/{total} 块（{chars} 字），试了 {tries} 次都失败：{error}。{why}下次发消息时会再试一次；也可以重启 KiroLex 换一个干净后端，或者把这条会话分叉一条新的继续，旧的留着查。 | 连续 {tries} 次失败：{error} ／ 重建历史卡在第 {chunk}/{total} 块（{chars} 字），试了 {tries} 次都失败：{error}。{why}下次发消息时会再试；也可以分叉出一条新会话继续。 | 改写；删掉「重启 KiroLex 换一个干净后端」；主句只留「连续 N 次失败：<简短原因>」，这一整句进「详情」 |  |
| 48 | src/main/primeRetry.ts:56 | 同上，放弃原因之一 | 这一块已经小到不可能是"发得太大"，所以不再重试 —— 多半是这条会话的后端连接坏了。 | 这一块已经很小，不是太大的问题，多半是会话的连接坏了。 | 改写 |  |
| 49 | src/main/primeRetry.ts:57 | 同上，放弃原因之二 | 同一块已经试到上限 {n} 次，所以先停下。 | 同一块已到重试上限（{n} 次）。 | 改写 |  |
| 50 | src/renderer/hooks/useAcp.ts:5059 | 手动「重建上下文」失败（进度行） | ⚠️ 上下文重建失败：{reason} | ⚠️ 重建历史失败：{reason} | 改写（统一叫「重建历史」） |  |
| 51 | src/main/index.ts:1550 | 手动重建时会话没连上（重建失败原因） | 该会话尚未连接后端，先打开它再重建 | 会话还没连上，先打开它再重建历史。 | 改写 |  |
| 52 | src/main/index.ts:1650 | 重建中执行器被换掉（重建失败原因） | 后端已被替换，将重新开始重建 | 会话重连了，重建历史将从头开始。 | 改写 |  |
| 53 | src/main/index.ts:1654 | 用户放弃重建（重建失败原因） | 用户已放弃重建 | 已放弃重建历史 | 改写 |  |
| 54 | src/main/index.ts:1706 | 重建中模型不可用、换了模型（重建失败原因） | 模型不可用，已切换后端（{msg}） | 模型不可用，已换成 {to}，重建历史从头开始（{msg}） | 改写；带上换成了哪个模型（`{to}`） | 旧文案说「已切换后端」，实际做的是 swapSessionModel（换模型）。另：这是"悄悄换模型"的一处，原来只在重建失败原因里提到。**已修（2026-10-24）**：换成之后在会话里说一句「🔀 模型「{from}」不可用，这条会话已换成「{to}」，重建历史从头开始。」（报错原文折进「详情」），走 `modelFallback`，同一对每条会话只说一次。 |
| 55 | src/renderer/components/Sidebar.tsx:300 | 侧栏 / 输入框的占用 tooltip | 占用中：正在重建历史上下文（会重试到完成；按 Stop 可放弃） | 占用中：正在重建历史（按「停止」可放弃） | 改写 |  |
| 56 | src/renderer/components/Sidebar.tsx:301 | 侧栏 / 输入框的占用 tooltip | 占用中：历史上下文缺失，重建即将/正在进行；新消息会排队 | 占用中：缺历史，即将重建历史；新消息会等它完成 | 改写 |  |
| 57 | src/main/index.ts（sshMux `onHealing`）<br>src/main/remoteRecovery.ts（`RECONNECTING_TEXT`） | 远程会话的本机工具连接中断、正在重连（状态行，挂着不消失） | ⚠️ 本机工具连接中断，正在重连（第 {n} 次）—— 这期间这条远程会话读写不了你机器上的文件。<br>——<br>⚠️ 本机工具连接中断，正在重连（第 {n} 次）—— 这期间这条远程会话读写不了你机器上的文件。 | ⚠️ 本机工具连接中断，正在重连（第 {n} 次），这期间读写不了你的文件。 | **合并**：两处各写一遍的同一件事用同一个 key |  |
| 58 | src/main/index.ts（sshMux `onReady`）<br>src/main/remoteRecovery.ts（`RECOVERED_TEXT`） | 本机工具连接恢复（状态行） | 🔌 本机工具连接已恢复。<br>——<br>🔌 本机工具连接已恢复，这条远程会话重新接上了。 | 本机工具连接已恢复。 | **合并**为一句；去掉 🔌；还挂着时再来同一句计数「×N」 |  |
| 59 | src/main/index.ts:2922 | 本机工具连接恢复、正在重连这条会话（状态行） | 🔌 本地工具通道回来了，正在重接这条会话的执行器 —— 之后它就能读写你机器上的文件了。 | ⏳ 本机工具连接已恢复，正在重连这条会话… | 改写；🔌 → ⏳ |  |
| 60 | src/main/index.ts:2230 | 远程会话的本机工具连接没建起来（状态行） | ⚠️ 本地工具通道没起来：{error}。这条远程会话读不到你机器上的文件 —— 先别让它改东西。连接恢复后会自动重接这条会话。 | ⚠️ 本机工具连接没建起来（{error}），这条远程会话暂时读写不了你的文件，会自动重连。 | 改写（已核对：mux 平台等 onReady 重接，Windows 走 remoteRecovery 退避重试，确实会自动重连） |  |
| 61 | src/main/index.ts:2035<br>src/main/index.ts:2146 | 组合里的 MCP 缺本机环境变量（状态行，本机 / 远程两处） | ⚠️ 组合「{combo}」里的 MCP「{mcp}」要用环境变量 {vars}，本机没有设置 —— 这一条先跳过。<br>——<br>⚠️ 组合「{combo}」里的 MCP「{mcp}」要用环境变量 {vars}，本机没有设置 —— 这条远程会话里先不挂它。 | ⚠️ 组合「{combo}」的 MCP「{mcp}」缺本机环境变量 {vars}，这次先不挂。 | **合并**为一句 |  |
| 62 | src/main/index.ts:2147 | 组合里的 MCP 没法从本机转发（状态行） | ⚠️ 组合「{combo}」里的 MCP「{mcp}」没法从本机转发：{reason} —— 这条远程会话里先不挂它。 | ⚠️ 组合「{combo}」的 MCP「{mcp}」没法从本机转发（{reason}），这次先不挂。 | 改写 |  |
| 63 | src/main/forwardMcp.ts:197 | 转发的 MCP 探测失败（状态行） | ⚠️ 从本机转发的 MCP「{name}」现在用不了：{msg}。这条会话照常可用，只是调它的工具会报同样的错 —— 改好本机配置后重开会话即可。 | ⚠️ 本机转发的 MCP「{name}」暂时用不了：{msg}。改好本机配置后重开会话。 | 改写；删掉"这条会话照常可用，只是…" |  |
| 64 | src/main/index.ts:2208 | 远端没有选的 agent（状态行） | ⚠️ {host} 上没有 agent「{agent}」，这条会话用**默认 agent** + 你本机的工具。要它按那个 agent 跑，在那台机器上建一份同名配置。 | ⚠️ {host} 上没有 agent「{agent}」，改用默认 agent；要用它，请在那台机器上建同名配置。 | 改写 |  |
| 65 | src/main/remoteWriteGuard.ts:167<br>src/main/remoteWriteGuard.ts:168 | 远程会话往远端写交付文件被拦（状态行） | 🛡 拦下了一次往 {host} 上写文件{where}：远程会话里交付给你的文件要落在你机器上 —— 已拒绝，按提示词它会改用 `local_write` 写到本机（`{dir}`）。 | ⚠️ 已拦下往 {host} 写文件{where}：交付文件要写在本机，它应改用 `local_write`（`{dir}`）。 | 改写；🛡 → ⚠️ | 旧文案说「按提示词它会改用 local_write」：KiroLex 只能拦下并在提示词里要求，模型会不会照做不确定。新文案改成「它应改用」。 |
| 66 | src/main/remoteWriteGuard.ts:167<br>src/main/remoteWriteGuard.ts:168 | 同上（没有会话文件夹时） | 🛡 拦下了一次往 {host} 上写文件{where}：远程会话里交付给你的文件要落在你机器上 —— 已拒绝，按提示词它会改用 `local_write` 写到本机。 | ⚠️ 已拦下往 {host} 写文件{where}：交付文件要写在本机，它应改用 `local_write`。 | 改写；🛡 → ⚠️ |  |
| 67 | src/main/remoteWriteGuard.ts:173 | 这一轮把文件写在了远端（状态行，带「⇩ 复制到本机」） | ⚠️ 这一轮把文件写在了 {host} 上（{paths}），不在你机器上 —— 点「⇩ 复制到本机」把它放进这条会话的本机文件夹，之后预览、comment 都按本机那一份来。 | ⚠️ 这一轮把文件写在了 {host} 上（{paths}），点「⇩ 复制到本机」拿回来。 | 改写 |  |
| 68 | src/main/localMcp.ts:408 | 远程会话改了本机文件（状态行） | 📝 远端那条会话改了你本机的 `{file}`。 | 远程会话改了你本机的 `{file}`。 | 改写；去掉 📝 |  |
| 69 | src/main/index.ts:2602 | 回复里有不认识的本机操作（状态行） | ⚠️ 它想让你这台机器做一件我不认的事：`{raw}` —— {why}。 | ⚠️ 已忽略一条不认识的本机操作：`{raw}`（{why}）。 | 改写 |  |
| 70 | src/main/index.ts:2607 | 一轮里要求打开的页面超过上限（状态行） | ⚠️ 这一轮它已经要求打开 {n} 个页面了，剩下的没开（`{target}`）—— 链接就在上面，需要的话点它。 | ⚠️ 这一轮已打开 {n} 个页面，`{target}` 没再打开；需要的话点上面的链接。 | 改写 |  |
| 71 | src/main/index.ts:2624 | 拒绝打开非 http(s) 链接 | ⚠️ 拒绝在本机打开 `{target}` —— 只允许 http/https。 | ⚠️ 已拒绝打开 `{target}`：本机只打开 http/https 链接。 | 改写；**从对话记录降为状态行**（和同组几句一致，已拦下、不用你做什么） |  |
| 72 | src/main/index.ts:2632 | 替远端在本机浏览器打开链接（状态行） | 🌐 已在**你的**浏览器里打开 `{target}`（{host} 上的它要求的）。 | 已在你的浏览器里打开 `{target}`（{host} 上的会话请求的）。 | 改写；去掉 🌐 |  |
| 73 | src/main/index.ts:2633 | 打开链接失败（状态行） | ⚠️ 它要求打开 `{target}`，但没打开：{error} | ⚠️ 没能打开 `{target}`：{error} | 改写 |  |
| 74 | src/main/index.ts:9022<br>src/main/index.ts:9090 | 换运行位置（连着的会话，状态行） | 🔀 这条会话从现在开始跑在**{where}**上（工作目录 `{dir}`）。后端会话是新的，上下文会随下一条消息带过去；之前的对话一条都没动。 | 🔀 这条会话已改为在**{where}**运行（工作目录 `{dir}`）。 ／ 后端会话是新的，上下文随下一条消息带过去。对话记录不变。 | 改写；"后端会话是新的…对话记录不变"折进「详情」 |  |
| 75 | src/main/index.ts:9022<br>src/main/index.ts:9090 | 换运行位置（没连着的会话，状态行） | 🔀 这条会话改成跑在**{where}**上（工作目录 `{dir}`）。它刚才没有连着，现在按新位置去连；对话一条都没动。 | 🔀 这条会话改为在**{where}**运行（工作目录 `{dir}`），下次连接时生效。 ／ 对话记录不变。 | 改写；「对话记录不变」折进「详情」 |  |
| 76 | src/main/index.ts:9091 | 换运行位置打断了正在跑的一轮（附在上一条主句里） | （切换打断了正在跑的那一轮 —— 已产出的内容都在，未完成的那部分没了，需要的话重发一次。） | （切换打断了正在跑的那一轮：已产出的内容保留，没完成的部分需要的话请重发。） | 改写 |  |
| 77 | src/main/index.ts:9479 | 换引擎（没连着，状态行） | 🤖 这条会话下次打开会由 **{engine}** 来跑。它现在没有连着，所以没有执行器要换；对话一条都没动。 | 🔀 这条会话下次打开时改由 **{engine}** 运行。 | 改写；🤖 → 🔀；删掉安慰句 |  |
| 78 | src/main/index.ts:9529 | 换引擎（状态行） | 🤖 这条会话从现在开始由 **{engine}** 来跑。后端会话是新的，上下文会随下一条消息带过去；之前的对话一条都没动。 | 🔀 这条会话已改由 **{engine}** 运行，上下文随下一条消息带过去。 | 改写；🤖 → 🔀；删掉安慰句 |  |
| 79 | src/main/index.ts:9635 | 换组合（状态行） | 🧩 这条会话换成了组合「{name}」。执行器重启过，上下文会随下一条消息带过去；之前的对话一条都没动。 | 🔀 已换成组合「{name}」，上下文随下一条消息带过去。 | 改写；🧩 → 🔀；删掉安慰句 |  |
| 80 | src/main/index.ts:9650 | 换组合失败（组合下拉旁的 ✗ / tooltip） | ⚠️ 换组合「{name}」没成功（{err}），这条会话还是原来的组合。执行器已经断开，下一条消息会按原来的组合重新接上（包括你本机的工具）。 | 换组合「{name}」失败（{err}），仍用原来的组合，下一条消息会按原组合重新连接。 | 改写；**只说一处**：原来状态行一条 + 抛错又在组合下拉旁显示一次，现在说明（仍用原组合、下一条消息重新连接）随抛出的错误给界面，不再另发状态行；去掉 ⚠️（那里已有 ✗） |  |
| 81 | src/main/index.ts:12136 | 一轮进行中改了项目（状态行） | 📁 项目已改为**{project}**。这一轮还在跑，所以执行器（memory scope）会在它结束之后再重置 —— 这一轮剩下的部分仍用原来的范围。 | 项目已改为**{project}**，记忆范围在这一轮结束后切换。 | 改写；去掉 📁 |  |
| 82 | src/main/mcpCombos.ts:285 | 组合要的 effort 当前引擎不支持（状态行） | ℹ️ {who}要的 effort「{want}」当前引擎 / 模型不支持{avail} | ⚠️ {who}要的 effort「{want}」当前引擎 / 模型不支持{avail} | ℹ️ → ⚠️（只用固定的几个 emoji） |  |
| 83 | src/main/index.ts:3951<br>src/main/index.ts:3953 | 侧栏改写在这条会话里排队 | ⏳ 已排队：{label} —— 前面还有 {n} 条改写没跑完，轮到它会自动发出去。<br>——<br>⏳ 已排队：{label} —— 这条会话正忙（{busy}），空下来会自动发出去。 | ⏳ 已排队：{label}（{why}），轮到时自动发出。 ／ 前面还有 {n} 条改写 ／ 会话正忙：{busy} | **合并**为一条带参数的；**从对话记录降为状态行**（只需知道） | 「轮到时自动发出」：会话忙超过 20 分钟会放弃，不是无限等。**已修（2026-10-24）**：放弃时在对话记录里说「⚠️ 等了 20 分钟还没轮到，已放弃这次改写：{label}。原文在下面，在文件预览里对它再点 ✓ 即可重发。」并附「原文：{意见}」（一直在忙的原因折进「详情」）；意见照旧放回文件预览那一处、按同一次（`retrySame`）重发（`src/main/reviseGiveUp.ts`，三处等空闲超时共用）。 |
| 84 | src/main/index.ts:11385 | 侧栏改写落盘（对话记录） | ✅ 已按意见改了{what}（现在 {chars} 字）⏎文件：{path}⏎KiroLex 落盘完成（写前已备份到 ~/.kirolex/backups/review-files/）。 | ✅ 已按意见改好{what}（现在 {chars} 字）⏎文件：{path}⏎写前已备份到 ~/.kirolex/backups/review-files/。 | 改写；删掉「KiroLex 落盘完成」 |  |
| 85 | src/main/index.ts:11427 | 侧栏改写落盘（对话记录） | ✅ 已按意见改了{what}（{n} 处，现在 {chars} 字）⏎文件：{path}⏎KiroLex 落盘完成（写前已备份到 ~/.kirolex/backups/review-files/）。 | ✅ 已按意见改好{what}（{n} 处，现在 {chars} 字）⏎文件：{path}⏎写前已备份到 ~/.kirolex/backups/review-files/。 | 改写 |  |
| 86 | src/main/index.ts:8004 | 定时任务结束（写进对话记录） | ⏰ 定时任务结束：{why}⏎{schedule} · 共运行 {n} 次 | 定时任务结束：{why}（{schedule}，共运行 {n} 次） | 改写；去掉 ⏰，压成一行 | 这句原来以 `role: 'assistant'` 写进 transcript（`runScheduledJob`），不是带 `kirolex: true` 的 KiroLex 提示，会被当成助手的话进快照 / history.md。**已修（2026-10-24）**：改走 `noteInSession`（中英两版）；旧记录按开头（`LEGACY_ASSISTANT_NOTE_OPENINGS`，只认 assistant 那侧）认成 KiroLex 提示，发给模型的路径都跳过，读盘时按 KiroLex 卡片显示。 |
| 87 | src/renderer/App.tsx:3283 | 追加指令时这一轮已结束，改作新消息发出（状态行） | 这一轮已经结束了 —— 刚才那条作为新消息发出。 | 这一轮已经结束，刚才那条作为新消息发出。 | 改写 |  |
| 88 | src/renderer/components/ChatArea.tsx:1353 | 被中断那一轮的提示条 | 这一轮已被中断 — 请在下方输入框重新提交，新消息会覆盖被中断的这一轮 | 这一轮已中断，在下方重新提交会替换它 | 改写 |  |

## 文案与行为不符：汇总

已经按代码改了文案的（上表「文案与行为不符」一列）：

1. 换模型那句说「kiro-cli 日志里是 EmptyResponse」「实测换三个都失败」，代码并不确认这两件事（#1）。
2. 「执行器正常退出，会自动重连并重发这一轮」「ssh 掉线，会按退避自动重发」—— 重发受 `planRetry` 约束（出过文字 / 跑过工具不重发）（#21、#22）。
3. kiro-cli 日志认出空响应时说「KiroLex 会按退避自己重发」，但这句只在自动重发已经结束后才出现（#24）。
4. 重建历史没完成的第二条说「按 Stop 后这一条消息会照常发出」，而这条消息此时已被拒（#41）。
5. 重建中「已切换后端」实际是换了模型（#54）。
6. 远程写文件被拦时说「它会改用 local_write」，KiroLex 只能拦下并要求，不能保证（#65）。

**行为本身有问题、这一波不改逻辑**（记下来，留给后续任务；2026-10-24 那一波已全部修掉）：

- （已修，2026-10-24）**定时任务结束那句以 `role: 'assistant'` 写进 transcript**（`runScheduledJob`），没有 `kirolex: true`，会被当成助手的话进快照 / history.md / 逐段重建。现在走 `noteInSession`；旧记录按开头认出来同样排除（`kirolexNote.ts` 的 `isLegacyAssistantNote` / `normalizeLegacyNote`）。测试：`tests/noticesAuditFollowups.test.ts`、`tests/scheduleWiring.test.ts`。
- （已修，2026-10-24）**重建历史时模型不可用会悄悄换模型**（`primeHistoryNow` → `swapSessionModel`），只出现在重建失败原因里，没有在会话里单独说一句（AGENTS.md §4.6 要求"悄悄换了的地方都要说一句"）。现在换成后经 `modelFallback.note` / `commit` 写进对话记录，同一对每条会话只说一次。测试：`tests/noticesAuditFollowups.test.ts`。
- （已修，2026-10-24）改写排队最多等 20 分钟，之后放弃并报错；「轮到时自动发出」说的是常见情况。现在放弃时在会话里明说并附原文，意见留在文件预览里可再点 ✓ 重发（见 #83）。测试：`tests/noticesAuditFollowups.test.ts`。
- （已修，属于提示的呈现）`noteInSession` 写进对话记录的提示原来不会当场显示，只有重新打开会话才看得见；现在当场插入。流式输出期间到达的那几条在这一轮结束后才插，所以当场看到的位置在这一轮回复之后，盘上（重新打开后）在回复之前。

## 这一波没动的（留给下一波）

- （已修，2026-10-24）循环（loop）每轮的校验结果（`✅ / ❌ / ⛔ 第 N 轮校验…`、`🔁 循环结束`）：原来每轮一条助手消息。现在同一个 loop 的校验结果是**一张** KiroLex 卡片、原地更新：主句是最新一轮 +「共校验 N 轮」，每一轮和它的输出折进「详情」（`loopMachine.ts` 的 `verdictRoundLine` / `foldVerdicts`，`useAcp.ts` 的 `showVerdict`）；emoji 收敛为 ✅（通过 / 循环达成）、⚠️（未通过、校验跑不起来到上限、其余结束原因）、⏳（容错重试）。测试：`tests/noticesAuditFollowups.test.ts`。
- 侧栏文件预览（`ReviewPane.tsx`）写进会话的三句「✅ …已落盘」：渲染层拼的，要带「详情」得另做一份双语拼接，这一波只改了主进程那两句同类的。
- 连接失败卡片「⚠️ 这条会话没连上：」：渲染层按这个开头认、替换旧的那张（`connectFailure.ts`），改开头要连判据一起改。
- `Wait for the active turn (including context compaction)…` 等几句被渲染端按关键词匹配（`context compaction` / `当前这一轮`），这一波保持原样。
- 进度条上的卡死倒计时 tooltip（`Tool stall threshold …` 那一组）：本来就是放在 tooltip 里的"详情"，长度合适，没改。

## 截图

`.agent-board/screenshots/`（看板收图）：`模型切换-旧vs新` 是在应用窗口里用应用自己的样式（`global.css` 里的类名）并排画出来的旧 / 新对照。
`超时中断-旧vs新（真实界面）`、`重建历史失败-旧vs新（真实界面）`、`远端重连-旧vs新（真实界面）` 是隔离的 HOME 里放演示会话、
真的应用分屏两格（左旧右新）渲染出来的（替换了原来按样式模拟画的三张）：超时中断那句是写进这一轮回复末尾的原文（新文案的「详情」已展开）；
重建历史失败是把主进程 `acp:prompt` 换成直接抛出那句错误、在输入框里真的发一条消息，界面走的是真实的失败路径；
远端重连是从主进程连发三次 `session:notice`（sticky），旧文案每次换一句、新文案同类只计数「×3」。
`切走再切回-重连计数×3还在`：右格切到别的会话再切回来，「×3」还在（会话级缓存存的是合并后的那句）。
`真实界面-换模型进记录与同类合并`、`真实界面-合并后展开最新详情`、`真实界面-新建会话里的换模型提示` 是隔离的 HOME 里放演示会话、真的 `ChatArea` 渲染出来的：
自动改用备用模型那句留在对话记录里（换到的模型不同就分开显示）；三条次数 / 后端会话 id 都不同的同类提示合成一条「×3」、显示最新那条；
新建会话里只有这一条换模型提示时的样子（这台机器没有 kiro-cli，没法真的新建并触发换模型，图里是从记录读回来的同一条，渲染和当场插入的相同）。
