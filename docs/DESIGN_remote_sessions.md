# 远程会话（Remote Sessions）设计

状态：**已实现并在用**（`standard` 分支）。`feature/flow` 还没有这套东西 —— 那边跑的是旧的
"全局一个远端目标"设计，而两个 app 共用 `~/.kirolex`，所以**别同时用两个 build**
（实测：flow 那个 app 会把一条会话的 `profile.remote` 改回去，看起来就是"会话串了"）。

## 一句话

**执行在远端，文件在你这台机器上，一个字节都不复制。** 一条会话的 kiro-cli 跑在你自己的另一台机器上，
而它读写文件、跑命令，靠的是一条反向隧道调回**你机器上**的一组工具（`local_read` / `local_write` /
`local_glob` / `local_grep` / `local_git` / `local_bash`）。远程会话和本地会话同时存在，一条一条地选。

## 为什么是这个形状

### 1. 让远端的 kiro-cli 回头读本地文件 —— 做不到

ACP 协议里客户端可以声明 `fs.readTextFile / fs.writeTextFile`，让 agent 把文件读写**回调给客户端**。
如果 kiro-cli 支持，"执行在远端、文件在本地"就是天生的。实测（声明了 fs 能力，然后让它读一个文件）：

```
initialize → agentCapabilities: {loadSession, promptCapabilities, mcpCapabilities, sessionCapabilities, auth}
工具调用: ['Reading marker.txt:2-2']
客户端被回调读文件次数: 0    写: 0
```

它**自己**读了文件，一次都没回调客户端，`agentCapabilities` 里也没有 fs。**这条事实是整套设计的地基**：
远端那个进程只能看见远端的文件系统。

### 2. 但它认 HTTP 的 MCP server —— 这就是那扇门

`kiro-cli mcp add --url` 说明它支持 HTTP 传输的 MCP。而 MCP 是**它主动去调**的东西 ——
所以只要那个 URL 通到你机器上，它的"工具"就落在你机器上执行。ssh 本来就能开反向隧道，于是：

```
你的 Mac：localMcp.ts，只听 127.0.0.1 的一个随机端口
          ssh -R 127.0.0.1:<远端端口>:127.0.0.1:<本地端口>   ← 执行器本来就是 ssh 起的
远端：    那条会话专用的 agent JSON 里一条 { "type": "http", "url": "http://127.0.0.1:<远端端口>/mcp/<token>" }
```

远端不需要装任何东西（连 rsync 都不需要），文件也不用搬。实测通过：远端那台 EC2 上的 kiro-cli
读到了只存在于本机的 `marker.txt`，`hostname` 回的是这台 Mac 的名字。

### 3. 反向挂载（远端 sshfs 挂本地）—— 代价更大

需要本机开 sshd + 远端装 FUSE；而 agent 动不动 grep 整个仓库，每次 open/stat 都是一个网络往返。
MCP 这条路可以把"grep 整个仓库"做成**一次**调用（在你机器上跑完只回结果），形状好得多。

## 184 毫秒决定了工具的粒度

实测到那台东京机器的 RTT 是 **184 ms**。所以工具**必须粗**：

* `local_read` 一次收**多个**路径（工具描述里明写，不然它会一个一个读）
* `local_grep` / `local_glob` / `local_git` 在**你机器上**跑完，只回结果
* `local_bash` 给它一条完整命令，而不是让它拼十次

做成"一次一个文件"的话，一轮 50 次读就是 9 秒纯延迟 —— 比它取代的那套镜像更慢。

## 边界：说实话，不做安全剧场

工具面里有 `local_bash`（用户明确选的），所以**这条通道等于那台远端机器在你 Mac 上有一个 shell**。
既然如此，再给读写加路径牢笼就是自欺 —— 能跑 bash 就能 `cat` 任何东西。真正起作用的是三条：

1. **只听 loopback**，而且只能顺着**那条 ssh** 的反向隧道进来；
2. **URL 里带 token**（`mcp add` 没有 `--headers`，所以只能放路径）—— 一条会话一个，会话结束即失效；
   EC2 上任何有 shell 的东西都能敲 `127.0.0.1:<端口>`，token 是那一层的锁；
3. **每一次写文件 / 跑命令都在会话状态行上说出来**。看得见比拦得住更重要 ——
   拦得住的清单总能被绕过，而看不见的操作你连事后都查不出来。

## 那条会话专用的 agent

kiro-cli 只认**它自己机器上** `~/.kiro/agents/` 里的 agent，而 MCP 的 URL 里带着会话 token，
所以配置**必须一条会话一份**（共用一份就分不出是谁在调、也就不知道 cwd 是哪个目录）。
KiroLex 每次起远程执行器时在远端拼一份 `kirolex-local-<会话>.json`，`--agent` 指定它，断开时删掉。

**底子按名字在远端解析**：
* 远端有同名的 `<agent>.json` → 拿**它**做底子（它的 prompt / MCP / resources 都是那台机器上成立的东西），
  只并上一条 `kirolex-local`；
* 没有 → 用默认 agent，**并在会话里说一句**。悄悄换一个 agent 是这条路上最贵的静默失败：
  产出是另一个 agent 干的，而界面一个字都不会说。

`tools` 是白名单，而且**缺这个字段等于一个工具都不给**（实测：不写它的时候远端回
"我手上没有任何可调用的工具"，连 fs_read 都没有，而隧道其实是通的）。所以要么把 `@kirolex-local`
并进它原来的清单，要么显式写 `["*"]`。

**本机那些 agent 不再同步过去**：推过去的 JSON 没人读，而拷 `mcpServers` 是**有害**的 ——
那些命令是本机路径（`/opt/homebrew/bin/node`、`~/.local/bin/mcp-proxy-for-aws`），远端没有，
kiro-cli 不报错、只静默少掉这些工具。安装脚本同样不碰 `~/.kiro`。

## 每台机器的启动命令（含本机）

设置 → 🖥 机器：本机和每台远端在同一个下拉里，各自配 kiro / claude / codex 的启动命令
（`claude`/`codex` 目前只检测和记录，KiroLex 还只起 kiro-cli）。

* **自动检测**：一段 shell 在那台机器上把候选逐个试一遍，**本机 `bash -lc`、远端走 ssh 用同一段**。
  每个候选都真的 `--version` 跑一遍 —— **找到文件 ≠ 能跑**。每次探测都 `< /dev/null`（有的 CLI
  读 stdin，实测 `claude-code-acp` 就是，不给 EOF 会挂住），去重按 `readlink -f` 的真实文件
  （`/opt/homebrew/bin/claude` 和 `~/.local/bin/claude` 是同一个 `claude.exe`）。
* **验证工具身份**：跑起来还不够。实测 PATH 上的 `kiro` 是 **Kiro IDE 的 CLI**（`--version` 回 `0.12.333`），
  和 kiro-cli 是两个东西 —— 所以每个工具带一条 `verify` 正则，不像它就标 ✗ 并说清它报的是什么。
* **记住成功过的**：执行器每次连上就把那条命令写进 `binHistory`（机器 → 工具 → 最近 5 条），
  检测时排最前面并标 `★`。一个真的起过会话的命令比"文件在这儿"可信得多。
* **没配就不起**：设置里没有那台机器的 kiro 启动命令时，执行器**直接拒绝启动**并说清去哪儿点什么。
  这台机器上就有两个 kiro-cli，而猜错不会报错 —— 表现是"模型列表少几个"、"agent 没生效"。
  远端那份**按 sshHost 现查配置**，不看会话记录里的快照（记录存的是建会话那一刻的目标）。

## 模型列表按机器分

两台机器的 kiro-cli 版本不同（实测本机 2.23.1、东京 1.27.0），模型集就不同。远程会话去问**那台机器**：
故意传一个不存在的模型，kiro-cli 在参数校验就会把可用列表打出来（不真调模型、不花额度）。
东京那台连 `--list-models` 都不认，所以远端只拿得到一串 id —— 名字/上下文窗口/乘数按 id 从本机那份补上
（机器决定**有哪些**模型，而"倍率 2.2"是模型自己的属性）。

启动时 `pickRemoteModel` 仍然会把选中的模型换成那台机器真有的一个，并在会话里说一句 ——
kiro-cli 对不存在的模型是**静默退回**（日志里见过 `Model 'gpt-5.6-terra' does not exist. Available models: auto`）。

**这个差别能有多大**（2026-09-24 实测，同一个 IdC 账号、同一个 `profile/YD3ARYRUKXQP`）：

| 机器 | kiro-cli | 清单 |
|---|---|---|
| 东京那台 | 1.27.0 | 19 个，含 `claude-opus-5` / `claude-sonnet-5` / `claude-opus-4.x`… |
| 这台 Mac | 2.23.1 | 8 个，**一个 Claude 都没有**（`gpt-5.6-*`、`deepseek-3.2`、`minimax-*`、`glm-5`、`qwen3-coder-next`），连 `auto` 都没有 |

**为什么** —— 查到底是**出口 IP 的地域过滤**（不是版本、不是额度、不是权限）：

* 缺的正好是 **10 个 Claude + `auto`**（19 − 11 = 8），一个不多一个不少；
* 这台 Mac 的出口 IP 是 `CN / AS4837`（联通），那台 EC2 是 `JP / AS16509`；
* **版本无关**：远端跑 2.24.0（比本机 2.23.1 **新**）照样 19 个全在；而且有人直接探
  `ListAvailableModels`、把 appVersion 从 2.12.0 伪装到 2.23.0，每次都是 19 个；
* 官方把 Claude 标成 Active、没有任何退役记录；已知 issue 里唯一确认过根因的那条就是
  "企业网络出口落在不支持的地区，Auto 和 Claude 一起消失"。

也就是说**在这台机器上这是长期状态**，换/降 kiro-cli 都没用。要用 Claude 就把会话切到远端 ——
这也正是远程会话存在的理由之一。所以本机换模型时会在会话里说一句，并且**只在那个签名成立时**
（清单里一个 Claude 都没有、`auto` 也没有）给出这个原因；签名不成立时只说"没有这个模型"，不乱归因。

本机这条路上因此多做一件事：
起执行器前先问一次 `chat --list-models`（不花额度、几秒），把清单里没有的直接记进
`modelsKnownDead` —— 否则每个新进程都要先付一轮失败才发现，实测那一轮 **30 秒**，
而且期间界面上一点动静都没有。

顺带查出来的第二件事：**`--model` 在 `chat --no-interactive` 上是空操作**。它一律先打一行
`[warn] failed to set model 'X': Method not found`，然后用别的模型跑（传不存在的名字也不报错）。
真正说话的是 **agent JSON 里的 `model` 字段**。KiroLex 的标题 / 建议 / 会话记忆压缩都走
`kirolex-lite` 这个 agent，而那份文件当时钉着 `claude-haiku-4.5` —— 于是这三件事**全都**失败，
而且改设置里的"辅助模型"完全没用。现在每次调用前把选中的模型钉进那份 agent（一样就不写盘）。

## 让它开你的浏览器：`KIROLEX-LOCAL: open <url>`

远端没有图形界面，它在那儿 `open` 一个 URL 最好的结果是什么都没发生。所以它可以在回复里写一行
`KIROLEX-LOCAL: open https://…`，KiroLex（跑在你机器上）认这一行并用 `shell.openExternal` 打开。

边界：**只有 `open` 一个动词**（能跑命令的通道等于把那台机器的权限接到你的 Mac 上，那是另一件事）；
**只收 http(s)**（别的 scheme 在 macOS 上是应用启动器）；**按整行解析**（半行会把 URL 截成另一个
仍然合法的地址）；一轮最多两个、同一地址只开一次，每次都在状态行说明。

## 远端那台机器需要什么

**只有 kiro-cli**（`REQUIRED_TOOLS`）。`git` 不需要（那个仓库不在远端，`local_git` 查的是你机器上那份）、
`rsync` 不需要（没有任何东西要同步了）。

* 远端的 cwd 是 `<remoteWorkdir>/scratch/<会话>` —— 一个**草稿目录**（它自己要落临时文件时有地方放），
  KiroLex 在起执行器前 `mkdir -p` 它。不是"项目在这里"。
* 断开时要**杀掉远端那个 kiro-cli**：ssh 这边死了它不会跟着退（无 PTY、也不在 stdin EOF 时退出），
  会一直占着那条 kiro-cli 会话的锁 —— 实测那台 EC2 上攒了 **85 个**孤儿，最老的 2 天 23 小时，
  然后下一次 attach 报 `Session is active in another process (PID …)` 并连锁出一串
  `Session not connected`。做法：远端命令先 `echo KIROLEX_REMOTE_PID $$ >&2` 再 `exec`
  （exec 之后 PID 不变），断开时按那个 PID `kill -TERM`；`before-quit` 也补一遍。
* 隧道端口**每次起执行器都换一个**：换 agent / 换模型是"先起新执行器、成功了再关旧的"，
  复用同一个端口会撞上还没退出的旧 ssh —— `ExitOnForwardFailure=yes` 让它直接失败（ssh exit 255），
  看起来像掉线，其实必然发生、重试也必然再撞。

## 会话可以选多个目录

一条会话带的是一**组**目录（第一个是主目录 = `local_bash` 的 cwd、相对路径的基准）。
输入框下面一格一个：点第一格换主目录，附加的那几格上有 ✕，最后一个 ＋ 再加一个。

`local_glob` / `local_grep` 不指定目录时搜**全部**（`find` / `rg` 本来就收多个起点，所以仍然是
**一次**调用 —— 184 ms 的往返下"每个目录搜一次"会把粒度打回镜像那版）。注入里把这几棵树都列出来：
不列的话它只在第一个里找，然后把"没找到"当成"没有这个东西"。

`undefined`（传字符串）= 只换主目录、清单不动；`[]` = 明确只留主目录。换机器那条路走前者 ——
顺手清空用户选的几个目录，是那种改完很久才发现的错。

## 它有哪些工具，不能靠历史推断

实测（「我让 agent 测本地 playwright 它找不到」）：那条会话的隧道是好的（远端 curl 两个 endpoint
都正常，`serverInfo: Playwright 1.64.0`），用同一份 agent、同一个模型单独跑一次 ACP，
`browser_*`（20 个）和 `local_read/write/grep` 全都在清单里。而 app 里它连着三轮说"我拿不到这些工具"，
**一次调用都没试**。

原因在随消息带过去的那几万字符里：历史和 memory 全是**镜像时代**的记录 ——「我在
`/home/ec2-user/kirolex-mirror`」「你的 `/Users/...` 路径都不存在」「5 个调用有 4 个被路径校验拦掉」。
它信了历史，没看工具清单。

这类错最贵的地方是它**看起来像故障**：人会去查隧道、查 MCP、重启，而那一层全是好的。
所以注入里有一条显式把旧结论作废，并点出历史里那几句原话（泛泛说"历史可能过时"它认不出指的是哪句）。

## 明确不做的事

* **不做安全沙箱**。见「边界」那一节：有 `local_bash` 的前提下，路径牢笼只是剧场。
* **不给"要不要转发某个 MCP"一个开关**。转发是自动的（见下一节）：判据成立就转发。
  想让远端用它自己那台的浏览器时，没有地方能说"这一条别转发" —— 目前的出路是在那台机器的
  同名 agent 里自己配一个。
* **没有 computer-use**。`local_bash` 已经是粗糙版（`screencapture` 截图 + `osascript` 点按都在你机器上跑），
  真要闭环得在本机装一个 computer-use 的 MCP —— 装上之后**自动就被转发**，不需要改代码。
* **不在远端装项目依赖 / 不跑构建**。构建和测试用 `local_bash` 在**你机器**上跑 —— 那里才有你的
  `node_modules` 和工具链。
* **不替你登录**。bootstrap 走 device flow：授权动作始终在你自己的浏览器里。

## 把本机的 MCP 转发过去（playwright 等）

远程会话的 agent 里如果有 `playwright`，它跑的是**远端**那台机器的浏览器 —— 没有显示器，
而且就算有你也看不见它点了什么。这些 MCP 是 stdio 的，所以 KiroLex 在本机把它们起起来，
在**同一条隧道**上多开一个路径 `/mcp/<token>/<名字>`，把 JSON-RPC **原样**转发。
远端的 kiro-cli 看到的就是一个普通 HTTP MCP，而 `browser_click` 落在你的机器上。

实测（远端 curl 那个 URL）：`initialize` 回的是 `serverInfo: Playwright 1.64.0`（跑在 Mac 上），
`browser_navigate https://example.com` 回 `Page Title: Example Domain`，本机 Chrome 进程 +1。

**原样转发**而不是自己包一层工具：那些 server 的工具清单 / schema / 行为都由它们自己说，
包一层就得跟着它们的版本走，而转发连它们的 `initialize` 响应都不用看懂。

挑谁转发（`forwardMcp.ts`）：
* 命令是**本机路径**的 —— 远端必然起不来，而 kiro-cli 对这种不报错、只静默少工具。
* **按名字**该在本机跑的（`playwright` / `drawio` / `pencil`）—— `npx` 远端也有，但它拉起的是
  远端那台的浏览器。这是语义问题，命令行里看不出来，所以只能白名单。
* `type: http` 的不转发（远端自己能连同一个地址）；`disabled` 的跳过。

**只看这条会话所选 agent 的那份定义**。所以跑默认 agent（没有具体 agent 名）的会话**什么都不转发** ——
要 playwright 就得选一个配了它的 agent。

生命周期：**懒启动**（没人调就不起浏览器）；会话作废 / 换 agent / 退出都跟着杀掉；子进程挂了下一次
调用重起，pending 的请求收到明确错误而不是永远挂着；单次调用上限 180 秒（`browser_navigate` 要等页面）。

注入里必须说"这些工具作用在**用户那台**机器上"：不说它会以为在自己机器上点浏览器，
而那是最难发现的一类错 —— 截图回来的是另一台机器的屏幕。

## 这版之前是「镜像 + 同步」—— 为什么换掉

第一版的形状是：rsync 把项目推到远端一份镜像，每轮前后同步，冲突落成 `<file>.remote`。
它能用，但账单是实测出来的：

| 事实 | 数字 |
|---|---|
| 一条 cwd 是 `~` 的会话把家目录推上远端 | 2.6 → 6.1 GB，含 `.aws/credentials`、`.aws/sso/cache`、17 把 `.pem` |
| 同一个目录被当成"项目镜像 + 会话镜像"推两遍 | app 里 21 秒，手动推同一份 5.9 秒 |
| 纯生成的一轮也在收尾拉一次 | 5–7 秒，只因为判据是标题匹配而"网页搜索"的标题里有 search |
| KiroLex 自己写的文件躺在被同步的树里 | `manifest.json` 每 20 秒报一次冲突，本地被塞满 `.remote` |
| KiroLex 被杀之后 rsync 不死 | 被 launchd 收养（ppid=1），继续推 6.1 GB 并吃光上行 |

这些不是没修好 —— 每一条都修了。换掉是因为**它们全都源自同一件事：多了一份副本**，
而副本一旦存在就要回答"哪一份是真的、什么时候同步、冲突怎么办"。本地 MCP 那条路把这个问题
整个消掉了：只有一份文件，就在你机器上。

## 测试

* `tests/localMcp.test.ts` —— 工具本身（多文件读、截断说明在开头、bash 留痕、git 只读子命令）、
  MCP 协议（initialize / tools/list / 通知不回包 / HTTP 404 与 token）、接线（隧道参数、端口竞态、
  远端 agent 按名字解析 —— 那段合并程序用临时 HOME **真跑一遍**）。
* `tests/binDetect.test.ts` —— 探测脚本（`< /dev/null`、去重、`verify`）、历史合并、设置分页与文案、
  "没配就不起"那道门。
* `tests/remoteTargets.test.ts` —— 配置读写（"键在 input 里才动它"）、界面接线、bootstrap 脚本的判据。
* `tests/localAction.test.ts` —— `KIROLEX-LOCAL` 通道的边界与两个实测踩到的接线 bug。
