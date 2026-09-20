# 远程会话（Remote Sessions）设计

状态：设计稿，待实现。分支：先在 `standard` 上做，再 cherry-pick 到 `feature/flow`。

## 一句话

**执行在远端，文件在本地。** 一条会话的 kiro-cli 跑在你自己的另一台机器上，而它读写的那份代码始终以
本地磁盘为准 —— KiroLex 负责在两边之间搬文件，并保证远端看到的永远是你刚刚看到的那份。
远程会话和本地会话**同时存在**，一条一条地选，不是一个全局开关。

## 为什么不能更简单

先说三个被实测否掉的"更省事的办法"，否则下面的复杂度看起来是凭空加的。

### 1. 让远端的 kiro-cli 回头读本地文件 —— 做不到

ACP 协议里客户端可以声明 `fs.readTextFile / fs.writeTextFile` 能力，让 agent 把文件读写**回调给客户端**。
如果 kiro-cli 支持，那"执行在远端、文件在本地"就是天生的：远端进程读的其实是你 Mac 上的文件。

实测（客户端声明了 fs 能力，然后让它读一个本地文件）：

```
initialize → agentCapabilities: {loadSession, promptCapabilities, mcpCapabilities, sessionCapabilities, auth}
工具调用: ['Reading marker.txt:2-2']
客户端被回调读文件次数: 0    写: 0
```

它**自己**读了文件，一次都没回调客户端；`agentCapabilities` 里也没有 fs。也就是说：远端的执行器
只能看见远端的文件系统。这一条把"代理文件访问"整条路线否掉了，剩下的只能是**镜像 + 同步**。

### 2. 反向挂载（远端 sshfs 挂本地）—— 代价和风险都更大

需要本机开 sshd + 反向隧道，远端装 FUSE；而 agent 动不动就 grep 整个仓库，每次 open/stat 都是一个
网络往返。rsync 是一次批量往返，形状简单得多，出错也看得见。

### 3. 把 node_modules 一起同步 —— 是**错的**，不只是慢

本地 617MB 的 `node_modules` 里有 darwin 的原生二进制，拷到 Linux 上不能用。所以远程会话**不做构建和测试**
（见「明确不做的事」）。`.git` 只有 9.9MB，同步它是划算的 —— 没有 `.git`，agent 的 `git status/diff/log`
全废，它会当场开始瞎猜。

## 实测到的远端事实

目标机（`ec2-user@99.83.165.184`，用户自己的 EC2）：

| 事实 | 值 | 对设计的影响 |
|---|---|---|
| OS | Amazon Linux 2023, x86_64 | POSIX 引号规则；`bash -lc` 可用 |
| kiro-cli | `~/.local/bin/kiro-cli`，**已登录**（IAM Identity Center） | 认证不用 KiroLex 管，但要在连接时**验一次**并给人话 |
| rsync | 3.4.0 / protocol 32；本机是 openrsync/29 | 实测**双向都通**（推上去、再拉回来能带回远端新建的文件） |
| git / python3 | 有 | agent 的常规工具可用 |
| LibreOffice | **没有** | 预览 / PPT 必须留在本地 |
| 规格 | 2 vCPU / 3GB | 重活别放远端；它的价值是"另一台机器的 kiro-cli"，不是算力 |

## 架构

```
┌────────────────── 本地（唯一真相）──────────────────┐        ┌──────── 远端（一次性镜像）────────┐
│ ~/code/myproj                     ← 你编辑 / review │        │ <remoteWorkdir>/<projectId>       │
│ ~/.kirolex/sessions/<id>/         ← transcript、    │  push  │   ← kiro-cli 的 cwd               │
│     history.md、附件                                │ ─────► │ <remoteWorkdir>/.kirolex-sessions/│
│                                                     │        │     <id>/  ← history.md、附件     │
│ review / diff / PPT / 预览（全部本地）              │ ◄───── │ kiro-cli acp（ssh -T 起）         │
└─────────────────────────────────────────────────────┘  pull  └───────────────────────────────────┘
```

- **本地永远是真相。** 镜像随时可以删掉重建；任何"只存在于远端"的状态都是 bug。
- **执行器**就是现在的 `AcpClient`，只是 `spawn` 的是 `ssh -T … kiro-cli acp …`（脚手架已在：
  `buildSshArgs` / `buildRemoteKiroCommand` / `config.RemoteTarget` / `profile.remote`）。
- **agent 的 bash 工具跑在远端** —— 这不是选择，kiro-cli 在哪就在哪。所以远端镜像必须"能读能写能 git"。

### 三个同步点（跟着一轮对话的生命周期）

| 时机 | 方向 | 失败时怎么办 |
|---|---|---|
| `session/prompt` **发出之前** | 本地 → 远端（`rsync -a --delete`） | **不发这一轮**，报错。宁可不跑，也不能让模型读着旧文件干活 |
| 一轮结束（`stopReason`） | 远端 → 本地 | 标记「远端有未取回的改动」并重试；绝不让人以为本地是新的 |
| 工具调用里出现写文件（防抖 ~800ms） | 远端 → 本地 | 同上，但静默重试 —— 这是让 review/gate 看起来是"活的"的那一半 |
| 打开 file review / diff 之前 | 远端 → 本地（按需，阻塞渲染） | 报错并拒绝渲染 —— 拿旧文件做 review 比不做更糟 |

排除清单（默认，按项目可改）：`node_modules/`、`build/`、`dist/`、`.venv/`、`__pycache__/`、`*.log`、
`.DS_Store`。`.git/` **包含**。

### 冲突：只在这一种情况下发生，也只处理这一种

单人单机，冲突窗口只有一个：**一轮正在远端跑的时候你改了同一个文件**。

push 的时候给每个文件记一份 `(mtime, size)` 快照；pull 的时候如果某个文件**本地变了**（和快照不一致）
**且远端也变了** —— 不覆盖，把远端那份写成 `foo.ts.remote`，并在会话里说一句。不搞三方合并。

### 五个"本地假设"必须改掉

这五处是现在代码里写死了"kiro-cli 在本机"的地方，不改掉的话远程会话会安静地给出错答案：

1. **附件路径**：`historyLine` 发的是 `file:<本地绝对路径>`。加一个 `pathForExecutor(p)` 做本地↔镜像映射，
   附件引用和 `session/new { cwd }` 都走它。
2. **session 目录**：`history.md` 写在 `~/.kirolex/sessions/<id>/`，在项目目录**之外** —— 要单独镜像到
   `<remoteWorkdir>/.kirolex-sessions/<id>/`。
3. **诊断读的是本机路径**：`cliErrorContext` / `trimHugeCliLogs` / `writeFailureBundle` 读的是
   `$TMPDIR/kiro-log` 和 `~/.kiro/sessions/cli`。远程会话要读**远端**的那几份，否则
   "为什么会断"这套刚建好的取证能力在远程会话上全是空的。
4. **退出码语义**：本地 `code 0 = 正常退出`；ssh 掉线是 **255**。255 要归到
   `isTransientTransportError`（可自动重试），**不能**判成"后端会话毒了"去重建会话。
5. **超时**：`LOAD_TIMEOUT_MS = 45s` 是按本地 spawn 估的。远端要加上 SSH 握手，按 host 分：本地 45s，远端 90s。

### 模块边界

新增三个纯模块（都能不碰 SSH 做单测）：

- `src/main/hostOps.ts` —— `HostOps { exec, readTail, stat, truncate, home, tmpdir }`，两个实现
  `LocalHost`（就是现在的 `fs`/`child_process`）和 `SshHost`（复用 `buildSshArgs`，和 `loopVerify` 同一条决策）。
  `kiroCliLog.ts` / `failureBundle.ts` 改成接 `HostOps`，本地行为一个字节都不变（现有测试照旧过）。
- `src/main/remoteMirror.ts` —— 纯函数：排除清单、rsync 参数、快照比较、冲突判定、镜像路径推导。
  真正跑 rsync 的那层薄薄一个 `syncPush/syncPull`。
- `src/main/remoteTargets.ts` —— 配置读取：`remotes: [{id, label, sshHost, sshPort, identityFile, remoteWorkdir}]`，
  并**兼容读**老的 `agents[].remote`（现在配置里就是这个形状，`enabled: false`）。

### 共存（这是需求里最容易做歪的一条）

`profile.remote` 已经是**按会话**存的，但现在的值来自全局 `activeAgentId` 的 agent —— 那是个模式开关。
改法很小：**新建会话时选目标**（本地 / `<host label>`），存进这条会话的 profile，之后不再看全局。

- 新建会话的入口给一个目标选择（默认本地）。
- 侧栏和会话头部给远程会话一个 host 徽标 —— 任何时候都不该猜"这一轮是在哪台机器上跑的"。
- 同步状态（推/拉中、有未取回的改动、有冲突）显示在会话头部。

### review / 预览 / PPT

不动。它们读的是本地文件，而本地是真相 —— 只要 pull 在渲染之前发生（上面第 4 个同步点）就自然是对的。
远端没有 LibreOffice，也不需要有。

### 远程会话要告诉模型的话

远程会话的上下文里加一句（否则它会试着 `npm test` 然后困惑）：

> 你在远端机器上。`node_modules/` 和构建产物没有同步；需要构建、跑测试或做预览时说出来，由本地执行。

### 连接时的检查（失败要给人话，不是挂着）

起执行器之前串一次：`ssh <opts> <host> 'kiro-cli whoami && command -v rsync git'`。
分别对应三句明确的错误：连不上（网络/密钥）、没登录（去远端 `kiro-cli login`）、缺 rsync/git。

## 明确不做的事

- 远程会话**不做构建、不跑测试、不做预览/PPT**（原生依赖 + 没有 LibreOffice + 2 vCPU）。
- 不做三方合并、不做 git 层面的同步（rsync 搬文件，git 历史照旧在文件里）。
- 不支持 Windows 远端；不支持多用户共享同一个 `remoteWorkdir`。
- 不把本地会话改成"也走镜像"—— 本地路径一行都不动。

## 分阶段

1. `hostOps` + 诊断/超时/退出码按 host 分流（**无可见变化**，纯铺路）。
2. `remoteMirror` + 三个同步点 + 路径映射 + 连接检查 → 远程会话真的能用。
3. UI：按会话选目标、host 徽标、同步状态、冲突提示。
4. cherry-pick 到 `feature/flow`。

feature flag `remoteSessions`（默认关），这样 `standard` 可以带着它提 PR 而不改变任何现有行为。

## 测试

- 纯模块单测：排除清单、rsync 参数、快照/冲突判定、255 归类、镜像路径推导、配置兼容读。
- 接线断言（本项目惯例）：三个同步点各自接在哪、push 失败不发 prompt、pull 失败必须留下标记。
- 一个**默认跳过**的集成测试，给了 `KIROLEX_TEST_REMOTE=<host>` 才跑：建临时项目 → push → 远端改文件 →
  pull → 验证内容和冲突分支。
