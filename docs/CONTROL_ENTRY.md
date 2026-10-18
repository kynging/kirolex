# 控制入口（本机 HTTP，带 token）

KiroLex 启动时在 `127.0.0.1` 的一个随机端口上开一个很小的 HTTP 入口（`src/main/controlServer.ts`），
给**本机**的工具用：agent-board 的「拉取并重启」、你本机的 Claude Code、脚本。

- 只听 `127.0.0.1`，不对外。
- 端口和 token 写在 `~/.kirolex/control.json`（`{port, token, pid}`，权限 0600），每次启动换新的，退出时删掉。
- 除了 `/ping`，每个请求都要带 `Authorization: Bearer <token>`，不对就 `401`。
- **不开 CDP 调试端口。** 标准版只有 `--dev` 才开 9222；CDP 端口等于任意代码执行，控制入口就是为了不用它。
- token 不进日志、不进任何响应。

## 路由

| 路由 | 要 token | 说明 |
|---|---|---|
| `GET /ping` | 否 | `{ok, pid, busy}`（等待退出 / 刷新时多 `pendingQuit` / `pendingReload`） |
| `POST /quit[?force=1]` | 是 | 走托盘「Quit」那条路退出；有会话在跑就等它们跑完 |
| `POST /reload[?force=1]` | 是 | 只重新加载窗口；规则同上 |
| `POST /quit/cancel` | 是 | 取消等待 |
| `GET /sessions[?q=…]` | 是 + 开关 | 会话列表 |
| `GET /sessions/:id/tail?n=10` | 是 + 开关 | 最近 n 条消息 |
| `GET /sessions/:id/status` | 是 + 开关 | 这条会话忙不忙 |
| `POST /sessions/:id/send` | 是 + 开关 | 往这条会话发一条消息 |

### 读会话 / 发消息：先在设置里打开

`/sessions…` 这四条默认**关着**：设置 → 🧪 开关 → 安全 →「允许本机工具通过控制入口读取和发送消息」。
关着时一律 `403 {"error":"disabled"}`；`/ping` `/quit` `/reload` 不受影响。开关存在 `~/.kirolex/config.json`
的 `features.controlSessionAccess`，改完立即生效。

只有「读」和「发消息」——没有执行命令、改设置、切模型、删会话的路由。KiroLex Advanced 的会话（flow / skill）
不出现在列表里，按 id 访问也是 `404`。

**`GET /sessions`** → `[{id, title, projectId, busy, remote, archived, updatedAt}]`

- `remote`：远程会话是那台机器的显示名，本机会话是 `null`；
- `busy`：这条会话正在跑一轮（或定时任务 / 侧栏改写）；
- `?q=` 按标题子串过滤（不分大小写）；不含任何消息内容。

**`GET /sessions/:id/tail?n=10`** → `[{id, role, ts, text}]`

- `n` 默认 10，最多 50；
- `role` 是 `user`（你发的）、`assistant`，或 `kirolex`（KiroLex 自己插进对话的提示，例如换了模型 —— 不是你发的）；
- `text` 截到 8000 字；
- 工具调用只给一行标题（`[tool] 标题`），**不给工具输出原文**（读到的文件、命令输出都不出去）；
- 附件引用这类给模型看的隐藏块（`<hidden>…</hidden>`）不给。

**`GET /sessions/:id/status`** → `{busy, turnStartedAt, queued, lastMessageAt}`

- `turnStartedAt`：正在跑的这一轮从什么时候开始（毫秒时间戳；没在跑是 `null`）；
- `queued`：排队卡片有几张。

**`POST /sessions/:id/send`**，body `{"text": "…", "mode": "auto" | "next"}`（`mode` 可省，默认 `auto`）

走的是和你在输入框按 **Enter 完全相同**的路由（界面里的 `steerRoute.enterRoute`）：

- 会话空闲 → 直接发；
- 这一轮正在跑 → 「追加指令」进这一轮；追加失败按现有规则在这一轮下面标红，等你选「作为下一条发送 / 放回输入框」；
- 正在重建历史 → 「重建历史中，结束后发送」；
- `mode: "next"` → 等于 ⌘/Ctrl+Enter：进排队卡片，这一轮结束后作为下一条发。

回 `200 {"accepted": true, "messageId": "…", "routed": "sent" | "steer" | "queued"}`；追加失败、标红等你选时多一个
`"steerFailed": "<原因>"`。`routed: "queued"` 时 `messageId` 是排队卡片的 id。

| 情况 | 返回 |
|---|---|
| 会话不存在 / KiroLex Advanced 的会话 | `404 {"error":"not-found"}` |
| 文字为空 | `400 {"error":"empty-text"}` |
| 超过 20000 字 | `400 {"error":"too-long"}` |
| 以 `/` 开头（`/clear` `/stop` 这类界面命令） | `400 {"error":"slash-command"}` |
| `mode` 不是 `auto` / `next` | `400 {"error":"bad-mode"}` |
| 会话已归档 | `409 {"error":"archived"}` |
| 会话正被循环占着 | `409 {"error":"loop-running"}` |
| 窗口没开 / 正在刷新 / 界面还没就绪 | `503 {"error":"ui-not-ready"}` |
| 界面 15 秒没回话 | `504 {"error":"ui-timeout"}`（不确定是否已发，先 `tail` 看一眼再决定要不要重发） |

`send` 一定先交给界面处理，主进程不会绕过界面直接发。

**看得见**：这样发的消息，气泡上有一个「经控制入口发送」（Sent via control entry）的小标签；对话记录
（`~/.kirolex/sessions/<id>/transcript.jsonl`）里那条带 `"via": "control"`，消息 id 里带 `_ctl_`。
主进程日志（`~/.kirolex/logs/main-*.log`，`[control]`）每次记一行：路由、会话 id、字数、走了哪条路——不记正文、不记 token。

## 例子

bash（macOS / Linux / Git Bash）：

```bash
CTL="require(require('os').homedir() + '/.kirolex/control.json')"
PORT=$(node -p "$CTL.port")
TOKEN=$(node -p "$CTL.token")
SID=s_1786935225555_abcdef   # 从 /sessions 里挑一条
BASE="http://127.0.0.1:$PORT"

# 列出标题里带 "CDE" 的会话
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/sessions?q=CDE"

# 看最近 5 条
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/sessions/$SID/tail?n=5"

# 忙不忙
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/sessions/$SID/status"

# 发一句话（忙时自动追加进这一轮）
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"继续"}' "$BASE/sessions/$SID/send"

# 等这一轮结束后作为下一条发
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"跑完之后把结果总结一下","mode":"next"}' "$BASE/sessions/$SID/send"
```

PowerShell：

```powershell
$ctl = Get-Content "$HOME\.kirolex\control.json" | ConvertFrom-Json
$h = @{ Authorization = "Bearer $($ctl.token)" }
$base = "http://127.0.0.1:$($ctl.port)"
Invoke-RestMethod -Headers $h "$base/sessions?q=CDE"
Invoke-RestMethod -Method Post -Headers $h -ContentType 'application/json' `
  -Body (@{ text = '继续' } | ConvertTo-Json) "$base/sessions/$sid/send"
```

不要把 token 写进脚本或命令历史里——每次从 `control.json` 现读（它每次启动都会变）。
